import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KEYSTORE_SALT_FILE, SECRETS_FILE } from './paths';

const KEY_LEN = 32;
const IV_LEN = 12;
const TAG_LEN = 16;
const PBKDF2_ITERATIONS = 100_000;
const FILE_VERSION = 1;

export interface EncryptedSecretRef {
  source: 'encrypted';
  id: string;
}

interface SecretEnvelope {
  iv: string;
  data: string;
  tag: string;
}

interface SecretStore {
  version: number;
  entries: Record<string, SecretEnvelope>;
}

const EMPTY_STORE: SecretStore = { version: FILE_VERSION, entries: {} };

export function encryptedSecretRef(id: string): EncryptedSecretRef {
  return { source: 'encrypted', id };
}

export function secretIdForApp(appId: string): string {
  return `app-${appId}`;
}

export function isEncryptedSecretRef(value: unknown): value is EncryptedSecretRef {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as any).source === 'encrypted' &&
      typeof (value as any).id === 'string' &&
      (value as any).id.length > 0
  );
}

export function getSecret(id: string): string | undefined {
  const store = readStore();
  const envelope = store.entries[id];
  if (!envelope) return undefined;
  return decrypt(deriveKey(), envelope);
}

export function setSecret(id: string, plaintext: string) {
  const store = readStore();
  store.entries[id] = encrypt(deriveKey(), plaintext);
  writeStore(store);
}

export function removeSecret(id: string): boolean {
  const store = readStore();
  if (!(id in store.entries)) return false;
  delete store.entries[id];
  writeStore(store);
  return true;
}

export function listSecretIds(): string[] {
  return Object.keys(readStore().entries).sort();
}

function readStore(): SecretStore {
  try {
    const parsed = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
    if (parsed?.version !== FILE_VERSION || !parsed.entries || typeof parsed.entries !== 'object') {
      return { ...EMPTY_STORE, entries: {} };
    }
    return { version: FILE_VERSION, entries: { ...parsed.entries } };
  } catch (err: any) {
    if (err.code === 'ENOENT') return { ...EMPTY_STORE, entries: {} };
    throw err;
  }
}

function writeStore(store: SecretStore) {
  const dir = path.dirname(SECRETS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${SECRETS_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600, encoding: 'utf8' });
  fs.renameSync(tmp, SECRETS_FILE);
}

function loadOrCreateSalt(): Buffer {
  try {
    const salt = fs.readFileSync(KEYSTORE_SALT_FILE);
    if (salt.length === KEY_LEN) return salt;
  } catch (err: any) {
    if (err.code !== 'ENOENT') throw err;
  }

  const salt = crypto.randomBytes(KEY_LEN);
  const dir = path.dirname(KEYSTORE_SALT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = `${KEYSTORE_SALT_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, salt, { mode: 0o600 });
  fs.renameSync(tmp, KEYSTORE_SALT_FILE);
  return salt;
}

function deriveKey(): Buffer {
  const seed = `${os.hostname()}|${os.userInfo().username}`;
  return crypto.pbkdf2Sync(seed, loadOrCreateSalt(), PBKDF2_ITERATIONS, KEY_LEN, 'sha256');
}

function encrypt(key: Buffer, plaintext: string): SecretEnvelope {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    data: data.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

function decrypt(key: Buffer, envelope: SecretEnvelope): string {
  const iv = Buffer.from(envelope.iv, 'base64');
  const data = Buffer.from(envelope.data, 'base64');
  const tag = Buffer.from(envelope.tag, 'base64');
  if (iv.length !== IV_LEN) throw new Error('Invalid encrypted secret IV length.');
  if (tag.length !== TAG_LEN) throw new Error('Invalid encrypted secret auth tag length.');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
