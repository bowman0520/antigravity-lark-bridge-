import { runAgent } from './adapter';
import { ResolvedConfig } from './config';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EventEmitter } from 'events';

jest.mock('child_process');
jest.mock('fs', () => {
  const actualFs = jest.requireActual('fs');
  return {
    ...actualFs,
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
    readdirSync: jest.fn(),
  };
});

describe('Agent Adapter Tests', () => {
  let mockChild: any;
  const actualFs = jest.requireActual('fs');

  const mockConfig: ResolvedConfig = {
    lark: {
      appId: 'app_123',
      appSecret: 'sec_123',
      encryptKey: 'enc_123',
      verificationToken: 'tok_123',
      domain: 'feishu',
    },
    agent: {
      defaultWorkspace: '/tmp',
      command: 'antigravity',
      args: [],
      mode: 'auto',
    },
    ipc: {
      host: '127.0.0.1',
      port: 3999,
      allowRandomPortOnConflict: false,
      approvalTimeoutSeconds: 60,
      maxPayloadSizeKb: 10240,
      hookPayloadLimitBytes: 512 * 1024,
      forwardedHookLimitBytes: 64 * 1024,
    },
    media: {
      autoCompressImages: true,
      imageMaxWidthPx: 1600,
      imageJpegQuality: 82,
      imageMaxBytes: 1024 * 1024,
      maxImagesPerPrompt: 3,
      maxPromptChars: 12000,
    },
    access: {
      allowedUsers: [],
      allowedChats: [],
      admins: [],
    },
    reply: {
      requireMentionInGroup: true,
      mode: 'card',
      messageFlushIntervalMs: 1200,
      maxMessageChars: 3500,
    },
    security: {
      redactBeforeSend: true,
      debugRawLogs: false,
      groupWriteRequiresApproval: true,
      p2pWriteRequiresApproval: false,
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();

    mockChild = new EventEmitter() as any;
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    mockChild.kill = jest.fn();

    (spawn as jest.Mock).mockReturnValue(mockChild);

    // Default fs implementation redirects to actual fs
    (fs.existsSync as jest.Mock).mockImplementation((p) => {
      if (typeof p === 'string' && p.endsWith('transcript.jsonl')) {
        return false;
      }
      return actualFs.existsSync(p);
    });
    (fs.readFileSync as jest.Mock).mockImplementation((p, opt) => actualFs.readFileSync(p, opt));
    (fs.readdirSync as jest.Mock).mockImplementation(() => []);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('runAgent spawns process and parses conversation ID', async () => {
    const onEvent = jest.fn();
    const handle = runAgent(
      {
        scope: 'p2p:user_1',
        workspace: '/tmp',
        prompt: 'hello world',
      },
      mockConfig,
      onEvent
    );

    expect(spawn).toHaveBeenCalledWith(
      'antigravity',
      expect.arrayContaining(['--log-file', expect.any(String), '--print', 'hello world']),
      expect.any(Object)
    );

    // Simulate stdout with conversation ID
    mockChild.stdout.emit('data', Buffer.from('{"conversationId": "conv_abc"}'));

    expect(handle.conversationId).toBe('conv_abc');
    expect(handle.isRunning()).toBe(true);

    // Setup transcript mocks
    (fs.existsSync as jest.Mock).mockImplementation((p) => {
      if (typeof p === 'string' && p.endsWith('transcript.jsonl')) {
        return true;
      }
      return actualFs.existsSync(p);
    });

    const mockTranscriptLine = JSON.stringify({
      type: 'PLANNER_RESPONSE',
      step_index: 0,
      content: 'This is the output from agent.',
    }) + '\n';

    (fs.readFileSync as jest.Mock).mockImplementation((p, opt) => {
      if (typeof p === 'string' && p.endsWith('transcript.jsonl')) {
        return mockTranscriptLine;
      }
      return actualFs.readFileSync(p, opt);
    });

    // Advance timers to trigger pollInterval
    jest.advanceTimersByTime(1000);

    expect(onEvent).toHaveBeenCalledWith({
      type: 'text',
      delta: 'This is the output from agent.',
    });

    // Close child process
    mockChild.emit('close', 0);

    const result = await handle.promise;
    expect(result).toBe('This is the output from agent.');
    expect(handle.isRunning()).toBe(false);
  });

  test('runAgent ignores transcript lines older than startedAt - 5000', async () => {
    const onEvent = jest.fn();
    const handle = runAgent(
      {
        scope: 'p2p:user_1',
        workspace: '/tmp',
        prompt: 'hello world',
      },
      mockConfig,
      onEvent
    );

    mockChild.stdout.emit('data', Buffer.from('{"conversationId": "conv_abc"}'));

    (fs.existsSync as jest.Mock).mockImplementation((p) => {
      if (typeof p === 'string' && p.endsWith('transcript.jsonl')) {
        return true;
      }
      return actualFs.existsSync(p);
    });

    const oldTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const newTime = new Date().toISOString();

    const mockTranscriptLines = [
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        step_index: 0,
        created_at: oldTime,
        content: 'Old historical output.',
      }),
      JSON.stringify({
        type: 'PLANNER_RESPONSE',
        step_index: 1,
        created_at: newTime,
        content: 'New active output.',
      })
    ].join('\n') + '\n';

    (fs.readFileSync as jest.Mock).mockImplementation((p, opt) => {
      if (typeof p === 'string' && p.endsWith('transcript.jsonl')) {
        return mockTranscriptLines;
      }
      return actualFs.readFileSync(p, opt);
    });

    jest.advanceTimersByTime(1000);

    expect(onEvent).not.toHaveBeenCalledWith(expect.objectContaining({
      delta: 'Old historical output.',
    }));
    expect(onEvent).toHaveBeenCalledWith({
      type: 'text',
      delta: 'New active output.',
    });

    mockChild.emit('close', 0);
    await handle.promise;
  });

  test('runAgent with sessionId uses send-message command', () => {
    const onEvent = jest.fn();
    runAgent(
      {
        scope: 'p2p:user_1',
        workspace: '/tmp',
        prompt: 'next step',
        sessionId: 'conv_123',
      },
      mockConfig,
      onEvent
    );

    expect(spawn).toHaveBeenCalledWith(
      'antigravity',
      expect.arrayContaining(['--log-file', expect.any(String), '--conversation', 'conv_123', '--print', 'next step']),
      expect.any(Object)
    );
  });

  test('runAgent ignores transient auth errors after silent auth recovery', async () => {
    const onEvent = jest.fn();
    const handle = runAgent(
      {
        scope: 'p2p:user_1',
        workspace: '/tmp',
        prompt: '1+1 是多少',
      },
      mockConfig,
      onEvent
    );

    mockChild.stdout.emit('data', Buffer.from('1+1 等于 2。'));

    (fs.existsSync as jest.Mock).mockImplementation((p) => {
      if (typeof p === 'string' && p.endsWith('.log')) {
        return true;
      }
      return actualFs.existsSync(p);
    });

    (fs.readFileSync as jest.Mock).mockImplementation((p, opt) => {
      if (typeof p === 'string' && p.endsWith('.log')) {
        return 'You are not logged into Antigravity.\nOAuth: authenticated successfully as user@example.com\nPrint mode: silent auth succeeded';
      }
      return actualFs.readFileSync(p, opt);
    });

    mockChild.emit('close', 0);

    await expect(handle.promise).resolves.toBe('1+1 等于 2。');
    expect(handle.isRunning()).toBe(false);
  });

  test('runAgent ignores recovered auth startup log errors', async () => {
    const onEvent = jest.fn();
    const handle = runAgent(
      {
        scope: 'p2p:user_1',
        workspace: '/tmp',
        prompt: 'hi',
      },
      mockConfig,
      onEvent
    );

    mockChild.stdout.emit('data', Buffer.from('你好！'));

    (fs.existsSync as jest.Mock).mockImplementation((p) => {
      if (typeof p === 'string' && p.endsWith('.log')) {
        return true;
      }
      return actualFs.existsSync(p);
    });

    (fs.readFileSync as jest.Mock).mockImplementation((p, opt) => {
      if (typeof p === 'string' && p.endsWith('.log')) {
        return 'E0524 00:06:14.814275 64362 log.go:398] Failed to poll ListExperiments: error getting token source: You are not logged into Antigravity.\nE0524 00:06:19.465952 64362 discovery.go:334] Failed to load JSON config file /Users/chiphen/.gemini/config/mcp_config.json: unexpected end of JSON input\nOAuth: authenticated successfully as user@example.com\nPrint mode: silent auth succeeded';
      }
      return actualFs.readFileSync(p, opt);
    });

    mockChild.emit('close', 0);

    await expect(handle.promise).resolves.toBe('你好！');
  });

  test('runAgent rejects unrecovered auth failures', async () => {
    const onEvent = jest.fn();
    const handle = runAgent(
      {
        scope: 'p2p:user_1',
        workspace: '/tmp',
        prompt: 'hello world',
      },
      mockConfig,
      onEvent
    );

    (fs.existsSync as jest.Mock).mockImplementation((p) => {
      if (typeof p === 'string' && p.endsWith('.log')) {
        return true;
      }
      return actualFs.existsSync(p);
    });

    (fs.readFileSync as jest.Mock).mockImplementation((p, opt) => {
      if (typeof p === 'string' && p.endsWith('.log')) {
        return 'Failed to get OAuth token: error getting token source from auth provider: You are not logged into Antigravity.';
      }
      return actualFs.readFileSync(p, opt);
    });

    mockChild.emit('close', 0);

    await expect(handle.promise).rejects.toThrow('Antigravity 当前未登录，CLI 无法获取模型授权。请先打开 Antigravity 或重新登录后再试。');
  });

  test('runAgent handles process exit failure', async () => {
    const onEvent = jest.fn();
    const handle = runAgent(
      {
        scope: 'p2p:user_1',
        workspace: '/tmp',
        prompt: 'hello world',
      },
      mockConfig,
      onEvent
    );

    // Simulate child process stderr and crash
    mockChild.stderr.emit('data', Buffer.from('fatal error occurred'));
    mockChild.emit('close', 1);

    await expect(handle.promise).rejects.toThrow('Agent process exited with code 1. Stderr: fatal error occurred');
    expect(handle.isRunning()).toBe(false);
  });

  test('runAgent stop kills the child process', async () => {
    const onEvent = jest.fn();
    const handle = runAgent(
      {
        scope: 'p2p:user_1',
        workspace: '/tmp',
        prompt: 'hello world',
      },
      mockConfig,
      onEvent
    );

    handle.stop();

    expect(mockChild.kill).toHaveBeenCalledWith('SIGTERM');

    // Simulate close after stop
    mockChild.emit('close', null);

    await expect(handle.promise).rejects.toThrow('Task cancelled by user /stop command.');
  });
});
