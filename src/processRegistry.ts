import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { PROCESSES_FILE } from './paths';

export interface ProcessRecord {
  id: string;
  appId: string;
  configPath: string;
  pid: number;
  startedAt: string;
  version: string;
  botName?: string;
}

export function listProcesses(): ProcessRecord[] {
  const records = readRecords();
  const live = records.filter((record) => isPidAlive(record.pid));
  if (live.length !== records.length) writeRecords(live);
  return live;
}

export function registerProcess(input: Omit<ProcessRecord, 'id' | 'pid' | 'startedAt'>): ProcessRecord {
  const records = listProcesses().filter((record) => record.pid !== process.pid);
  const record: ProcessRecord = {
    ...input,
    id: crypto.randomBytes(3).toString('hex'),
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  records.push(record);
  writeRecords(records);
  return record;
}

export function unregisterProcess(id: string) {
  writeRecords(listProcesses().filter((record) => record.id !== id));
}

export function findConflicts(appId: string, currentPid = process.pid): ProcessRecord[] {
  return listProcesses().filter((record) => record.appId === appId && record.pid !== currentPid);
}

export function killProcess(selector: string): boolean {
  const records = listProcesses();
  const record = records.find((item, index) => item.id === selector || String(index + 1) === selector);
  if (!record) return false;
  process.kill(record.pid, 'SIGTERM');
  return true;
}

function readRecords(): ProcessRecord[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(PROCESSES_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err: any) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

function writeRecords(records: ProcessRecord[]) {
  const dir = path.dirname(PROCESSES_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(PROCESSES_FILE, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600, encoding: 'utf8' });
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM';
  }
}
