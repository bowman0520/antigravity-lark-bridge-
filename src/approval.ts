import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { isPathEscaped, isSensitiveSystemPath, redactSecrets } from './security';
import { APPROVALS_FILE } from './paths';

export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'cancelled'
  | 'failed';

export interface ApprovalRequest {
  approvalId: string;
  sessionId: string;
  conversationId: string;
  toolCallId: string;
  stepIdx: number;
  scope: string;
  chatId: string;
  messageId: string;
  cardMessageId: string;
  workspace: string;
  toolName: string;
  toolArgs: any;
  toolArgsPreview: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  riskReason: string;
  status: ApprovalStatus;
  requesterId?: string;
  decidedBy?: string;
  nonce: string;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
}

const MAX_TOOL_ARGS_PREVIEW_CHARS = 12000;
const MAX_STORED_TOOL_ARGS_CHARS = 65536;
const MAX_SAFE_LINE_RANGE = 200;
const LARGE_OUTPUT_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'logs',
  'scratch',
]);
const LARGE_FILE_EXTENSIONS = new Set(['.log', '.jsonl']);

// In-memory cache of approvals
let approvalsCache: Record<string, ApprovalRequest> = {};

function loadApprovals() {
  const dir = path.dirname(APPROVALS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(APPROVALS_FILE)) {
    try {
      const raw = fs.readFileSync(APPROVALS_FILE, 'utf8');
      approvalsCache = JSON.parse(raw);
    } catch (err) {
      approvalsCache = {};
    }
  } else {
    approvalsCache = {};
  }
}

export function saveApprovals() {
  try {
    fs.writeFileSync(APPROVALS_FILE, JSON.stringify(approvalsCache, null, 2), {
      mode: 0o600,
      encoding: 'utf8',
    });
  } catch (err) {
    // Ignore errors writing approvals
  }
}

// Initialize on load
loadApprovals();

export function generateNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

export function generateId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString('hex')}`;
}

// Evaluate tool risk level and decision
export interface PolicyDecision {
  decision: 'allow' | 'deny' | 'require_approval';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  reason: string;
}

export function evaluatePolicy(
  toolName: string,
  args: any,
  workspace: string,
  allowedWorkspaces: string[]
): PolicyDecision {
  // 1. Path Escape Check
  const checkPaths = [];
  if (args.Cwd) checkPaths.push(args.Cwd);
  if (args.TargetFile) checkPaths.push(args.TargetFile);
  if (args.AbsolutePath) checkPaths.push(args.AbsolutePath);

  for (const p of checkPaths) {
    if (isSensitiveSystemPath(p)) {
      return {
        decision: 'deny',
        riskLevel: 'critical',
        reason: `Access to sensitive system path is blocked: ${p}`,
      };
    }
    if (isPathEscaped(p, allowedWorkspaces)) {
      return {
        decision: 'deny',
        riskLevel: 'critical',
        reason: `Path escapes the allowed workspace: ${p}`,
      };
    }
  }

  const payloadGuard = evaluatePayloadGuard(toolName, args, workspace);
  if (payloadGuard) {
    return payloadGuard;
  }

  // 2. Direct Deny Commands
  if (toolName === 'run_command' && args.CommandLine) {
    const cmd: string = args.CommandLine.trim();
    if (cmd.includes('sudo') || cmd.includes('su ')) {
      return {
        decision: 'deny',
        riskLevel: 'critical',
        reason: 'Execution of sudo or privilege escalation is blocked.',
      };
    }
  }

  // 3. Auto-Allow Read-Only Tools
  const readOnlyTools = ['grep_search', 'list_dir', 'view_file'];
  if (readOnlyTools.includes(toolName)) {
    return {
      decision: 'allow',
      riskLevel: 'low',
      reason: 'Read-only developer tool inside workspace.',
    };
  }

  if (toolName === 'run_command' && args.CommandLine) {
    const cmd: string = args.CommandLine.trim();
    // Check shell metacharacters
    const hasMetachars = /[&|;><`$]/.test(cmd);
    if (!hasMetachars) {
      if (/^git (status|diff|log|show|branch)$/.test(cmd) || cmd === 'pwd' || /^rg\s+.+$/.test(cmd)) {
        return {
          decision: 'allow',
          riskLevel: 'low',
          reason: 'Read-only terminal command.',
        };
      }
    }
  }

  // 4. Default require_approval / Risk Grading
  if (toolName === 'run_command') {
    const cmd: string = args.CommandLine || '';
    if (cmd.includes('install') || cmd.includes('build') || cmd.includes('test') || cmd.includes('make')) {
      return {
        decision: 'require_approval',
        riskLevel: 'medium',
        reason: 'Build/test or dependency installation execution.',
      };
    }
    if (cmd.includes('rm') || cmd.includes('delete') || cmd.includes('git push')) {
      return {
        decision: 'require_approval',
        riskLevel: 'high',
        reason: 'Destructive command or git push to remote repository.',
      };
    }
    return {
      decision: 'require_approval',
      riskLevel: 'medium',
      reason: 'Generic shell execution.',
    };
  }

  // File replacement and writing tools
  const fileWriteTools = ['write_to_file', 'replace_file_content', 'multi_replace_file_content'];
  if (fileWriteTools.includes(toolName)) {
    return {
      decision: 'require_approval',
      riskLevel: 'high',
      reason: 'Writing or modifying local files.',
    };
  }

  return {
    decision: 'require_approval',
    riskLevel: 'medium',
    reason: `Generic tool execution: ${toolName}`,
  };
}

