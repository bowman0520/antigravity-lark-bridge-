import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

describe('process registry', () => {
  const originalHome = process.env.ANTIGRAVITY_LARK_HOME;

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.ANTIGRAVITY_LARK_HOME;
    } else {
      process.env.ANTIGRAVITY_LARK_HOME = originalHome;
    }
    jest.resetModules();
  });

  test('registers, lists, detects conflicts, and unregisters current process', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agl-process-test-'));
    process.env.ANTIGRAVITY_LARK_HOME = dir;
    jest.resetModules();
    const registry = require('./processRegistry');

    const record = registry.registerProcess({
      appId: 'cli_123',
      configPath: path.join(dir, 'config.json'),
      version: 'test',
    });

    expect(registry.listProcesses()).toHaveLength(1);
    expect(registry.findConflicts('cli_123', 999999)).toHaveLength(1);
    registry.unregisterProcess(record.id);
    expect(registry.listProcesses()).toHaveLength(0);
  });
});
