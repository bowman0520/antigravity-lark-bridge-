export const DEFAULT_HOOK_PAYLOAD_LIMIT_BYTES = 512 * 1024;
export const DEFAULT_FORWARDED_HOOK_LIMIT_BYTES = 64 * 1024;
export const DEFAULT_AGENT_PROMPT_LIMIT_CHARS = 12000;

export function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function truncateMiddle(text: string, maxChars: number, label = 'content'): string {
  if (text.length <= maxChars) return text;
  if (maxChars < 80) return text.slice(0, maxChars);

  const marker = `\n... [${label} truncated: ${text.length - maxChars} chars omitted] ...\n`;
  const remaining = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(remaining * 0.7);
  const tail = remaining - head;
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}

export function buildPayloadTooLargeDecision(bytes: number, maxBytes: number) {
  return {
    decision: 'deny',
    reason:
      `Tool payload is ${bytes} bytes, above the ${maxBytes} byte bridge limit. ` +
      'Narrow the request, read files in 50-200 line chunks, avoid large directories, or limit command output with head/tail.',
  };
}

export function compactHookPayload(input: string, maxBytes = DEFAULT_FORWARDED_HOOK_LIMIT_BYTES): string {
  if (byteLength(input) <= maxBytes) return input;

  let parsed: any = null;
  try {
    parsed = JSON.parse(input);
  } catch (err) {
    return JSON.stringify({
      truncated: true,
      originalBytes: byteLength(input),
      preview: truncateMiddle(input, Math.min(8000, Math.floor(maxBytes / 2)), 'hook payload'),
    });
  }

  const compact = {
    truncated: true,
    originalBytes: byteLength(input),
    toolName: parsed?.toolCall?.name || parsed?.tool_name || parsed?.name || parsed?.tool,
    conversationId: parsed?.conversationId,
    stepIdx: parsed?.stepIdx ?? parsed?.step_index,
    status: parsed?.status,
    error: parsed?.error,
    preview: truncateMiddle(JSON.stringify(parsed, null, 2), Math.min(8000, Math.floor(maxBytes / 2)), 'hook payload'),
  };

  return JSON.stringify(compact);
}

export function limitAgentPrompt(prompt: string, maxChars = DEFAULT_AGENT_PROMPT_LIMIT_CHARS): {
  prompt: string;
  truncated: boolean;
  originalChars: number;
} {
  const trimmed = prompt.trim();
  if (trimmed.length <= maxChars) {
    return { prompt: trimmed, truncated: false, originalChars: trimmed.length };
  }

  return {
    prompt:
      truncateMiddle(trimmed, maxChars, 'prompt') +
      '\n\n注意：上面的用户输入已被 bridge 自动截断，以避免 Antigravity IPC payload 过大。请基于保留内容作答；如信息不足，请要求用户拆分任务。',
    truncated: true,
    originalChars: trimmed.length,
  };
}
