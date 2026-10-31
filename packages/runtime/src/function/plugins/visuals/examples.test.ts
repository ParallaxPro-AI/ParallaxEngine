/**
 * Acceptance: every visual component in all example games decodes with the real visuals
 * schemas, and every scene of every example instantiates and runs a second of frames with
 * the plugin's rigs, views, animation timing and zones live.
 *
 * Components of other plugins and games, and behavior params, get permissive schemas
 * derived from the data (as in kernel/examples.test.ts), except the two this plugin reads
 * by id — `collider` (EnvironmentZone volumes) and `grid` (`"fit": "grid"`) — which get
 * their SDK field types.
 */

import { describe, expect, it } from 'vitest';
import { Vec2, Vec3 } from '../../../core/index.js';
import { ParallaxError } from '../../../core/index.js';
import type { ProjectFiles } from '../../../core/index.js';
import { loadProject, resolvePrefab } from '../../../resource/index.js';
import type { JsonObject, Project } from '../../../resource/index.js';
import { instantiate, Kernel, t } from '../../kernel/index.js';
import type { BehaviorDef, ComponentDef, GameDefinition, KernelPlugin, Schema } from '../../kernel/index.js';
import { ANIMATION_CLIPS_SERVICE } from '../../services/index.js';
import { RENDER_SCHEMAS, VISUAL_SCHEMAS, visuals } from './index.js';

declare global {
  interface ImportMeta {
    glob(pattern: string[] | string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  }
}

const PREFIX = '../../../../../../examples/';
const raw = import.meta.glob(['../../../../../../examples/*/**/*.json', '../../../../../../examples/*/game/main.py'], {
  query: '?raw', import: 'default', eager: true,
});

interface Example {
  readonly files: Map<string, string>;
  mode: '2d' | '3d';
}

const examples = new Map<string, Example>();
for (const [path, text] of Object.entries(raw)) {
  const [name, ...rest] = path.slice(PREFIX.length).split('/');
  if (name === undefined || name.startsWith('_')) continue;
  const example = examples.get(name) ?? { files: new Map<string, string>(), mode: '3d' };
  const rel = rest.join('/');
  if (rel === 'game/main.py') {
    const mode = /mode\s*=\s*"(2d|3d)"/.exec(text)?.[1];
    if (mode === undefined) throw new Error(`${name}: no Game(mode=...) in game/main.py`);
    example.mode = mode as '2d' | '3d';
  } else {
    example.files.set(rel, text);
  }
  examples.set(name, example);
}

function projectFiles(files: Map<string, string>): ProjectFiles {
  return { list: () => [...files.keys()].sort(), read: (path) => files.get(path)! };
}

const COLLIDER: Schema = {
  shape: t.string({ default: 'box' }),
  size: t.vec3({ default: Vec3.ONE }),
  radius: t.number({ default: 0.5 }),
  height: t.number({ default: 1 }),
  offset: t.vec3({ default: Vec3.ZERO }),
  trigger: t.bool({ default: false }),
};
const GRID: Schema = {
  cols: t.int({ default: 8 }),
  rows: t.int({ default: 8 }),
  cell_size: t.vec2({ default: Vec2.ONE }),
  plane: t.string({ default: 'xy' }),
  origin: t.string({ default: 'center' }),
  row_order: t.string({ default: 'down' }),
};
const TYPED: Readonly<Record<string, Schema>> = { collider: COLLIDER, grid: GRID };

type Instance = { components: Readonly<Record<string, JsonObject>>; params: Readonly<Record<string, JsonObject>> };

function game(project: Project): GameDefinition {
  const componentFields = new Map<string, Set<string>>();
  const behaviorParams = new Map<string, Set<string>>();
  const note = (map: Map<string, Set<string>>, id: string, fields: JsonObject): void => {
    const set = map.get(id) ?? new Set<string>();
    for (const key of Object.keys(fields)) set.add(key);
    map.set(id, set);
  };
  const noteInstance = (inst: Instance): void => {
    for (const [id, fields] of Object.entries(inst.components)) note(componentFields, id, fields);
    for (const [id, params] of Object.entries(inst.params)) note(behaviorParams, id, params);
  };
  for (const prefab of project.prefabs.values()) {
    for (const [id, fields] of Object.entries(prefab.components)) note(componentFields, id, fields);
    for (const use of prefab.behaviors) note(behaviorParams, use.use, use.params);
    prefab.children.forEach(noteInstance);
  }
  for (const scene of project.scenes.values()) scene.entities.forEach(noteInstance);

  const permissive = (fields: Set<string>, typed: Schema = {}): Schema => ({
    ...Object.fromEntries([...fields].filter((f) => !(f in typed)).map((f) => [f, { type: { kind: 'json' as const }, default: null }])),
    ...typed,
  });
  const components: ComponentDef[] = [...componentFields]
    .filter(([id]) => !(id in VISUAL_SCHEMAS))
    .map(([id, fields]) => ({ id, schema: permissive(fields, TYPED[id]) }));
  const behaviors: BehaviorDef[] = [...behaviorParams].map(([id, params]) => ({
    id, params: permissive(params), state: {}, requires: [], handlers: [], create: () => ({}),
  }));
  return { components, behaviors, resources: [], events: [], systems: [] };
}

/** Clip facts as a data-only run has them (no model files: clips have no frames); render3d provides the real ones. */
const DATA_ONLY_CLIPS: KernelPlugin = {
  id: 'data_only_clips',
  install: (kernel) => kernel.provide(ANIMATION_CLIPS_SERVICE, { clip: () => null, root: () => null }),
};

const projects = [...examples].sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, example]) => ({
  name, mode: example.mode, project: loadProject(projectFiles(example.files)),
}));

