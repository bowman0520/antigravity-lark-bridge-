import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { checkFilePermissions } from './config';
import { RUNTIME_FILE } from './paths';

export interface RuntimeData {
  port: number;
  ipcToken: string;
  pid: number;
}

export function generateIpcToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function saveRuntime(port: number, ipcToken: string) {
  const data: RuntimeData = {
    port,
    ipcToken,
    pid: process.pid,
  };

  const dir = path.dirname(RUNTIME_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Write file with 0600 permission
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(data, null, 2), {
    mode: 0o600,
    encoding: 'utf8',
  });
}

export function loadRuntime(): RuntimeData {
  if (!fs.existsSync(RUNTIME_FILE)) {
    throw new Error(`Runtime file not found at ${RUNTIME_FILE}. Is the bridge server running?`);
  }

  // Validate file permissions before loading
  checkFilePermissions(RUNTIME_FILE);

  const raw = fs.readFileSync(RUNTIME_FILE, 'utf8');
  try {
    return JSON.parse(raw) as RuntimeData;
  } catch (err) {
    throw new Error(`Invalid JSON in runtime file: ${err}`);
  }
}

export function deleteRuntime() {
  if (fs.existsSync(RUNTIME_FILE)) {
    try {
      fs.unlinkSync(RUNTIME_FILE);
    } catch (err) {
      // Ignore errors deleting runtime file on cleanup
    }
  }
}
