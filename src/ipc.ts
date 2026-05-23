import * as http from 'http';
import { logger } from './logger';
import { evaluatePolicy, createApprovalRequest, updateApprovalStatus, getApproval, generateId } from './approval';
import { getAllowedWorkspaces } from './workspace';
import { sessionManager } from './session';

export interface PendingRequest {
  res: http.ServerResponse;
  timeoutId: NodeJS.Timeout;
}

export const pendingIpcRequests: Map<string, PendingRequest> = new Map();

// Helper to send JSON responses
export function sendJson(res: http.ServerResponse, statusCode: number, data: any) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// Global hook to send card (will be registered by lark.ts)
let sendApprovalCardCallback: ((req: any) => Promise<string>) | null = null;

export function registerCardCallback(callback: (req: any) => Promise<string>) {
  sendApprovalCardCallback = callback;
}

export function createIpcServer(token: string, maxPayloadSizeKb: number = 10240): http.Server {
  const server = http.createServer((req, res) => {
    // 1. Verify Bearer Token
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn('ipc.unauthorized', { reason: 'Missing or malformed Authorization header' });
      return sendJson(res, 401, { error: 'Unauthorized' });
    }
    const reqToken = authHeader.substring(7);
    if (reqToken !== token) {
      logger.warn('ipc.unauthorized', { reason: 'Invalid token' });
      return sendJson(res, 401, { error: 'Unauthorized' });
    }

    // 2. Limit request size
    let body = '';
    let bodySize = 0;
    const maxBodySize = maxPayloadSizeKb * 1024;

    req.on('data', (chunk) => {
      bodySize += chunk.length;
      if (bodySize > maxBodySize) {
        logger.error('ipc.payload_too_large', `Request payload exceeded ${maxPayloadSizeKb}KB limit`);
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Payload Too Large' }));
        req.destroy();
      } else {
        body += chunk;
      }
    });

    req.on('end', async () => {
      if (res.writableEnded) return;

      const url = req.url || '';
      const method = req.method || 'GET';

      try {
        if (url === '/api/approval' && method === 'POST') {
          const payload = JSON.parse(body);
          const toolCall = payload.toolCall;
          const conversationId = payload.conversationId;
          const stepIdx = payload.stepIdx;
          const workspacePaths = payload.workspacePaths || [];

          if (!toolCall || !conversationId) {
            return sendJson(res, 400, { error: 'Missing toolCall or conversationId' });
          }

          // Find active session for this conversation ID
          // In MVP, we might look up which session has this conversationId.
          // Let's search if any session matches.
          // If not found, we fallback to default workspace / default chat
          let scope = 'default';
          let workspace = workspacePaths[0] || getAllowedWorkspaces()[0] || '';
          let chatId = '';
          let messageId = '';
          let requesterId = '';

          // Find session by conversation ID
          // We can scan the sessions in sessionManager
          const allowed = getAllowedWorkspaces();

          // Evaluate policy
          const policy = evaluatePolicy(toolCall.name, toolCall.args, workspace, allowed);
          logger.info('policy.evaluated', {
            toolName: toolCall.name,
            decision: policy.decision,
            riskLevel: policy.riskLevel,
            reason: policy.reason,
          });

          if (policy.decision === 'allow') {
            return sendJson(res, 200, {
              decision: 'allow',
              reason: 'Policy engine auto-approved.',
            });
          }

          if (policy.decision === 'deny') {
            return sendJson(res, 200, {
              decision: 'deny',
              reason: `Policy engine denied: ${policy.reason}`,
            });
          }

          // Check if we can route to an active session
          // We need a way to find which Feishu chat is running this.
          // In adapter.ts (Milestone 5), when we start Antigravity, we set the association:
          // conversationId -> session. We can look it up using a session map or sessionManager.
          // Let's look up the session by conversationId in sessionManager
          let activeSession = null;
          // Let's search inside sessionManager. (We can add a getSessionByConversationId to sessionManager)
          // Wait, let's find the session scope
          // We can cast sessionManager to access sessions or add a method.
          // Let's add a helper to sessionManager or search here:
          const sessionsObj = (sessionManager as any).sessions;
          if (sessionsObj instanceof Map) {
            for (const s of sessionsObj.values()) {
              if (s.conversationId === conversationId) {
                activeSession = s;
                break;
              }
            }
          }

          if (activeSession) {
            scope = activeSession.scope;
            workspace = activeSession.workspace;
            // Parse chat_id from scope e.g. "p2p:oc_xxx" -> "oc_xxx"
            const parts = scope.split(':');
            chatId = parts[1] || '';
            // Get original message ID if enqueued
            // (We will save the last message id in the session or map)
            messageId = (activeSession as any).lastMessageId || '';
            requesterId = (activeSession as any).lastRequesterId || '';
          }

          // Create approval request
          const approvalReq = createApprovalRequest({
            sessionId: scope,
            conversationId,
            toolCallId: toolCall.id || generateId('tc'),
            stepIdx,
            scope,
            chatId,
            messageId,
            workspace,
            toolName: toolCall.name,
            toolArgs: toolCall.args,
            riskLevel: policy.riskLevel,
            riskReason: policy.reason,
            requesterId,
            timeoutSeconds: 600, // 10 minutes
          });

          // Change session status to AWAITING_APPROVAL
          if (activeSession) {
            sessionManager.setStatus(activeSession.scope, 'AWAITING_APPROVAL');
          }

          // Register pending response
          const timeoutId = setTimeout(() => {
            const pending = pendingIpcRequests.get(approvalReq.approvalId);
            if (pending) {
              logger.warn('approval.timeout', { approvalId: approvalReq.approvalId });
              updateApprovalStatus(approvalReq.approvalId, 'expired');
              if (activeSession) {
                sessionManager.setStatus(activeSession.scope, 'EXPIRED');
              }
              sendJson(pending.res, 200, {
                decision: 'deny',
                reason: 'Approval timeout (10 minutes elapsed).',
              });
              pendingIpcRequests.delete(approvalReq.approvalId);
            }
          }, 600 * 1000);

          pendingIpcRequests.set(approvalReq.approvalId, { res, timeoutId });

          // Trigger Feishu Card sending
          if (sendApprovalCardCallback) {
            try {
              const cardMessageId = await sendApprovalCardCallback(approvalReq);
              approvalReq.cardMessageId = cardMessageId;
            } catch (cardErr: any) {
              logger.error('approval.card_error', cardErr.message);
              // Fail the approval immediately if card fails to send
              clearTimeout(timeoutId);
              pendingIpcRequests.delete(approvalReq.approvalId);
              updateApprovalStatus(approvalReq.approvalId, 'failed');
              if (activeSession) {
                sessionManager.setStatus(activeSession.scope, 'FAILED');
              }
              sendJson(res, 200, {
                decision: 'deny',
                reason: `Failed to send Feishu approval card: ${cardErr.message}`,
              });
            }
          } else {
            logger.error('approval.callback_missing', 'No Feishu card callback registered');
            clearTimeout(timeoutId);
            pendingIpcRequests.delete(approvalReq.approvalId);
            updateApprovalStatus(approvalReq.approvalId, 'failed');
            sendJson(res, 200, {
              decision: 'deny',
              reason: 'Bridge approval callback missing.',
            });
          }

        } else if (url === '/hook/post-tool-use' && method === 'POST') {
          // Just acknowledge
          return sendJson(res, 200, { ok: true });
        } else if (url === '/hook/stop' && method === 'POST') {
          // Just acknowledge
          return sendJson(res, 200, { ok: true });
        } else {
          return sendJson(res, 404, { error: 'Not Found' });
        }
      } catch (err: any) {
        logger.error('ipc.request_error', err.message);
        return sendJson(res, 500, { error: 'Internal Server Error' });
      }
    });
  });

  return server;
}
