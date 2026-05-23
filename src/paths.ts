import * as os from 'os';
import * as path from 'path';

export const APP_DIR =
  process.env.ANTIGRAVITY_LARK_HOME ||
  (process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID
    ? path.join(os.tmpdir(), 'antigravity-lark-test')
    : path.join(os.homedir(), '.antigravity-lark'));

export const CONFIG_FILE = path.join(APP_DIR, 'config.json');
export const RUNTIME_FILE = path.join(APP_DIR, 'runtime.json');
export const SESSIONS_FILE = path.join(APP_DIR, 'sessions.json');
export const WORKSPACES_FILE = path.join(APP_DIR, 'workspaces.json');
export const APPROVALS_FILE = path.join(APP_DIR, 'approvals.json');
export const PROCESSES_FILE = path.join(APP_DIR, 'processes.json');
export const SECRETS_FILE = path.join(APP_DIR, 'secrets.enc');
export const KEYSTORE_SALT_FILE = path.join(APP_DIR, '.keystore.salt');

export const LOG_DIR = process.env.ANTIGRAVITY_LARK_LOG_DIR || path.join(APP_DIR, 'logs');
export const AGENT_LOG_DIR = path.join(APP_DIR, 'agy-logs');
export const MEDIA_DIR = path.join(APP_DIR, 'media');

export const LAUNCHD_PLIST_FILE = path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.antigravity-lark-bridge.plist');

export function getMediaChatDir(chatId: string): string {
  const safeChatId = chatId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(MEDIA_DIR, safeChatId);
}

export function getAntigravityCliBrainDir(): string {
  if (process.env.ANTIGRAVITY_APP_DATA_DIR) {
    const dir = path.join(process.env.ANTIGRAVITY_APP_DATA_DIR, 'brain');
    return dir;
  }
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain');
}

export function getAntigravityBrainDir(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
}

export function getAntigravityLastConversationsFile(): string {
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json');
}
