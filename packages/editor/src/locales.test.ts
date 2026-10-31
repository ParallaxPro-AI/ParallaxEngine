import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LANGUAGES, MESSAGES } from './locales.js';
import { language, setLanguage, t } from './i18n.js';
import { primitiveLabel } from './hierarchy_model.js';

// Every language has every string, with the same {placeholders}; every key the editor's code
// asks for exists. A string added to the code without its translations fails here.

const SRC = dirname(fileURLToPath(import.meta.url));
const english = MESSAGES['en']!;
const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

/** The literal keys the editor's code passes to t(), tr() and lt(). */
function keysInCode(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of readdirSync(SRC)) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts') || file === 'locales.ts') continue;
    const text = readFileSync(join(SRC, file), 'utf8');
    for (const m of text.matchAll(/\b(?:t|tr|lt)\(\s*'([A-Za-z0-9_.]+)'/g)) found.set(m[1]!, file);
  }
  return found;
}

describe('the editor\'s languages', () => {
  it('offers exactly the languages it has strings for', () => {
    expect(LANGUAGES.map((l) => l.code).sort()).toEqual(Object.keys(MESSAGES).sort());
  });

  it.each(LANGUAGES.filter((l) => l.code !== 'en').map((l) => l.code))('%s has every English key and no others', (code) => {
    const messages = MESSAGES[code]!;
    expect(Object.keys(english).filter((k) => messages[k] === undefined), 'missing').toEqual([]);
    expect(Object.keys(messages).filter((k) => english[k] === undefined), 'unknown').toEqual([]);
  });

  it.each(LANGUAGES.map((l) => l.code))('%s keeps every {placeholder} and has no empty string', (code) => {
    const messages = MESSAGES[code]!;
    const wrong = Object.keys(english).filter((k) => messages[k] !== undefined && placeholders(messages[k]!).join() !== placeholders(english[k]!).join());
    expect(wrong, 'placeholders differ from English').toEqual([]);
    expect(Object.keys(messages).filter((k) => messages[k]!.trim() === ''), 'empty').toEqual([]);
  });

  it('has an English string for every key the code uses', () => {
    const missing = [...keysInCode()].filter(([key]) => english[key] === undefined).map(([key, file]) => `${file}: ${key}`);
    expect(missing).toEqual([]);
  });
});

describe('localized default names', () => {
  it('names an unnamed primitive in the current language, numbered like its prefab', () => {
    const before = language();
    try {
      setLanguage('en');
      expect(primitiveLabel('cube')).toBe('Cube');
      expect(primitiveLabel('point_light_3')).toBe('Point Light 3');
      expect(primitiveLabel('crate')).toBeUndefined();
      setLanguage('ja');
      expect(primitiveLabel('cube')).toBe(t('hierarchy.cube'));
      expect(primitiveLabel('cube')).not.toBe('Cube');
      expect(primitiveLabel('sphere_2')).toBe(`${MESSAGES['ja']!['hierarchy.sphere']} 2`);
    } finally {
      setLanguage(before);
    }
  });
});
