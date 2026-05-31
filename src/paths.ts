import * as fs from 'fs';
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

function getStateDbPaths(): { ide: string; app: string } {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return {
      ide: path.join(appData, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
      app: path.join(appData, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
    };
  }
  if (process.platform === 'darwin') {
    return {
      ide: path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
      app: path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
    };
  }
  // Linux
  const configDir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return {
    ide: path.join(configDir, 'Antigravity IDE', 'User', 'globalStorage', 'state.vscdb'),
    app: path.join(configDir, 'Antigravity', 'User', 'globalStorage', 'state.vscdb'),
  };
}

const _dbPaths = getStateDbPaths();
export const ANTIGRAVITY_IDE_STATE_DB = _dbPaths.ide;
export const ANTIGRAVITY_STATE_DB = _dbPaths.app;

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

export function getAntigravityLastConversationsFile(workspace?: string): string {
  if (workspace) {
    const wsPath = path.join(workspace, '.antigravitycli', 'cache', 'last_conversations.json');
    if (fs.existsSync(wsPath)) return wsPath;
  }
  return path.join(os.homedir(), '.gemini', 'antigravity-cli', 'cache', 'last_conversations.json');
}

