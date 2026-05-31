import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { APP_DIR, CONFIG_FILE, RUNTIME_FILE } from '../paths';
import { listProcesses } from '../processRegistry';
import { deleteRuntime } from '../runtime';

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
  if (process.platform === 'win32') {
    fs.writeFileSync(getHiddenLauncherPath(), renderWindowsHiddenLauncher(options.configPath || CONFIG_FILE), { mode: 0o600, encoding: 'utf8' });
  }
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

export async function ensureServiceStarted(options: ServiceOptions = {}): Promise<ServiceStatus> {
  registerService(options);

  if (process.platform === 'win32') {
    const before = await getServiceHealthStatus();
    if (before.running) return before;
    terminateRegisteredBridgeProcesses();
    cleanupStaleRuntimeState();
  }

  startService();
  return process.platform === 'win32'
    ? await waitForHealthyStatus()
    : getServiceStatus();
}

export function stopService() {
  if (process.platform === 'darwin') run('launchctl', ['bootout', `gui/${process.getuid?.()}/${SERVICE_LABEL}`], true);
  else if (process.platform === 'linux') run('systemctl', ['--user', 'stop', SERVICE_LABEL], true);
  else if (process.platform === 'win32') {
    run('schtasks', ['/End', '/TN', SERVICE_LABEL], true);
    terminateRegisteredBridgeProcesses();
    cleanupStaleRuntimeState();
  }
}

export function restartService(options: ServiceOptions = {}) {
  if (process.platform === 'darwin') {
    const isLoaded = getServiceStatus().running;
    if (isLoaded) {
      stopService();
      const start = Date.now();
      while (Date.now() - start < 2000) {
        if (!getServiceStatus().running) {
          break;
        }
        spawnSync('sleep', ['0.1']);
      }
    }
    registerService(options);
    startService();
  } else if (process.platform === 'linux') {
    run('systemctl', ['--user', 'restart', SERVICE_LABEL], true);
  } else if (process.platform === 'win32') {
    stopService();
    registerService(options);
    startService();
  }
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

export async function getServiceHealthStatus(): Promise<ServiceStatus> {
  const installed = fs.existsSync(getServiceFilePath());
  if (process.platform !== 'win32') {
    return getServiceStatus();
  }

  const taskResult = spawnSync('schtasks', ['/Query', '/TN', SERVICE_LABEL], { encoding: 'utf8' });
  const taskRegistered = taskResult.status === 0;
  const processes = listProcesses();
  const runtime = readRuntimeFile();
  const runtimePidAlive = runtime ? isPidAlive(runtime.pid) : false;
  const ipcListening = runtime ? await isTcpPortListening(runtime.port) : false;
  const running = taskRegistered && processes.length > 0 && runtimePidAlive && ipcListening;

  const processText = processes.length > 0
    ? processes.map((record) => `${record.id}:${record.pid}`).join(',')
    : 'none';
  const runtimeText = runtime
    ? `pid=${runtime.pid} pidAlive=${runtimePidAlive} port=${runtime.port} ipc=${ipcListening ? 'ok' : 'down'}`
    : 'missing';
  const taskText = taskRegistered ? 'registered' : 'not registered';

  return {
    installed,
    running,
    message: `Task ${taskText}; bridge ${running ? 'healthy' : 'not healthy'}; processes=${processText}; runtime=${runtimeText}`,
  };
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

  const hiddenLauncher = getHiddenLauncherPath();
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Actions Context="Author"><Exec><Command>wscript.exe</Command><Arguments>//B //NoLogo "${escapeXml(hiddenLauncher)}"</Arguments></Exec></Actions>
</Task>
`;
}

function getHiddenLauncherPath(): string {
  return path.join(APP_DIR, 'hidden-start.vbs');
}

function renderWindowsHiddenLauncher(configPath: string, cliPath = getCliPath()): string {
  return [
    "' Hidden launcher for antigravity-lark-bridge",
    "' Runs the node bridge with no visible console window.",
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.Run "${escapeVbsArg(process.execPath)} ${escapeVbsArg(cliPath)} run --config ${escapeVbsArg(configPath)}", 0, False`,
    '',
  ].join('\r\n');
}

async function waitForHealthyStatus(timeoutMs = 8000): Promise<ServiceStatus> {
  const startedAt = Date.now();
  let last = await getServiceHealthStatus();
  while (!last.running && Date.now() - startedAt < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    last = await getServiceHealthStatus();
  }
  return last;
}

function cleanupStaleRuntimeState() {
  listProcesses();
  const runtime = readRuntimeFile();
  if (runtime && (!isPidAlive(runtime.pid) || !runtime.port)) {
    deleteRuntime();
  }
}

function terminateRegisteredBridgeProcesses() {
  for (const record of listProcesses()) {
    try {
      process.kill(record.pid, 'SIGTERM');
    } catch {
      // Process registry is best-effort; listProcesses prunes stale entries.
    }
  }

  const start = Date.now();
  while (Date.now() - start < 2500 && listProcesses().length > 0) {
    spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 100)']);
  }
}

function readRuntimeFile(): { port: number; pid: number } | null {
  try {
    if (!fs.existsSync(RUNTIME_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    if (typeof parsed?.port !== 'number' || typeof parsed?.pid !== 'number') return null;
    return { port: parsed.port, pid: parsed.pid };
  } catch {
    return null;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    return err.code === 'EPERM';
  }
}

function isTcpPortListening(port: number, host = '127.0.0.1', timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeVbsArg(value: string): string {
  return `""${value.replace(/"/g, '""""')}""`;
}

function run(command: string, args: string[], ignoreFailure = false) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (!ignoreFailure && result.status !== 0) throw new Error(result.stderr || result.stdout || `${command} failed`);
}
