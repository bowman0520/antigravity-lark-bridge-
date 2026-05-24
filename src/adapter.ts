import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { redactSecrets } from './security';
import { ResolvedConfig } from './config';
import { logger } from './logger';
import { sessionManager } from './session';
import { getBrainDir } from './workspace';
import { AGENT_LOG_DIR, getAntigravityLastConversationsFile } from './paths';
import { AgentEvent } from './card';

export interface AgentInput {
  scope: string;        // 会话 scope (p2p / chat / topic)
  workspace: string;    // 本地工作区路径
  prompt: string;       // 用户指令
  sessionId?: string;   // 可选会话恢复 ID
  timeoutMs?: number;
}

export interface AgentRunHandle {
  promise: Promise<string>;
  conversationId: string | null;
  pid: number | null;
  startedAt: number;
  isRunning: () => boolean;
  stop: () => Promise<void>;
}

const ALLOWED_STEP_TYPES = new Set<string>([
  'PLANNER_RESPONSE',
  'RUN_COMMAND',
  'VIEW_FILE',
  'WRITE_TO_FILE',
  'REPLACE_FILE_CONTENT',
  'MULTI_REPLACE_FILE_CONTENT',
  'GREP_SEARCH',
  'LIST_DIR',
  'LIST_DIRECTORY',
  'SEARCH_WEB',
  'READ_URL_CONTENT',
  'INVOKE_SUBAGENT',
  'SEND_MESSAGE',
  'MANAGE_SUBAGENTS',
  'MANAGE_TASK',
  'SCHEDULE',
  'ASK_PERMISSION',
  'ASK_QUESTION',
  'GENERATE_IMAGE',
]);

const TRANSCRIPT_SIZE_WARN_THRESHOLD = 5 * 1024 * 1024;

function getTranscriptPath(id: string): string {
  return path.join(getBrainDir(), id, '.system_generated', 'logs', 'transcript.jsonl');
}

function getInitialMaxStepIndex(id: string): number {
  const transcriptPath = getTranscriptPath(id);
  if (fs.existsSync(transcriptPath)) {
    try {
      const rawContent = fs.readFileSync(transcriptPath, 'utf8');
      const rawLines = rawContent.split('\n');
      let maxIndex = -1;
      for (const line of rawLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const data = JSON.parse(trimmed);
          if (typeof data.step_index === 'number') {
            maxIndex = Math.max(maxIndex, data.step_index);
          }
        } catch (e) {}
      }
      return maxIndex;
    } catch (err) {
      logger.warn('Failed to read transcript for initial max step index', { error: err });
    }
  }
  return -1;
}

function getBaselineBytes(id: string): number {
  const transcriptPath = getTranscriptPath(id);
  if (!fs.existsSync(transcriptPath)) return 0;
  try {
    return fs.statSync(transcriptPath).size;
  } catch {
    return 0;
  }
}

