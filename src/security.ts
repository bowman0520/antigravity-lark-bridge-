import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Resolve home directory shorthand (~)
function resolveHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return p.replace(/^~/, os.homedir());
  }
  return p;
}

// Find first existing ancestor directory
function findFirstExistingAncestor(p: string): string {
  let current = path.resolve(p);
  while (current !== path.dirname(current)) {
    if (fs.existsSync(current)) {
      return current;
    }
    current = path.dirname(current);
  }
  return current;
}

// Check if a path escapes the allowed workspace paths
export function isPathEscaped(targetPath: string, allowedWorkspaces: string[]): boolean {
  try {
    const absoluteTarget = path.resolve(resolveHome(targetPath));
    const firstExisting = findFirstExistingAncestor(absoluteTarget);
    const resolvedTarget = fs.realpathSync(firstExisting);

    for (const ws of allowedWorkspaces) {
      const resolvedWs = fs.realpathSync(resolveHome(ws));
      if (resolvedTarget === resolvedWs || resolvedTarget.startsWith(resolvedWs + path.sep)) {
        return false; // Valid path inside workspace
      }
    }
  } catch (err) {
    // If anything fails, default to deny for safety
  }
  return true; // Escaped or invalid path
}

// System paths that are always direct deny
const DISSALLOWED_SYSTEM_PATHS = [
  '~/.ssh',
  '~/.aws',
  '~/.config/gcloud',
  '~/.kube',
  '~/.docker/config.json',
  '~/.npmrc',
  '~/.pypirc',
  '/etc',
  '/private/etc',
  '/var/db',
  '~/Library/Keychains'
].map(p => path.normalize(resolveHome(p)));

export function isSensitiveSystemPath(targetPath: string): boolean {
  try {
    const resolvedTarget = fs.realpathSync(resolveHome(targetPath));
    for (const disallowed of DISSALLOWED_SYSTEM_PATHS) {
      try {
        const resolvedDisallowed = fs.realpathSync(disallowed);
        if (resolvedTarget === resolvedDisallowed || resolvedTarget.startsWith(resolvedDisallowed + path.sep)) {
          return true; // Match disallowed sensitive directory
        }
      } catch (err) {
        // Disallowed path doesn't exist on system, continue
      }
    }
  } catch (err) {
    // Target doesn't exist, check path segments for text matching as fallback
    const normalizedTarget = path.normalize(resolveHome(targetPath));
    for (const disallowed of DISSALLOWED_SYSTEM_PATHS) {
      if (normalizedTarget === disallowed || normalizedTarget.startsWith(disallowed + path.sep)) {
        return true;
      }
    }
  }
  return false;
}

// Secret Redactor regex patterns
const REDACT_PATTERNS: { type: string; regex: RegExp }[] = [
  { type: 'openai_key', regex: /sk-[a-zA-Z0-9]{48}/g },
  { type: 'github_pat', regex: /ghp_[a-zA-Z0-9]{36}|github_pat_[a-zA-Z0-9_]{82}/g },
  { type: 'google_api_key', regex: /AIzaSy[a-zA-Z0-9_-]{33}/g },
  { type: 'aws_access_key', regex: /AKIA[A-Z0-9]{16}/g },
  { type: 'anthropic_key', regex: /sk-ant-[a-zA-Z0-9-]+/g },
  { type: 'slack_token', regex: /xoxb-[a-zA-Z0-9-]+/g },
  { type: 'pem_private_key', regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g },
  { type: 'jwt', regex: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g },
  { type: 'bearer_token', regex: /Bearer [a-zA-Z0-9_-]{20,}/g },
  { type: 'sensitive_config', regex: /(PASSWORD|SECRET|TOKEN|API_KEY)\s*[:=]\s*["']?([^\s"']{8,})["']?/gi }
];

export function redactSecrets(text: string): string {
  if (!text) return text;
  let redacted = text;
  for (const pattern of REDACT_PATTERNS) {
    if (pattern.type === 'sensitive_config') {
      // For key-value matches, we want to keep the key and mask only the value
      redacted = redacted.replace(pattern.regex, (match, key, val) => {
        if (val && val.includes('[SECRET_MASKED:')) {
          return match;
        }
        // Keep the key, mask the value
        return `${key}: [SECRET_MASKED:type=sensitive_config]`;
      });
    } else {
      redacted = redacted.replace(pattern.regex, `[SECRET_MASKED:type=${pattern.type}]`);
    }
  }
  return redacted;
}
