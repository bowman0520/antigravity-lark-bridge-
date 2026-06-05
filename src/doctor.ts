import * as fs from 'fs';
import { spawnSync } from 'child_process';
import { checkFilePermissions, loadConfig } from './config';
import { CONFIG_FILE } from './paths';

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  message: string;
}

export function runDoctor(configPath = CONFIG_FILE): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  if (!fs.existsSync(configPath)) {
    checks.push({ name: 'config', status: 'fail', message: `Config file not found: ${configPath}` });
    return checks;
  }

  try {
    checkFilePermissions(configPath);
    checks.push({ name: 'config.permissions', status: 'ok', message: 'Config file permissions are owner-only.' });
  } catch (err: any) {
    checks.push({ name: 'config.permissions', status: 'fail', message: err.message });
  }

  let config;
  try {
    config = loadConfig(configPath);
    checks.push({ name: 'config.parse', status: 'ok', message: 'Config parsed and secrets resolved.' });
  } catch (err: any) {
    checks.push({ name: 'config.parse', status: 'fail', message: err.message });
    return checks;
  }

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({
    name: 'node.version',
    status: major >= 20 ? 'ok' : 'fail',
    message: `Node.js ${process.versions.node}${major >= 20 ? '' : ' is too old; Node.js 20+ is required.'}`,
  });

  const agent = spawnSync(config.agent.command, ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  checks.push({
    name: 'agent.command',
    status: agent.error ? 'fail' : 'ok',
    message: agent.error ? `Cannot execute ${config.agent.command}: ${agent.error.message}` : `${config.agent.command} is executable.`,
  });

  checks.push({
    name: 'agent.workspace',
    status: fs.existsSync(config.agent.defaultWorkspace) ? 'ok' : 'fail',
    message: fs.existsSync(config.agent.defaultWorkspace)
      ? `Default workspace exists: ${config.agent.defaultWorkspace}`
      : `Default workspace does not exist: ${config.agent.defaultWorkspace}`,
  });

  checks.push({
    name: 'lark.credentials',
    status: config.lark.appId && config.lark.appSecret ? 'ok' : 'fail',
    message: config.lark.appId && config.lark.appSecret ? 'Lark app credentials are present.' : 'Lark app credentials are missing.',
  });

  checks.push({
    name: 'access.admins',
    status: config.access.admins.length > 0 ? 'ok' : 'warn',
    message: config.access.admins.length > 0
      ? `${config.access.admins.length} admin user(s) configured.`
      : 'No admins configured; admin commands are unrestricted for legacy compatibility.',
  });

  return checks;
}

export function formatDoctorChecks(checks: DoctorCheck[]): string {
  return checks.map((check) => `[${check.status.toUpperCase()}] ${check.name}: ${check.message}`).join('\n');
}
