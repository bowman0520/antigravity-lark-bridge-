import * as path from 'path';
import * as os from 'os';

export type AgentEvent =
  | { type: 'system'; sessionId?: string; cwd?: string; model?: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; id: string; output: string; isError: boolean }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number; costUsd?: number }
  | { type: 'done'; sessionId?: string }
  | { type: 'error'; message: string };

export type ToolStatus = 'running' | 'done' | 'error';

export interface ToolEntry {
  id: string;
  name: string;
  input: unknown;
  status: ToolStatus;
  output?: string;
}

export type Block =
  | { kind: 'text'; content: string; streaming: boolean }
  | { kind: 'tool'; tool: ToolEntry };

export type FooterStatus = 'thinking' | 'tool_running' | 'streaming' | null;

export type Terminal = 'running' | 'done' | 'interrupted' | 'error' | 'idle_timeout';

export interface RunState {
  scope?: string;
  blocks: Block[];
  reasoning: {
    content: string;
    active: boolean;
  };
  footer: FooterStatus;
  terminal: Terminal;
  errorMsg?: string;
  idleTimeoutMinutes?: number;
}

const HEADER_SUMMARY_MAX = 80;
const BODY_FIELD_MAX = 600;
const OUTPUT_MAX = 1200;
const BODY_TOTAL_MAX = 2500;
const REASONING_MAX = 1500;
const COLLAPSE_TOOL_THRESHOLD = 3;

export const initialState: RunState = {
  blocks: [],
  reasoning: { content: '', active: false },
  footer: 'thinking',
  terminal: 'running',
};

export function closeStreamingText(blocks: Block[]): Block[] {
  return blocks.map((b) =>
    b.kind === 'text' && b.streaming ? { ...b, streaming: false } : b
  );
}

export function reduce(state: RunState, evt: AgentEvent): RunState {
  switch (evt.type) {
    case 'text': {
      const last = state.blocks[state.blocks.length - 1];
      if (last && last.kind === 'text' && last.streaming) {
        const next: Block = { ...last, content: last.content + evt.delta };
        return {
          ...state,
          blocks: [...state.blocks.slice(0, -1), next],
          reasoning: { ...state.reasoning, active: false },
          footer: 'streaming',
        };
      }
      return {
        ...state,
        blocks: [...state.blocks, { kind: 'text', content: evt.delta, streaming: true }],
        reasoning: { ...state.reasoning, active: false },
        footer: 'streaming',
      };
    }
    case 'thinking': {
      return {
        ...state,
        reasoning: { content: state.reasoning.content + evt.delta, active: true },
        footer: 'thinking',
      };
    }
    case 'tool_use': {
      const tool: ToolEntry = {
        id: evt.id,
        name: evt.name,
        input: evt.input,
        status: 'running',
      };
      return {
        ...state,
        blocks: [...closeStreamingText(state.blocks), { kind: 'tool', tool }],
        reasoning: { ...state.reasoning, active: false },
        footer: 'tool_running',
      };
    }
    case 'tool_result': {
      const blocks = state.blocks.map((b): Block => {
        if (b.kind !== 'tool' || b.tool.id !== evt.id) return b;
        return {
          ...b,
          tool: {
            ...b.tool,
            status: evt.isError ? 'error' : 'done',
            output: evt.output,
          },
        };
      });
      return { ...state, blocks };
    }
    case 'error': {
      return { ...state, terminal: 'error', errorMsg: evt.message, footer: null };
    }
    case 'done': {
      return {
        ...state,
        blocks: closeStreamingText(state.blocks),
        reasoning: { ...state.reasoning, active: false },
        terminal: 'done',
        footer: null,
      };
    }
    default:
      return state;
  }
}

export function markInterrupted(state: RunState): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'interrupted',
    footer: null,
  };
}

export function markIdleTimeout(state: RunState, minutes: number): RunState {
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'idle_timeout',
    footer: null,
    idleTimeoutMinutes: minutes,
  };
}

