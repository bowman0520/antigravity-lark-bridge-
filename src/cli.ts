#!/usr/bin/env node
import * as fs from 'fs';
import { Command } from 'commander';
import { loadConfig, migratePlaintextSecrets, ResolvedConfig } from './config';
import { listSecretIds, removeSecret, setSecret } from './keystore';
import { loadRuntime, generateIpcToken, saveRuntime, deleteRuntime } from './runtime';
import { logger } from './logger';
import { initWorkspaces } from './workspace';
import { createIpcServer } from './ipc';
import { LarkGateway } from './lark';
import { CONFIG_FILE } from './paths';
import { runSetupWizard } from './wizard';
import { formatDoctorChecks, runDoctor } from './doctor';
import { findConflicts, killProcess, listProcesses, registerProcess, unregisterProcess } from './processRegistry';
import { ensureServiceStarted, getServiceHealthStatus, restartService, stopService, unregisterService } from './daemon/serviceAdapter';
import {
  buildPayloadTooLargeDecision,
  byteLength,
  compactHookPayload,
  DEFAULT_FORWARDED_HOOK_LIMIT_BYTES,
  DEFAULT_HOOK_PAYLOAD_LIMIT_BYTES,
} from './payload';

const program = new Command();

program
  .name('antigravity-lark-bridge')
  .description('Local bridge connecting Antigravity with Feishu (Lark)')
  .version('1.0.0');

program
  .command('start')
  .description('Register and start the user-level bridge service')
  .option('-c, --config <path>', 'path to configuration file')
  .action(async (options) => {
    const status = await ensureServiceStarted({ configPath: options.config || CONFIG_FILE });
    console.log(`installed=${status.installed} running=${status.running} ${status.message}`);
  });

program
  .command('stop')
  .description('Stop the user-level bridge service')
  .action(() => {
    stopService();
    console.log('Bridge service stop requested.');
  });

program
  .command('restart')
  .description('Restart the user-level bridge service')
  .option('-c, --config <path>', 'path to configuration file')
  .action((options) => {
    restartService({ configPath: options.config || CONFIG_FILE });
    console.log('Bridge service restart requested.');
  });

program
  .command('status')
  .description('Show user-level bridge service status')
  .action(async () => {
    const status = await getServiceHealthStatus();
    console.log(`installed=${status.installed} running=${status.running} ${status.message}`);
  });

program
  .command('unregister')
  .description('Stop and remove the user-level bridge service')
  .action(() => {
    unregisterService();
    console.log('Bridge service unregistered.');
  });

program
  .command('ps')
  .description('List running bridge processes')
  .action(() => {
    const processes = listProcesses();
    if (processes.length === 0) {
      console.log('No running bridge processes found.');
      return;
    }
    processes.forEach((record, index) => {
      console.log(`${index + 1}. ${record.id} pid=${record.pid} app=${record.appId} config=${record.configPath} started=${record.startedAt}`);
    });
  });

program
  .command('kill <idOrIndex>')
  .description('Stop a running bridge process by registry ID or list index')
  .action((idOrIndex) => {
    if (!killProcess(idOrIndex)) {
      console.error(`No running bridge process matched: ${idOrIndex}`);
      process.exit(1);
    }
    console.log(`Sent SIGTERM to bridge process: ${idOrIndex}`);
  });

program
  .command('doctor')
  .description('Run local bridge diagnostics')
  .option('-c, --config <path>', 'path to configuration file')
  .action((options) => {
    const checks = runDoctor(options.config || CONFIG_FILE);
    console.log(formatDoctorChecks(checks));
    if (checks.some((check) => check.status === 'fail')) process.exit(1);
  });

program
  .command('migrate')
  .description('Migrate plaintext config secrets into the encrypted local keystore')
  .option('-c, --config <path>', 'path to configuration file')
  .option('--dry-run', 'only report whether migration is needed')
  .action((options) => {
    const actualPath = options.config || CONFIG_FILE;
    if (options.dryRun) {
      const resolved = loadConfig(actualPath);
      console.log(`Config can be loaded for app ${resolved.lark.appId}. Run without --dry-run to migrate plaintext secrets if present.`);
      return;
    }
    const migrated = migratePlaintextSecrets(actualPath);
    console.log(migrated ? 'Migrated plaintext app secret into encrypted local keystore.' : 'No plaintext app secret migration needed.');
  });

const secrets = program.command('secrets').description('Manage encrypted local secrets');

