import * as fs from 'fs';
import * as path from 'path';
import { ResolvedConfig } from './config';
import { WORKSPACES_FILE, getAntigravityBrainDir, getAntigravityCliBrainDir } from './paths';

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