export function finalizeIfRunning(state: RunState): RunState {
  if (state.terminal !== 'running') return state;
  return {
    ...state,
    blocks: closeStreamingText(state.blocks),
    reasoning: { ...state.reasoning, active: false },
    terminal: 'done',
    footer: null,
  };
}

function toolHeaderText(tool: ToolEntry): string {
  const icon = tool.status === 'done' ? '✅' : tool.status === 'error' ? '❌' : '⏳';
  const summary = summarizeInput(tool.name, tool.input);
  return summary ? `${icon} **${tool.name}** — ${summary}` : `${icon} **${tool.name}**`;
}

function cleanToolOutput(name: string, output: string): string {
  if (!output) return '';

  let cleaned = output.trim();

  // 1. Remove Created At / Completed At lines
  cleaned = cleaned.replace(/^Created At:[^\n]*\n?/im, '');
  cleaned = cleaned.replace(/^Completed At:[^\n]*\n?/im, '');

  cleaned = cleaned.trim();

  // 2. Tool-specific cleaning
  if (name === 'RunCommand') {
    // Remove "The command completed successfully." or "The command failed with..."
    cleaned = cleaned.replace(/^[^\n]*completed successfully\.[^\n]*\n?/im, '');
    cleaned = cleaned.replace(/^[^\n]*failed with exit code[^\n]*\n?/im, '');
    cleaned = cleaned.trim();

    // Remove "Output:" prefix
    cleaned = cleaned.replace(/^Output:\s*/im, '');
    cleaned = cleaned.trim();
  } else if (
    name === 'ViewFile' ||
    name === 'WriteFile' ||
    name === 'ReplaceFileContent' ||
    name === 'MultiReplaceFileContent'
  ) {
    // Remove headers
    cleaned = cleaned.replace(/^File Path:[^\n]*\n?/im, '');
    cleaned = cleaned.replace(/^Total Lines:[^\n]*\n?/im, '');
    cleaned = cleaned.replace(/^Total Bytes:[^\n]*\n?/im, '');
    cleaned = cleaned.replace(/^Showing lines [^\n]*\n?/im, '');

    // Remove instructions
    cleaned = cleaned.replace(
      /^The following code has been modified to include a line number before every line[^\n]*\n?/im,
      ''
    );
    cleaned = cleaned.replace(
      /^Please note that any changes targeting the original code should remove the line number, colon, and leading space\.[^\n]*\n?/im,
      ''
    );

    cleaned = cleaned.trim();

    // Strip line number prefixes if they exist (e.g. "1: {", "12: foo")
    const lines = cleaned.split('\n');
    const hasLineNumbers =
      lines.length > 0 &&
      lines.slice(0, 5).every((line) => /^\s*\d+:\s/.test(line) || line.trim() === '');
    if (hasLineNumbers) {
      cleaned = lines.map((line) => line.replace(/^\s*\d+:\s?/, '')).join('\n');
    }
  }

  return cleaned.trim();
}

function toolBodyMd(tool: ToolEntry): string {
  const parts: string[] = [];
  const inputMd = renderInput(tool);
  if (inputMd) parts.push(inputMd);
  if (tool.output) {
    const cleaned = cleanToolOutput(tool.name, tool.output);
    if (cleaned) {
      const truncated = truncate(cleaned, OUTPUT_MAX);
      if (tool.status === 'error') {
        parts.push(`**Error**\n\`\`\`\n${truncated}\n\`\`\``);
      } else {
        parts.push(`**Output**\n\`\`\`\n${truncated}\n\`\`\``);
      }
    }
  } else if (tool.status === 'running') {
    parts.push('_运行中…_');
  }
  const body = parts.join('\n\n');
  if (body.length <= BODY_TOTAL_MAX) return body;
  return `${body.slice(0, BODY_TOTAL_MAX)}…\n\n_（body 已截断，完整内容请在日志中查询）_`;
}