function evaluatePayloadGuard(
  toolName: string,
  args: any,
  workspace: string
): PolicyDecision | null {
  const normalizedTool = toolName.toLowerCase();

  if (normalizedTool === 'view_file') {
    const filePath = getStringArg(args, ['AbsolutePath', 'Path', 'path']);
    const range = getLineRange(args);
    if (range && range > MAX_SAFE_LINE_RANGE) {
      return denyForPayload(
        `view_file line range is ${range} lines. Read at most ${MAX_SAFE_LINE_RANGE} lines per request.`
      );
    }
    if (filePath && isLargeOutputPath(filePath) && (!range || range > MAX_SAFE_LINE_RANGE)) {
      return denyForPayload(
        `Refusing full read of large/log path: ${filePath}. Use StartLine and EndLine with at most ${MAX_SAFE_LINE_RANGE} lines.`
      );
    }
  }

  if (normalizedTool === 'list_dir') {
    const dirPath = getStringArg(args, ['AbsolutePath', 'Path', 'DirectoryPath', 'SearchPath', 'path']) || workspace;
    if (isWorkspaceRoot(dirPath, workspace)) {
      return denyForPayload(
        'Refusing to list the workspace root. Target a specific subdirectory to avoid huge directory payloads.'
      );
    }
    if (isLargeOutputPath(dirPath)) {
      return denyForPayload(
        `Refusing to list large/generated directory: ${dirPath}. Avoid node_modules, dist, build, .git, logs, temp, and scratch.`
      );
    }
  }

  if (normalizedTool === 'grep_search') {
    const searchPath = getStringArg(args, ['SearchPath', 'Path', 'DirectoryPath', 'Cwd', 'path']) || workspace;
    if (isWorkspaceRoot(searchPath, workspace)) {
      return denyForPayload(
        'Refusing broad grep_search at workspace root. Set SearchPath to a focused subdirectory and use Includes filters.'
      );
    }
    if (isLargeOutputPath(searchPath)) {
      return denyForPayload(
        `Refusing grep_search inside large/generated path: ${searchPath}. Avoid node_modules, dist, build, .git, logs, temp, and scratch.`
      );
    }
  }

  if (normalizedTool === 'run_command') {
    const command = String(args?.CommandLine || '').trim();
    if (isLikelyLargeOutputCommand(command)) {
      return denyForPayload(
        'Command may produce too much output for the Antigravity bridge. Add a hard output limit such as `| head -n 200`, `| tail -n 100`, `git log -n 20`, or narrow the target path.'
      );
    }
  }

  return null;
}

function denyForPayload(reason: string): PolicyDecision {
  return {
    decision: 'deny',
    riskLevel: 'medium',
    reason: `Payload guard: ${reason}`,
  };
}

