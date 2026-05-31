import * as Lark from '@larksuiteoapi/node-sdk';
import * as fs from 'fs';
import * as path from 'path';
import { ResolvedConfig } from './config';
import { logger } from './logger';
import { sessionManager, Session } from './session';
import { getApproval, updateApprovalStatus, ApprovalRequest } from './approval';
import { pendingIpcRequests, sendJson, registerCardCallback } from './ipc';
import { runAgent, AgentRunHandle } from './adapter';
import { getAllowedWorkspaces, getAntigravityProjects, getBrainDir } from './workspace';
import { getMediaChatDir } from './paths';
import { prepareImageForAgent, PreparedImage } from './media';
import { limitAgentPrompt, truncateMiddle } from './payload';
import { PromptQueue, QueuedPrompt } from './promptQueue';
import { PendingQueue } from './pending-queue';
import { reduce, initialState, finalizeIfRunning, markIdleTimeout, markInterrupted, renderCard, renderText, toLarkMarkdown, RunState } from './card';
import { isAdmin, isChatAllowed, isUserAllowed } from './access';
import { formatDoctorChecks, runDoctor } from './doctor';

type InterruptReason = 'user_stop' | 'new_session' | 'shutdown' | 'idle_timeout' | 'stale_run';

interface ActiveRun {
  scope: string;
  runHandle: AgentRunHandle;
  cardMessageId: string;
  state: RunState;
  interrupted: boolean;
  startedAt: number;
  lastActivityAt: number;
  idleTimer?: NodeJS.Timeout;
}

const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const PENDING_DEBOUNCE_MS = 400;

interface PendingPrompt {
  prompt: string;
  msgId: string;
  senderId: string;
  enqueuedAt: number;
}

interface ChatModeCacheEntry {
  mode: string;
  expiresAt: number;
}

export class LarkGateway {
  private client: Lark.Client;
  private wsClient: Lark.WSClient;
  private config: ResolvedConfig;
  private processedMessageIds: Set<string> = new Set();
  private eventDispatcher: Lark.EventDispatcher;
  private promptQueue = new PromptQueue();
  private pendingQueue: PendingQueue<PendingPrompt>;
  private agentUnavailableUntil = 0;
  private agentUnavailableMessage = '';
  private taskUpdateVersions = new Map<string, number>();
  private finalizedTaskCards = new Set<string>();
  private activeRuns = new Map<string, ActiveRun>();
  private chatModeCache = new Map<string, ChatModeCacheEntry>();
  private botOpenId?: string;
  private botName?: string;

  constructor(config: ResolvedConfig) {
    this.config = config;

    this.pendingQueue = new PendingQueue<PendingPrompt>(PENDING_DEBOUNCE_MS, (scope, batch) => {
      void this.handlePendingFlush(scope, batch);
    });

    this.client = new Lark.Client({
      appId: config.lark.appId,
      appSecret: config.lark.appSecret,
      domain: config.lark.domain === 'feishu' ? Lark.Domain.Feishu : Lark.Domain.Lark,
    });

    this.eventDispatcher = new Lark.EventDispatcher({});

    this.eventDispatcher.register<any>({
      'im.message.receive_v1': this.handleMessage.bind(this),
      'card.action.trigger': this.handleCardAction.bind(this),
    });

    this.wsClient = new Lark.WSClient({
      appId: config.lark.appId,
      appSecret: config.lark.appSecret,
      domain: config.lark.domain === 'feishu' ? Lark.Domain.Feishu : Lark.Domain.Lark,
    });

    // Register IPC callback to send approval card
    registerCardCallback(this.sendApprovalCard.bind(this));
  }

  public async start() {
    logger.info('lark.ws_connecting', { appId: this.config.lark.appId });
    try {
      const res = await this.client.request({
        url: '/open-apis/bot/v3/info',
        method: 'GET',
      });
      if (res && res.bot) {
        this.botOpenId = res.bot.open_id;
        this.botName = res.bot.app_name;
        logger.info('lark.bot_info_loaded', { name: this.botName, openId: this.botOpenId });
      }
    } catch (err: any) {
      logger.warn('lark.bot_info_failed', { error: err.message });
    }
    await this.wsClient.start({ eventDispatcher: this.eventDispatcher });
    logger.info('lark.ws_connected', { appId: this.config.lark.appId });
  }

  public async stop() {
    await this.interruptAllActiveRuns('shutdown');
    logger.info('lark.ws_disconnected');
  }

  private async handleMessage(data: any) {
    logger.info('event.handle_message_entry', {
      hasData: !!data,
      hasMessage: !!data?.message,
      hasSender: !!data?.sender,
      messageKeys: data?.message && typeof data.message === 'object' ? Object.keys(data.message) : [],
    });
    const message = data.message;
    const sender = data.sender;

    if (!message || !sender) return;

    const msgId = message.message_id;
    if (this.processedMessageIds.has(msgId)) {
      return;
    }
    this.processedMessageIds.add(msgId);
    setTimeout(() => this.processedMessageIds.delete(msgId), 5 * 60 * 1000);

    const senderId = sender.sender_id?.open_id;
    const chatId = message.chat_id;

    if (!senderId || !chatId) return;

    // Access control check
    if (!isUserAllowed(this.config, senderId)) {
      logger.warn('access.denied_user', { senderId, chatId });
      return;
    }
    if (!isChatAllowed(this.config, chatId)) {
      logger.warn('access.denied_chat', { senderId, chatId });
      return;
    }

    let text = '';
    const messageType = message.msg_type || message.message_type;
    if (messageType === 'text') {
      try {
        const contentObj = JSON.parse(message.content);
        text = contentObj.text || '';
      } catch (err) {
        logger.warn('message.ignored', { reason: 'content_json_parse_failed', messageType });
        return;
      }
    } else if (messageType === 'image') {
      let imageKey = '';
      try {
        const contentObj = JSON.parse(message.content);
        imageKey = contentObj.image_key || '';
      } catch (err) {
        logger.warn('message.ignored', { reason: 'image_content_json_parse_failed' });
        await this.replyText(msgId, '未能读取图片信息。');
        return;
      }
      if (!imageKey) {
        logger.warn('message.ignored', { reason: 'missing_image_key' });
        await this.replyText(msgId, '未能读取图片信息。');
        return;
      }
      try {
        const image = await this.downloadMessageImage(chatId, msgId, imageKey);
        text = this.buildImagePrompt([image], '');
      } catch (err: any) {
        logger.error('image.download_failed', err.message, { msgId, imageKey: imageKey.substring(0, 12) });
        await this.replyText(msgId, '图片下载失败，可能缺少消息资源读取权限。');
        return;
      }
    } else if (messageType === 'post') {
      try {
        const contentObj = JSON.parse(message.content);
        const postText = this.extractPostText(contentObj);
        const imageKeys = this.extractPostImageKeys(contentObj);
        if (imageKeys.length > 0) {
          const images: PreparedImage[] = [];
          for (const imageKey of imageKeys) {
            images.push(await this.downloadMessageImage(chatId, msgId, imageKey));
          }
          text = this.buildImagePrompt(images, postText);
        } else {
          text = postText;
        }
      } catch (err: any) {
        logger.error('post.process_failed', err.message, { msgId });
        await this.replyText(msgId, '未能读取富文本消息里的图片或文字。');
        return;
      }
    } else {
      logger.warn('message.ignored', { reason: 'unsupported_message_type', messageType });
      return;
    }

    const chatMode = await this.getChatMode(chatId, message.chat_type);
    const threadKey = this.isTopicChatMode(chatMode)
      ? (message.thread_id || message.root_id || message.parent_id)
      : '';
    const scope = message.chat_type === 'p2p'
      ? `p2p:${chatId}`
      : (threadKey ? `thread:${chatId}:${threadKey}` : `chat:${chatId}`);
    logger.info('message.scope_resolved', {
      scope,
      chatMode,
      hasThreadId: !!message.thread_id,
      hasRootId: !!message.root_id,
      hasParentId: !!message.parent_id,
    });

    // If group, check mention
    if (message.chat_type === 'group') {
      const isMentioned = message.mentions && message.mentions.some((m: any) => {
        const mentionId = typeof m.id === 'object' ? (m.id?.open_id || m.id?.user_id) : m.id;
        const mentionName = m.name;
        return mentionId === this.config.lark.appId ||
               (this.botOpenId && mentionId === this.botOpenId) ||
               mentionName === '机器人' ||
               (this.botName && mentionName === this.botName);
      });
      if (this.config.reply.requireMentionInGroup && !isMentioned) {
        logger.info('message.ignored_no_mention', { chatId, botOpenId: this.botOpenId, mentions: message.mentions });
        return;
      }
    }

    const session = this.getOrCreateMessageSession(scope, chatId, message.chat_type);

    // Clean the current message by stripping mentions, then attach quoted/replied
    // message content if Feishu only sent us a parent/root message id.
    text = this.stripMentions(text);
    const quotedMessageId = this.getQuotedMessageId(message);
    const quotedContext = quotedMessageId ? await this.fetchQuotedMessageContext(message) : '';
    if (quotedContext) {
      text = text
        ? `${quotedContext}\n\n<current_message>\n${text}\n</current_message>`
        : `${quotedContext}\n\n<current_message>\n(no extra text)\n</current_message>`;
    } else if (quotedMessageId && this.isQuoteDependentReply(text)) {
      logger.warn('message.quote_context_required_but_missing', { quotedMessageId, text: text.substring(0, 80) });
      await this.replyText(msgId, '我没有拿到被引用消息的正文，所以不能可靠判断这句“怎么看”指的是什么。请复制引用内容正文，或重新引用一条普通文本消息。');
      return;
    }
    if (!text) return;

    const imagePathMatches = Array.from(text.matchAll(/(\/[^\s)]+?\.(?:png|jpe?g|webp))/gi)).map((match) => match[1]);
    if (messageType === 'image') {
      (session as any).lastImagePath = imagePathMatches[imagePathMatches.length - 1];
    } else if (imagePathMatches.length > 0) {
      (session as any).lastImagePath = imagePathMatches[imagePathMatches.length - 1];
    } else {
      const lastImagePath = (session as any).lastImagePath;
      if (lastImagePath && this.looksLikeImageFollowUp(text)) {
        text = `用户上一条消息发送了一张图片，图片路径：${lastImagePath}\n\n用户现在追问：${text}\n\n请结合这张图片回答用户。`;
      }
    }

