export interface QueuedPrompt {
  prompt: string;
  scope: string;
  msgId: string;
  senderId: string;
  enqueuedAt: number;
  batchPrompts?: string[];
  batchMsgIds?: string[];
}

export class PromptQueue {
  private queues = new Map<string, QueuedPrompt[]>();
  private activeScopes = new Set<string>();

  public isActive(scope: string): boolean {
    return this.activeScopes.has(scope);
  }

  public setActive(scope: string, active: boolean) {
    if (active) {
      this.activeScopes.add(scope);
    } else {
      this.activeScopes.delete(scope);
    }
  }

  public push(item: Omit<QueuedPrompt, 'enqueuedAt'>): number {
    const queue = this.getQueue(item.scope);
    queue.push({
      ...item,
      enqueuedAt: Date.now(),
    });
    return queue.length;
  }

  public unshift(item: Omit<QueuedPrompt, 'enqueuedAt'>): number {
    const queue = this.getQueue(item.scope);
    queue.unshift({
      ...item,
      enqueuedAt: Date.now(),
    });
    return queue.length;
  }

  public shift(scope: string): QueuedPrompt | undefined {
    const queue = this.queues.get(scope);
    if (!queue || queue.length === 0) return undefined;
    const item = queue.shift();
    if (queue.length === 0) {
      this.queues.delete(scope);
    }
    return item;
  }

  public clear(scope: string) {
    this.queues.delete(scope);
  }

  public size(scope: string): number {
    return this.queues.get(scope)?.length || 0;
  }

  public snapshot(scope: string): string[] {
    return (this.queues.get(scope) || []).map((item) => item.prompt);
  }

  private getQueue(scope: string): QueuedPrompt[] {
    let queue = this.queues.get(scope);
    if (!queue) {
      queue = [];
      this.queues.set(scope, queue);
    }
    return queue;
  }
}
