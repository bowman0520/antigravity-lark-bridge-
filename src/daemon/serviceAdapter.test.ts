import { renderServiceDefinition } from './serviceAdapter';

describe('service adapter', () => {
  test('renders service definition with selected config path', () => {
    const rendered = renderServiceDefinition('/tmp/antigravity-lark-config.json', '/usr/local/bin/antigravity-lark-bridge');

    expect(rendered).toContain('/tmp/antigravity-lark-config.json');
    expect(rendered).toContain('run');
    expect(rendered).not.toContain('/Users/chiphen/.agents/antigravity-lark-bridge');
  });
});
