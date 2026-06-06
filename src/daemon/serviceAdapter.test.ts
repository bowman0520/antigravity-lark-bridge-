import { renderServiceDefinition } from './serviceAdapter';

describe('service adapter', () => {
  test('renders service definition with selected config path', () => {
    const rendered = renderServiceDefinition('/tmp/antigravity-lark-config.json', '/usr/local/bin/antigravity-lark-bridge');

    if (process.platform === 'win32') {
      expect(rendered).toContain('wscript.exe');
      expect(rendered).toContain('hidden-start.vbs');
    } else {
      expect(rendered).toContain('/tmp/antigravity-lark-config.json');
      expect(rendered).toContain('run');
      expect(rendered).not.toContain('/Users/chiphen/.agents/antigravity-lark-bridge');
    }
  });
});
