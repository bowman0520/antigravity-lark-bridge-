import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isPathEscaped, isSensitiveSystemPath, redactSecrets } from './security';

describe('Security Guard and Redactor Tests', () => {
  const testWorkspace = path.join(os.tmpdir(), 'antigravity-test-workspace');

  beforeAll(() => {
    if (!fs.existsSync(testWorkspace)) {
      fs.mkdirSync(testWorkspace, { recursive: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  test('isPathEscaped validates paths correctly', () => {
    const insidePath = path.join(testWorkspace, 'src', 'index.ts');
    const outsidePath = path.join(testWorkspace, '..', 'someone-else-workspace');

    // Make sure we create the directory or file paths to resolve realpath correctly if exists
    expect(isPathEscaped(insidePath, [testWorkspace])).toBe(false);
    expect(isPathEscaped(outsidePath, [testWorkspace])).toBe(true);
    expect(isPathEscaped(testWorkspace, [testWorkspace])).toBe(false);
  });

  test('isSensitiveSystemPath identifies disallowed paths', () => {
    expect(isSensitiveSystemPath('/etc/passwd')).toBe(true);
    expect(isSensitiveSystemPath(path.join(os.homedir(), '.ssh', 'id_rsa'))).toBe(true);
    expect(isSensitiveSystemPath(path.join(testWorkspace, 'src'))).toBe(false);
  });

  test('redactSecrets filters sensitive credentials', () => {
    const openAiText = 'My key is sk-123456789012345678901234567890123456789012345678';
    expect(redactSecrets(openAiText)).toBe('My key is [SECRET_MASKED:type=openai_key]');

    const githubPatText = 'Token: ghp_123456789012345678901234567890123456';
    expect(redactSecrets(githubPatText)).toBe('Token: [SECRET_MASKED:type=github_pat]');

    const envText = 'PASSWORD="mysecretpassword"';
    expect(redactSecrets(envText)).toBe('PASSWORD: [SECRET_MASKED:type=sensitive_config]');
  });
});
