import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { APP_DIR, CONFIG_FILE } from '../paths';

const SERVICE_LABEL = 'com.antigravity-lark-bridge';

export interface ServiceOptions {
  configPath?: string;
}

export interface ServiceStatus {
  installed: boolean;
  running: boolean;
  message: string;
}

export function registerService(options: ServiceOptions = {}) {
  const file = getServiceFilePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, renderServiceDefinition(options.configPath || CONFIG_FILE), { mode: 0o600, encoding: 'utf8' });
  if (process.platform === 'darwin') {
    run('launchctl', ['bootstrap', `gui/${process.getuid?.()}`, file], true);
  } else if (process.platform === 'linux') {
    run('systemctl', ['--user', 'daemon-reload'], true);
    run('systemctl', ['--user', 'enable', SERVICE_LABEL], true);
  } else if (process.platform === 'win32') {
    run('schtasks', ['/Create', '/TN', SERVICE_LABEL, '/XML', file, '/F'], true);
  }
}

export function startService() {
  if (process.platform === 'darwin') run('launchctl', ['kickstart', '-k', `gui/${process.getuid?.()}/${SERVICE_LABEL}`], true);
  else if (process.platform === 'linux') run('systemctl', ['--user', 'start', SERVICE_LABEL], true);
  else if (process.platform === 'win32') run('schtasks', ['/Run', '/TN', SERVICE_LABEL], true);
}

export function stopService() {
  if (process.platform === 'darwin') run('launchctl', ['bootout', `gui/${process.getuid?.()}/${SERVICE_LABEL}`], true);
  else if (process.platform === 'linux') run('systemctl', ['--user', 'stop', SERVICE_LABEL], true);
  else if (process.platform === 'win32') run('schtasks', ['/End', '/TN', SERVICE_LABEL], true);
}

export function unregisterService() {
  stopService();
  if (process.platform === 'linux') {
    run('systemctl', ['--user', 'disable', SERVICE_LABEL], true);
    run('systemctl', ['--user', 'daemon-reload'], true);
  } else if (process.platform === 'win32') {
    run('schtasks', ['/Delete', '/TN', SERVICE_LABEL, '/F'], true);
  }
  try {
    fs.unlinkSync(getServiceFilePath());
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }
}

export function getServiceStatus(): ServiceStatus {
  const installed = fs.existsSync(getServiceFilePath());
  if (process.platform === 'darwin') {
    const result = spawnSync('launchctl', ['print', `gui/${process.getuid?.()}/${SERVICE_LABEL}`], { encoding: 'utf8' });
    return { installed, running: result.status === 0, message: result.status === 0 ? 'LaunchAgent is loaded.' : 'LaunchAgent is not loaded.' };
  }
  if (process.platform === 'linux') {
    const result = spawnSync('systemctl', ['--user', 'is-active', SERVICE_LABEL], { encoding: 'utf8' });
    return { installed, running: result.stdout.trim() === 'active', message: result.stdout.trim() || result.stderr.trim() || 'unknown' };
  }
  if (process.platform === 'win32') {
    const result = spawnSync('schtasks', ['/Query', '/TN', SERVICE_LABEL], { encoding: 'utf8' });
    return { installed, running: result.status === 0, message: result.status === 0 ? 'Task is registered.' : 'Task is not registered.' };
  }
  return { installed, running: false, message: `Unsupported platform: ${process.platform}` };
}

export function getServiceFilePath(): string {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  if (process.platform === 'linux') return path.join(os.homedir(), '.config', 'systemd', 'user', `${SERVICE_LABEL}.service`);
  if (process.platform === 'win32') return path.join(APP_DIR, `${SERVICE_LABEL}.xml`);
  return path.join(APP_DIR, `${SERVICE_LABEL}.service`);
}

export function renderServiceDefinition(configPath: string, cliPath = getCliPath()): string {
  const stdoutPath = path.join(APP_DIR, 'stdout.log');
  const stderrPath = path.join(APP_DIR, 'stderr.log');
  const servicePath = sanitizePath(process.env.PATH || '');

  if (process.platform === 'darwin') {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${cliPath}</string>
    <string>run</string>
    <string>--config</string>
    <string>${configPath}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${servicePath}</string></dict>
  <key>StandardOutPath</key><string>${stdoutPath}</string>
  <key>StandardErrorPath</key><string>${stderrPath}</string>
</dict>
</plist>
`;
  }

  if (process.platform === 'linux') {
    return `[Unit]
Description=Antigravity Lark Bridge
After=network.target

[Service]
Type=simple
ExecStart=${process.execPath} ${cliPath} run --config ${configPath}
Restart=always
Environment=PATH=${servicePath}
StandardOutput=append:${stdoutPath}
StandardError=append:${stderrPath}

[Install]
WantedBy=default.target
`;
  }

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Actions Context="Author"><Exec><Command>${process.execPath}</Command><Arguments>${cliPath} run --config ${configPath}</Arguments></Exec></Actions>
</Task>
`;
}

function sanitizePath(value: string): string {
  return value
    .split(path.delimiter)
    .filter((entry) => entry && !entry.includes('node_modules') && !entry.includes(`${path.sep}.agents${path.sep}`))
    .join(path.delimiter);
}

function getCliPath(): string {
  return process.argv[1] ? path.resolve(process.argv[1]) : path.resolve(__dirname, '..', 'cli.js');
}

function run(command: string, args: string[], ignoreFailure = false) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (!ignoreFailure && result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
}
