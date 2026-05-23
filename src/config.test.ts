import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { migratePlaintextSecrets, resolveValue, ConfigSchema } from './config';

describe('Configuration Tests', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('ConfigSchema parses valid configuration', () => {
    const validConfig = {
      lark: {
        appId: 'cli_123',
        appSecretRef: 'env:LARK_APP_SECRET',
        encryptKeyRef: 'env:LARK_ENCRYPT_KEY',
        verificationTokenRef: 'env:LARK_VERIFICATION_TOKEN',
        domain: 'feishu'
      },
      agent: {
        defaultWorkspace: '/Users/chiphen/.agents',
        command: 'antigravity',
        args: [],
        mode: 'auto'
      },
      ipc: {
        host: '127.0.0.1',
        port: 3999,
        allowRandomPortOnConflict: true,
        approvalTimeoutSeconds: 600
      },
      media: {
        autoCompressImages: true,
        imageMaxWidthPx: 1600,
        imageJpegQuality: 82,
        imageMaxBytes: 1048576,
        maxImagesPerPrompt: 3,
        maxPromptChars: 12000
      },
      access: {
        allowedUsers: ['ou_123'],
        allowedChats: ['oc_123'],
        admins: ['ou_123']
      },
      reply: {
        requireMentionInGroup: true,
        mode: 'card',
        messageFlushIntervalMs: 1200,
        maxMessageChars: 3500
      },
      security: {
        redactBeforeSend: true,
        debugRawLogs: false,
        groupWriteRequiresApproval: true,
        p2pWriteRequiresApproval: false
      }
    };

    const result = ConfigSchema.safeParse(validConfig);
    expect(result.success).toBe(true);
  });

  test('ConfigSchema fills in defaults', () => {
    const minimalConfig = {
      lark: {
        appId: 'cli_123',
        appSecretRef: 'env:LARK_APP_SECRET',
        encryptKeyRef: 'env:LARK_ENCRYPT_KEY',
        verificationTokenRef: 'env:LARK_VERIFICATION_TOKEN'
      },
      agent: {
        defaultWorkspace: '/Users/chiphen/.agents'
      }
    };

    const result = ConfigSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lark.domain).toBe('feishu');
      expect(result.data.ipc.port).toBe(3999);
      expect(result.data.reply.mode).toBe('card');
      expect(result.data.media.autoCompressImages).toBe(true);
      expect(result.data.media.imageMaxWidthPx).toBe(1600);
    }
  });

  test('ConfigSchema allows optional encryptKeyRef and verificationTokenRef', () => {
    const minimalConfig = {
      lark: {
        appId: 'cli_123',
        appSecretRef: 'env:LARK_APP_SECRET',
      },
      agent: {
        defaultWorkspace: '/Users/chiphen/.agents'
      }
    };

    const result = ConfigSchema.safeParse(minimalConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.lark.encryptKeyRef).toBe('');
      expect(result.data.lark.verificationTokenRef).toBe('');
    }
  });

  test('resolveValue resolves env variables', () => {
    process.env.TEST_API_KEY = 'secret_key_123';
    expect(resolveValue('env:TEST_API_KEY')).toBe('secret_key_123');
    expect(resolveValue('plain_text_value')).toBe('plain_text_value');
  });

  test('resolveValue throws if env variable is missing', () => {
    expect(() => resolveValue('env:NON_EXISTENT_VAR')).toThrow();
  });

  test('ConfigSchema accepts encrypted secret refs', () => {
    const result = ConfigSchema.safeParse({
      lark: {
        appId: 'cli_123',
        appSecretRef: { source: 'encrypted', id: 'app-cli_123' },
      },
      agent: {
        defaultWorkspace: '/tmp/workspace'
      }
    });

    expect(result.success).toBe(true);
  });

  test('migratePlaintextSecrets encrypts literal app secret refs', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agl-config-test-'));
    process.env.ANTIGRAVITY_LARK_HOME = dir;
    jest.resetModules();
    const { migratePlaintextSecrets: migrate, loadConfig } = require('./config');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      lark: {
        appId: 'cli_123',
        appSecretRef: 'plain-secret',
      },
      agent: {
        defaultWorkspace: '/tmp/workspace'
      }
    }, null, 2), { mode: 0o600 });

    expect(migrate(configPath)).toBe(true);
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(raw.lark.appSecretRef).toEqual({ source: 'encrypted', id: 'app-cli_123' });
    expect(loadConfig(configPath).lark.appSecret).toBe('plain-secret');
    delete process.env.ANTIGRAVITY_LARK_HOME;
  });
});
