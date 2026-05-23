import * as http from 'http';
import { createIpcServer, registerCardCallback, pendingIpcRequests } from './ipc';
import { initWorkspaces } from './workspace';

describe('IPC Server Tests', () => {
  let server: http.Server;
  const token = 'test-secret-token';
  const port = 4999;
  const baseUrl = `http://127.0.0.1:${port}`;

  beforeAll((done) => {
    // Initialize workspaces config for tests
    initWorkspaces({
      lark: {
        appId: 'test',
        appSecret: 'test',
        encryptKey: 'test',
        verificationToken: 'test',
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
        port,
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
    });

    server = createIpcServer(token, 512);
    server.listen(port, '127.0.0.1', done);
  });

  afterAll((done) => {
    server.close(done);
  });

  test('Requires Authorization header', async () => {
    const res = await fetch(`${baseUrl}/api/approval`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  test('Rejects invalid token', async () => {
    const res = await fetch(`${baseUrl}/api/approval`, {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer wrong-token',
      },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(401);
  });

  test('Handles auto-allow policy without blocking', async () => {
    const res = await fetch(`${baseUrl}/api/approval`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        conversationId: 'conv_1',
        stepIdx: 1,
        toolCall: {
          name: 'view_file',
          args: { AbsolutePath: '/tmp/test.txt' },
        },
        workspacePaths: ['/tmp'],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decision).toBe('allow');
  });

  test('Enforces payload size limit of 512KB', async () => {
    // Generate a payload larger than 512KB
    const largeString = 'a'.repeat(513 * 1024);
    const res = await fetch(`${baseUrl}/api/approval`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        conversationId: 'conv_1',
        stepIdx: 1,
        toolCall: {
          name: 'view_file',
          args: { AbsolutePath: '/tmp/test.txt', Content: largeString },
        },
        workspacePaths: ['/tmp'],
      }),
    });
    expect(res.status).toBe(413);
  });
});
