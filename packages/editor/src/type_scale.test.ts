import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const DIR = fileURLToPath(new URL('.', import.meta.url));
const SCALE: Readonly<Record<string, string>> = {
  xs: '10px', sm: '11px', md: '12px', lg: '14px', xl: '16px', display: '22px',
};

describe('the type scale', () => {
  it('is the documented one (styles.css :root)', () => {
    const css = readFileSync(`${DIR}/styles.css`, 'utf8');
    for (const [name, size] of Object.entries(SCALE)) expect(css).toContain(`--font-size-${name}: ${size};`);
  });

  it('every font-size in the editor names a step of it (no stray px sizes)', () => {
    const stray: string[] = [];
    for (const file of readdirSync(DIR).filter((f) => f.endsWith('.css') || (f.endsWith('.ts') && !f.endsWith('.test.ts')))) {
      const text = readFileSync(`${DIR}/${file}`, 'utf8');
      for (const match of text.matchAll(/font-size:\s*([^;}"'`]+)/g)) {
        const value = match[1]!.trim();
        if (!/^var\(--font-size-(xs|sm|md|lg|xl|display)(, *\d+px)?\)$/.test(value) && value !== 'inherit') stray.push(`${file}: ${value}`);
      }
    }
    expect(stray).toEqual([]);
  });
});
