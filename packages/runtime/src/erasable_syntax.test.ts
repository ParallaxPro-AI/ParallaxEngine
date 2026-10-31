/**
 * The runtime runs straight from its TypeScript in Node (the CLI and `parallax test` load it
 * with Node's type stripping), so every source file must use erasable syntax only: no
 * constructor parameter properties, enums or namespaces. One such line anywhere stops every
 * playtest with PP3415 before a test runs. Test files are left out: Vitest compiles them in full.
 */

import { describe, expect, it } from 'vitest';

declare global {
  interface ImportMeta {
    glob(pattern: string[], options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  }
}

const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(import.meta.glob(['./**/*.ts', '!./**/*.test.ts'], { query: '?raw', import: 'default', eager: true }))
    .map(([path, text]) => [path.slice(2), text]),
);

const RULES: readonly { name: string; pattern: RegExp }[] = [
  { name: 'enum', pattern: /^\s*(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+[A-Za-z_$]/m },
  { name: 'namespace', pattern: /^\s*(?:export\s+)?namespace\s+[A-Za-z_$]/m },
];

describe('erasable TypeScript only', () => {
  it('has no parameter properties, enums or namespaces in any source file', () => {
    const found: string[] = [];
    for (const [path, text] of Object.entries(SOURCES)) {
      // Parameter properties: only constructor heads, so `readonly` in a type annotation stays allowed.
      for (const head of text.match(/constructor\s*\([^)]*\)/g) ?? []) {
        if (/\(\s*(?:[^,()]*,\s*)*(?:public|private|protected|readonly)\s+[A-Za-z_$]\w*\s*[:?=,)]/.test(head)) found.push(`${path}: constructor parameter property`);
      }
      for (const rule of RULES) if (rule.pattern.test(text)) found.push(`${path}: ${rule.name}`);
    }
    expect(found).toEqual([]);
  });
});
