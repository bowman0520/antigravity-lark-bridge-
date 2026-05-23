import { PromptQueue } from './promptQueue';

describe('PromptQueue', () => {
  test('tracks active scopes independently', () => {
    const queue = new PromptQueue();

    expect(queue.isActive('p2p:a')).toBe(false);
    queue.setActive('p2p:a', true);

    expect(queue.isActive('p2p:a')).toBe(true);
    expect(queue.isActive('p2p:b')).toBe(false);

    queue.setActive('p2p:a', false);
    expect(queue.isActive('p2p:a')).toBe(false);
  });

  test('preserves prompt order per scope', () => {
    const queue = new PromptQueue();

    queue.push({ scope: 'p2p:a', prompt: 'one', msgId: 'm1', senderId: 'u1' });
    queue.push({ scope: 'p2p:a', prompt: 'two', msgId: 'm2', senderId: 'u1' });
    queue.push({ scope: 'p2p:b', prompt: 'other', msgId: 'm3', senderId: 'u2' });

    expect(queue.size('p2p:a')).toBe(2);
    expect(queue.snapshot('p2p:a')).toEqual(['one', 'two']);
    expect(queue.shift('p2p:a')?.prompt).toBe('one');
    expect(queue.shift('p2p:a')?.prompt).toBe('two');
    expect(queue.shift('p2p:b')?.prompt).toBe('other');
    expect(queue.size('p2p:a')).toBe(0);
  });

  test('supports prepending the first prompt before draining', () => {
    const queue = new PromptQueue();

    queue.push({ scope: 'p2p:a', prompt: 'queued', msgId: 'm2', senderId: 'u1' });
    queue.unshift({ scope: 'p2p:a', prompt: 'first', msgId: 'm1', senderId: 'u1' });

    expect(queue.snapshot('p2p:a')).toEqual(['first', 'queued']);
  });
});
