import { reduce, initialState, renderCard, renderText, toLarkMarkdown } from './card';

describe('Card Module Tests', () => {
  test('initial state and text/thinking events', () => {
    let state = { ...initialState };
    expect(state.blocks.length).toBe(0);
    expect(state.footer).toBe('thinking');

    // Add thinking
    state = reduce(state, { type: 'thinking', delta: 'Thinking about listing directory' });
    expect(state.reasoning.content).toBe('Thinking about listing directory');
    expect(state.reasoning.active).toBe(true);
    expect(state.footer).toBe('thinking');

    // Add text block
    state = reduce(state, { type: 'text', delta: 'Hello from agent' });
    expect(state.blocks.length).toBe(1);
    expect(state.blocks[0]).toEqual({ kind: 'text', content: 'Hello from agent', streaming: true });
    expect(state.reasoning.active).toBe(false);
    expect(state.footer).toBe('streaming');

    // Stream more text
    state = reduce(state, { type: 'text', delta: ', here is more info.' });
    expect(state.blocks.length).toBe(1);
    expect(state.blocks[0]).toEqual({ kind: 'text', content: 'Hello from agent, here is more info.', streaming: true });
  });

  test('tool events and status rendering', () => {
    let state = { ...initialState };

    // 1. Tool use
    state = reduce(state, { type: 'tool_use', id: '1-0', name: 'RunCommand', input: { CommandLine: 'ls -la' } });
    expect(state.blocks.length).toBe(1);
    expect(state.blocks[0]).toEqual({
      kind: 'tool',
      tool: {
        id: '1-0',
        name: 'RunCommand',
        input: { CommandLine: 'ls -la' },
        status: 'running',
      },
    });
    expect(state.footer).toBe('tool_running');

    // 2. Tool result
    state = reduce(state, { type: 'tool_result', id: '1-0', output: 'file1\nfile2', isError: false });
    expect(state.blocks[0]).toEqual({
      kind: 'tool',
      tool: {
        id: '1-0',
        name: 'RunCommand',
        input: { CommandLine: 'ls -la' },
        status: 'done',
        output: 'file1\nfile2',
      },
    });

    // 3. Render Card output
    const cardObj: any = renderCard(state);
    expect(cardObj.schema).toBe('2.0');
    expect(cardObj.header.title.content).toBe('Antigravity 任务执行中');
    expect(cardObj.header.template).toBe('blue');

    const panel = cardObj.body.elements[0];
    expect(panel.tag).toBe('collapsible_panel');
    expect(panel.header.title.content).toContain('RunCommand');
  });

  test('terminal statuses', () => {
    let state = { ...initialState };
    state = reduce(state, { type: 'done' });
    expect(state.terminal).toBe('done');
    expect(state.footer).toBeNull();

    const doneCard: any = renderCard(state);
    expect(doneCard.header.title.content).toBe('Antigravity 任务已完成');
    expect(doneCard.header.template).toBe('green');

    let textState = { ...initialState };
    textState = reduce(textState, { type: 'error', message: 'Something went wrong' });
    expect(textState.terminal).toBe('error');
    expect(textState.errorMsg).toBe('Something went wrong');
    expect(textState.footer).toBeNull();

    const textOut = renderText(textState);
    expect(textOut).toContain('⚠️ agent 失败：Something went wrong');
  });

  test('toLarkMarkdown strips absolute file:// links', () => {
    const input = 'Please check [00-收集箱](file:///Users/chiphen/Library/Mobile Documents/iCloud~md~obsidian/Documents/我的知识库/00-收集箱) and [CLAUDE.md](file:///Users/chiphen/Library/Mobile Documents/iCloud~md~obsidian/Documents/我的知识库/CLAUDE.md) for details.';
    const output = toLarkMarkdown(input);
    expect(output).toBe('Please check **00-收集箱** and **CLAUDE.md** for details.');
  });
});
