/**
 * Acceptance: every scene of every example game instantiates and runs frames.
 *
 * Engine component schemas come from plugins (not written yet) and game schemas from the
 * transpiler, so this derives permissive schemas from the data itself. What it proves is
 * the instantiation path on real data — variants, children, grids, per-instance params,
 * entity references, scene loading — not the schemas.
 */

import { describe, expect, it } from 'vitest';
import type { ProjectFiles } from '../../core/index.js';
import { loadProject } from '../../resource/index.js';
import type { JsonObject, Project } from '../../resource/index.js';
import type { BehaviorDef, ComponentDef, GameDefinition } from './definitions.js';
import { Kernel } from './kernel.js';
import type { Schema } from './schema.js';

declare global {
  interface ImportMeta {
    glob(pattern: string[] | string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  }
}

const PREFIX = '../../../../../examples/';
const raw = import.meta.glob('../../../../../examples/*/**/*.json', { query: '?raw', import: 'default', eager: true });

const examples = new Map<string, Map<string, string>>();
for (const [path, text] of Object.entries(raw)) {
  const [example, ...rest] = path.slice(PREFIX.length).split('/');
  if (example === undefined || example.startsWith('_')) continue;
  const project = examples.get(example) ?? new Map<string, string>();
  project.set(rest.join('/'), text);
  examples.set(example, project);
}

function projectFiles(files: Map<string, string>): ProjectFiles {
  return { list: () => [...files.keys()].sort(), read: (path) => files.get(path)! };
}

/** Every field name used anywhere for a component or behavior, as an optional JSON field. */
function permissiveGame(project: Project): GameDefinition {
  const componentFields = new Map<string, Set<string>>();
  const behaviorParams = new Map<string, Set<string>>();
  const note = (map: Map<string, Set<string>>, id: string, fields: JsonObject): void => {
    const set = map.get(id) ?? new Set<string>();
    for (const key of Object.keys(fields)) set.add(key);
    map.set(id, set);
  };
  const noteInstance = (inst: { components: Readonly<Record<string, JsonObject>>; params: Readonly<Record<string, JsonObject>> }): void => {
    for (const [id, fields] of Object.entries(inst.components)) note(componentFields, id, fields);
    for (const [id, params] of Object.entries(inst.params)) note(behaviorParams, id, params);
  };
  for (const prefab of project.prefabs.values()) {
    for (const [id, fields] of Object.entries(prefab.components)) note(componentFields, id, fields);
    for (const use of prefab.behaviors) note(behaviorParams, use.use, use.params);
    prefab.children.forEach(noteInstance);
  }
  for (const scene of project.scenes.values()) scene.entities.forEach(noteInstance);

  const schema = (fields: Set<string>): Schema =>
    Object.fromEntries([...fields].map((f) => [f, { type: { kind: 'json' as const }, default: null }]));
  const components: ComponentDef[] = [...componentFields].map(([id, fields]) => ({ id, schema: schema(fields) }));
  const behaviors: BehaviorDef[] = [...behaviorParams].map(([id, params]) => ({
    id, params: schema(params), state: {}, requires: [], handlers: [], create: () => ({}),
  }));
  return { components, behaviors, resources: [], events: [], systems: [] };
}

describe('example scenes', () => {
  const cases = [...examples.keys()].sort().flatMap((name) => {
    const project = loadProject(projectFiles(examples.get(name)!));
    return [...project.scenes.keys()].sort().map((scene) => [`${name}/${scene}`, project, scene] as const);
  });

  it('covers every scene of every example', () => {
    expect(cases.length).toBeGreaterThanOrEqual(60);
  });

  it.each(cases)('%s instantiates and runs a second of frames', (_label, project, scene) => {
    const kernel = new Kernel({ project, game: permissiveGame(project) });
    kernel.start(scene);
    const placed = project.scenes.get(scene)!.entities.reduce(
      (n, p) => n + (p.grid === undefined ? 1 : p.grid.cols * p.grid.rows), 0);
    expect(kernel.world.count).toBeGreaterThanOrEqual(placed);
    for (let i = 0; i < 60; i++) kernel.step(1 / 60);
    expect(kernel.time.now).toBeCloseTo(1);
  });
});
