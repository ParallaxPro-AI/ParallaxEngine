/** `parallax build` over a copy of the fixture: what it writes, and what a rebuild removes. */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { directoryFiles } from '@parallax/check';
import { buildProject, checkCommand } from './build.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/drop', import.meta.url));
const root = mkdtempSync(`${tmpdir()}/parallax-build-`);
afterAll(() => rmSync(root, { recursive: true, force: true }));

function copyFixture(project: string): void {
  const tree = directoryFiles(FIXTURE);
  for (const path of tree.all()) {
    mkdirSync(`${project}/${path.split('/').slice(0, -1).join('/')}`, { recursive: true });
    writeFileSync(`${project}/${path}`, tree.bytes(path));
  }
}

describe('buildProject', () => {
  it('reports an entry that did not compile instead of crashing the link pass (ENOENT)', () => {
    const project = `${root}/broken`;
    copyFixture(project);
    writeFileSync(`${project}/game/main.py`, 'def broken(:\n');
    const result = buildProject(project, { assetFiles: false });
    expect(result.errors).toBeGreaterThan(0);
    expect(result.diagnostics.some((d) => d.code === 'PP9504' && d.path === 'game/main.py')).toBe(true);
  });

  it('`parallax check` reports the transpiler\'s diagnostics; --no-compile skips them', () => {
    const project = `${root}/check`;
    copyFixture(project);
    writeFileSync(`${project}/game/extra.py`, 'import os\n');
    const full = checkCommand(project, { assetFiles: false, outDir: false });
    expect(full.diagnostics.some((d) => d.path === 'game/extra.py' && d.severity === 'error')).toBe(true);
    const fast = checkCommand(project, { assetFiles: false, outDir: false, compile: false });
    expect(fast.diagnostics.some((d) => d.path === 'game/extra.py')).toBe(false);
  });

  it('writes a source map per module and removes a deleted module\'s .js and .js.map on rebuild', () => {
    const project = `${root}/project`;
    const tree = directoryFiles(FIXTURE);
    for (const path of tree.all()) {
      mkdirSync(`${project}/${path.split('/').slice(0, -1).join('/')}`, { recursive: true });
      writeFileSync(`${project}/${path}`, tree.bytes(path));
    }
    writeFileSync(`${project}/game/extra.py`, 'X = 1\n');
    const first = buildProject(project);
    expect(first.errors).toBe(0);
    const js = `${first.buildDir}/game/extra.js`;
    expect(readFileSync(js, 'utf8')).toContain('//# sourceMappingURL=extra.js.map');
    expect(existsSync(`${js}.map`)).toBe(true);
    rmSync(`${project}/game/extra.py`);
    buildProject(project);
    expect(existsSync(js)).toBe(false);
    expect(existsSync(`${js}.map`)).toBe(false);
  });
});