export function runAgent(
  input: AgentInput,
  config: ResolvedConfig,
  onEvent: (evt: AgentEvent) => void
): AgentRunHandle {
  const args: string[] = [...(config.agent.args || [])];
  const runLogPath = buildRunLogPath(input.scope);
  args.push('--log-file', runLogPath);
  
  if (input.sessionId) {
    args.push('--conversation', input.sessionId, '--print', input.prompt);
  } else {
    args.push('--print', input.prompt);
  }

  const timeoutMs = input.timeoutMs || 60000;

  logger.info('agent.spawn', { command: config.agent.command, args, cwd: input.workspace, timeoutMs });

  const childEnv = { ...process.env };
  if (!childEnv.LANG) {
    childEnv.LANG = 'zh_CN.UTF-8';
  }
  if (!childEnv.LC_ALL) {
    childEnv.LC_ALL = 'zh_CN.UTF-8';
  }
  if (!childEnv.LC_CTYPE) {
    childEnv.LC_CTYPE = 'zh_CN.UTF-8';
  }

  const child = spawn(config.agent.command, args, {
    cwd: input.workspace,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (typeof child.stdout?.setEncoding === 'function') {
    child.stdout.setEncoding('utf8');
  }
  if (typeof child.stderr?.setEncoding === 'function') {
    child.stderr.setEncoding('utf8');
  }

  let conversationId: string | null = input.sessionId || null;
  let lastPlannerResponse = '';
  let baselineBytes = 0;
  let lastReadOffset = 0;
  let initialMaxStepIndex = -1;

  if (conversationId) {
    baselineBytes = getBaselineBytes(conversationId);
    lastReadOffset = baselineBytes;
    initialMaxStepIndex = getInitialMaxStepIndex(conversationId);
    if (baselineBytes > TRANSCRIPT_SIZE_WARN_THRESHOLD) {
      logger.warn('agent.transcript_oversized', {
        scope: input.scope,
        conversationId,
        bytes: baselineBytes,
        threshold: TRANSCRIPT_SIZE_WARN_THRESHOLD,
        hint: 'consider /new to start a fresh conversation',
      });
    }
  }

  const processedStepIndices = new Set<number>();
  const seenToolCallKeys = new Set<string>();
  let pollInterval: NodeJS.Timeout | null = null;
  let timeoutId: NodeJS.Timeout | null = null;
  let isStopped = false;
  let isTimedOut = false;
  let isRunning = true;
  let isSettled = false;
  const startedAt = Date.now();

  interface PendingToolCall {
    id: string;
    name: string;
  }
  const pendingToolCalls: PendingToolCall[] = [];

  function mapToolName(raw: string): string {
    const mapping: Record<string, string> = {
      'run_command': 'RunCommand',
      'view_file': 'ViewFile',
      'write_to_file': 'WriteFile',
      'replace_file_content': 'ReplaceFileContent',
      'multi_replace_file_content': 'ReplaceFileContent',
      'grep_search': 'GrepSearch',
      'list_dir': 'ListDir',
      'search_web': 'SearchWeb',
      'read_url_content': 'ReadUrl',
      'invoke_subagent': 'InvokeSubagent',
      'send_message': 'SendMessage',
      'manage_subagents': 'ManageSubagents',
      'manage_task': 'ManageTask',
      'schedule': 'Schedule',
      'ask_permission': 'AskPermission',
      'ask_question': 'AskQuestion',
      'generate_image': 'GenerateImage',
    };
    return mapping[raw] || raw;
  }

  const handle: AgentRunHandle = {
    promise: new Promise<string>((resolve, reject) => {
      let stdoutBuffer = '';
      let stderrBuffer = '';
      timeoutId = setTimeout(() => {
        isTimedOut = true;
        isRunning = false;
        logger.warn('agent.timeout', { scope: input.scope, timeoutMs });
        child.kill('SIGTERM');
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch (e) {}
        }, 2000);
      }, timeoutMs);

      child.stdout.on('data', (chunk) => {
        const str = chunk.toString();
        stdoutBuffer += str;

        if (!conversationId) {
          // Try to extract conversationId
          const matchedId = extractConversationId(stdoutBuffer);
          if (matchedId) {
            rememberConversationId(matchedId);
          }
        }
      });

      child.stderr.on('data', (chunk) => {
        stderrBuffer += chunk.toString();
      });

      child.on('error', (err) => {
        if (isSettled) return;
        isSettled = true;
        isRunning = false;
        cleanup();
        reject(err);
      });

      const settle = (code: number | null, signal?: NodeJS.Signals | null) => {
        if (isSettled) return;
        isSettled = true;
        isRunning = false;
        cleanup();
        // Give one final poll to ensure we get any final logs
        if (conversationId) {
          pollTranscript(conversationId);
        } else {
          const discoveredId = discoverConversationId(input.workspace, startedAt, runLogPath);
          if (discoveredId) {
            rememberConversationId(discoveredId);
            pollTranscript(discoveredId);
          }
        }

        const runLog = readTextIfExists(runLogPath);
        const cliFailure = detectCliFailure(`${stderrBuffer}\n${stdoutBuffer}\n${runLog}`);
        const resolvedText = lastPlannerResponse || stdoutBuffer.trim();

        if (isStopped) {
          reject(new Error('Task cancelled by user /stop command.'));
        } else if (isTimedOut) {
          reject(new Error(`Antigravity CLI timed out after ${Math.round(timeoutMs / 1000)} seconds.`));
        } else if (cliFailure) {
          reject(new Error(cliFailure));
        } else if (code !== 0) {
          const exitReason = code === null ? `signal ${signal || 'unknown'}` : `code ${code}`;
          reject(new Error(`Agent process exited with ${exitReason}. Stderr: ${stderrBuffer.trim()}`));
        } else {
          resolve(resolvedText || '任务执行完毕，但未返回文本响应。');
        }
      };

      // Resolve on exit as well as close. Some CLI tools leave inherited stdio
      // open through helper processes, which can prevent `close` from firing.
      child.on('exit', settle);
      child.on('close', settle);
    }),
    conversationId,
    pid: child.pid || null,
    startedAt,
    isRunning: () => isRunning,
    stop: async () => {
      isStopped = true;
      isRunning = false;
      cleanup();
      child.kill('SIGTERM');
      setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (e) {}
      }, 2000);
    },
  };

  // If sessionId was already known, start polling immediately
  if (conversationId) {
    startPollingTranscript(conversationId);
  }

  function rememberConversationId(id: string) {
    if (!id || conversationId === id) return;
    conversationId = id;
    handle.conversationId = id;
    sessionManager.setConversationId(input.scope, id);
    logger.info('agent.conversation_identified', { scope: input.scope, conversationId: id });
    if (initialMaxStepIndex === -1) {
      initialMaxStepIndex = getInitialMaxStepIndex(id);
    }
    if (baselineBytes === 0 && lastReadOffset === 0) {
      baselineBytes = getBaselineBytes(id);
      lastReadOffset = baselineBytes;
    }
    startPollingTranscript(id);
  }

  function startPollingTranscript(id: string) {
    if (pollInterval) return;
    pollInterval = setInterval(() => {
      pollTranscript(id);
    }, 1000);
  }

  function pollTranscript(id: string) {
    const transcriptPath = getTranscriptPath(id);

    if (!fs.existsSync(transcriptPath)) {
      return;
    }

    let chunk = '';
    try {
      const stat = fs.statSync(transcriptPath);
      if (stat.size < lastReadOffset) {
        lastReadOffset = 0;
        baselineBytes = 0;
      }
      if (stat.size === lastReadOffset) {
        return;
      }
      const fd = fs.openSync(transcriptPath, 'r');
      try {
        const buf = Buffer.alloc(stat.size - lastReadOffset);
        fs.readSync(fd, buf, 0, buf.length, lastReadOffset);
        chunk = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
      lastReadOffset = stat.size;
    } catch (err: any) {
      logger.error('agent.transcript_poll_error', err.message);
      return;
    }

    const lines = chunk.split('\n');
    const completeLines = lines.slice(0, -1);
    let trailing = lines[lines.length - 1] || '';
    if (trailing.length > 0) {
      lastReadOffset -= Buffer.byteLength(trailing, 'utf8');
    }

    for (const line of completeLines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let data: any;
      try {
        data = JSON.parse(trimmed);
      } catch (err) {
        break;
      }

      const stepCreatedAt = data.created_at ? new Date(data.created_at).getTime() : 0;
      if (stepCreatedAt && stepCreatedAt < startedAt - 5000) {
        continue;
      }

      const stepIdx = Number(data.step_index);
      if (!isNaN(stepIdx) && stepIdx <= initialMaxStepIndex) {
        continue;
      }

      const type = String(data.type || '').toUpperCase();
      if (!ALLOWED_STEP_TYPES.has(type)) {
        continue;
      }

      if (type === 'PLANNER_RESPONSE') {
        if (processedStepIndices.has(stepIdx)) continue;
        processedStepIndices.add(stepIdx);

        if (data.thinking) {
          onEvent({
            type: 'thinking',
            delta: redactSecrets(data.thinking),
          });
        }

        if (data.tool_calls && Array.isArray(data.tool_calls)) {
          data.tool_calls.forEach((tc: any, tcIdx: number) => {
            const toolId = `${stepIdx}-${tcIdx}`;
            const dedupKey = `${id}:${toolId}:${tc.name}`;
            if (seenToolCallKeys.has(dedupKey)) return;
            seenToolCallKeys.add(dedupKey);
            const mappedName = mapToolName(tc.name);
            pendingToolCalls.push({ id: toolId, name: tc.name });
            onEvent({
              type: 'tool_use',
              id: toolId,
              name: mappedName,
              input: tc.args,
            });
          });
        }

        if (data.content && (!data.tool_calls || data.tool_calls.length === 0)) {
          lastPlannerResponse = redactSecrets(data.content);
          onEvent({
            type: 'text',
            delta: lastPlannerResponse,
          });
        }
      } else {
        const rawTypeName = type.toLowerCase().replace(/_/g, '');
        const matchIdx = pendingToolCalls.findIndex((t) => {
          const mappedName = t.name.toLowerCase().replace(/_/g, '');
          return (
            mappedName === rawTypeName ||
            (mappedName === 'listdir' && rawTypeName === 'listdirectory') ||
            (mappedName === 'replacefilecontent' && rawTypeName === 'replacefilecontent') ||
            (mappedName === 'multireplacefilecontent' && rawTypeName === 'multireplacefilecontent') ||
            (mappedName === 'writetofile' && rawTypeName === 'writetofile')
          );
        });

        if (matchIdx !== -1) {
          const toolCall = pendingToolCalls[matchIdx];
          pendingToolCalls.splice(matchIdx, 1);
          const resultKey = `${id}:result:${toolCall.id}`;
          if (seenToolCallKeys.has(resultKey)) continue;
          seenToolCallKeys.add(resultKey);
          onEvent({
            type: 'tool_result',
            id: toolCall.id,
            output: data.content || '',
            isError: data.status === 'ERROR',
          });
        }
      }
    }
  }

  function cleanup() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  return handle;
}

