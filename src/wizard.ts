import * as fs from 'fs';
import * as path from 'path';
import * as qrcode from 'qrcode-terminal';
import * as larkSdk from '@larksuiteoapi/node-sdk';
import { Config, loadConfig, ResolvedConfig, saveDefaultConfig } from './config';
import { encryptedSecretRef, secretIdForApp, setSecret } from './keystore';
import { DEFAULT_FORWARDED_HOOK_LIMIT_BYTES, DEFAULT_HOOK_PAYLOAD_LIMIT_BYTES } from './payload';

export async function runSetupWizard(configPath: string): Promise<ResolvedConfig> {
  const defaultDir = path.dirname(configPath);
  if (!fs.existsSync(defaultDir)) {
    fs.mkdirSync(defaultDir, { recursive: true });
  }

  const defaultConfig: Config = {
    lark: {
      appId: '',
      appSecretRef: '',
      encryptKeyRef: '',
      verificationTokenRef: '',
      domain: 'feishu',
    },
    agent: {
      defaultWorkspace: process.cwd(),
      command: 'agy',
      args: [],
      mode: 'auto',
    },
    ipc: {
      host: '127.0.0.1',
      port: 3999,
      allowRandomPortOnConflict: true,
      approvalTimeoutSeconds: 600,
      maxPayloadSizeKb: 10240,
      hookPayloadLimitBytes: DEFAULT_HOOK_PAYLOAD_LIMIT_BYTES,
      forwardedHookLimitBytes: DEFAULT_FORWARDED_HOOK_LIMIT_BYTES,
    },
    media: {
      autoCompressImages: true,
      imageMaxWidthPx: 1600,
      imageJpegQuality: 82,
      imageMaxBytes: 1024 * 1024,
      maxImagesPerPrompt: 3,
      maxPromptChars: 12000,
    },
    access: {
      allowedUsers: [],
      allowedChats: [],
      admins: [],
    },
    reply: {
      requireMentionInGroup: true,
      mode: 'card',
      messageFlushIntervalMs: 1200,
      maxMessageChars: 3500,
    },
    security: {
      redactBeforeSend: true,
      debugRawLogs: false,
      groupWriteRequiresApproval: true,
      p2pWriteRequiresApproval: false,
    },
  };

  let existingConfig: any = {};
  if (fs.existsSync(configPath)) {
    try {
      existingConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (e) {}
  }

  const mergedConfig: Config = {
    ...defaultConfig,
    ...existingConfig,
    lark: {
      ...defaultConfig.lark,
      ...(existingConfig.lark || {}),
    },
    agent: {
      ...defaultConfig.agent,
      ...(existingConfig.agent || {}),
    },
    ipc: {
      ...defaultConfig.ipc,
      ...(existingConfig.ipc || {}),
    },
    media: {
      ...defaultConfig.media,
      ...(existingConfig.media || {}),
    },
    access: {
      ...defaultConfig.access,
      ...(existingConfig.access || {}),
    },
    reply: {
      ...defaultConfig.reply,
      ...(existingConfig.reply || {}),
    },
    security: {
      ...defaultConfig.security,
      ...(existingConfig.security || {}),
    },
  };

  console.log('\n======================================================');
  console.log('         Feishu/Lark App Registration Wizard          ');
  console.log('======================================================\n');
  console.log('This wizard will help you automatically create and register');
  console.log('a Feishu/Lark App using OAuth 2.0 Device Flow.');
  console.log('Please scan the QR code below or open the link using your');
  console.log('Feishu/Lark mobile app to authorize this application.\n');

  try {
    const result = await larkSdk.registerApp({
      onQRCodeReady(info) {
        console.log(`Verification URL: ${info.url}\n`);
        qrcode.generate(info.url, { small: true });
        console.log(`\nScan the QR code above. Link expires in ${info.expireIn} seconds.`);
        console.log('Waiting for authorization...');
      },
      onStatusChange(info) {
        if (info.status === 'domain_switched') {
          console.log('Detected an international Lark tenant and switched domain automatically.');
        } else if (info.status === 'slow_down') {
          console.log('Polling slowed down automatically.');
        }
      },
    });

    console.log('\nAuthorization successful!');
    console.log(`App ID: ${result.client_id}`);
    const detectedDomain = result.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu';
    const scannerOpenId = result.user_info?.open_id;
    console.log(`Tenant Brand: ${detectedDomain}\n`);

    const consoleDomain = detectedDomain === 'lark' ? 'open.larksuite.com' : 'open.feishu.cn';
    console.log('======================================================');
    console.log('    Step-by-Step Feishu/Lark Console Configuration    ');
    console.log('======================================================');
    console.log(`1. Enable Bot Feature:\n   https://${consoleDomain}/app/${result.client_id}/bot\n`);
    console.log(`2. Enable Scopes (im:message.p2p_msg:readonly, im:message.group_at_msg:readonly, im:message:send_as_bot):\n   https://${consoleDomain}/app/${result.client_id}/auth\n`);
    console.log(`3. Subscribe to "im.message.receive_v1" & set mode to WebSocket:\n   https://${consoleDomain}/app/${result.client_id}/event\n`);
    console.log(`4. Release a version to activate changes:\n   https://${consoleDomain}/app/${result.client_id}/version`);
    console.log('======================================================\n');

    const secretId = secretIdForApp(result.client_id);
    setSecret(secretId, result.client_secret);

    mergedConfig.lark.appId = result.client_id;
    mergedConfig.lark.appSecretRef = encryptedSecretRef(secretId);
    mergedConfig.lark.domain = detectedDomain;
    if (scannerOpenId) {
      mergedConfig.access.admins = Array.from(new Set([...(mergedConfig.access.admins || []), scannerOpenId]));
      console.log(`Admin user set to scanner open_id: ${scannerOpenId}`);
    } else if ((mergedConfig.access.admins || []).length === 0) {
      console.warn('Warning: scanner open_id was not returned. Admin commands remain unrestricted until access.admins is configured.');
    }

    saveDefaultConfig(configPath, mergedConfig);
    console.log(`Saved configuration to ${configPath} (owner-read/write only).`);
    console.log('App secret was encrypted into the local keystore.\n');

    return loadConfig(configPath);
  } catch (err: any) {
    console.error(`\nRegistration failed: ${err.description || err.message || err}`);
    throw err;
  }
}
