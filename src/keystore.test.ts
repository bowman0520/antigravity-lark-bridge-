import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('Encrypted keystore', () => {
  const originalHome = process.env.ANTIGRAVITY_LARK_HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.ANTIGRAVITY_LARK_HOME;
    } else {
      process.env.ANTIGRAVITY_LARK_HOME = originalHome;
    }
    jest.resetModules();
  });

  test('stores, reads, lists, and removes encrypted secrets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agl-keystore-test-'));
    process.env.ANTIGRAVITY_LARK_HOME = dir;
    jest.resetModules();
    const keystore = require('./keystore');

    keystore.setSecret('app-cli_123', 'super-secret');

    expect(keystore.getSecret('app-cli_123')).toBe('super-secret');
    expect(keystore.listSecretIds()).toEqual(['app-cli_123']);
    expect(fs.readFileSync(path.join(dir, 'secrets.enc'), 'utf8')).not.toContain('super-secret');
    expect(keystore.removeSecret('app-cli_123')).toBe(true);
    expect(keystore.getSecret('app-cli_123')).toBeUndefined();
  });
});