secrets
  .command('list')
  .description('List encrypted secret IDs')
  .action(() => {
    for (const id of listSecretIds()) console.log(id);
  });

secrets
  .command('set <id> <value>')
  .description('Store a secret value in the encrypted keystore')
  .action((id, value) => {
    setSecret(id, value);
    console.log(`Stored encrypted secret: ${id}`);
  });

secrets
  .command('remove <id>')
  .description('Remove a secret from the encrypted keystore')
  .action((id) => {
    console.log(removeSecret(id) ? `Removed encrypted secret: ${id}` : `Secret not found: ${id}`);
  });

program
  .command('run')
  .description('Run the Feishu bridge server')
  .option('-c, --config <path>', 'path to configuration file')
  .option('--allow-duplicate', 'allow another live bridge process for the same app ID')
  .action(async (options) => {
    try {
      const actualPath = options.config || CONFIG_FILE;

      let resolvedConfig: ResolvedConfig;
      let processRecordId = '';
      let needsWizard = false;

      if (!fs.existsSync(actualPath)) {
        logger.info('bridge.config_missing', { path: actualPath, message: 'Configuration file not found. Starting setup wizard...' });
        needsWizard = true;
      } else {
        try {
          if (migratePlaintextSecrets(actualPath)) {
            logger.info('bridge.config_migrated', { message: 'Plaintext app secret migrated to encrypted local keystore.' });
          }
          resolvedConfig = loadConfig(actualPath);
          if (resolvedConfig.lark.appId === 'cli_mock_id' || resolvedConfig.lark.appSecret === 'cli_mock_secret' || !resolvedConfig.lark.appId || !resolvedConfig.lark.appSecret) {
            logger.info('bridge.placeholder_detected', { message: 'Placeholder or empty credentials detected. Starting setup wizard...' });
            needsWizard = true;
          }
        } catch (err: any) {
          logger.warn('bridge.config_load_failed', { message: `Failed to load config: ${err.message}. Starting setup wizard...` });
          needsWizard = true;
        }
      }

      if (needsWizard) {
        resolvedConfig = await runSetupWizard(actualPath);
      } else {
        resolvedConfig = loadConfig(actualPath);
      }

      const conflicts = findConflicts(resolvedConfig.lark.appId);
      if (conflicts.length > 0 && !options.allowDuplicate) {
        const detail = conflicts.map((record) => `${record.id} pid=${record.pid} config=${record.configPath}`).join('; ');
        throw new Error(`Another bridge process is already running for app ${resolvedConfig.lark.appId}: ${detail}. Stop it with 'antigravity-lark-bridge kill <id>' or pass --allow-duplicate.`);
      }

      const processRecord = registerProcess({
        appId: resolvedConfig.lark.appId,
        configPath: actualPath,
        version: program.version() || 'unknown',
      });
      processRecordId = processRecord.id;

      logger.info('bridge.start', {
        configPath: actualPath,
        workspace: resolvedConfig.agent.defaultWorkspace,
        processId: processRecord.id,
      });

      // 1. Initialize workspaces
      initWorkspaces(resolvedConfig);

      // 2. Generate high-entropy IPC token
      const token = generateIpcToken();

      // 3. Create IPC server
      const server = createIpcServer(token, resolvedConfig.ipc.maxPayloadSizeKb);
      let port = resolvedConfig.ipc.port;
      const host = resolvedConfig.ipc.host || '127.0.0.1';

      await new Promise<void>((resolve, reject) => {
        const startListening = (p: number) => {
          server.listen(p, host);
        };

        server.once('listening', () => {
          const address = server.address();
          if (address && typeof address === 'object') {
            port = address.port;
          }
          logger.info('ipc.server_started', { host, port });
          resolve();
        });

        server.on('error', (err: any) => {
          if (err.code === 'EADDRINUSE' && resolvedConfig.ipc.allowRandomPortOnConflict && port === resolvedConfig.ipc.port) {
            logger.warn('ipc.port_in_use', { port: resolvedConfig.ipc.port, message: 'Trying random port...' });
            startListening(0); // 0 assigns a random free port
          } else {
            reject(err);
          }
        });

        startListening(port);
      });

      // 4. Save runtime configuration
      saveRuntime(port, token);
      logger.info('runtime.saved', { port, pid: process.pid });

      // 5. Start Lark Gateway WebSocket client
      const gateway = new LarkGateway(resolvedConfig);
      await gateway.start();
      logger.info('bridge.ready');

      // 6. Setup process signal/exit handlers for cleanup
      let cleaningUp = false;
      const cleanup = async (signal?: string) => {
        if (cleaningUp) return;
        cleaningUp = true;
        logger.info('bridge.stopping', { signal });
        try {
          await gateway.stop();
        } catch (e) {}
        try {
          server.close();
        } catch (e) {}
        try {
          deleteRuntime();
        } catch (e) {}
        try {
          if (processRecordId) unregisterProcess(processRecordId);
        } catch (e) {}
        logger.info('bridge.stopped');
        process.exit(0);
      };

      process.on('SIGINT', () => cleanup('SIGINT'));
      process.on('SIGTERM', () => cleanup('SIGTERM'));
      process.on('exit', () => {
        try {
          deleteRuntime();
        } catch (e) {}
        try {
          if (processRecordId) unregisterProcess(processRecordId);
        } catch (e) {}
      });

    } catch (err: any) {
      logger.error('bridge.failed_to_start', err.message);
      try {
        deleteRuntime();
      } catch (e) {}
      process.exit(1);
    }
  });

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
    process.stdin.on('error', (err) => {
      reject(err);
    });
  });
}

