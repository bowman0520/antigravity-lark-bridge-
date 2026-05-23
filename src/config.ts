import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { CONFIG_FILE } from './paths';
import { encryptedSecretRef, getSecret, isEncryptedSecretRef, secretIdForApp, setSecret } from './keystore';

const SecretRefSchema = z.union([
  z.string(),
  z.object({
    source: z.literal('encrypted'),
    id: z.string().min(1),
  }),
]);

export type SecretRef = z.infer<typeof SecretRefSchema>;

export const ConfigSchema = z.object({
  lark: z.object({
    appId: z.string(),
    appSecretRef: SecretRefSchema,
    encryptKeyRef: SecretRefSchema.optional().default(''),
    verificationTokenRef: SecretRefSchema.optional().default(''),
    domain: z.string().default('feishu'),
  }),
  agent: z.object({
    defaultWorkspace: z.string(),
    command: z.string().default('agy'),
    args: z.array(z.string()).default([]),
    mode: z.enum(['auto', 'native-tool-hook', 'cli-supervisor']).default('auto'),
  }),
  ipc: z.object({
    host: z.string().default('127.0.0.1'),
    port: z.number().default(3999),
    allowRandomPortOnConflict: z.boolean().default(true),
    approvalTimeoutSeconds: z.number().default(600),
    maxPayloadSizeKb: z.number().default(10240),
    hookPayloadLimitBytes: z.number().default(512 * 1024),
    forwardedHookLimitBytes: z.number().default(64 * 1024),
  }).default({}),
  media: z.object({
    autoCompressImages: z.boolean().default(true),
    imageMaxWidthPx: z.number().default(1600),
    imageJpegQuality: z.number().default(82),
    imageMaxBytes: z.number().default(1024 * 1024),
    maxImagesPerPrompt: z.number().default(3),
    maxPromptChars: z.number().default(12000),
  }).default({}),
  access: z.object({
    allowedUsers: z.array(z.string()).default([]),
    allowedChats: z.array(z.string()).default([]),
    admins: z.array(z.string()).default([]),
  }).default({}),
  reply: z.object({
    requireMentionInGroup: z.boolean().default(true),
    mode: z.enum(['card', 'text']).default('card'),
    messageFlushIntervalMs: z.number().default(1200),
    maxMessageChars: z.number().default(3500),
  }).default({}),
  security: z.object({
    redactBeforeSend: z.boolean().default(true),
    debugRawLogs: z.boolean().default(false),
    groupWriteRequiresApproval: z.boolean().default(true),
    p2pWriteRequiresApproval: z.boolean().default(false),
  }).default({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export interface ResolvedConfig extends Omit<Config, 'lark'> {
  lark: {
    appId: string;
    appSecret: string;
    encryptKey: string;
    verificationToken: string;
    domain: string;
  };
}

export function checkFilePermissions(filePath: string) {
  if (process.platform === 'win32') return;
  try {
    const stat = fs.statSync(filePath);
    const mode = stat.mode & 0o777;
    // Check if group or others have any read, write, or execute permissions (0o077)
    if ((mode & 0o077) !== 0) {
      throw new Error(
        `Permissions for file ${filePath} are too broad (${mode.toString(8)}). It must be owner-only (e.g. 0600). Run 'chmod 600 ${filePath}' to fix.`
      );
    }
  } catch (err: any) {
    if (err.code === 'ENOENT') return; // File doesn't exist yet, we will create it with 0600
    throw err;
  }
}

export function resolveValue(ref: SecretRef): string {
  if (typeof ref === 'string') {
    if (ref.startsWith('env:')) {
      const envVar = ref.substring(4);
      const value = process.env[envVar];
      if (!value) {
        throw new Error(`Environment variable '${envVar}' referenced by '${ref}' is not set.`);
      }
      return value;
    }
    return ref;
  }

  if (isEncryptedSecretRef(ref)) {
    const value = getSecret(ref.id);
    if (value === undefined) {
      throw new Error(`Encrypted secret '${ref.id}' is not found in the local keystore.`);
    }
    return value;
  }

  throw new Error('Unsupported secret reference.');
}

export function loadConfig(configPath?: string): ResolvedConfig {
  const actualPath = configPath || CONFIG_FILE;

  if (!fs.existsSync(actualPath)) {
    throw new Error(`Configuration file not found at ${actualPath}. Please initialize it first.`);
  }

  // Check file permissions
  checkFilePermissions(actualPath);

  const rawData = fs.readFileSync(actualPath, 'utf8');
  let json: any;
  try {
    json = JSON.parse(rawData);
  } catch (err) {
    throw new Error(`Invalid JSON in configuration file: ${err}`);
  }

  const parsed = ConfigSchema.parse(json);

  // Resolve env vars
  return {
    ...parsed,
    lark: {
      appId: parsed.lark.appId,
      appSecret: resolveValue(parsed.lark.appSecretRef),
      encryptKey: parsed.lark.encryptKeyRef ? resolveValue(parsed.lark.encryptKeyRef) : '',
      verificationToken: parsed.lark.verificationTokenRef ? resolveValue(parsed.lark.verificationTokenRef) : '',
      domain: parsed.lark.domain,
    },
  };
}

export function saveDefaultConfig(configPath: string, config: Config) {
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), {
    mode: 0o600,
    encoding: 'utf8',
  });
}

export function migratePlaintextSecrets(configPath: string): boolean {
  if (!fs.existsSync(configPath)) return false;
  checkFilePermissions(configPath);

  const rawData = fs.readFileSync(configPath, 'utf8');
  const json = JSON.parse(rawData);
  const parsed = ConfigSchema.parse(json);
  const ref = parsed.lark.appSecretRef;

  if (typeof ref !== 'string' || !parsed.lark.appId || !ref || ref.startsWith('env:')) {
    return false;
  }

  const id = secretIdForApp(parsed.lark.appId);
  setSecret(id, ref);
  const migrated: Config = {
    ...parsed,
    lark: {
      ...parsed.lark,
      appSecretRef: encryptedSecretRef(id),
    },
  };
  saveDefaultConfig(configPath, migrated);
  return true;
}
