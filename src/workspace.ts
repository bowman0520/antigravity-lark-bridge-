import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ResolvedConfig } from './config';
import { WORKSPACES_FILE, ANTIGRAVITY_IDE_STATE_DB, ANTIGRAVITY_STATE_DB, getAntigravityBrainDir, getAntigravityCliBrainDir } from './paths';

export interface WorkspaceData {
  default: string;
  projects: { [name: string]: string };
}

export function initWorkspaces(config: ResolvedConfig) {
  const dir = path.dirname(WORKSPACES_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (!fs.existsSync(WORKSPACES_FILE)) {
    const data: WorkspaceData = {
      default: config.agent.defaultWorkspace,
      projects: {
        default: config.agent.defaultWorkspace,
      },
    };
    fs.writeFileSync(WORKSPACES_FILE, JSON.stringify(data, null, 2), {
      mode: 0o600,
      encoding: 'utf8',
    });
  }
}

export function loadWorkspaces(): WorkspaceData {
  if (!fs.existsSync(WORKSPACES_FILE)) {
    throw new Error(`Workspaces file not found at ${WORKSPACES_FILE}`);
  }

  const raw = fs.readFileSync(WORKSPACES_FILE, 'utf8');
  try {
    return JSON.parse(raw) as WorkspaceData;
  } catch (err) {
    throw new Error(`Invalid JSON in workspaces file: ${err}`);
  }
}

export function getAllowedWorkspaces(): string[] {
  try {
    const wsData = loadWorkspaces();
    const list = [wsData.default];
    for (const p of Object.values(wsData.projects)) {
      list.push(p);
    }
    return Array.from(new Set(list));
  } catch (err) {
    return [];
  }
}

export function getBrainDir(workspace?: string): string {
  if (workspace) {
    const wsDir = path.join(workspace, '.antigravitycli', 'brain');
    if (fs.existsSync(wsDir)) return wsDir;
  }
  const cliDir = getAntigravityCliBrainDir();
  if (fs.existsSync(cliDir)) return cliDir;
  return getAntigravityBrainDir();
}


function readRecentPathsFromDb(dbPath: string): string[] {
  if (!fs.existsSync(dbPath)) return [];
  let tmpPath: string | undefined;
  try {
    const Database = require('better-sqlite3');
    // Copy to temp file on Windows — better-sqlite3 cannot open DBs locked by another process
    const openPath = process.platform === 'win32' ? (() => {
      tmpPath = path.join(os.tmpdir(), `state_${Date.now()}.vscdb`);
      fs.copyFileSync(dbPath, tmpPath);
      return tmpPath;
    })() : dbPath;
    const db = new Database(openPath, { readonly: true });
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'").get() as { value: string } | undefined;
    db.close();
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch {} }
    if (!row?.value) return [];
    const parsed = JSON.parse(row.value);
    const entries: Array<{ folderUri?: string }> = parsed?.entries || [];
    return entries
      .map(e => e.folderUri)
      .filter((u): u is string => typeof u === 'string' && u.startsWith('file://'))
      .map(u => {
        let p = decodeURIComponent(u.replace(/^file:\/\//, ''));
        // Windows: file:///c%3A/... decodes to /c:/... — strip leading slash
        if (process.platform === 'win32' && /^\/[a-zA-Z]:/.test(p)) {
          p = p.slice(1);
        }
        return p;
      });
  } catch {
    if (tmpPath) { try { fs.unlinkSync(tmpPath); } catch {} }
    return [];
  }
}

export function getAntigravityProjects(): string[] {
  const paths = [...readRecentPathsFromDb(ANTIGRAVITY_IDE_STATE_DB), ...readRecentPathsFromDb(ANTIGRAVITY_STATE_DB)];
  return Array.from(new Set(paths)).filter(p => fs.existsSync(p));
}