function shortenPath(p: string): string {
  if (!p) return p;
  const home = os.homedir();
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function summarizeInput(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const pick = (key: string, max = HEADER_SUMMARY_MAX) => {
    const v = input[key];
    if (typeof v !== 'string') return '';
    const oneLine = v.replace(/\s+/g, ' ').trim();
    return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
  };
  switch (name) {
    case 'RunCommand':
      return pick('CommandLine');
    case 'ViewFile':
      return shortenPath(pick('AbsolutePath'));
    case 'WriteFile':
      return shortenPath(pick('TargetFile'));
    case 'ReplaceFileContent':
    case 'MultiReplaceFileContent':
      return shortenPath(pick('TargetFile'));
    case 'ListDir':
      return shortenPath(pick('DirectoryPath'));
    case 'GrepSearch': {
      const pat = pick('Query', 40);
      const pathVal = pick('SearchPath', 30);
      return pathVal ? `${pat} in ${shortenPath(pathVal)}` : pat;
    }
    case 'SearchWeb':
      return pick('query', 60);
    case 'ReadUrl':
      return pick('Url');
    case 'InvokeSubagent':
      return pick('Role') || pick('TypeName');
    case 'SendMessage':
      return pick('Recipient');
    case 'AskPermission': {
      const action = pick('Action');
      const target = pick('Target');
      return `${action} on ${target}`;
    }
    case 'GenerateImage':
      return pick('Prompt');
    default:
      return (
        pick('CommandLine') ||
        pick('TargetFile') ||
        pick('AbsolutePath') ||
        pick('DirectoryPath') ||
        pick('query') ||
        pick('Url') ||
        pick('Prompt') ||
        pick('toolSummary')
      );
  }
}

function renderInput(tool: ToolEntry): string {
  const input = tool.input as any;
  if (!input || typeof input !== 'object') return '';
  const str = (k: string) => (typeof input[k] === 'string' ? input[k] : '');
  switch (tool.name) {
    case 'RunCommand': {
      const cmd = str('CommandLine');
      return cmd ? `**CommandLine**\n\`\`\`bash\n${truncate(cmd, BODY_FIELD_MAX)}\n\`\`\`` : '';
    }
    case 'ViewFile':
    case 'WriteFile':
    case 'ReplaceFileContent':
    case 'MultiReplaceFileContent': {
      const fp = str('AbsolutePath') || str('TargetFile');
      return fp ? `**File** \`${fp}\`` : '';
    }
    case 'ListDir': {
      const dp = str('DirectoryPath');
      return dp ? `**Directory** \`${dp}\`` : '';
    }
    case 'GrepSearch': {
      const lines = [];
      if (str('Query')) lines.push(`**Query** \`${str('Query')}\``);
      if (str('SearchPath')) lines.push(`**SearchPath** \`${str('SearchPath')}\``);
      return lines.join('\n');
    }
    case 'SearchWeb':
      return str('query') ? `**Query** \`${truncate(str('query'), BODY_FIELD_MAX)}\`` : '';
    case 'ReadUrl':
      return str('Url') ? `**URL** ${str('Url')}` : '';
    case 'GenerateImage':
      return str('Prompt') ? `**Prompt** \`${truncate(str('Prompt'), BODY_FIELD_MAX)}\`` : '';
    default:
      return '';
  }
}

function* groupBlocks(blocks: Block[]) {
  let toolBuf: ToolEntry[] = [];
  for (const b of blocks) {
    if (b.kind === 'tool') {
      toolBuf.push(b.tool);
    } else {
      if (toolBuf.length > 0) {
        yield { kind: 'tools', tools: toolBuf } as const;
        toolBuf = [];
      }
      yield { kind: 'text', content: b.content } as const;
    }
  }
  if (toolBuf.length > 0) {
    yield { kind: 'tools', tools: toolBuf } as const;
  }
}

function renderToolGroup(tools: ToolEntry[], finalized: boolean): any[] {
  if (tools.length === 0) return [];
  if (tools.length < COLLAPSE_TOOL_THRESHOLD) {
    return tools.map((t) => toolPanel(t, false));
  }
  if (finalized) {
    return [collapsedToolSummary(tools, true)];
  }
  const prior = tools.slice(0, -1);
  const latest = tools[tools.length - 1];
  const out: any[] = [];
  if (prior.length > 0) out.push(collapsedToolSummary(prior, false));
  if (latest) out.push(toolPanel(latest, true));
  return out;
}

function reasoningPanel(content: string, active: boolean) {
  const title = active ? '🧠 **思考中**' : '🧠 **思考完成，点击查看**';
  return collapsiblePanel({
    title,
    expanded: active,
    border: 'grey',
    body: truncate(content, REASONING_MAX),
  });
}

function toolPanel(tool: ToolEntry, expanded: boolean) {
  return collapsiblePanel({
    title: toolHeaderText(tool),
    expanded,
    border: tool.status === 'error' ? 'red' : 'grey',
    body: toolBodyMd(tool) || '_无输出_',
  });
}

function collapsedToolSummary(tools: ToolEntry[], finalized: boolean) {
  const suffix = finalized ? '（已结束）' : '';
  const title = `☕ **${tools.length} 个工具调用${suffix}**`;
  const headerList = tools.map((t) => `- ${toolHeaderText(t)}`).join('\n');
  return {
    tag: 'collapsible_panel',
    expanded: false,
    header: panelHeader(title),
    border: { color: 'blue', corner_radius: '5px' },
    vertical_spacing: '8px',
    padding: '8px 8px 8px 8px',
    elements: [{ tag: 'markdown', content: headerList, text_size: 'notation' }],
  };
}

function collapsiblePanel(opts: { title: string; expanded: boolean; border: string; body: string }) {
  const panel: any = {
    tag: 'collapsible_panel',
    expanded: opts.expanded,
    header: panelHeader(opts.title),
    vertical_spacing: '8px',
    elements: [{ tag: 'markdown', content: opts.body, text_size: 'notation' }],
  };
  if (opts.expanded) {
    panel.border = { color: opts.border, corner_radius: '5px' };
    panel.padding = '8px 8px 8px 8px';
  }
  return panel;
}

function panelHeader(titleMd: string) {
  return {
    title: { tag: 'markdown', content: titleMd },
    vertical_align: 'center',
    icon: { tag: 'standard_icon', token: 'down-small-ccm_outlined', size: '16px 16px' },
    icon_position: 'follow_text',
    icon_expanded_angle: -180,
  };
}

function markdown(content: string) {
  return { tag: 'markdown', content: toLarkMarkdown(content) };
}

function noteMd(content: string) {
  return { tag: 'markdown', content, text_size: 'notation' };
}

function stopButton(scope?: string) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '⏹ 终止' },
    type: 'danger',
    behaviors: [{ type: 'callback', value: { cmd: 'stop', scope } }],
  };
}

