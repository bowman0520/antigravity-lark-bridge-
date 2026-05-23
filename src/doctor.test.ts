import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runDoctor } from './doctor';

describe('doctor', () => {
  test('reports missing config as failure', () => {
    const checks = runDoctor(path.join(os.tmpdir(), 'missing-antigravity-lark-config.json'));
    expect(checks[0]).toMatchObject({ name: 'config', status: 'fail' });
  });

  test('warns when admins are empty', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agl-doctor-test-'));
    process.env.ANTIGRAVITY_LARK_HOME = dir;
    jest.resetModules();
    const { setSecret } = require('./keystore');
    const { runDoctor: run } = require('./doctor');
    setSecret('app-cli_123', 'secret');
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({
      lark: {
        appId: 'cli_123',
        appSecretRef: { source: 'encrypted', id: 'app-cli_123' }
      },
      agent: {
        defaultWorkspace: dir,
        command: process.execPath,
        args: []
      },
      access: {
        admins: []
      }
    }, null, 2), { mode: 0o600 });

    const checks = run(configPath);
    expect(checks.find((check: any) => check.name === 'access.admins')).toMatchObject({ status: 'warn' });
    delete process.env.ANTIGRAVITY_LARK_HOME;
  });
});