    logger.info('message.received', { scope, senderId, messageType, text: text.substring(0, 100) });

    // Handle Slash Commands
    if (text.startsWith('/') && !text.startsWith('/task ') && !text.startsWith('/long ')) {
      await this.handleCommand(text, scope, msgId, senderId);
      return;
    }

    // Normal natural language Prompt
    await this.enqueuePrompt(text, scope, msgId, senderId);
  }

  private async handleCommand(cmd: string, scope: string, msgId: string, senderId: string) {
    const parts = cmd.split(' ');
    const primary = parts[0];

    const session = sessionManager.getOrCreateSession(scope, this.config.agent.defaultWorkspace);

    if (primary === '/help') {
      const helpText = `🤖 Antigravity 飞书桥接系统 MVP 帮助\n\n` +
        `支持的命令：\n` +
        `- /help : 显示本帮助信息\n` +
        `- /status : 查看当前工作区和会话状态\n` +
        `- /new (或 /reset) : 清空当前会话上下文并开启新会话\n` +
        `- /doctor : 运行桥接自诊断（管理员）\n` +
        `- /list (或 /ws) : 查看和切换当前工作空间与历史会话\n` +
        `- /stop : 停止当前正在执行的 Agent 任务\n` +
        `- /cd <路径> : 切换工作区到指定路径\n` +
        `- /task : 长任务模式，最多等待 10 分钟\n` +
        `- /long : 同 /task\n` +
        `- /reconnect : 触发连接刷新\n\n` +
        `您可以直接在此对话框中发送自然语言 Prompt 以让本地 Antigravity Agent 执行开发任务。\n` +
        `遇到高风险工具调用时，系统会在本线程回复您一个审批卡片，点击即可授权或拒绝执行。`;

      await this.replyText(msgId, helpText);
    } else if (primary === '/status') {
      const statusText = `📊 Antigravity Bridge 状态\n\n` +
        `工作区: \`${session.workspace}\`\n` +
        `会话状态: \`${session.status}\`\n` +
        `会话 ID: \`${session.conversationId || 'none'}\``;
      await this.replyText(msgId, statusText);
    } else if (primary === '/new' || primary === '/reset') {
      const wasRunning = await this.interruptRun(scope, 'new_session');
      sessionManager.resetSession(scope, this.config.agent.defaultWorkspace);
      await this.replyText(msgId, wasRunning ? '已中断当前任务并清空会话上下文，下一条消息会开启新的 Antigravity 会话。' : '已清空当前会话上下文，下一条消息会开启新的 Antigravity 会话。');
    } else if (primary === '/doctor') {
      if (!isAdmin(this.config, senderId)) {
        await this.replyText(msgId, '无权限执行 /doctor。');
        return;
      }
      await this.replyText(msgId, formatDoctorChecks(runDoctor()));
    } else if (primary === '/stop') {
      const stopped = await this.interruptRun(scope, 'user_stop');
      await this.replyText(msgId, stopped ? '🚫 当前任务已被用户中断停止。' : '⚠️ 当前没有正在运行的任务。');
    } else if (primary === '/reconnect') {
      if (!isAdmin(this.config, senderId)) {
        await this.replyText(msgId, '无权限执行 /reconnect。');
        return;
      }
      await this.replyText(msgId, '🔄 WebSocket 连接在线，已刷新。');
    } else if (primary === '/cd') {
      const targetPath = parts.slice(1).join(' ').trim();
      if (!targetPath) {
        await this.replyText(msgId, `当前工作区: \`${session.workspace}\`\n用法: /cd <路径>`);
        return;
      }
      if (!fs.existsSync(targetPath)) {
        await this.replyText(msgId, `❌ 路径不存在: ${targetPath}`);
        return;
      }
      session.workspace = targetPath;
      sessionManager.saveSessions();
      await this.replyText(msgId, `✅ 工作区已切换到: \`${targetPath}\``);
    } else if (primary === '/list' || primary === '/ws') {
      const card = this.buildListCard(session);
      try {
        const res = await this.client.im.message.reply({
          path: {
            message_id: msgId,
          },
          data: {
            content: JSON.stringify(card),
            msg_type: 'interactive',
          },
        });
        logger.info('lark.list_card_sent', { scope, messageId: res?.data?.message_id });
      } catch (err: any) {
        logger.error('lark.list_card_error', err.message, {
          code: err?.response?.data?.code,
          msg: err?.response?.data?.msg,
          logId: err?.response?.data?.log_id,
        });
        await this.replyText(msgId, this.buildWorkspaceSessionText(session));
      }
    } else {
      await this.replyText(msgId, `❌ 未知指令: ${primary}。输入 /help 查看支持的命令。`);
    }
  }

  private extractPostText(contentObj: any): string {
    const content = contentObj.content || contentObj.zh_cn?.content || contentObj.en_us?.content || [];
    const parts: string[] = [];

    for (const line of content) {
      if (!Array.isArray(line)) continue;
      for (const item of line) {
        if (item?.tag === 'img') continue;
        const text = item?.text || item?.name || item?.href || '';
        if (text) parts.push(text);
      }
    }

    return parts.join(' ').trim();
  }

  private stripMentions(text: string): string {
    return text
      .replace(/<at id="[^"]+">@.*?<\/at>\s*/g, '')
      .replace(/@_user_\d+\s*/g, '')
      .trim();
  }

  private async getChatMode(chatId: string, chatType: string): Promise<string> {
    if (chatType === 'p2p') return 'p2p';

    const cached = this.chatModeCache.get(chatId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.mode;
    }

    try {
      const res = await this.client.im.chat.get({
        path: { chat_id: chatId },
      });
      const data = res?.data || {};
      const mode = data.group_message_type || data.chat_mode || 'chat';
      this.chatModeCache.set(chatId, {
        mode,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
      logger.info('lark.chat_mode_loaded', {
        chatId,
        mode,
        groupMessageType: data.group_message_type,
        chatMode: data.chat_mode,
      });
      return mode;
    } catch (err: any) {
      logger.warn('lark.chat_mode_failed', { chatId, error: err?.message });
      return 'chat';
    }
  }

  private isTopicChatMode(mode: string): boolean {
    const normalized = String(mode || '').toLowerCase();
    return normalized === 'thread' || normalized === 'topic' || normalized === 'thread_v2';
  }

  private getOrCreateMessageSession(scope: string, chatId: string, chatType: string): Session {
    let defaultWorkspace = this.config.agent.defaultWorkspace;
    if (scope.startsWith('thread:') && chatType === 'group') {
      const parentChatSession = sessionManager.getSession(`chat:${chatId}`);
      if (parentChatSession?.workspace) {
        defaultWorkspace = parentChatSession.workspace;
      }
    }

    const session = sessionManager.getOrCreateSession(scope, defaultWorkspace);
    if (scope.startsWith('thread:') && chatType === 'group') {
      const parentChatSession = sessionManager.getSession(`chat:${chatId}`);
      const inheritedWorkspace = parentChatSession?.workspace;
      if (inheritedWorkspace && session.workspace === this.config.agent.defaultWorkspace && session.workspace !== inheritedWorkspace) {
        logger.info('session.thread_workspace_inherited', { scope, from: session.workspace, to: inheritedWorkspace });
        session.workspace = inheritedWorkspace;
        session.conversationId = null;
        sessionManager.saveSessions();
      }
    }
    return session;
  }

  private parseMessageText(message: any): string {
    if (!message) return '';

    const messageType = message.msg_type || message.message_type;
    const rawContent = message.body?.content || message.content;

    if (message.deleted) return '[deleted message]';
    if (messageType === 'image') return '[image message]';
    if (!rawContent || typeof rawContent !== 'string') return '';

    try {
      const contentObj = JSON.parse(rawContent);
      if (messageType === 'text') return this.stripMentions(contentObj.text || '');
      if (messageType === 'post') return this.stripMentions(this.extractPostText(contentObj));
      if (messageType === 'interactive') return this.extractInteractiveCardContent(rawContent);
      return this.stripMentions(contentObj.text || contentObj.title || rawContent);
    } catch (err) {
      if (messageType === 'interactive') return this.extractInteractiveCardContent(rawContent);
      return rawContent.trim();
    }
  }

  private extractInteractiveCardContent(rawContent: string): string {
    const parsed = this.tryParseJson(rawContent);
    const userDsl = parsed && typeof parsed.user_dsl === 'string' && parsed.user_dsl.trim()
      ? parsed.user_dsl.trim()
      : '';
    const rawForModel = userDsl || rawContent;
    const contentObj = this.tryParseJson(rawForModel) || parsed;
    const textParts = this.extractCardTextParts(contentObj);
    const blocks: string[] = [];

    if (textParts.length > 0) {
      blocks.push([
        '<interactive_card_text>',
        truncateMiddle(textParts.join('\n'), 3000, 'interactive card text'),
        '</interactive_card_text>',
      ].join('\n'));
    }

    if (rawForModel.trim()) {
      blocks.push([
        '<interactive_card_raw>',
        truncateMiddle(rawForModel, 4000, 'interactive card raw json'),
        '</interactive_card_raw>',
      ].join('\n'));
    }

    return blocks.join('\n\n');
  }

  private extractCardTextParts(value: any): string[] {
    const parts: string[] = [];
    const seen = new Set<any>();
    const textKeys = new Set([
      'content',
      'text',
      'title',
      'subtitle',
      'description',
      'label',
      'name',
      'placeholder',
      'alt',
    ]);
    const skipKeys = new Set([
      'config',
      'style',
      'styles',
      'behaviors',
      'actions',
      'action',
      'value',
      'values',
      'url',
      'href',
      'image_key',
      'img_key',
      'icon',
      'template',
      'template_id',
      'uuid',
    ]);

    const visit = (node: any, keyHint = '') => {
      if (node === null || node === undefined) return;
      if (typeof node === 'string') {
        const trimmed = this.stripMentions(node).trim();
        if (trimmed && (textKeys.has(keyHint) || keyHint === 'user_dsl')) {
          parts.push(trimmed);
        }
        return;
      }
      if (typeof node !== 'object') return;
      if (seen.has(node)) return;
      seen.add(node);

      if (Array.isArray(node)) {
        for (const item of node) visit(item, keyHint);
        return;
      }

      if (typeof node.user_dsl === 'string' && node.user_dsl.trim()) {
        const dsl = this.tryParseJson(node.user_dsl);
        if (dsl) visit(dsl, 'user_dsl');
      }

      for (const [key, child] of Object.entries(node)) {
        if (skipKeys.has(key)) continue;
        if (key === 'tag' || key === 'type' || key === 'schema') continue;
        visit(child, key);
      }
    };

    visit(value);
    return Array.from(new Set(parts.map((part) => part.replace(/\s+\n/g, '\n').trim()).filter(Boolean)));
  }

  private tryParseJson(text: string): any | undefined {
    try {
      return JSON.parse(text);
    } catch (err) {
      return undefined;
    }
  }

  private isQuoteDependentReply(text: string): boolean {
    const normalized = text.replace(/\s+/g, '').trim();
    if (!normalized) return true;
    if (normalized.length > 40) return false;
    return /(怎么看|你怎么看|这个呢|这呢|这条呢|啥意思|什么意思|对吗|可行吗|评价下|分析下|说说|意见)/.test(normalized);
  }

  private getQuotedMessageId(message: any): string {
    const currentId = message?.message_id;
    const candidates = [
      message?.parent_id,
      message?.root_id !== currentId ? message?.root_id : '',
      message?.thread_id !== currentId ? message?.thread_id : '',
    ];
    return candidates.find((id) => typeof id === 'string' && id.trim()) || '';
  }

  private async fetchQuotedMessageContext(message: any): Promise<string> {
    const quotedMessageId = this.getQuotedMessageId(message);
    if (!quotedMessageId) return '';

    try {
      const res: any = await this.client.im.message.get({
        params: {
          card_msg_content_type: 'user_card_content',
        },
        path: {
          message_id: quotedMessageId,
        },
      });
      const quotedMessage = res?.data?.items?.[0];
      const quotedText = this.parseMessageText(quotedMessage);
      if (!quotedText) {
        logger.info('message.quote_context_empty', { quotedMessageId });
        return '';
      }

      logger.info('message.quote_context_attached', {
        quotedMessageId,
        quotedMessageType: quotedMessage?.msg_type,
        quotedLength: quotedText.length,
      });
      return [
        '<quoted_message>',
        `message_id: ${quotedMessageId}`,
        truncateMiddle(quotedText, 3000, 'quoted message'),
        '</quoted_message>',
      ].join('\n');
    } catch (err: any) {
      logger.warn('message.quote_context_fetch_failed', {
        quotedMessageId,
        error: err?.message,
        code: err?.response?.data?.code,
        msg: err?.response?.data?.msg,
      });
      return '';
    }
  }

  private extractPostImageKeys(contentObj: any): string[] {
    const content = contentObj.content || contentObj.zh_cn?.content || contentObj.en_us?.content || [];
    const imageKeys: string[] = [];

    for (const line of content) {
      if (!Array.isArray(line)) continue;
      for (const item of line) {
        const imageKey = item?.image_key;
        if (item?.tag === 'img' && imageKey) imageKeys.push(imageKey);
      }
    }

    return imageKeys;
  }

  private looksLikeImageFollowUp(text: string): boolean {
    const normalized = text.trim();
    if (/^[？?。.！!…\s]{1,8}$/.test(normalized)) return true;
    return /图|图片|截图|照片|这个|上面|里面|看|什么意思|哪里|怎么|为什么|为啥/.test(normalized);
  }

  private isContextDependentReply(text: string): boolean {
    const normalized = text.replace(/\s+/g, '').trim();
    if (!normalized) return false;
    if (/^[0-9一二三四五六七八九十]{1,3}$/.test(normalized)) return true;
    if (/^[？?。.！!…]{1,8}$/.test(normalized)) return true;
    return /^(同意|可以|继续|好的|好|行|确认|确定|开始|执行|按这个|按上面|用中文|中文|好了没|好了吗|啥情况|什么意思)$/.test(normalized);
  }

  private isPureChitChat(text: string): boolean {
    const normalized = text.replace(/\s+/g, '').trim().toLowerCase();
    if (!normalized) return false;
    if (normalized.length > 12) return false;
    return /^(hi|hello|hey|哈喽|哈啰|你好|您好|在吗|在不|在么|早|早上好|中午好|下午好|晚上好|嗨|喂|测试|test|ping)[。.!！~～]*$/.test(normalized);
  }

  private buildContextualAgentPrompt(userPrompts: string | string[], scope: string, senderId: string, session: Session): string {
    const promptArr = Array.isArray(userPrompts) ? userPrompts : [userPrompts];
    const userPrompt = promptArr.join('\n\n');
    const isChitChat = promptArr.length === 1 && this.isPureChitChat(promptArr[0]);
    const isP2p = scope.startsWith('p2p:');
    const shortReplyHint = isP2p && promptArr.length === 1 && this.isContextDependentReply(promptArr[0])
      ? '用户当前消息很短，必须优先结合最近对话判断它是在选择、确认、追问、催办还是要求切换语言；不要把它当成孤立的新任务。'
      : '';
    const chitChatHint = isChitChat
      ? '用户只是在打招呼或简单测试连通性。请用一两句话简短回应即可，不要主动检索代码、读取文件、运行命令或开启任何新任务。'
      : '';
    const batchHint = promptArr.length > 1
      ? `用户在很短时间内连续发了 ${promptArr.length} 条消息，已合并为一次请求（按时间顺序，用空行分隔）。请把它们视为同一意图的补充/纠正，整体回复一次即可，不要逐条复述。`
      : '';
    const conversationText = session.conversationId || 'none';
    const currentBotName = this.botName || '小G';

    return [
      '<bridge_context>',
      `bot_name: ${currentBotName}`,
      'channel: feishu',
      `scope: ${scope}`,
      `chat_id: ${scope.split(':')[1] || ''}`,
      `sender_id: ${senderId}`,
      `workspace: ${session.workspace}`,
      `conversation_id: ${conversationText}`,
      '</bridge_context>',
      '<bridge_instructions>',
      'If <user_message> contains <quoted_message>, it is the quoted/replied message the user is asking about; answer based on it first and do not repeat the XML tags.',
      'If quoted_message contains <interactive_card_text> or <interactive_card_raw>, the user quoted a Feishu interactive card; prefer interactive_card_text and use raw JSON only as backup.',
      'If the user asks a quote-dependent question but the quoted content is empty or unreadable, say that the quoted body was unavailable; do not guess or read local files to infer it.',
      `你叫${currentBotName}，是通过飞书接入的 Antigravity 本地开发助手。`,
      '默认使用中文回复，除非用户明确要求其他语言。',
      'bridge_context 是桥接层元数据，只用于理解上下文；不要在回复中复述这些字段。',
      '如果 user_message 里包含 <quoted_message>，它就是用户当前引用回复所指向的内容，必须优先围绕它回答；不要把 XML 标签原样复述给用户。',
      '如果 quoted_message 里包含 <interactive_card_text> 或 <interactive_card_raw>，说明用户引用的是飞书交互卡片；先根据 interactive_card_text 理解，必要时再参考 raw JSON。',
      '如果用户问“怎么看/这个呢”等依赖引用的问题，但引用内容为空、不可读或只有占位符，必须说明没有拿到引用正文；不要自行读取本地文件、不要猜测用户指的是哪个项目。',
      '当 <user_message> 内容很短或只是打招呼/确认/感叹（如 hi、你好、在吗、收到、好的、谢谢）时，只用一两句话简短回复，禁止主动调用任何工具。',
      '当用户表达抱怨、疑问或闲聊（如"卡住了吗"、"什么情况"、"为啥还没好"、"能不能..."），先直接用对话回应；不要主动读代码、跑命令、翻 bridge实现去排查，除非用户明确说"帮我看一下代码"或"调试一下"。',
      '【发送图片/文件/视频到飞书】生成或准备好本地文件后，必须用 lark-cli 主动发到当前对话，不要只在文本里写 ![](file://...)。命令模板：`lark-cli im +messages-send --chat-id <chat_id> --media-path <绝对路径>`，其中 chat_id 取自 bridge_context.chat_id。发完之后简短一句话告诉用户已发送即可，不要再贴本地路径。',
      shortReplyHint,
      chitChatHint,
      batchHint,
      '</bridge_instructions>',
      '<user_message>',
      userPrompt,
      '</user_message>',
    ].filter(Boolean).join('\n\n');
  }

  private async enqueuePrompt(prompt: string, scope: string, msgId: string, senderId: string) {
    const session = sessionManager.getOrCreateSession(scope, this.config.agent.defaultWorkspace);

    if (this.agentUnavailableUntil > Date.now()) {
      await this.replyText(msgId, this.agentUnavailableMessage || 'Antigravity 后端当前不可用，请稍后再试。');
      return;
    }

    const isRunning = this.promptQueue.isActive(scope) || session.status === 'RUNNING' || session.status === 'AWAITING_APPROVAL';
    let runActive = isRunning;
    if (isRunning) {
      const cleared = this.clearStaleRunIfNeeded(session, scope);
      if (cleared) runActive = false;
    }

    if (runActive) {
      // Block the debounce timer so we don't flush mid-run; we'll unblock when the current batch finishes.
      // (We intentionally skip a visible ack here — flush will reply once the current run completes.)
      this.pendingQueue.block(scope);
    }

    this.pendingQueue.push(scope, { prompt, msgId, senderId, enqueuedAt: Date.now() });
    session.pendingQueue = this.snapshotPending(scope);
  }

  private snapshotPending(scope: string): string[] {
    const n = this.pendingQueue.size(scope);
    if (n === 0) return [];
    return [`(pending batch, ${n} message${n > 1 ? 's' : ''})`];
  }

  private async handlePendingFlush(scope: string, batch: PendingPrompt[]) {
    if (batch.length === 0) return;
    // Push the entire batch as a single queued unit, then drain.
    this.promptQueue.push({
      prompt: '',  // unused; batch carried via batchPrompts
      scope,
      msgId: batch[batch.length - 1].msgId,  // anchor: last user message
      senderId: batch[batch.length - 1].senderId,
      batchPrompts: batch.map(b => b.prompt),
      batchMsgIds: batch.map(b => b.msgId),
    } as any);
    await this.drainPromptQueue(scope);
  }

  private async drainPromptQueue(scope: string) {
    if (this.promptQueue.isActive(scope)) return;

    this.promptQueue.setActive(scope, true);
    try {
      let item: QueuedPrompt | undefined;
      while ((item = this.promptQueue.shift(scope))) {
        const session = sessionManager.getOrCreateSession(scope, this.config.agent.defaultWorkspace);
        session.pendingQueue = this.promptQueue.snapshot(scope);
        await this.processPrompt(item);
      }
    } finally {
      this.promptQueue.setActive(scope, false);
      const session = sessionManager.getSession(scope);
      if (session) {
        session.pendingQueue = [];
      }
      // Unblock the debounce queue so any messages that arrived during the run can flush.
      this.pendingQueue.unblock(scope);
    }
  }

  private async processPrompt(item: QueuedPrompt) {
    const { scope, msgId, senderId } = item;
    const batchPrompts: string[] = (item as any).batchPrompts || [item.prompt];
    const session = sessionManager.getOrCreateSession(scope, this.config.agent.defaultWorkspace);
    const rawPrompts = batchPrompts.map(p => p.replace(/^\/(task|long)\s+/, '').trim()).filter(Boolean);
    const rawPrompt = rawPrompts.join('\n\n');
    const contextualPrompt = this.buildContextualAgentPrompt(rawPrompts, scope, senderId, session);
    const limitedPrompt = limitAgentPrompt(contextualPrompt, this.config.media.maxPromptChars);
    if (limitedPrompt.truncated) {
      logger.warn('prompt.truncated', {
        scope,
        originalChars: limitedPrompt.originalChars,
        maxChars: this.config.media.maxPromptChars,
      });
    }
    const userPrompt = limitedPrompt.prompt;
    const timeoutMs = 10 * 60 * 1000;

    // Save prompt context metadata for approval routing
    (session as any).lastMessageId = msgId;
    (session as any).lastRequesterId = senderId;

    sessionManager.setStatus(scope, 'RUNNING');
    logger.info('agent.started', { scope, workspace: session.workspace });

    let state: RunState = { ...initialState, scope };
    let taskCardMessageId = '';

    try {
      if (this.config.reply.mode === 'card') {
        const card = renderCard(state);
        try {
          const { cardId, messageId } = await this.createAndReplyCard(msgId, card);
          taskCardMessageId = messageId;
          (session as any).activeTaskCardId = cardId;
          (session as any).activeTaskCardSequence = 1;
        } catch (sendErr: any) {
          logger.error('lark.reply_card_failed', JSON.stringify({
            scope,
            msgId,
            status: sendErr?.response?.status,
            body: sendErr?.response?.data,
            cardPreview: JSON.stringify(card).slice(0, 500),
          }));
          throw sendErr;
        }
      } else {
        const text = renderText(state);
        const res = await this.replyText(msgId, text || 'Thinking...');
        taskCardMessageId = res?.data?.message_id || '';
      }

      (session as any).activeTaskCardMessageId = taskCardMessageId;
      (session as any).activeTaskState = state;

      // Start run
      const runHandle = await runAgent({
        scope,
        workspace: session.workspace,
        prompt: userPrompt,
        sessionId: session.conversationId || undefined,
        timeoutMs,
      }, this.config, async (evt) => {
        state = reduce(state, evt);
        this.updateActiveRunState(scope, state);
        (session as any).activeTaskState = state;
        await this.updateTaskProgress(taskCardMessageId, state);
      });

      (session as any).activeRunHandle = runHandle;
      this.registerActiveRun(scope, runHandle, taskCardMessageId, state);

      // Wait for run completion (or error)
      const finalResult = await runHandle.promise;

      if (runHandle.conversationId) {
        sessionManager.setConversationId(scope, runHandle.conversationId);
      }

      sessionManager.setStatus(scope, 'COMPLETED');
      sessionManager.touchActive(scope);
      logger.info('agent.completed', { scope });

      // Use finalResult as fallback only when transcript polling yielded no text
      const hasAnyText = state.blocks.some(b => b.kind === 'text' && b.content.trim().length > 0);
      if (!hasAnyText && finalResult) {
        state = reduce(state, { type: 'text', delta: finalResult });
      }

      state.terminal = 'done';
      state.footer = null;
      state = finalizeIfRunning(state);
      await this.updateTaskProgress(taskCardMessageId, state);
    } catch (err: any) {
      const activeRun = this.activeRuns.get(scope);
      if (activeRun?.interrupted) {
        state = activeRun.state;
        logger.info('agent.interrupted', { scope });
      } else {
        sessionManager.setStatus(scope, 'FAILED');
        logger.error('agent.failed', err.message);

        const errorMsg = `出错了：${err.message}`;
        if (this.isQuotaError(err.message)) {
          this.rememberAgentUnavailable(err.message);
        }

        if (this.isFatalCliError(err.message)) {
          state.blocks = [];
          state.reasoning = { content: '', active: false };
        }
        state.terminal = 'error';
        state.errorMsg = errorMsg;
        state.footer = null;
        state = finalizeIfRunning(state);
        await this.updateTaskProgress(taskCardMessageId, state);

        if (this.isQuotaError(err.message)) {
          await this.replyText(msgId, errorMsg);
        }
      }
    } finally {
      this.clearActiveRun(scope);
      const currentSession = sessionManager.getSession(scope);
      if (currentSession && (currentSession.status === 'RUNNING' || currentSession.status === 'AWAITING_APPROVAL')) {
        sessionManager.setStatus(scope, 'IDLE');
      }
      delete (session as any).activeRunHandle;
      delete (session as any).activeTaskCardMessageId;
      delete (session as any).activeTaskState;
    }
  }

  private registerActiveRun(scope: string, runHandle: AgentRunHandle, cardMessageId: string, state: RunState) {
    this.clearActiveRun(scope);
    const activeRun: ActiveRun = {
      scope,
      runHandle,
      cardMessageId,
      state,
      interrupted: false,
      startedAt: runHandle.startedAt,
      lastActivityAt: Date.now(),
    };
    this.activeRuns.set(scope, activeRun);
    this.armIdleTimer(activeRun);
  }

  private updateActiveRunState(scope: string, state: RunState) {
    const activeRun = this.activeRuns.get(scope);
    if (!activeRun || activeRun.interrupted) return;
    activeRun.state = state;
    activeRun.lastActivityAt = Date.now();
    this.armIdleTimer(activeRun);
  }

  private clearActiveRun(scope: string) {
    const activeRun = this.activeRuns.get(scope);
    if (activeRun?.idleTimer) clearTimeout(activeRun.idleTimer);
    this.activeRuns.delete(scope);
  }

  private armIdleTimer(activeRun: ActiveRun) {
    if (activeRun.idleTimer) clearTimeout(activeRun.idleTimer);
    activeRun.idleTimer = setTimeout(() => {
      void this.interruptRun(activeRun.scope, 'idle_timeout');
    }, IDLE_TIMEOUT_MS);
  }

  private async interruptRun(scope: string, reason: InterruptReason): Promise<boolean> {
    const session = sessionManager.getSession(scope);
    const activeRun = this.activeRuns.get(scope);
    const activeHandle = activeRun?.runHandle || ((session as any)?.activeRunHandle as AgentRunHandle | undefined);
    if (!activeRun && !activeHandle && session?.status !== 'RUNNING' && session?.status !== 'AWAITING_APPROVAL') {
      return false;
    }

    this.promptQueue.clear(scope);
    this.pendingQueue.cancel(scope);
    if (session) session.pendingQueue = [];
    this.cancelPendingApprovals(scope, `Task interrupted: ${reason}.`);

    let state = activeRun?.state || ((session as any)?.activeTaskState as RunState | undefined) || { ...initialState, scope };
    state = reason === 'idle_timeout' ? markIdleTimeout(state, Math.ceil(IDLE_TIMEOUT_MS / 60000)) : markInterrupted(state);
    if (activeRun) {
      activeRun.interrupted = true;
      activeRun.state = state;
    }
    if (session) (session as any).activeTaskState = state;

    const cardMessageId = activeRun?.cardMessageId || ((session as any)?.activeTaskCardMessageId as string | undefined) || '';
    await this.updateTaskProgress(cardMessageId, state);

    if (activeHandle?.isRunning?.()) {
      await activeHandle.stop();
    }

    sessionManager.setStatus(scope, reason === 'idle_timeout' ? 'FAILED' : 'CANCELLED');
    if (reason !== 'shutdown') {
      sessionManager.setStatus(scope, 'IDLE');
    }
    return true;
  }

  public async interruptAllActiveRuns(reason: InterruptReason = 'shutdown') {
    const scopes = new Set<string>(this.activeRuns.keys());
    await Promise.allSettled([...scopes].map((scope) => this.interruptRun(scope, reason)));
  }

  private isQuotaError(message: string): boolean {
    return /RESOURCE_EXHAUSTED|额度已耗尽|quota/i.test(message || '');
  }

  private isFatalCliError(message: string): boolean {
    return this.isQuotaError(message) || /未登录|not logged into Antigravity|无法获取模型授权|CLI 报错|CLI 等待模型响应超时|timed out/i.test(message || '');
  }

  private rememberAgentUnavailable(message: string) {
    const resetMs = this.parseResetDurationMs(message) || 10 * 60 * 1000;
    this.agentUnavailableUntil = Date.now() + resetMs;
    this.agentUnavailableMessage = `Antigravity 模型额度已耗尽，暂时无法继续调用后端。${this.formatUnavailableUntil()}`;
  }

  private parseResetDurationMs(message: string): number | null {
    const match = message.match(/Resets in\s+([0-9hms\s]+)/i);
    if (!match?.[1]) return null;

    const text = match[1];
    const hours = Number(text.match(/(\d+)\s*h/)?.[1] || 0);
    const minutes = Number(text.match(/(\d+)\s*m/)?.[1] || 0);
    const seconds = Number(text.match(/(\d+)\s*s/)?.[1] || 0);
    const totalMs = ((hours * 60 + minutes) * 60 + seconds) * 1000;
    return totalMs > 0 ? totalMs : null;
  }

  private formatUnavailableUntil(): string {
    if (!this.agentUnavailableUntil) return '';
    const remainingSeconds = Math.max(0, Math.round((this.agentUnavailableUntil - Date.now()) / 1000));
    return `预计 ${this.formatDuration(remainingSeconds)} 后恢复。`;
  }

  private buildRunHeartbeat(runHandle: AgentRunHandle, lastProgressAt: number, queuedCount = 0): string {
    const elapsedSeconds = Math.max(0, Math.round((Date.now() - runHandle.startedAt) / 1000));
    const idleSeconds = Math.max(0, Math.round((Date.now() - lastProgressAt) / 1000));
    const elapsedText = this.formatDuration(elapsedSeconds);
    const pidText = runHandle.pid ? `PID ${runHandle.pid}` : 'PID 未知';
    const queueText = queuedCount > 0 ? `，队列中还有 ${queuedCount} 条消息` : '';
    if (idleSeconds >= 90) {
      return `仍在运行，已耗时 ${elapsedText}，${pidText}${queueText}，最近 ${this.formatDuration(idleSeconds)} 没有新进展，可能正在等待 Antigravity 输出。`;
    }
    return `仍在运行，已耗时 ${elapsedText}，${pidText}${queueText}。`;
  }

  private async noteQueuedPrompt(session: Session, queueSize: number) {
    const cardMessageId = (session as any).activeTaskCardMessageId as string | undefined;
    let state = (session as any).activeTaskState as RunState | undefined;
    if (!cardMessageId || !state) return;

    const note = `已收到后续消息，队列中还有 ${queueSize} 条，当前任务结束后自动继续处理。`;
    state = reduce(state, { type: 'text', delta: `\n\n_${note}_` });
    (session as any).activeTaskState = state;
    await this.updateTaskProgress(cardMessageId, state);
  }

  private formatDuration(totalSeconds: number): string {
    if (totalSeconds < 60) return `${totalSeconds} 秒`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 60) return seconds ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return remainingMinutes ? `${hours} 小时 ${remainingMinutes} 分` : `${hours} 小时`;
  }

  private trimTaskSteps(steps: string[]) {
    const maxSteps = 8;
    while (steps.length > maxSteps) {
      steps.splice(1, 1);
    }
  }

  private clearStaleRunIfNeeded(session: Session, scope: string): boolean {
    const activeHandle = (session as any).activeRunHandle as AgentRunHandle | undefined;
    if (session.status !== 'RUNNING' && session.status !== 'AWAITING_APPROVAL') {
      return false;
    }

    const timeoutMs = 10 * 60 * 1000;
    const staleAfterMs = timeoutMs + 30 * 1000;
    const now = Date.now();
    const missingHandle = !activeHandle;
    const deadHandle = !!activeHandle && typeof activeHandle.isRunning === 'function' && !activeHandle.isRunning();
    const expiredHandle = !!activeHandle && now - activeHandle.startedAt > staleAfterMs;

    if (!missingHandle && !deadHandle && !expiredHandle) {
      return false;
    }

    logger.warn('session.stale_run_reset', {
      scope,
      status: session.status,
      reason: missingHandle ? 'missing_handle' : deadHandle ? 'dead_handle' : 'expired_handle',
      pid: activeHandle?.pid || null,
      ageMs: activeHandle?.startedAt ? now - activeHandle.startedAt : null,
    });

    void this.interruptRun(scope, 'stale_run');
    delete (session as any).activeRunHandle;
    sessionManager.setStatus(scope, 'IDLE');
    return true;
  }

  private cancelPendingApprovals(scope: string, reason: string) {
    for (const [approvalId, pending] of pendingIpcRequests.entries()) {
      const approvalReq = getApproval(approvalId);
      if (approvalReq && approvalReq.sessionId === scope) {
        clearTimeout(pending.timeoutId);
        sendJson(pending.res, 200, {
          decision: 'deny',
          reason,
        });
        updateApprovalStatus(approvalId, 'cancelled');
        pendingIpcRequests.delete(approvalId);
      }
    }
  }

  private async updateTaskProgress(cardMessageId: string, state: RunState) {
    if (!cardMessageId) return;
    const isFinal = state.terminal !== 'running';
    if (!isFinal && this.finalizedTaskCards.has(cardMessageId)) return;

    const version = (this.taskUpdateVersions.get(cardMessageId) || 0) + 1;
    this.taskUpdateVersions.set(cardMessageId, version);
    if (isFinal) {
      this.finalizedTaskCards.add(cardMessageId);
    }

    try {
      await this.patchTaskProgress(cardMessageId, state, version, isFinal);
      if (isFinal && this.config.reply.mode === 'card') {
        await new Promise(resolve => setTimeout(resolve, 600));
        await this.patchTaskProgress(cardMessageId, state, version, true);
      }
    } finally {
      if (isFinal) {
        this.taskUpdateVersions.delete(cardMessageId);
        setTimeout(() => this.finalizedTaskCards.delete(cardMessageId), 60 * 1000);
      }
    }
  }

  private async createAndReplyCard(
    replyToMsgId: string,
    cardSpec: object,
  ): Promise<{ cardId: string; messageId: string }> {
    const createRes: any = await (this.client as any).cardkit.v1.card.create({
      data: {
        type: 'card_json',
        data: JSON.stringify(cardSpec),
      },
    });
    const cardId = createRes?.data?.card_id;
    if (!cardId) {
      throw new Error(`cardkit.card.create returned no card_id: ${JSON.stringify(createRes)}`);
    }
    const sendRes: any = await this.client.im.message.reply({
      path: { message_id: replyToMsgId },
      data: {
        msg_type: 'interactive',
        content: JSON.stringify({ type: 'card', data: { card_id: cardId } }),
      },
    });
    const messageId = sendRes?.data?.message_id || '';
    return { cardId, messageId };
  }

  private async updateCardKit(cardId: string, cardSpec: object, sequence: number) {
    await (this.client as any).cardkit.v1.card.update({
      path: { card_id: cardId },
      data: {
        card: { type: 'card_json', data: JSON.stringify(cardSpec) },
        sequence,
        uuid: `u_${cardId}_${sequence}`,
      },
    });
  }

  private async patchTaskProgress(cardMessageId: string, state: RunState, version: number, isFinal: boolean) {
    if (!isFinal && this.taskUpdateVersions.get(cardMessageId) !== version) return;
    try {
      if (this.config.reply.mode === 'card') {
        const session = state.scope ? sessionManager.getSession(state.scope) : undefined;
        const cardId = session ? (session as any).activeTaskCardId : undefined;
        if (cardId) {
          const seq = ((session as any).activeTaskCardSequence || 1) + 1;
          (session as any).activeTaskCardSequence = seq;
          const card = renderCard(state);
          await this.updateCardKit(cardId, card, seq);
        } else {
          const card = renderCard(state);
          await this.client.im.v1.message.patch({
            path: { message_id: cardMessageId },
            data: { content: JSON.stringify(card) },
          });
        }
      } else if (state.terminal !== 'running') {
        const text = renderText(state);
        await this.replyText(cardMessageId, text);
      }
    } catch (err: any) {
      logger.warn('lark.update_task_progress_failed', {
        message: err.message,
        cardMessageId,
        terminal: state.terminal,
        final: isFinal,
      });
      if (state.terminal !== 'running') {
        const text = renderText(state);
        await this.replyText(cardMessageId, text);
      }
    }
  }

  private buildImagePrompt(images: PreparedImage[], postText: string): string {
    const maxImages = Math.max(1, this.config.media.maxImagesPerPrompt);
    const selectedImages = images.slice(0, maxImages);
    const omittedCount = images.length - selectedImages.length;
    const imageList = selectedImages
      .map((image, index) => {
        const sizeInfo =
          image.compressed
            ? ` (compressed ${image.originalBytes} -> ${image.finalBytes} bytes)`
            : ` (${image.finalBytes} bytes)`;
        return `- 图片${index + 1}: ${image.path}${sizeInfo}`;
      })
      .join('\n');
    const safePostText = postText ? truncateMiddle(postText, 3000, 'message text') : '';

    const multiImageInstruction =
      selectedImages.length > 1
        ? '请先快速理解每张图片的作用，但不要默认输出图片摘要或对比报告；必须优先执行用户附带文字里的真实任务。'
        : '请直接查看并理解这张本地图片，但不要默认只描述图片；必须优先执行用户附带文字里的真实任务。';
    const omittedNote =
      omittedCount > 0
        ? `\n\n注意：本条消息包含 ${images.length} 张图片，为避免 Antigravity bridge payload 过大，本次只传入前 ${selectedImages.length} 张。请提示用户把剩余图片分批发送。`
        : '';

    return [
      `用户发送了一条包含图片的消息。${multiImageInstruction}`,
      '如果用户要求“改、修、处理、实现、调整、设置”，这通常是执行任务，不是让你分析图片。只有在用户明确要求“描述/比较/总结图片”时，才输出图片摘要或对比分析。',
      '不要无关扩写；如果需要改代码或配置，先定位相关文件并直接处理。图片只是需求参考。',
      safePostText ? `用户附带文字：${safePostText}` : '',
      `图片路径：\n${imageList}`,
      omittedNote,
    ].filter(Boolean).join('\n\n');
  }

  private async downloadMessageImage(chatId: string, messageId: string, imageKey: string): Promise<PreparedImage> {
    const safeMessageId = messageId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const safeImageKey = imageKey.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 32);
    const dir = getMediaChatDir(chatId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${safeMessageId}-${safeImageKey || 'image'}.png`);
    const res = await this.client.im.messageResource.get({
      path: {
        message_id: messageId,
        file_key: imageKey,
      },
      params: {
        type: 'image',
      },
    });
    await res.writeFile(filePath);
    const prepared = prepareImageForAgent(filePath, {
      enabled: this.config.media.autoCompressImages,
      maxWidthPx: this.config.media.imageMaxWidthPx,
      jpegQuality: this.config.media.imageJpegQuality,
      maxBytes: this.config.media.imageMaxBytes,
    });
    logger.info('image.downloaded', {
      msgId: messageId,
      imageKey: imageKey.substring(0, 12),
      filePath,
      preparedPath: prepared.path,
      originalBytes: prepared.originalBytes,
      finalBytes: prepared.finalBytes,
      compressed: prepared.compressed,
    });
    return prepared;
  }

  private async replyText(messageId: string, text: string) {
    try {
      return await this.client.im.message.reply({
        path: {
          message_id: messageId,
        },
        data: {
          content: JSON.stringify({ text }),
          msg_type: 'text',
        },
      });
    } catch (err: any) {
      logger.error('lark.reply_error', err.message);
      return null;
    }
  }

  private async replyMarkdown(messageId: string, text: string) {
    try {
      const formattedText = toLarkMarkdown(text);
      const card = {
        schema: '2.0',
        config: {
          wide_screen_mode: true,
          enable_forward: true,
        },
        elements: [
          {
            tag: 'div',
            text: {
              tag: 'lark_md',
              content: formattedText,
            },
          },
        ],
      };
      return await this.client.im.message.reply({
        path: {
          message_id: messageId,
        },
        data: {
          content: JSON.stringify(card),
          msg_type: 'interactive',
        },
      });
    } catch (err: any) {
      logger.error('lark.reply_markdown_error', err.message);
      return await this.replyText(messageId, text);
    }
  }

  private async replyResult(messageId: string, text: string) {
    if (this.config.reply.mode === 'card') {
      return await this.replyMarkdown(messageId, text);
    } else {
      return await this.replyText(messageId, text);
    }
  }

  private async updateTextMessage(messageId: string, text: string) {
    try {
      await this.client.im.v1.message.patch({
        path: { message_id: messageId },
        data: { content: JSON.stringify({ text }) },
      });
    } catch (err: any) {
      logger.warn('lark.update_text_message_failed', { message: err.message });
      // Fallback: reply as a new message
      await this.replyText(messageId, text);
    }
  }

  // Callback registered with ipc.ts to push approval card
  private async sendApprovalCard(req: ApprovalRequest): Promise<string> {
    try {
      const card = this.buildApprovalCard(req);
      const res = await this.client.im.message.reply({
        path: {
          message_id: req.messageId,
        },
        data: {
          content: JSON.stringify(card),
          msg_type: 'interactive',
        },
      });

      return res?.data?.message_id || '';
    } catch (err: any) {
      logger.error('lark.send_card_error', err.message);
      throw err;
    }
  }

  private async handleCardAction(data: any): Promise<any> {
    const operator = data.operator;
    const actionVal = data.action?.value || data.action?.behaviors?.[0]?.value;

    if (!operator || !actionVal) {
      return {};
    }

    if (actionVal.type === 'switch_session_confirm' || actionVal.type === 'switch_workspace' || actionVal.type === 'switch_conversation') {
      const scope = actionVal.scope;
      const formValues = data.action?.form_value || data.action?.form_values || data.form_values || actionVal.form_values || {};
      const selectedWorkspace = actionVal.workspace || formValues.workspace;
      const selectedSession = actionVal.session || formValues.session;
      logger.info('lark.switch_action', { type: actionVal.type, scope, selectedWorkspace, selectedSession, formValues, actionKeys: Object.keys(data.action || {}), dataKeys: Object.keys(data) });

      return this.applyWorkspaceSessionSwitch(scope, selectedWorkspace, selectedSession);
    }

    if (actionVal.type === 'switch_session_cancel') {
      return {
        toast: {
          type: 'info',
          content: '操作已取消',
        },
      };
    }

    if (actionVal.cmd === 'stop') {
      const scope = actionVal.scope;
      if (!scope) {
        return { toast: { type: 'error', content: '无法确定任务作用域' } };
      }
      const stopped = await this.interruptRun(scope, 'user_stop');
      if (stopped) {
        return {
          toast: { type: 'success', content: '任务已终止' },
        };
      }
      return {
        toast: { type: 'warning', content: '当前没有正在运行的任务' },
      };
    }

    if (actionVal.type !== 'approval_decision') {
      return {};
    }

    const operatorId = operator.open_id;
    const approvalId = actionVal.approval_id;
    const nonce = actionVal.nonce;
    const action = actionVal.action; // 'approve' or 'reject'

    const approvalReq = getApproval(approvalId);
    if (!approvalReq) {
      return {
        toast: { type: 'error', content: '审批请求不存在' }
      };
    }

    if (approvalReq.status !== 'pending') {
      return {
        toast: { type: 'warn', content: '该审批已处理' },
        card: this.buildProcessedApprovalCard(approvalReq)
      };
    }

    if (approvalReq.nonce !== nonce) {
      return {
        toast: { type: 'error', content: '非法安全校验 Nonce 错误' }
      };
    }

    // Verify Admin rights or Requester
    const isRequester = approvalReq.requesterId === operatorId;
    const operatorIsAdmin = isAdmin(this.config, operatorId);

    if (!isRequester && !operatorIsAdmin) {
      logger.warn('approval.unauthorized_operator', { operatorId, approvalId });
      return {
        toast: { type: 'error', content: '无审批权限' }
      };
    }

    // Update status
    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    updateApprovalStatus(approvalId, newStatus, operatorId);

    // Resolve Hook HTTP Pending Response
    const pending = pendingIpcRequests.get(approvalId);
    if (pending) {
      clearTimeout(pending.timeoutId);
      sendJson(pending.res, 200, {
        decision: action === 'approve' ? 'allow' : 'deny',
        reason: `Approved by user ${operatorId}`,
      });
      pendingIpcRequests.delete(approvalId);
    }

    // Change session state
    const session = sessionManager.getSession(approvalReq.sessionId);
    if (session) {
      sessionManager.setStatus(session.scope, action === 'approve' ? 'RUNNING' : 'REJECTED');
    }

    logger.info('approval.decided', {
      approvalId,
      chatId: approvalReq.chatId,
      operatorId,
      decision: newStatus,
    });

    return {
      toast: {
        type: 'success',
        content: action === 'approve' ? '已批准执行' : '已拒绝执行',
      },
      card: this.buildProcessedApprovalCard(approvalReq)
    };
  }

  private buildApprovalCard(req: ApprovalRequest) {
    const template = req.riskLevel === 'critical' ? 'red' : req.riskLevel === 'high' ? 'orange' : req.riskLevel === 'medium' ? 'yellow' : 'blue';

    return {
      schema: '2.0',
      config: {
        update_multi: true,
      },
      header: {
        title: {
          tag: 'plain_text',
          content: 'Antigravity 工具调用审批',
        },
        template,
      },
      elements: [
        {
          tag: 'div',
          element_id: 'ws_info',
          text: {
            tag: 'lark_md',
            content: `**工作区**: \`${req.workspace}\``,
          },
        },
        {
          tag: 'div',
          element_id: 'tool_info',
          text: {
            tag: 'lark_md',
            content: `**工具名**: \`${req.toolName}\``,
          },
        },
        {
          tag: 'div',
          element_id: 'risk_info',
          text: {
            tag: 'lark_md',
            content: `**风险等级**: \`${req.riskLevel}\`\n**原因**: ${req.riskReason}`,
          },
        },
        {
          tag: 'div',
          element_id: 'args_info',
          text: {
            tag: 'lark_md',
            content: `**待执行命令/参数**:\n\`\`\`json\n${req.toolArgsPreview}\n\`\`\``,
          },
        },
        {
          tag: 'button',
          element_id: 'btn_approve',
          text: {
            tag: 'plain_text',
            content: '允许 (Approve)',
          },
          type: 'primary',
          value: {
            type: 'approval_decision',
            action: 'approve',
            approval_id: req.approvalId,
            nonce: req.nonce,
          },
        },
        {
          tag: 'button',
          element_id: 'btn_reject',
          text: {
            tag: 'plain_text',
            content: '拒绝 (Deny)',
          },
          type: 'danger',
          value: {
            type: 'approval_decision',
            action: 'reject',
            approval_id: req.approvalId,
            nonce: req.nonce,
          },
        },
      ],
    };
  }

  private buildProcessedApprovalCard(req: ApprovalRequest) {
    const statusText = req.status === 'approved' 
      ? '🟢 已批准' 
      : req.status === 'rejected' 
      ? '🔴 已拒绝' 
      : req.status === 'expired' 
      ? '⏳ 已过期' 
      : '🚫 已取消';

    return {
      schema: '2.0',
      header: {
        title: {
          tag: 'plain_text',
          content: 'Antigravity 工具调用审批 - 已处理',
        },
        template: 'grey',
      },
      elements: [
        {
          tag: 'div',
          element_id: 'ws_info',
          text: {
            tag: 'lark_md',
            content: `**工作区**: \`${req.workspace}\``,
          },
        },
        {
          tag: 'div',
          element_id: 'tool_info',
          text: {
            tag: 'lark_md',
            content: `**工具名**: \`${req.toolName}\``,
          },
        },
        {
          tag: 'div',
          element_id: 'status_info',
          text: {
            tag: 'lark_md',
            content: `**审批状态**: ${statusText}${req.decidedBy ? ` (由 ${req.decidedBy} 操作)` : ''}`,
          },
        },
      ],
    };
  }

  private buildWorkspaceSessionText(session: Session): string {
    const workspaces = [...getAllowedWorkspaces(), ...getAntigravityProjects()].filter((v, i, a) => a.indexOf(v) === i).slice(0, 5).map((ws, index) => `${index + 1}. ${ws}`).join('\n') || '无可用工作区';
    const conversations = this.getRecentConversations(session.workspace).slice(0, 5).map((item, index) => `${index + 1}. ${item.summary} (${item.id.slice(0, 8)})`).join('\n') || '暂无历史会话';
    return `当前工作区: ${session.workspace}\n当前会话: ${session.conversationId || '新建会话'}\n\n可用工作区:\n${workspaces}\n\n最近会话:\n${conversations}`;
  }

  private applyWorkspaceSessionSwitch(scope: string, selectedWorkspace?: string, selectedSession?: string) {
    const session = sessionManager.getSession(scope);
    if (!session) {
      return {
        toast: { type: 'error', content: '会话不存在' },
      };
    }

    if (selectedWorkspace && sessionManager.isWorkspaceLocked(selectedWorkspace, scope)) {
      return {
        toast: { type: 'error', content: '工作区已被其他运行中的会话锁定，请稍后再试' },
      };
    }

    if (selectedWorkspace) {
      session.workspace = selectedWorkspace;
    }

    if (selectedSession) {
      session.conversationId = selectedSession === 'new' ? null : selectedSession;
    }

    sessionManager.saveSessions();

    return {
      toast: {
        type: 'success',
        content: `切换成功：${path.basename(session.workspace)} / ${session.conversationId ? session.conversationId.slice(0, 8) : '新建会话'}`,
      },
    };
  }

  private buildListCard(session: Session) {
    const allowed = Array.from(new Set([session.workspace, this.config.agent.defaultWorkspace, ...getAllowedWorkspaces(), ...getAntigravityProjects()].filter(Boolean)));
    const workspaceOptions = allowed.map(ws => {
      const basename = path.basename(ws);
      return {
        text: {
          tag: 'plain_text',
          content: basename === '' || basename === '/' ? ws : basename,
        },
        value: ws,
      };
    });

    const recent = this.getRecentConversations(session.workspace);
    const sessionOptions = [
      {
        text: {
          tag: 'plain_text',
          content: '🆕 新建会话 (开始新任务)',
        },
        value: 'new',
      },
    ];

    const currentConvId = session.conversationId;
    if (currentConvId) {
      const match = recent.find(r => r.id === currentConvId);
      const text = match ? `⏳ 当前会话 (${match.summary})` : `⏳ 当前会话 (${currentConvId.slice(0, 8)})`;
      sessionOptions.push({
        text: {
          tag: 'plain_text',
          content: text,
        },
        value: currentConvId,
      });
    }

    for (const r of recent) {
      if (r.id !== currentConvId) {
        sessionOptions.push({
          text: {
            tag: 'plain_text',
            content: `💬 ${r.summary}`,
          },
          value: r.id,
        });
      }
    }

    const wsBasename = path.basename(session.workspace);
    const wsDisplay = wsBasename === '' || wsBasename === '/' ? session.workspace : wsBasename;
    const currentSessionValue = session.conversationId || 'new';

    return {
      schema: '2.0',
      config: {
        update_multi: true,
      },
      header: {
        title: {
          tag: 'plain_text',
          content: '切换工作区与会话',
        },
        template: 'blue',
      },
      body: {
        elements: [
        {
          tag: 'form',
          name: 'switch_session_form',
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: '切到哪个工作区 / 会话？',
              },
            },
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: '**工作区**',
              },
            },
            {
              tag: 'select_static',
              name: 'workspace',
              placeholder: {
                tag: 'plain_text',
                content: wsDisplay,
              },
              initial_option: session.workspace,
              options: workspaceOptions.slice(0, 20),
            },
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: '**会话**',
              },
            },
            {
              tag: 'select_static',
              name: 'session',
              placeholder: {
                tag: 'plain_text',
                content: session.conversationId ? session.conversationId.slice(0, 8) : '新建会话',
              },
              initial_option: currentSessionValue,
              options: sessionOptions.slice(0, 20),
            },
            {
              tag: 'hr',
            },
            {
              tag: 'column_set',
              flex_mode: 'flow',
              horizontal_spacing: 'small',
              columns: [
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'cancel_btn',
                      text: {
                        tag: 'plain_text',
                        content: '取消',
                      },
                      behaviors: [{ type: 'callback', value: { type: 'switch_session_cancel', scope: session.scope } }],
                    },
                  ],
                },
                {
                  tag: 'column',
                  width: 'auto',
                  elements: [
                    {
                      tag: 'button',
                      name: 'submit_btn',
                      text: {
                        tag: 'plain_text',
                        content: '切换',
                      },
                      type: 'primary',
                      form_action_type: 'submit',
                      behaviors: [{ type: 'callback', value: { type: 'switch_session_confirm', scope: session.scope } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        ],
      },
    };
  }

  private summarizeConversationInput(content: string): string {
    const userMessageMatch = content.match(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/i);
    const userRequestMatch = content.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i);
    const raw = userMessageMatch?.[1] || userRequestMatch?.[1] || content;
    const cleaned = raw
      .replace(/<bridge_context>[\s\S]*?<\/bridge_context>/gi, '')
      .replace(/<bridge_instructions>[\s\S]*?<\/bridge_instructions>/gi, '')
      .replace(/<recent_messages>[\s\S]*?<\/recent_messages>/gi, '')
      .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '')
      .replace(/<ADDITIONAL_METADATA>[\s\S]*/gi, '')
      .replace(/用户发送了一条包含图片的富文本消息。请直接查看并理解这些本地图片，然后回答用户。/g, '')
      .replace(/用户附带文字：/g, '')
      .replace(/图片路径：[\s\S]*/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();

    return cleaned;
  }

  private getRecentConversations(workspace?: string): Array<{ id: string; summary: string }> {
    try {
      const brainDir = getBrainDir(workspace);
      if (!fs.existsSync(brainDir)) return [];

      const files = fs.readdirSync(brainDir);
      const conversations: Array<{ id: string; summary: string; mtime: number }> = [];

      for (const file of files) {
        if (file.startsWith('.')) continue;
        const transcriptPath = path.join(brainDir, file, '.system_generated', 'logs', 'transcript.jsonl');
        if (fs.existsSync(transcriptPath)) {
          const stat = fs.statSync(transcriptPath);
          let summary = '';
          try {
            const content = fs.readFileSync(transcriptPath, 'utf8');
            const lines = content.split('\n');
            for (const line of lines) {
              if (!line.trim()) continue;
              const parsed = JSON.parse(line);
              if (parsed.type === 'USER_INPUT' && parsed.content) {
                summary = this.summarizeConversationInput(parsed.content);
                if (summary) break;
              }
            }
          } catch (e) {
            // Ignore
          }
          conversations.push({
            id: file,
            summary: summary || `会话 ${file.slice(0, 8)}`,
            mtime: stat.mtimeMs,
          });
        }
      }

      return conversations
        .sort((a, b) => b.mtime - a.mtime)
        .slice(0, 10)
        .map(c => ({
          id: c.id,
          summary: c.summary.length > 40 ? c.summary.slice(0, 40) + '...' : c.summary,
        }));
    } catch (err: any) {
      logger.error('lark.get_recent_conversations_error', err.message);
      return [];
    }
  }
}