function footerStatus(status: FooterStatus) {
  const text =
    status === 'thinking'
      ? '🧠 正在思考'
      : status === 'tool_running'
      ? '🧰 正在调用工具'
      : '✍️ 正在输出';
  return noteMd(text);
}

function summaryText(state: RunState): string {
  if (state.terminal === 'interrupted') return '已中断';
  if (state.terminal === 'idle_timeout') return '已超时';
  if (state.terminal === 'error') return '出错';
  if (state.terminal === 'done') return '已完成';
  if (state.footer === 'tool_running') return '正在调用工具';
  if (state.footer === 'streaming') return '正在输出';
  return '思考中';
}

export function renderCard(state: RunState): object {
  const elements: any[] = [];
  const finalized = state.terminal !== 'running';

  // 1. Title/Header Template
  let template = 'blue';
  let titleText = 'Antigravity 任务执行中';

  if (state.terminal === 'done') {
    template = 'green';
    titleText = 'Antigravity 本轮回复完成';
  } else if (state.terminal === 'error') {
    template = 'red';
    titleText = 'Antigravity 任务失败';
  } else if (state.terminal === 'interrupted') {
    template = 'grey';
    titleText = 'Antigravity 任务已中断';
  } else if (state.terminal === 'idle_timeout') {
    template = 'grey';
    titleText = 'Antigravity 任务超时已终止';
  }

  // 2. Reasoning
  if (state.reasoning.content) {
    elements.push(reasoningPanel(state.reasoning.content, state.reasoning.active));
  }

  // 3. Blocks
  for (const group of groupBlocks(state.blocks)) {
    if (group.kind === 'text') {
      if (group.content.trim()) {
        elements.push(markdown(group.content));
      }
    } else {
      elements.push(...renderToolGroup(group.tools, finalized));
    }
  }

  // 4. Terminal status notes
  if (state.terminal === 'interrupted') {
    elements.push(noteMd('_⏹ 已被中断_'));
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    elements.push(noteMd(`_⏱ ${mins} 分钟无响应，已自动终止_`));
  } else if (state.terminal === 'error' && state.errorMsg) {
    elements.push(noteMd(`⚠️ agent 失败：${state.errorMsg}`));
  } else if (state.terminal === 'done') {
    const hasText = state.blocks.some((b) => b.kind === 'text' && b.content.trim());
    if (!hasText) {
      if (elements.length === 0) {
        elements.push(noteMd('_（未返回内容）_'));
      } else {
        elements.push(noteMd('⚠️ _Agent 未输出任何直接回复文本。_'));
      }
    }
  }

  // 5. Active controls (running only)
  if (state.terminal === 'running') {
    if (state.footer) elements.push(footerStatus(state.footer));
    elements.push(stopButton(state.scope));
  }

  const card: any = {
    schema: '2.0',
    config: {
      summary: { content: summaryText(state) },
    },
    header: {
      title: {
        tag: 'plain_text',
        content: titleText,
      },
      template,
    },
    body: { elements },
  };

  return card;
}