const hook = program.command('hook').description('Antigravity tool lifecycle hook commands');

hook
  .command('pre-tool-use')
  .description('Pre-tool execution hook')
  .action(async () => {
    try {
      const input = await readStdin();
      const payloadBytes = byteLength(input);
      let configPayloadLimit = DEFAULT_HOOK_PAYLOAD_LIMIT_BYTES;
      try {
        configPayloadLimit = loadConfig().ipc.hookPayloadLimitBytes;
      } catch (err) {}
      if (payloadBytes > configPayloadLimit) {
        logger.warn('hook.payload_too_large', { payloadBytes, limitBytes: configPayloadLimit });
        console.log(JSON.stringify(buildPayloadTooLargeDecision(payloadBytes, configPayloadLimit)));
        process.exit(0);
      }
      
      // Load runtime data
      let runtime;
      try {
        runtime = loadRuntime();
      } catch (err: any) {
        // Safe default: deny if bridge is not running
        console.log(JSON.stringify({
          decision: 'deny',
          reason: `Bridge not running or runtime access error: ${err.message}`
        }));
        process.exit(0);
      }

      // Query local HTTP server
      const url = `http://127.0.0.1:${runtime.port}/api/approval`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${runtime.ipcToken}`
        },
        body: input,
      });

      if (!response.ok) {
        const text = await response.text();
        console.log(JSON.stringify({
          decision: 'deny',
          reason: `Bridge IPC returned status ${response.status}: ${text}`
        }));
        process.exit(0);
      }

      const resBody = await response.json();
      console.log(JSON.stringify(resBody));
    } catch (err: any) {
      console.log(JSON.stringify({
        decision: 'deny',
        reason: `Hook helper execution error: ${err.message}`
      }));
    }
    process.exit(0);
  });

hook
  .command('post-tool-use')
  .description('Post-tool execution hook')
  .action(async () => {
    try {
      const input = await readStdin();
      let forwardedLimit = DEFAULT_FORWARDED_HOOK_LIMIT_BYTES;
      try {
        forwardedLimit = loadConfig().ipc.forwardedHookLimitBytes;
      } catch (err) {}
      const body = compactHookPayload(input, forwardedLimit);
      let runtime;
      try {
        runtime = loadRuntime();
      } catch (err) {
        process.exit(0);
      }

      const url = `http://127.0.0.1:${runtime.port}/hook/post-tool-use`;
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${runtime.ipcToken}`
        },
        body,
      });
    } catch (err) {
      // Ignore errors on post-tool-use notification
    }
    process.exit(0);
  });

hook
  .command('stop')
  .description('Stop task notification hook')
  .action(async () => {
    try {
      const input = await readStdin();
      let forwardedLimit = DEFAULT_FORWARDED_HOOK_LIMIT_BYTES;
      try {
        forwardedLimit = loadConfig().ipc.forwardedHookLimitBytes;
      } catch (err) {}
      const body = compactHookPayload(input, forwardedLimit);
      let runtime;
      try {
        runtime = loadRuntime();
      } catch (err) {
        process.exit(0);
      }

      const url = `http://127.0.0.1:${runtime.port}/hook/stop`;
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${runtime.ipcToken}`
        },
        body,
      });
    } catch (err) {
      // Ignore errors on stop hook notification
    }
    process.exit(0);
  });

program.parse(process.argv);
