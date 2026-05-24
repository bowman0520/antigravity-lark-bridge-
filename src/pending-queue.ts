export type FlushHandler<TMsg> = (scope: string, batch: TMsg[]) => void;

interface PendingEntry<TMsg> {
  messages: TMsg[];
  timer?: NodeJS.Timeout;
}

/**
 * Per-scope debounce queue, ported from lark-channel-bridge.
 * - push(scope, msg): append; (re)arm a debounce timer unless the scope is blocked
 * - block(scope): clear timer, hold further flushes (used while a run is in-flight)
 * - unblock(scope): release; if there are pending messages, immediately re-arm
 * - cancel(scope): drop everything queued for the scope
 *
 * onFlush is fired exactly once per debounce window with the merged batch.
 */
export class PendingQueue<TMsg> {
  private map = new Map<string, PendingEntry<TMsg>>();
  private blocked = new Set<string>();

  constructor(private delayMs: number, private onFlush: FlushHandler<TMsg>) {}

  push(scope: string, msg: TMsg): number {
    const existing = this.map.get(scope);
    if (existing) {
      if (existing.timer) {
        clearTimeout(existing.timer);
        existing.timer = undefined;
      }
      existing.messages.push(msg);
      if (!this.blocked.has(scope)) {
        existing.timer = this.armTimer(scope);
      }
      return existing.messages.length;
    }
    const entry: PendingEntry<TMsg> = { messages: [msg] };
    if (!this.blocked.has(scope)) {
      entry.timer = this.armTimer(scope);
    }
    this.map.set(scope, entry);
    return 1;
  }

  cancel(scope: string): TMsg[] {
    const entry = this.map.get(scope);
    if (!entry) return [];
    if (entry.timer) clearTimeout(entry.timer);
    this.map.delete(scope);
    return entry.messages;
  }

  cancelAll() {
    for (const [, entry] of this.map) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.map.clear();
    this.blocked.clear();
  }

  block(scope: string) {
    this.blocked.add(scope);
    const entry = this.map.get(scope);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }

  unblock(scope: string) {
    this.blocked.delete(scope);
    const entry = this.map.get(scope);
    if (entry && entry.messages.length > 0 && !entry.timer) {
      entry.timer = this.armTimer(scope);
    }
  }

  size(scope: string): number {
    return this.map.get(scope)?.messages.length || 0;
  }

  isBlocked(scope: string): boolean {
    return this.blocked.has(scope);
  }

  private armTimer(scope: string): NodeJS.Timeout {
    return setTimeout(() => this.flush(scope), this.delayMs);
  }

  private flush(scope: string) {
    const entry = this.map.get(scope);
    if (!entry) return;
    this.map.delete(scope);
    try {
      this.onFlush(scope, entry.messages);
    } catch (err) {
      // Re-throw asynchronously so callers see it in unhandled rejection.
      setImmediate(() => {
        throw err;
      });
    }
  }
}
