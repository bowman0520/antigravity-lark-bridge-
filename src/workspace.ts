import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
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

export function getBrainDir(): string {
  const cliDir = getAntigravityCliBrainDir();
  if (fs.existsSync(cliDir)) return cliDir;
  return getAntigravityBrainDir();
}

function readRecentPathsFromDb(dbPath: string): string[] {
  if (!fs.existsSync(dbPath)) return [];
  try {
    const raw = execFileSync('sqlite3', [dbPath, "SELECT value FROM ItemTable WHERE key = 'history.recentlyOpenedPathsList'"], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const parsed = JSON.parse(raw);
    const entries: Array<{ folderUri?: string }> = parsed?.entries || [];
    return entries
      .map(e => e.folderUri)
      .filter((u): u is string => typeof u === 'string' && u.startsWith('file://'))
      .map(u => decodeURIComponent(u.replace(/^file:\/\//, '')));
  } catch {
    return [];
  }
}

export function getAntigravityProjects(): string[] {
  const paths = [...readRecentPathsFromDb(ANTIGRAVITY_IDE_STATE_DB), ...readRecentPathsFromDb(ANTIGRAVITY_STATE_DB)];
  return Array.from(new Set(paths)).filter(p => fs.existsSync(p));
}

