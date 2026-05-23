import { evaluatePolicy, createApprovalRequest, getApproval, updateApprovalStatus } from './approval';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

describe('Approval and Policy Engine Tests', () => {
  const ws = path.join(os.tmpdir(), 'test-ws');
  const allowed = [ws];

  beforeAll(() => {
    if (!fs.existsSync(ws)) {
      fs.mkdirSync(ws, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(ws)) {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  });

  test('evaluatePolicy auto-allows read-only tools and safe commands', () => {
    // Read only tool
    const r1 = evaluatePolicy('view_file', { AbsolutePath: path.join(ws, 'index.js') }, ws, allowed);
    expect(r1.decision).toBe('allow');
    expect(r1.riskLevel).toBe('low');

    // Safe command
    const r2 = evaluatePolicy('run_command', { CommandLine: 'git status', Cwd: ws }, ws, allowed);
    expect(r2.decision).toBe('allow');
  });

  test('evaluatePolicy denies escaping paths and unsafe commands', () => {
    // Escaping path
    const r1 = evaluatePolicy('view_file', { AbsolutePath: '/etc/passwd' }, ws, allowed);
    expect(r1.decision).toBe('deny');

    // Sudo command
    const r2 = evaluatePolicy('run_command', { CommandLine: 'sudo rm -rf /', Cwd: ws }, ws, allowed);
    expect(r2.decision).toBe('deny');
  });

  test('evaluatePolicy requires approval for write or generic commands', () => {
    // Write tool
    const r1 = evaluatePolicy('write_to_file', { TargetFile: path.join(ws, 'new.js') }, ws, allowed);
    expect(r1.decision).toBe('require_approval');
    expect(r1.riskLevel).toBe('high');

    // Generic command
    const r2 = evaluatePolicy('run_command', { CommandLine: 'npm install', Cwd: ws }, ws, allowed);
    expect(r2.decision).toBe('require_approval');
    expect(r2.riskLevel).toBe('medium');
  });

  test('evaluatePolicy blocks payload-heavy read patterns', () => {
    const fullLogRead = evaluatePolicy(
      'view_file',
      { AbsolutePath: path.join(ws, 'logs', 'run.jsonl') },
      ws,
      allowed
    );
    expect(fullLogRead.decision).toBe('deny');
    expect(fullLogRead.reason).toContain('Payload guard');

    const boundedLogRead = evaluatePolicy(
      'view_file',
      { AbsolutePath: path.join(ws, 'logs', 'run.jsonl'), StartLine: 10, EndLine: 60 },
      ws,
      allowed
    );
    expect(boundedLogRead.decision).toBe('allow');

    const broadSearch = evaluatePolicy('grep_search', { SearchPath: ws, Query: 'error' }, ws, allowed);
    expect(broadSearch.decision).toBe('deny');

    const noisyCommand = evaluatePolicy('run_command', { CommandLine: 'find . -name "*.ts"', Cwd: ws }, ws, allowed);
    expect(noisyCommand.decision).toBe('deny');

    const limitedCommand = evaluatePolicy('run_command', { CommandLine: 'find . -name "*.ts" | head -n 100', Cwd: ws }, ws, allowed);
    expect(limitedCommand.decision).toBe('require_approval');
  });

  test('createApprovalRequest and updateApprovalStatus', () => {
    const req = createApprovalRequest({
      sessionId: 'sess_123',
      conversationId: 'conv_123',
      toolCallId: 'tc_123',
      stepIdx: 1,
      scope: 'p2p:123',
      chatId: 'oc_123',
      messageId: 'om_123',
      workspace: ws,
      toolName: 'run_command',
      toolArgs: { CommandLine: 'npm test' },
      riskLevel: 'medium',
      riskReason: 'Test run',
      timeoutSeconds: 60,
    });

    expect(req.approvalId).toBeDefined();
    expect(req.nonce).toBeDefined();
    expect(req.status).toBe('pending');

    const fetched = getApproval(req.approvalId);
    expect(fetched).toBeDefined();
    expect(fetched?.toolCallId).toBe('tc_123');

    updateApprovalStatus(req.approvalId, 'approved', 'ou_admin');
    const updated = getApproval(req.approvalId);
    expect(updated?.status).toBe('approved');
    expect(updated?.decidedBy).toBe('ou_admin');
  });

  test('createApprovalRequest truncates large tool args for storage and card preview', () => {
    const req = createApprovalRequest({
      sessionId: 'sess_large',
      conversationId: 'conv_large',
      toolCallId: 'tc_large',
      stepIdx: 1,
      scope: 'p2p:123',
      chatId: 'oc_123',
      messageId: 'om_123',
      workspace: ws,
      toolName: 'run_command',
      toolArgs: { CommandLine: 'echo large', output: 'a'.repeat(80_000) },
      riskLevel: 'medium',
      riskReason: 'Large arg test',
      timeoutSeconds: 60,
    });

    expect(req.toolArgsPreview.length).toBeLessThan(13_000);
    expect(req.toolArgsPreview).toContain('truncated');
    expect(req.toolArgs.truncated).toBe(true);
  });
});