export function renderText(state: RunState): string {
  const parts: string[] = [];
  for (const block of state.blocks) {
    if (block.kind === 'text') {
      if (block.content.trim()) {
        parts.push(block.content.trim());
      }
    } else {
      parts.push(`> ${toolHeaderText(block.tool)}`);
    }
  }
  if (state.terminal === 'interrupted') {
    parts.push('_⏹ 已被中断_');
  } else if (state.terminal === 'idle_timeout') {
    const mins = state.idleTimeoutMinutes ?? 0;
    parts.push(`_⏱ ${mins} 分钟无响应，已自动终止_`);
  } else if (state.terminal === 'error' && state.errorMsg) {
    parts.push(`⚠️ agent 失败：${state.errorMsg}`);
  } else if (state.terminal === 'running' && state.footer) {
    if (state.footer === 'thinking') parts.push('_🧠 正在思考…_');
    else if (state.footer === 'tool_running') parts.push('_🧰 正在调用工具…_');
    else parts.push('_✍️ 正在输出…_');
  }
  return parts.join('\n\n');
}

export function toLarkMarkdown(markdownText: string): string {
  if (!markdownText) return '';

  const cleanedText = markdownText.replace(/\[([^\]]+)\]\(file:\/\/[^\)]+\)/g, '**$1**');
  const lines = cleanedText.split('\n');
  const processedLines: string[] = [];
  let inTable = false;
  let tableLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTableLine = line.includes('|');

    if (isTableLine) {
      if (!inTable) {
        inTable = true;
      }
      tableLines.push(line);
    } else {
      if (inTable) {
        processedLines.push('```');
        processedLines.push(...tableLines);
        processedLines.push('```');
        tableLines = [];
        inTable = false;
      }

      let processedLine = line;

      // 1. Convert headers (# Header) to bold text
      processedLine = processedLine.replace(/^(#{1,6})\s+(.+)$/, '**$2**');

      // 2. Convert horizontal rules (--- or ***) to divider line
      if (/^[-*]{3,}\s*$/.test(processedLine)) {
        processedLine = '----------------------------------------';
      }

      processedLines.push(processedLine);
    }
  }

  if (inTable && tableLines.length > 0) {
    processedLines.push('```');
    processedLines.push(...tableLines);
    processedLines.push('```');
  }

  return processedLines.join('\n');
}
