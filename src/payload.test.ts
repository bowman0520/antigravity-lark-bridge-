import {
  buildPayloadTooLargeDecision,
  byteLength,
  compactHookPayload,
  limitAgentPrompt,
} from './payload';

describe('Payload helpers', () => {
  test('compactHookPayload preserves key metadata and shrinks large JSON', () => {
    const input = JSON.stringify({
      conversationId: 'conv_1',
      stepIdx: 2,
      toolCall: {
        name: 'view_file',
        args: { Content: 'a'.repeat(80_000) },
      },
    });

    const compacted = compactHookPayload(input, 10_000);
    const parsed = JSON.parse(compacted);

    expect(byteLength(compacted)).toBeLessThan(byteLength(input));
    expect(parsed.truncated).toBe(true);
    expect(parsed.toolName).toBe('view_file');
    expect(parsed.conversationId).toBe('conv_1');
  });

  test('limitAgentPrompt truncates large prompts with a clear note', () => {
    const result = limitAgentPrompt('x'.repeat(20_000), 1000);

    expect(result.truncated).toBe(true);
    expect(result.prompt.length).toBeGreaterThan(1000);
    expect(result.prompt).toContain('自动截断');
  });

  test('buildPayloadTooLargeDecision returns a deny decision', () => {
    const decision = buildPayloadTooLargeDecision(600_000, 512_000);
    expect(decision.decision).toBe('deny');
    expect(decision.reason).toContain('above');
  });
});
