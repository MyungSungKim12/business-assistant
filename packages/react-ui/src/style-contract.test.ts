import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const packageRoot = resolve(import.meta.dirname, '..');
const appRoot = resolve(packageRoot, '../../apps/desktop-react');

describe('React design contract', () => {
  it('defines the approved beige palette and density', () => {
    const tokenPath = resolve(import.meta.dirname, 'tokens.css');
    expect(existsSync(tokenPath)).toBe(true);

    const css = readFileSync(tokenPath, 'utf8');
    expect(css).toContain('--surface-app: #eee9e3');
    expect(css).toContain('--surface-panel: #fffefa');
    expect(css).toContain('--surface-muted: #e8e1d9');
    expect(css).toContain('--border: #d1c7bd');
    expect(css).toContain('--text: #2d2925');
    expect(css).toContain('--text-muted: #726961');
    expect(css).toContain('--accent: #8a6049');
    expect(css).toContain('--selection: #e4d5c8');
    expect(css).toContain('--font-size-body: 12px');
    expect(css).toContain('--data-row-height: 28px');
  });

  it('bundles four fixed SUIT weights and keyboard focus styling', () => {
    const basePath = resolve(import.meta.dirname, 'base.css');
    expect(existsSync(basePath)).toBe(true);

    const css = readFileSync(basePath, 'utf8');
    expect(css.match(/@font-face/g)).toHaveLength(4);
    expect(css).toContain(':focus-visible');

    for (const name of ['Regular', 'Medium', 'SemiBold', 'Bold']) {
      const font = resolve(appRoot, `src/assets/fonts/SUIT-${name}.ttf`);
      expect(existsSync(font)).toBe(true);
      expect(statSync(font).size).toBeGreaterThan(0);
    }
    expect(statSync(resolve(appRoot, 'src/assets/fonts/SUIT-LICENSE.txt')).size).toBeGreaterThan(0);
  });
});
