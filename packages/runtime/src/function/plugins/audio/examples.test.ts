/**
 * Acceptance: every example's audio data goes through this plugin's loader and checks —
 * assets/audio.json defaults (values, ranges, draws), every scene's "music", every
 * prefab's audio_source sound, every sound file named in content/config, and every
 * `Assets.sfx.*` / `Assets.music.*` the code plays.
 * The examples ship without their sound files, so references are checked for form and
 * folder (the catalog's unchecked mode), as `parallax check` does for the SDK examples.
 */

import { describe, expect, it } from 'vitest';
import { formatDiagnostic, SeededRandom } from '../../../core/index.js';
import type { ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { AudioCatalog, audioHandle, AudioDefaultsTable, checkAudioDefaults } from './index.js';

declare global {
  interface ImportMeta {
    glob(pattern: string[] | string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  }
}

const ROOT = '../../../../../../examples/';
const json = import.meta.glob('../../../../../../examples/*/**/*.json', { query: '?raw', import: 'default', eager: true });
const code = import.meta.glob('../../../../../../examples/*/**/*.py', { query: '?raw', import: 'default', eager: true });

function byExample(raw: Record<string, string>): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const [path, text] of Object.entries(raw)) {
    const [example, ...rest] = path.slice(ROOT.length).split('/');
    if (example === undefined || example.startsWith('_')) continue;
    const files = out.get(example) ?? new Map<string, string>();
    files.set(rest.join('/'), text);
    out.set(example, files);
  }
  return out;
}

const examples = byExample(json);
const sources = byExample(code);

function projectFiles(files: Map<string, string>): ProjectFiles {
  return { list: () => [...files.keys()].sort(), read: (path) => files.get(path)! };
}

/** Every sound the example refers to, as [where, written, folder]. */
function references(name: string): Array<[string, string, 'sfx' | 'music']> {
  const project = loadProject(projectFiles(examples.get(name)!));
  const refs: Array<[string, string, 'sfx' | 'music']> = [];
  for (const scene of project.scenes.values()) {
    if (scene.music !== undefined) refs.push([`${scene.path} music`, scene.music, 'music']);
  }
  for (const prefab of project.prefabs.values()) {
    const sound = prefab.components['audio_source']?.['sound'];
    if (typeof sound === 'string') refs.push([`${prefab.path} audio_source.sound`, sound, 'sfx']);
  }
  // SoundRef fields in content and config are written as file paths or as handles
  // ("sfx/hit_light": a synthesized `.synth.json` sound or a file, whichever exists).
  const visit = (where: string, value: unknown): void => {
    if (typeof value === 'string') {
      const folder = /^(?:assets\/)?(sfx|music)\/[A-Za-z0-9_]+(?:\.[a-z0-9.]+)?$/.exec(value)?.[1];
      if (folder !== undefined) refs.push([where, value, folder as 'sfx' | 'music']);
    } else if (typeof value === 'object' && value !== null) {
      for (const child of Object.values(value)) visit(where, child);
    }
  };
  for (const kind of project.content.values()) for (const entry of kind.values()) visit(entry.path, entry.values);
  for (const config of project.config.values()) visit(config.path, config.values);
  for (const [path, text] of sources.get(name) ?? []) {
    for (const match of text.matchAll(/\bAssets\.(sfx|music)\.([A-Za-z0-9_]+)/g)) {
      refs.push([path, `${match[1]}/${match[2]}`, match[1] as 'sfx' | 'music']);
    }
  }
  return refs;
}

const withAudioJson = [...examples].filter(([, files]) => files.has('assets/audio.json')).map(([name]) => name).sort();

describe('example audio', () => {
  it('finds the examples and their audio.json files', () => {
    expect(examples.size).toBe(32);
    expect(withAudioJson.length).toBeGreaterThan(0);
  });

  it.each(withAudioJson)('%s: audio.json loads and checks clean, and every default draws within its range', (name) => {
    const project = loadProject(projectFiles(examples.get(name)!));
    expect(project.diagnostics.map(formatDiagnostic)).toEqual([]);
    expect(project.audio.size).toBeGreaterThan(0);
    const catalog = new AudioCatalog(null);
    expect(checkAudioDefaults(project.audio, catalog).map(formatDiagnostic)).toEqual([]);
    const table = new AudioDefaultsTable(project.audio, catalog);
    const random = new SeededRandom(1);
    for (const [handle, entry] of project.audio) {
      for (let i = 0; i < 4; i++) {
        const drawn = table.draw(handle, random);
        for (const what of ['volume', 'pitch'] as const) {
          const level = entry[what] ?? 1;
          const [lo, hi] = typeof level === 'number' ? [level, level] : level;
          expect(drawn[what]).toBeGreaterThanOrEqual(lo);
          expect(drawn[what]).toBeLessThanOrEqual(hi);
        }
      }
    }
  });

  it.each([...examples.keys()].sort())('%s: every sound and music reference is well-formed and in the right folder', (name) => {
    const problems: string[] = [];
    for (const [where, written, folder] of references(name)) {
      try {
        audioHandle(written, folder, where);
      } catch (error) {
        problems.push(String(error));
      }
    }
    expect(problems).toEqual([]);
  });

  it.each(withAudioJson)('%s: audio.json names only sounds the game refers to', (name) => {
    // With a catalog of exactly the referenced sounds, a defaults entry for anything else
    // is PP2063 — what the plugin reports once the real files are present.
    const handles = new Set(references(name).map(([where, written, folder]) => audioHandle(written, folder, where)));
    const project = loadProject(projectFiles(examples.get(name)!));
    const catalog = new AudioCatalog([...handles].map((h) => `assets/${h}.ogg`));
    expect(checkAudioDefaults(project.audio, catalog).map((d) => d.message)).toEqual([]);
  });
});
