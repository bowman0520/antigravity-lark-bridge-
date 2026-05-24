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

export class LarkGateway {
  private client: Lark.Client;
  private wsClient: Lark.WSClient;
  private config: ResolvedConfig;
  private processedMessageIds: Set<string> = new Set();
  private eventDispatcher: Lark.EventDispatcher;
  private promptQueue = new PromptQueue();
  private agentUnavailableUntil = 0;
  private agentUnavailableMessage = '';
  private taskUpdateVersions = new Map<string, number>();
  private finalizedTaskCards = new Set<string>();
  private activeRuns = new Map<string, ActiveRun>();

  constructor(config: ResolvedConfig) {
    this.config = config;

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

    // Identify chat scope
    const scope = message.thread_id
      ? `topic:${chatId}:${message.thread_id}`
      : (message.chat_type === 'p2p' ? `p2p:${chatId}` : `chat:${chatId}`);

    // If group, check mention
    if (message.chat_type === 'group') {
      const isMentioned = message.mentions && message.mentions.some((m: any) => m.id === this.config.lark.appId || m.name === '机器人');
      if (this.config.reply.requireMentionInGroup && !isMentioned) {
        return;
      }
    }

    const session = sessionManager.getOrCreateSession(scope, this.config.agent.defaultWorkspace);

    // Clean text by stripping mentions
    text = text.replace(/<at id="[^"]+">@.*?<\/at>\s*/g, '').trim();
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

    if (this.looksLikeStatusProbe(text)) {
      await this.replyText(msgId, this.buildRuntimeStatusText(scope, session));
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

  private looksLikeStatusProbe(text: string): boolean {
    const normalized = text.replace(/[\s，。！？!?～~…,.]+/g, '').trim();
    if (!normalized) return false;
    if (/^(\?|？)+$/.test(normalized)) return true;
    if (/^(还是)?(不行|没反应|没有反应|卡住了|卡了吗|还在吗|咋没反应|怎么没反应|啥情况|什么情况|无响应|停住了|还没好吗|好了没|好了吗)[啊哦呀呢吗嘛吧]*$/.test(normalized)) return true;
    if (normalized.length <= 16 && /(没反应|没有反应|卡住|无响应|不行|啥情况|什么情况)/.test(normalized)) return true;
    return false;
  }

  private buildRuntimeStatusText(scope: string, session: Session): string {
    const activeRun = this.activeRuns.get(scope);
    if (!activeRun) {
      return `📊 Antigravity Bridge 状态\n\n当前没有正在运行的任务。\n工作区: \`${session.workspace}\`\n会话 ID: \`${session.conversationId || 'none'}\`\n\n如果要开始新上下文，可以发送 /new；如果要诊断连接，可以发送 /status 或 /doctor。`;
    }

    const elapsed = this.formatDuration(Math.max(0, Math.round((Date.now() - activeRun.startedAt) / 1000)));
    const idle = this.formatDuration(Math.max(0, Math.round((Date.now() - activeRun.lastActivityAt) / 1000)));
    const pidText = activeRun.runHandle.pid ? `PID ${activeRun.runHandle.pid}` : 'PID 未知';
    return `📊 Antigravity Bridge 状态\n\n当前任务仍在运行。\n已运行: ${elapsed}\n最近进展: ${idle} 前\n进程: ${pidText}\n工作区: \`${session.workspace}\`\n\n可发送 /stop 终止当前任务，或发送 /new 中断并开启新会话。`;
  }

  private buildContextualAgentPrompt(userPrompt: string, scope: string, senderId: string, session: Session): string {
    const recentContext = session.recentMessages.length > 0
      ? `<recent_messages>\n${session.recentMessages.slice(-8).join('\n')}\n</recent_messages>`
      : '';
    const shortReplyHint = this.isContextDependentReply(userPrompt)
      ? '用户当前消息很短，必须优先结合最近对话判断它是在选择、确认、追问、催办还是要求切换语言；不要把它当成孤立的新任务。'
      : '';
    const conversationText = session.conversationId || 'none';

    return [
      '<bridge_context>',
      'bot_name: 陈陈',
      'channel: feishu',
      `scope: ${scope}`,
      `sender_id: ${senderId}`,
      `workspace: ${session.workspace}`,
      `conversation_id: ${conversationText}`,
      '</bridge_context>',
      '<bridge_instructions>',
      '你叫陈陈，是通过飞书接入的 Antigravity 本地开发助手。',
      '默认使用中文回复，除非用户明确要求其他语言。',
      'bridge_context 是桥接层元数据，只用于理解上下文；不要在回复中复述这些字段。',
      '这是连续飞书会话；如果底层 CLI 没有可用 conversationId，也必须根据 recent_messages 延续上下文。',
      '不要把孤立的数字、同意、继续、用中文、问号、好了没当成全新需求；它们通常是在回应上一轮选项或追问上一轮任务。',
      shortReplyHint,
      '</bridge_instructions>',
      recentContext,
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

    if (this.promptQueue.isActive(scope) || session.status === 'RUNNING' || session.status === 'AWAITING_APPROVAL') {
      const clearedStaleRun = this.clearStaleRunIfNeeded(session, scope);
      if (!clearedStaleRun) {
        const queueSize = this.promptQueue.push({ prompt, scope, msgId, senderId });
        session.pendingQueue = this.promptQueue.snapshot(scope);
        await this.replyText(msgId, `已收到，当前任务还在运行。你的消息已加入队列，前面还有 ${queueSize} 条待处理。需要中断当前任务可发 /stop。`);
        await this.noteQueuedPrompt(session, queueSize);
        return;
      }
    }

    this.promptQueue.unshift({ prompt, scope, msgId, senderId });
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
    }
  }

  private async processPrompt(item: QueuedPrompt) {
    const { prompt, scope, msgId, senderId } = item;
    const session = sessionManager.getOrCreateSession(scope, this.config.agent.defaultWorkspace);
    const rawPrompt = prompt.replace(/^\/(task|long)\s+/, '').trim();
    const contextualPrompt = this.buildContextualAgentPrompt(rawPrompt, scope, senderId, session);
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
        const res = await this.client.im.message.reply({
          path: {
            message_id: msgId,
          },
          data: {
            content: JSON.stringify(card),
            msg_type: 'interactive',
          },
        });
        taskCardMessageId = res?.data?.message_id || '';
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
      sessionManager.appendExchange(scope, rawPrompt, finalResult);
      logger.info('agent.completed', { scope });

      // Ensure final result is in state blocks
      const hasFinalText = state.blocks.some(b => b.kind === 'text' && b.content.includes(finalResult));
      if (!hasFinalText) {
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

  private async patchTaskProgress(cardMessageId: string, state: RunState, version: number, isFinal: boolean) {
    if (!isFinal && this.taskUpdateVersions.get(cardMessageId) !== version) return;
    try {
      if (this.config.reply.mode === 'card') {
        const card = renderCard(state);
        await this.client.im.v1.message.patch({
          path: { message_id: cardMessageId },
          data: { content: JSON.stringify(card) },
        });
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
        body: {
          elements: [
            {
              tag: 'div',
              text: {
                tag: 'lark_md',
                content: formattedText,
              },
            },
          ],
        },
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
      body: {
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
      },
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
      body: {
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
      },
    };
  }

  private buildWorkspaceSessionText(session: Session): string {
    const workspaces = [...getAllowedWorkspaces(), ...getAntigravityProjects()].filter((v, i, a) => a.indexOf(v) === i).slice(0, 5).map((ws, index) => `${index + 1}. ${ws}`).join('\n') || '无可用工作区';
    const conversations = this.getRecentConversations().slice(0, 5).map((item, index) => `${index + 1}. ${item.summary} (${item.id.slice(0, 8)})`).join('\n') || '暂无历史会话';
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

    const recent = this.getRecentConversations();
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

  private getRecentConversations(): Array<{ id: string; summary: string }> {
    try {
      const brainDir = getBrainDir();
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