function buildRunLogPath(scope: string): string {
  try {
    fs.mkdirSync(AGENT_LOG_DIR, { recursive: true });
  } catch (err) {
    // If this fails, let the CLI try the path and surface its own error.
  }
  const safeScope = scope.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
  return path.join(AGENT_LOG_DIR, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safeScope}.log`);
}

function readTextIfExists(filePath: string): string {
  try {
    if (!fs.existsSync(filePath)) return '';
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return '';
  }
}

function extractConversationId(text: string): string | null {
  const patterns = [
    /"conversationId"\s*:\s*"([^"]+)"/,
    /"recipientId"\s*:\s*"([^"]+)"/,
    /\bconversation=([0-9a-f]{8}-[0-9a-f-]{27,})\b/i,
    /\bCreated conversation\s+([0-9a-f]{8}-[0-9a-f-]{27,})\b/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1];
  }
  return null;
}

function discoverConversationId(workspace: string, startedAt: number, runLogPath: string): string | null {
  const fromLog = extractConversationId(readTextIfExists(runLogPath));
  if (fromLog) return fromLog;

  const fromCache = readConversationIdFromCache(workspace, startedAt);
  if (fromCache) return fromCache;

  return findNewestTranscriptConversation(startedAt);
}

function readConversationIdFromCache(workspace: string, startedAt: number): string | null {
  const cachePath = getAntigravityLastConversationsFile();
  try {
    if (!fs.existsSync(cachePath)) return null;
    const stat = fs.statSync(cachePath);
    if (stat.mtimeMs + 5000 < startedAt) return null;

    const parsed = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Record<string, string>;
    const id = parsed[workspace];
    return typeof id === 'string' && id ? id : null;
  } catch (err) {
    return null;
  }
}

function findNewestTranscriptConversation(startedAt: number): string | null {
  const brainDir = getBrainDir();
  try {
    if (!fs.existsSync(brainDir)) return null;
    let best: { id: string; mtimeMs: number } | null = null;

    for (const id of fs.readdirSync(brainDir)) {
      if (id.startsWith('.')) continue;
      const transcriptPath = path.join(brainDir, id, '.system_generated', 'logs', 'transcript.jsonl');
      if (!fs.existsSync(transcriptPath)) continue;
      const stat = fs.statSync(transcriptPath);
      if (stat.mtimeMs + 5000 < startedAt) continue;
      if (!best || stat.mtimeMs > best.mtimeMs) {
        best = { id, mtimeMs: stat.mtimeMs };
      }
    }

    return best?.id || null;
  } catch (err) {
    return null;
  }
}

function detectCliFailure(text: string): string | null {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  const quotaMatch = normalized.match(/RESOURCE_EXHAUSTED.*?(Resets in [^.:]+[.:]?)/i);
  if (quotaMatch) {
    return `Antigravity 模型额度已耗尽：${quotaMatch[0].replace(/:$/, '')}`;
  }

  const authMatch = normalized.match(/You are not logged into Antigravity/i);
  const authRecovered =
    /silent auth succeeded/i.test(normalized) ||
    /OAuth: authenticated successfully/i.test(normalized) ||
    /ChainedAuth: authenticated via keyring/i.test(normalized);
  if (authMatch && !authRecovered) {
    return 'Antigravity 当前未登录，CLI 无法获取模型授权。请先打开 Antigravity 或重新登录后再试。';
  }

  const timeoutMatch = normalized.match(/timed out waiting for response/i);
  if (timeoutMatch) {
    return 'Antigravity CLI 等待模型响应超时。';
  }

  const genericError = normalized.match(/(?:agent executor error|print mode error|print mode failed|failed to stream generate content)[:：]\s*(.{1,500})/i);
  if (genericError?.[1]) {
    return `Antigravity CLI 报错：${genericError[1]}`;
  }

  return null;
}
