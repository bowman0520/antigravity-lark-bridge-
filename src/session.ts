import * as fs from 'fs';
import * as path from 'path';
import { SESSIONS_FILE } from './paths';

export type SessionStatus =
  | 'IDLE'
  | 'RUNNING'
  | 'AWAITING_APPROVAL'
  | 'REJECTED'
  | 'EXPIRED'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface Session {
  scope: string;
  workspace: string;
  conversationId: string | null;
  status: SessionStatus;
  pendingQueue: string[];
  lastActive: string;
  summary: string;
}

export interface PersistentSessionData {
  workspace: string;
  conversationId: string | null;
  lastActive: string;
  summary?: string;
}

class SessionManager {
  private sessions: Map<string, Session> = new Map();

  constructor() {
    this.loadSessions();
  }

  private loadSessions() {
    const dir = path.dirname(SESSIONS_FILE);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (fs.existsSync(SESSIONS_FILE)) {
      try {
        const raw = fs.readFileSync(SESSIONS_FILE, 'utf8');
        const data = JSON.parse(raw) as Record<string, PersistentSessionData>;
        for (const [scope, sessionData] of Object.entries(data)) {
          this.sessions.set(scope, {
            scope,
            workspace: sessionData.workspace,
            conversationId: sessionData.conversationId,
            status: 'IDLE',
            pendingQueue: [],
            lastActive: sessionData.lastActive,
            summary: sessionData.summary || '',
          });
        }
      } catch (err) {
        // Fallback to empty map on corruption
      }
    }
  }

  public saveSessions() {
    const data: Record<string, PersistentSessionData> = {};
    for (const [scope, session] of this.sessions.entries()) {
      data[scope] = {
        workspace: session.workspace,
        conversationId: session.conversationId,
        lastActive: session.lastActive,
        summary: session.summary,
      };
    }

    try {
      fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), {
        mode: 0o600,
        encoding: 'utf8',
      });
    } catch (err) {
      // Ignore errors writing to session file
    }
  }

  public getOrCreateSession(scope: string, defaultWorkspace: string): Session {
    let session = this.sessions.get(scope);
    if (!session) {
      session = {
        scope,
        workspace: defaultWorkspace,
        conversationId: null,
        status: 'IDLE',
        pendingQueue: [],
        lastActive: new Date().toISOString(),
        summary: '',
      };
      this.sessions.set(scope, session);
      this.saveSessions();
    }
    return session;
  }

  public setConversationId(scope: string, conversationId: string | null) {
    const session = this.sessions.get(scope);
    if (session) {
      session.conversationId = conversationId;
      session.lastActive = new Date().toISOString();
      this.saveSessions();
    }
  }

  public setStatus(scope: string, status: SessionStatus) {
    const session = this.sessions.get(scope);
    if (session) {
      session.status = status;
      session.lastActive = new Date().toISOString();
    }
  }

  public getSession(scope: string): Session | undefined {
    return this.sessions.get(scope);
  }

  public resetSession(scope: string, defaultWorkspace: string): Session {
    let session = this.sessions.get(scope);
    if (!session) {
      session = this.getOrCreateSession(scope, defaultWorkspace);
    }
    session.conversationId = null;
    session.status = 'IDLE';
    session.pendingQueue = [];
    session.summary = '';
    session.lastActive = new Date().toISOString();
    delete (session as any).activeRunHandle;
    delete (session as any).activeTaskCardMessageId;
    delete (session as any).activeTaskState;
    this.saveSessions();
    return session;
  }

  public touchActive(scope: string) {
    const session = this.sessions.get(scope);
    if (!session) return;
    session.lastActive = new Date().toISOString();
    session.summary = '';
    this.saveSessions();
  }

  // Check if a workspace is locked by another running session
  public isWorkspaceLocked(workspace: string, currentScope: string): boolean {
    for (const [scope, session] of this.sessions.entries()) {
      if (scope !== currentScope && session.workspace === workspace) {
        if (session.status === 'RUNNING' || session.status === 'AWAITING_APPROVAL') {
          return true;
        }
      }
    }
    return false;
  }
}

export const sessionManager = new SessionManager();
