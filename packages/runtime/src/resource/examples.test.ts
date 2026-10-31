/**
 * Acceptance: every example game's data files load clean. The examples were written
 * against the SDK before this loader existed, so this is the loader meeting real data.
 */

import { describe, expect, it } from 'vitest';
import { formatDiagnostic } from '../core/index.js';
import type { ProjectFiles } from '../core/index.js';
import { loadProject } from './load_project.js';

declare global {
  interface ImportMeta {
    glob(pattern: string[] | string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  }
}

const EXAMPLES_DIR = '../../../../examples/';
const raw = import.meta.glob('../../../../examples/*/**/*.json', { query: '?raw', import: 'default', eager: true });

/** example name → project-relative path → text. */
const examples = new Map<string, Map<string, string>>();
for (const [path, text] of Object.entries(raw)) {
  const [example, ...rest] = path.slice(EXAMPLES_DIR.length).split('/');
  if (example === undefined || example.startsWith('_')) continue;
  const project = examples.get(example) ?? new Map<string, string>();
  project.set(rest.join('/'), text);
  examples.set(example, project);
}

function projectFiles(files: Map<string, string>): ProjectFiles {
  return { list: () => [...files.keys()].sort(), read: (path) => files.get(path)! };
}

describe('example projects', () => {
  it('finds all 32 examples', () => {
    expect(examples.size).toBe(32);
  });

  it.each([...examples.keys()].sort())('%s loads without diagnostics', (name) => {
    const project = loadProject(projectFiles(examples.get(name)!));
    expect(project.diagnostics.map(formatDiagnostic)).toEqual([]);
  });

  it('brick_breaker loads exactly what its files declare', () => {
    const project = loadProject(projectFiles(examples.get('brick_breaker')!));
    expect([...project.prefabs.keys()].sort()).toEqual(
      ['ball', 'brick', 'camera', 'field', 'paddle', 'rail', 'rail_top', 'sun', 'wall']);
    expect([...project.scenes.keys()].sort()).toEqual(['arena', 'title']);
    expect(project.scenes.get('arena')?.entities).toHaveLength(9);
    expect(project.scenes.get('arena')?.ui).toEqual(['hud']);
    expect(project.content.get('stage')?.size).toBe(5);
    expect(project.content.get('upgrade')?.size).toBe(9);
    expect(project.config.get('rules')?.values['lives']).toBe(3);
    // The template's hosted track (the generated music/prism_run.ogg is gone), at the template's 0.28.
    expect(project.audio.get('https://r2.parallaxpro.ai/assets/audio_music/aa/38/aa382c853274b28019e614c20d9b0ad2273875c9eaefa6ccfe80462a0fb5b239.mp3'))
      .toEqual({ volume: 0.28 });
  });
});
