/**
 * Acceptance: every scene of every 3D example (`Game(mode="3d")`) loads through a kernel
 * with the visuals, terrain and environment plugins, render3d and the recording surface,
 * runs half a second, and draws a sane frame: a view per active camera, every visible
 * shape and model in a draw, finite matrices, palettes and particles, the terrain when the
 * scene has one.
 *
 * "Assets are assumed to exist" (examples/README.md): models, effects and images the
 * data names are stand-ins — every model is `standInCharacter` with every clip name the
 * example's data mentions, every effect a small emitter, every image an empty file.
 * Hosted models (`https://r2…/assets/….glb`, most examples' since the parity pass) load
 * nothing headless, like a missing file (models plugin `remoteAssets`, off outside the
 * browser): a stand-in can't stand for them (the data names their real materials and the
 * code their clips), so they are not expected in a draw.
 */

import { describe, expect, it } from 'vitest';
import { isAssetUrl, Vec2, Vec3 } from '../../../core/index.js';
import type { Frame3d, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import type { JsonObject, Project } from '../../../resource/index.js';
import { Kernel, t } from '../../kernel/index.js';
import type { BehaviorDef, ComponentDef, EntityRecord, GameDefinition, Schema } from '../../kernel/index.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../../../platform/headless/render3d.js';
import { environment } from '../environment/index.js';
import { terrain } from '../terrain/index.js';
import { VISUAL_SCHEMAS, visuals } from '../visuals/index.js';
import { viewmodel } from '../viewmodel/index.js';
import { weather } from '../weather/index.js';

/** viewmodel() runs too (first-person arms resolve their view layer there); its components are its own. */
const VIEWMODEL_OWNED = new Set((viewmodel().components ?? []).map((c) => c.id));
import { models } from '../models/index.js';
import { render3d } from './index.js';
import { standInCharacter } from '../models/testing.js';

declare global {
  interface ImportMeta {
    glob(pattern: string[] | string, options: { query: '?raw'; import: 'default'; eager: true }): Record<string, string>;
  }
}

const PREFIX = '../../../../../../examples/';
const rawJson = import.meta.glob('../../../../../../examples/*/**/*.json', { query: '?raw', import: 'default', eager: true });
const rawMain = import.meta.glob('../../../../../../examples/*/game/main.py', { query: '?raw', import: 'default', eager: true });

const examples3d = Object.entries(rawMain)
  .filter(([, text]) => /mode\s*=\s*"3d"/.test(text))
  .map(([path]) => path.slice(PREFIX.length).split('/')[0]!)
  .filter((name) => !name.startsWith('_'))
  .sort();

/** Scenes whose camera follows several targets: visuals can't decode them yet (see visuals/examples.test.ts). */
const NEEDS_UNION_FOLLOW = new Set(['fighting_game/arena', 'soccer/stadium']);

type Components = Record<string, JsonObject>;

function assumed(ref: string, folder: 'models' | 'images' | 'vfx'): string {
  const ext = { models: '.glb', images: '.png', vfx: '.vfx.json' }[folder];
  // A hosted asset (https://r2…/assets/….glb) loads nothing headless: no stand-in.
  if (isAssetUrl(ref)) return ref;
  if (ref.startsWith('assets/')) return ref;
  return ref.includes('/') ? `assets/${ref}${ext}` : `assets/${folder}/${ref}${ext}`;
}

interface ExampleFiles {
  readonly text: Map<string, string>;
  readonly binary: Map<string, Uint8Array>;
}

function exampleFiles(name: string): ExampleFiles {
  const text = new Map<string, string>();
  for (const [path, content] of Object.entries(rawJson)) {
    if (path.startsWith(`${PREFIX}${name}/`)) text.set(path.slice(PREFIX.length + name.length + 1), content);
  }
  const models = new Set<string>();
  const clips = new Set<string>();
  const visit = (components: Components | undefined): void => {
    for (const [id, fields] of Object.entries(components ?? {})) {
      if (id === 'model' && typeof fields['model'] === 'string') models.add(assumed(fields['model'], 'models'));
      if (id === 'animator' && typeof fields['default_clip'] === 'string') {
        const clip = fields['default_clip'];
        const hash = clip.lastIndexOf('#');
        if (hash >= 0) models.add(assumed(clip.slice(0, hash), 'models'));
        clips.add(hash >= 0 ? clip.slice(hash + 1) : clip);
      }
      if (id === 'shape' && typeof fields['texture'] === 'string') text.set(assumed(fields['texture'], 'images'), '');
      if (id === 'particles' && typeof fields['effect'] === 'string') {
        text.set(assumed(fields['effect'], 'vfx'), JSON.stringify({ rate: 30, burst: 4, lifetime: [0.5, 1], spread: 360 }));
      }
    }
  };
  for (const [path, content] of [...text]) {
    if (!path.endsWith('.prefab.json') && !path.endsWith('scene.json')) continue;
    const doc = JSON.parse(content) as { components?: Components; children?: { components?: Components }[]; entities?: { components?: Components }[] };
    visit(doc.components);
    for (const child of [...(doc.children ?? []), ...(doc.entities ?? [])]) visit(child.components);
  }
  const binary = new Map<string, Uint8Array>();
  const character = standInCharacter([...clips], 1);
  for (const model of models) {
    // Code-built `.model.json` documents are real example data (already in `text`): only .glb models get a stand-in.
    if (isAssetUrl(model) || model.endsWith('.json') || text.has(model.replace(/\.glb$/, '.model.json'))) continue;
    text.set(model, '');
    binary.set(model, character);
  }
  return { text, binary };
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
    .filter(([id]) => !(id in VISUAL_SCHEMAS) && !VIEWMODEL_OWNED.has(id))
    .map(([id, fields]) => ({ id, schema: permissive(fields, TYPED[id]) }));
  const behaviors: BehaviorDef[] = [...behaviorParams].map(([id, params]) => ({
    id, params: permissive(params), state: {}, requires: [], handlers: [], create: () => ({}),
  }));
  return { components, behaviors, resources: [], events: [], systems: [] };
}

function shown(kernel: Kernel, record: EntityRecord): boolean {
  for (let r: EntityRecord | undefined = record; r !== undefined; r = r.parent === null ? undefined : kernel.world.get(r.parent)) {
    if (!r.visible) return false;
  }
  return true;
}

function finite(values: ArrayLike<number>): boolean {
  for (let i = 0; i < values.length; i++) if (!Number.isFinite(values[i])) return false;
  return true;
}

const cases = examples3d.flatMap((name) => {
  const files = exampleFiles(name);
  const projectFiles: ProjectFiles = { list: () => [...files.text.keys()].sort(), read: (p) => files.text.get(p)! };
  const project = loadProject(projectFiles);
  return [...project.scenes.keys()].sort().map((scene) => [`${name}/${scene}`, project, projectFiles, files.binary, scene] as const);
});

describe('3D examples', () => {
  it('finds every 3D example', () => {
    expect(examples3d).toHaveLength(23);
    expect(cases.length).toBeGreaterThanOrEqual(examples3d.length * 2);
  });

  it.each(cases.filter(([label]) => !NEEDS_UNION_FOLLOW.has(label)))('%s draws a sane frame', async (_label, project, projectFiles, binary, scene) => {
    const surface = new RecordingSurface3d();
    const plugin = render3d({ surface, files: projectFiles });
    const kernel = new Kernel({
      project, game: game(project), context: {},
      plugins: [visuals({ dimension: '3d' }), terrain(), environment(), weather(), viewmodel(), models({ files: projectFiles, binary: new MemoryBinaryFiles(binary) }), plugin],
    });
    plugin.engine.preload();
    await plugin.engine.whenLoaded();
    kernel.start(scene);
    for (let i = 0; i < 30; i++) kernel.step(1 / 60);
    expect(surface.drawn).toBe(30);
    const frame: Frame3d = surface.last!;
    // PP3830 (a terrain tile blends > 4 layers; the extras fold in) is a fidelity notice on moba/racing data, not breakage.
    expect(plugin.engine.takeWarnings().filter((w) => w.code !== 'PP3815' && w.code !== 'PP3830')).toEqual([]);

    const live = [...kernel.world.live()];
    if (live.some((r) => r.components.has('camera'))) expect(frame.views.length).toBeGreaterThan(0);
    for (const view of frame.views) {
      expect(finite(view.viewProjection)).toBe(true);
      expect(finite(view.inverseViewProjection)).toBe(true);
    }

    const drawn = new Set<number | null>([...frame.meshes.flatMap((m) => m.entities), ...frame.skinned.map((s) => s.entity)]);
    for (const record of live) {
      if (!shown(kernel, record)) continue;
      const shape = record.components.get('shape');
      const size = shape?.['size'] as Vec3 | undefined;
      if (shape !== undefined && size !== undefined && size.x > 0 && size.z > 0) expect(drawn.has(record.id)).toBe(true);
      const model = record.components.get('model')?.['model'];
      if (model !== undefined && !(typeof model === 'string' && isAssetUrl(model))) expect(drawn.has(record.id)).toBe(true);
    }
    for (const batch of frame.meshes) expect(finite(batch.instances)).toBe(true);
    for (const draw of frame.skinned) expect(finite(draw.palette)).toBe(true);
    for (const batch of frame.billboards) expect(finite(batch.data)).toBe(true);
    for (const batch of frame.particles ?? []) expect(finite(batch.data)).toBe(true);

    const hasTerrain = project.scenes.get(scene)!.plugins['terrain'] !== undefined;
    expect(frame.terrain !== null).toBe(hasTerrain);
    if (frame.terrain !== null) {
      for (const tile of frame.terrain.tiles) expect(finite(tile.geometry.positions)).toBe(true);
      expect(frame.terrain.tiles.length).toBeGreaterThan(0);
      expect(frame.terrain.materials.length).toBeGreaterThan(0);
    }
    if (live.some((r) => shown(kernel, r) && r.components.get('particles')?.['emitting'] === true)) {
      expect((frame.particles ?? []).some((b) => b.entity !== null && b.count > 0)).toBe(true);
    }
    if (frame.environment.sun?.shadows === true && frame.views.length > 0) expect(frame.sunShadow).not.toBeNull();
  });
});