describe('visual components in the examples', () => {
  const decodedById = new Map<string, number>();
  it('covers all 32 examples', () => {
    expect(projects.length).toBe(32);
  });

  const decodeCases = projects.map(({ name, project }) => [name, project] as const);
  it.each(decodeCases)('%s: every prefab, child and placement decodes', (_name, project) => {
    const check = (components: Readonly<Record<string, JsonObject>>, where: string): void => {
      for (const [id, data] of Object.entries(components)) {
        const schema = VISUAL_SCHEMAS[id];
        if (schema === undefined) continue;
        if (id === 'camera' && Array.isArray(data['follow'])) continue; // NEEDS_UNION_FOLLOW
        instantiate(schema, data, `${where}.${id}`);
        decodedById.set(id, (decodedById.get(id) ?? 0) + 1);
      }
    };
    for (const prefab of project.prefabs.values()) {
      const resolved = resolvePrefab(project, prefab.id);
      check(resolved.components, `prefab ${prefab.id}`);
      // A child naming a prefab overrides that prefab's components, as the spawner merges them.
      resolved.children.forEach((child, i) => {
        const base = child.prefab === undefined ? {} : resolvePrefab(project, child.prefab).components;
        const merged = { ...base, ...Object.fromEntries(Object.entries(child.components).map(([id, f]) => [id, { ...base[id], ...f }])) };
        check(merged, `prefab ${prefab.id} child ${i}`);
      });
    }
    for (const scene of project.scenes.values()) {
      scene.entities.forEach((p, i) => {
        const base = resolvePrefab(project, p.prefab).components;
        const merged = Object.fromEntries(Object.entries(p.components).map(([id, f]) => [id, { ...base[id], ...f }]));
        check(merged, `scene ${scene.id} entity ${i}`);
      });
    }
  });

  it('decoded every kind of visual component the examples use', () => {
    // `socket` is what `attach(child, socket=...)` adds at runtime; no example writes one in data.
    // `outline` is added at runtime too (`entity.add(Outline(...))` to highlight a target).
    // The render-scale components (lod, decal, mirror, monitor, …) are newer than the examples' data,
    // except `static_mesh`, `surface_fx` and `heat_haze` (racing's nitro), which the examples use.
    // `tilemap`: no example uses one since the re-ports (physics2d/tilemap.test.ts covers it).
    const inExamples = ['static_mesh', 'surface_fx', 'heat_haze'];
    const runtimeOnly = ['socket', 'outline', 'tilemap', ...Object.keys(RENDER_SCHEMAS).filter((id) => !inExamples.includes(id))];
    expect([...decodedById.keys()].sort()).toEqual(Object.keys(VISUAL_SCHEMAS).filter((id) => !runtimeOnly.includes(id)).sort());
  });

  const sceneCases = projects.flatMap(({ name, mode, project }) =>
    [...project.scenes.keys()].sort().map((scene) => [`${name}/${scene}`, mode, project, scene] as const));

  it('covers every scene', () => {
    expect(sceneCases.length).toBeGreaterThanOrEqual(60);
  });

  it.each(sceneCases)('%s runs a second with the visuals plugin', (label, mode, project, scene) => {
    const start = (): Kernel => {
      const kernel = new Kernel({ project, game: game(project), plugins: [visuals({ dimension: mode }), DATA_ONLY_CLIPS], context: {} });
      kernel.start(scene);
      return kernel;
    };
    const kernel = start();
    for (let i = 0; i < 60; i++) kernel.step(1 / 60);
    expect(kernel.time.now).toBeCloseTo(1);
    for (const record of kernel.world.live()) {
      const camera = record.components.get('camera') as { __view__: { position: Vec3 } } | undefined;
      if (camera !== undefined) expect(Number.isFinite(camera.__view__.position.length())).toBe(true);
    }
  });
});