function getStringArg(args: any, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function getLineRange(args: any): number | null {
  const start = Number(args?.StartLine ?? args?.startLine);
  const end = Number(args?.EndLine ?? args?.endLine);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.abs(end - start) + 1;
}

function isWorkspaceRoot(targetPath: string, workspace: string): boolean {
  if (!targetPath || !workspace) return false;
  const resolvedTarget = path.resolve(targetPath);
  const resolvedWorkspace = path.resolve(workspace);
  return resolvedTarget === resolvedWorkspace;
}

function isLargeOutputPath(targetPath: string): boolean {
  const normalized = path.normalize(targetPath);
  const segments = normalized.split(path.sep).filter(Boolean);
  if (segments.some((segment) => LARGE_OUTPUT_DIRS.has(segment))) return true;
  return LARGE_FILE_EXTENSIONS.has(path.extname(normalized).toLowerCase());
}

function isLikelyLargeOutputCommand(command: string): boolean {
  if (!command) return false;
  const lowered = command.toLowerCase();
  const hasOutputLimit = /\|\s*(head|tail)\b|sed\s+-n|--max-count(?:=|\s+)\d+|\s-n\s+\d+/.test(lowered);
  if (hasOutputLimit) return false;

  if (/(^|\s)find\s+(\.|\S+)/.test(lowered)) return true;
  if (/\bls\s+.*\s-r\b|\bls\s+-[^|]*r/.test(lowered)) return true;
  if (/\bcat\s+.*\.(log|jsonl)\b/.test(lowered)) return true;
  if (/\bgit\s+log\b/.test(lowered)) return true;
  if (/(node_modules|\/\.git\b|\/dist\b|\/build\b|\/logs\b)/.test(lowered)) return true;

  return false;
}

function safeJsonStringify(value: any): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (err) {
    return JSON.stringify({ unserializable: true, type: typeof value });
  }
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const omitted = value.length - maxChars;
  return `${value.slice(0, maxChars)}\n... [truncated ${omitted} chars to keep approval payload small]`;
}

export function createApprovalRequest(params: {
  sessionId: string;
  conversationId: string;
  toolCallId: string;
  stepIdx: number;
  scope: string;
  chatId: string;
  messageId: string;
  workspace: string;
  toolName: string;
  toolArgs: any;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  riskReason: string;
  requesterId?: string;
  timeoutSeconds: number;
}): ApprovalRequest {
  const approvalId = generateId('apr');
  const nonce = generateNonce();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + params.timeoutSeconds * 1000).toISOString();

  // Create a bounded preview of tool args. Large tool payloads can overflow
  // Feishu cards and the local approval store, so keep only the actionable part.
  const redactedArgsJson = redactSecrets(safeJsonStringify(params.toolArgs));
  const toolArgsPreview = truncateText(redactedArgsJson, MAX_TOOL_ARGS_PREVIEW_CHARS);
  const toolArgs =
    redactedArgsJson.length > MAX_STORED_TOOL_ARGS_CHARS
      ? {
          truncated: true,
          preview: truncateText(redactedArgsJson, MAX_STORED_TOOL_ARGS_CHARS),
        }
      : params.toolArgs;

  const req: ApprovalRequest = {
    approvalId,
    sessionId: params.sessionId,
    conversationId: params.conversationId,
    toolCallId: params.toolCallId,
    stepIdx: params.stepIdx,
    scope: params.scope,
    chatId: params.chatId,
    messageId: params.messageId,
    cardMessageId: '', // To be filled once card is sent
    workspace: params.workspace,
    toolName: params.toolName,
    toolArgs,
    toolArgsPreview,
    riskLevel: params.riskLevel,
    riskReason: params.riskReason,
    status: 'pending',
    requesterId: params.requesterId,
    nonce,
    createdAt,
    expiresAt,
  };

  approvalsCache[approvalId] = req;
  saveApprovals();
  return req;
}

export function getApproval(approvalId: string): ApprovalRequest | undefined {
  return approvalsCache[approvalId];
}

export function updateApprovalStatus(
  approvalId: string,
  status: ApprovalStatus,
  decidedBy?: string
) {
  const req = approvalsCache[approvalId];
  if (req) {
    req.status = status;
    req.decidedAt = new Date().toISOString();
    if (decidedBy) {
      req.decidedBy = decidedBy;
    }
    saveApprovals();
  }
}
