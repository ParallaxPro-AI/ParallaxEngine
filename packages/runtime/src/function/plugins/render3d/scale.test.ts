/**
 * Render scale in a kernel: levels of detail and impostors, the view distance, static
 * merging, the first-person view layer, morph targets, generated meshes; and the models
 * plugin's skeleton, ragdoll blending and oriented reach goals.
 */

import { describe, expect, it } from 'vitest';
import { MESH_INSTANCE_STRIDE, ParallaxError, Quat, Vec3, VIEWMODEL_DEPTH } from '../../../core/index.js';
import type { EntityId, Frame3d, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { ComponentDef, GameDefinition, KernelPlugin } from '../../kernel/index.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../../../platform/headless/render3d.js';
import { FOG_OF_WAR_SERVICE, PROCGEN_SERVICE, RAGDOLL_POSE_SERVICE, SKELETON_SERVICE } from '../../services/index.js';
import type { GeneratedMesh } from '../../services/index.js';
import { visuals } from '../visuals/index.js';
import { models } from '../models/index.js';
import { standInCharacter, writeGlb } from '../models/testing.js';
import { chooseLod, lodBands } from './lod.js';
import { QUALITY_LADDER } from './quality.js';
import { MorphedGeometry } from './morph.js';
import { mergeGeometry } from './static_merge.js';
import { render3d } from './index.js';
import { compressedVariants } from './engine.js';
import type { Render3dEngine } from './engine.js';
import { viewFadeOf } from '../../../platform/browser/render3d/sky_plan.js';
import { FAR } from '../visuals/index.js';

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const map = new Map(Object.entries(contents).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => [...map.keys()].sort(), read: (p) => map.get(p)! };
}

interface Run {
  readonly kernel: Kernel;
  readonly engine: Render3dEngine;
  readonly surface: RecordingSurface3d;
  frame(): Frame3d;
  id(placed: string): EntityId;
  step(n?: number): void;
}

async function run(
  data: { prefabs: Record<string, unknown>; entities: unknown[] },
  options: { binary?: Record<string, Uint8Array>; components?: ComponentDef[]; plugins?: KernelPlugin[] } = {},
): Promise<Run> {
  const binary = options.binary ?? {};
  const project = files({
    ...Object.fromEntries(Object.entries(data.prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities: data.entities },
    ...Object.fromEntries(Object.keys(binary).map((path) => [path, ''])),
  });
  const loaded = loadProject(project);
  expect(loaded.diagnostics).toEqual([]);
  const surface = new RecordingSurface3d();
  const plugin = render3d({ surface, files: project });
  const game: GameDefinition = { components: options.components ?? [], resources: [], events: [], behaviors: [], systems: [] };
  const kernel = new Kernel({
    project: loaded, game, context: {}, fixedStep: DT,
    plugins: [visuals({ dimension: '3d' }), models({ files: project, binary: new MemoryBinaryFiles(binary) }), ...(options.plugins ?? []), plugin],
  });
  plugin.engine.preload();
  await plugin.engine.whenLoaded();
  kernel.start('main');
  kernel.step(DT);
  return {
    kernel, surface, engine: plugin.engine,
    frame: () => surface.last!,
    id: (placed) => [...kernel.world.live()].find((r) => r.placedId === placed)!.id,
    step: (n = 1) => { for (let i = 0; i < n; i++) kernel.step(DT); },
  };
}

const CAMERA = { components: { camera: { fov: 60 } } };

/** A one-triangle model, its id in the name. */
function triangle(size: number): Uint8Array {
  return writeGlb({
    nodes: [{ name: 'body', mesh: 0 }],
    meshes: [{ positions: [0, 0, 0, size, 0, 0, 0, size, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2] }],
  });
}

describe('levels of detail', () => {
  const bands = lodBands({ levels: [{ distance: 20, model: 'mid' }, { distance: 50, model: null }], impostor: null, cull: 200, fade: 0.1 }, QUALITY_LADDER.high, 'lod');

  it('picks the band for a distance, cross-fading two bands with complementary dither', () => {
    expect(chooseLod(bands, 5)).toEqual([{ band: 0, fade: 1 }]);
    expect(chooseLod(bands, 30)).toEqual([{ band: 1, fade: 1 }]);
    const mid = chooseLod(bands, 21);
    expect(mid.map((d) => d.band)).toEqual([1, 0]);
    // The incoming band keeps t of its pixels; the outgoing one (encoded t - 1) keeps exactly the rest.
    expect(mid[0]!.fade).toBeCloseTo(0.5, 6);
    expect(mid[1]!.fade).toBeCloseTo(-0.5, 6);
    expect(1 + mid[1]!.fade).toBeCloseTo(mid[0]!.fade, 6);
    expect(chooseLod(bands, 250)).toEqual([]);
  });

  it('fades out before the cull distance, and the far fade is full there', () => {
    const near = chooseLod(bands, 185);
    expect(near).toHaveLength(1);
    expect(near[0]!.fade).toBeGreaterThan(0);
    expect(near[0]!.fade).toBeLessThan(1);
    // Low quality: a 1.5 km view distance (the far plane); everything is sky (97%) before it.
    const low = lodBands({ levels: [], impostor: null, cull: null, fade: 0.1 }, QUALITY_LADDER.low, 'lod');
    expect(low.cull).toBe(1500);
    const fade = viewFadeOf({ far: 1500 });
    expect(fade.end).toBeLessThan(1500);
    expect(fade.end).toBeGreaterThanOrEqual(1500 * 0.95);
    // Every far plane fades, high quality's 20 km one too: the world never ends in a hard edge.
    expect(viewFadeOf({ far: FAR }).end).toBeGreaterThan(FAR * 0.9);
    expect(viewFadeOf({ far: Infinity })).toEqual({ start: 0, end: 0 });
  });

  it('scales distances by the quality and refuses bands out of order', () => {
    const low = lodBands({ levels: [{ distance: 20, model: null }], impostor: 60, cull: 100, fade: 0.1 }, QUALITY_LADDER.low, 'lod');
    expect(low.starts).toEqual([10, 30]);
    expect(low.cull).toBe(50);
    const bad = (): unknown => lodBands({ levels: [{ distance: 20, model: null }, { distance: 10, model: null }], impostor: null, cull: null, fade: 0 }, QUALITY_LADDER.high, 'lod');
    expect(bad).toThrow(ParallaxError);
  });

  it('draws the level models, an impostor past `impostor`, and nothing past `cull`, in a frame', async () => {
    const r = await run({
      prefabs: {
        cam: CAMERA,
        tree: { components: { model: { model: 'models/tree' }, lod: { levels: [{ distance: 30, model: 'models/tree_low' }], impostor: 80, cull: 300 } } },
      },
      entities: [
        { id: 'cam', prefab: 'cam', at: [0, 0, 0] },
        { id: 'near', prefab: 'tree', at: [0, 0, 10] },
        { id: 'mid', prefab: 'tree', at: [0, 0, 50] },
        { id: 'far', prefab: 'tree', at: [0, 0, 150] },
        { id: 'gone', prefab: 'tree', at: [0, 0, 400] },
      ],
    }, { binary: { 'assets/models/tree.glb': triangle(1), 'assets/models/tree_low.glb': triangle(2) } });
    const frame = r.frame();
    const drawnBy = (entity: EntityId): string[] => frame.meshes.filter((b) => b.entities.includes(entity)).map((b) => b.geometry.id);
    expect(drawnBy(r.id('near'))[0]).toContain('tree.glb');
    expect(drawnBy(r.id('mid'))[0]).toContain('tree_low.glb');
    expect(drawnBy(r.id('far'))).toEqual([]);
    expect(drawnBy(r.id('gone'))).toEqual([]);
    expect(frame.impostors).toHaveLength(1);
    const impostor = frame.impostors![0]!;
    // The impostor shows the last level's model, at the far tree.
    expect(impostor.source.id).toBe('impostor:assets/models/tree_low.glb');
    expect(impostor.entities).toEqual([r.id('far')]);
    expect([...impostor.instances.subarray(0, 6)]).toEqual([0, 0, 150, 1, 0, 1]);
    expect(impostor.source.radius).toBeGreaterThan(0);
  });
});

describe('static merging', () => {
  it('merges a static subtree into one chunk draw, kept while nothing moves, rebuilt when something does', async () => {
    const r = await run({
      prefabs: {
        cam: CAMERA,
        yard: { components: { static_mesh: { chunk: 64 } }, children: [
          { components: { shape: { kind: 'box', color: '#808080' } }, at: [1, 0, 0] },
          { components: { shape: { kind: 'sphere', color: '#808080' } }, at: [-1, 0, 0] },
        ] },
      },
      entities: [{ id: 'cam', prefab: 'cam', at: [10, 2, 0] }, { id: 'yard', prefab: 'yard', at: [10, 0, 10] }],
    });
    const merged = (): Frame3d['meshes'] => r.frame().meshes.filter((b) => b.geometry.id.startsWith('static:'));
    expect(merged()).toHaveLength(1);
    const first = merged()[0]!;
    expect(first.entities).toEqual([null]);
    expect(r.frame().meshes.some((b) => b.geometry.id === 'shape:box')).toBe(false);
    r.step(3);
    expect(merged()[0]!.geometry).toBe(first.geometry);
    const yard = r.kernel.world.get(r.id('yard'))!;
    yard.transform.position = new Vec3(10, 0, 11);
    r.step();
    expect(merged()[0]!.geometry).not.toBe(first.geometry);
    expect(merged()[0]!.geometry.min[2]).toBeGreaterThan(first.geometry.min[2]);
  });

  it('bakes each mesh into world space, tint into vertex colors, and keeps mirrored winding front-facing', () => {
    const tri = { id: 't', positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), normals: new Float32Array([0, 0, -1, 0, 0, -1, 0, 0, -1]), uvs: new Float32Array(6), indices: new Uint16Array([0, 1, 2]), joints: null, weights: null, colors: null, min: [0, 0, 0] as const, max: [1, 1, 0] as const };
    const at = (x: number, sx = 1): Float32Array => new Float32Array([sx, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
    const g = mergeGeometry('m', [{ geometry: tri, matrix: at(5), tint: [1, 1, 1, 1] }, { geometry: tri, matrix: at(10, -1), tint: [0.5, 1, 1, 1] }]);
    expect([...g.positions.subarray(0, 3)]).toEqual([5, 0, 0]);
    expect([...g.positions.subarray(9, 12)]).toEqual([10, 0, 0]);
    expect([...g.indices]).toEqual([0, 1, 2, 3, 5, 4]);
    // Mirroring x leaves a -z normal pointing -z (inverse-transpose of diag(-1, 1, 1)), not flipped inward.
    expect(Array.from(g.normals.subarray(9, 12), (v) => v + 0)).toEqual([0, 0, -1]);
    expect(g.colors![12]).toBeCloseTo(0.214, 3);
    expect(g.min).toEqual([5, 0, 0]);
    expect(g.max).toEqual([10, 1, 0]);
  });
});

/** The viewmodel plugin's component, as render3d reads it (`__view_layer__`). */
function viewmodelStub(layer: () => object): ComponentDef {
  return { id: 'viewmodel', schema: {}, methods: { get __view_layer__() { return layer(); } } } as unknown as ComponentDef;
}

describe('the first-person view layer', () => {
  it('draws the viewmodel subtree on its layer in its camera\'s view only, with the overlay projection, casting no shadows', async () => {
    let camera = 0 as EntityId;
    let body = 0 as EntityId;
    const r = await run({
      prefabs: {
        cam: CAMERA,
        hands: { components: { viewmodel: {} }, children: [{ components: { shape: { kind: 'box', color: '#ff0000' } }, at: [0.2, -0.2, 0.5] }] },
        hero: { components: { shape: { kind: 'capsule', color: '#00ff00' } } },
      },
      entities: [{ id: 'cam', prefab: 'cam', at: [0, 1.6, 0] }, { id: 'hands', prefab: 'hands', at: [0, 1.6, 0] }, { id: 'hero', prefab: 'hero', at: [0, 1, 0] }],
    }, { components: [viewmodelStub(() => ({ camera, fov: 50, near: 0.05, body, bodyOptions: {}, hideBody: true }))] });
    camera = r.id('cam');
    body = r.id('hero');
    r.step();
    const frame = r.frame();
    const vm = frame.meshes.find((b) => b.geometry.id === 'shape:box')!;
    expect(vm.layer).toBe('viewmodel');
    expect(vm.views).toEqual({ only: camera });
    expect(vm.castShadows).toBe(false);
    // The body is hidden in its own view (hideBody) but still drawn, and casts its shadow, elsewhere.
    const hero = frame.meshes.filter((b) => b.entities.includes(body));
    expect(hero.map((b) => b.views)).toEqual([{ except: camera }]);
    expect(hero[0]!.castShadows).toBe(true);
    const view = frame.views[0]!;
    const overlay = view.overlay!;
    expect(overlay.near).toBe(0.05);
    // Depth of a point at the overlay's far plane is VIEWMODEL_DEPTH, the near plane 0.
    const depth = (z: number): number => {
      const m = overlay.viewProjection;
      const p = [view.position[0] + view.forward[0] * z, view.position[1] + view.forward[1] * z, view.position[2] + view.forward[2] * z];
      const cz = m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!;
      const cw = m[3]! * p[0]! + m[7]! * p[1]! + m[11]! * p[2]! + m[15]!;
      return cz / cw;
    };
    expect(depth(0.05)).toBeCloseTo(0, 6);
    expect(depth(overlay.far)).toBeCloseTo(VIEWMODEL_DEPTH, 6);
  });

  it('draws the body in its own view with the layer\'s Model options and no second shadow', async () => {
    let camera = 0 as EntityId;
    const r = await run({
      prefabs: { cam: CAMERA, hands: { components: { viewmodel: {} } }, hero: { components: { shape: { kind: 'capsule' } } } },
      entities: [{ id: 'cam', prefab: 'cam', at: [0, 1.6, 0] }, { id: 'hands', prefab: 'hands' }, { id: 'hero', prefab: 'hero', at: [0, 1, 2] }],
    }, { components: [viewmodelStub(() => ({ camera, fov: 50, near: 0.05, body: null, bodyOptions: {}, hideBody: false }))] });
    camera = r.id('cam');
    r.step();
    // No body named: nothing is masked.
    expect(r.frame().meshes.find((b) => b.entities.includes(r.id('hero')))!.views).toBe(undefined);
  });
});

describe('morph targets', () => {
  const face = writeGlb({
    nodes: [{ name: 'face', mesh: 0 }],
    meshes: [{
      positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], indices: [0, 1, 2],
      targets: [{ positions: [0, 0, 0, 0, 0, 0, 0, 1, 0] }], targetNames: ['smile'],
    }],
    animations: [{ name: 'grin', channels: [{ node: 0, path: 'weights', times: [0, 1], values: [0, 1] }] }],
  });

  it('deforms by a clip\'s weight channel, and set_morph overrides it, into a per-entity dynamic geometry', async () => {
    const r = await run({
      prefabs: { cam: CAMERA, head: { components: { model: { model: 'models/face' }, animator: {} } } },
      entities: [{ id: 'cam', prefab: 'cam', at: [0, 0, -5] }, { id: 'head', prefab: 'head' }],
    }, { binary: { 'assets/models/face.glb': face } });
    const animator = r.kernel.world.get(r.id('head'))!.components.get('animator') as unknown as {
      play(clip: string, ...kw: unknown[]): void; set_morph(name: string, value: number | null, ...kw: unknown[]): void;
    };
    const geometry = (): MorphedGeometry => r.frame().meshes.find((b) => b.entities.includes(r.id('head')))!.geometry as MorphedGeometry;
    animator.play('grin');
    r.step(31);
    const g = geometry();
    expect(g).toBeInstanceOf(MorphedGeometry);
    // Halfway through the clip: weight ~0.5 moves the top vertex up by ~0.5.
    expect(g.positions[7]!).toBeGreaterThan(1.4);
    expect(g.positions[7]!).toBeLessThan(1.6);
    const version = g.version;
    animator.set_morph('smile', 0);
    r.step();
    expect(geometry()).toBe(g);
    expect(g.positions[7]).toBeCloseTo(1, 5);
    expect(g.version).toBeGreaterThan(version);
    expect(() => { animator.set_morph('frown', 1); r.step(); }).toThrow(/PP3784|frown/);
  });
});

describe('the models plugin\'s skeleton and ragdolls', () => {
  it('gives the animated bones in model space, and blends ragdoll bones over the animation by weight', async () => {
    const glb = standInCharacter(['idle']);
    let ragdoll: { weight: number; bones: Map<string, { position: Vec3; rotation: Quat }> } | undefined;
    const physics: KernelPlugin = { id: 'fake_ragdolls', install: (k) => k.provide(RAGDOLL_POSE_SERVICE, { pose: () => ragdoll }) };
    const r = await run({
      prefabs: { cam: CAMERA, guy: { components: { model: { model: 'models/guy' } } } },
      entities: [{ id: 'cam', prefab: 'cam', at: [0, 1, -5] }, { id: 'guy', prefab: 'guy' }],
    }, { binary: { 'assets/models/guy.glb': glb }, plugins: [physics] });
    const skeleton = r.kernel.service(SKELETON_SERVICE).pose(r.id('guy'))!;
    expect(skeleton.bones.map((b) => b.name)).toEqual(['root', 'upper']);
    expect(skeleton.bones[1]!.parent).toBe(0);
    const upper = skeleton.bones[1]!;
    ragdoll = { weight: 0.5, bones: new Map([['upper', { position: upper.position.__add__(new Vec3(1, 0, 0)), rotation: upper.rotation }]]) };
    r.step();
    const blended = r.kernel.service(SKELETON_SERVICE).pose(r.id('guy'))!.bones[1]!;
    expect(blended.position.x - upper.position.x).toBeCloseTo(0.5, 4);
  });
});

describe('generated meshes', () => {
  it('draws the procgen service\'s parts as one instance each at the mesh\'s world matrix', async () => {
    const geometry = { id: 'sweep:1#v1', positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]), normals: new Float32Array(9), uvs: new Float32Array(6), indices: new Uint32Array([0, 1, 2]), joints: null, weights: null, colors: null, min: [0, 0, 0] as const, max: [1, 0, 1] as const };
    const mesh: GeneratedMesh = {
      key: 'sweep:1', entity: null, version: 1, world: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1]), collision: null, collisionVersion: 0,
      parts: [{ geometry, castShadows: true, material: { id: 'asphalt', color: [0.2, 0.2, 0.2, 1], texture: null, roughness: 0.9, metallic: 0, blend: false, doubleSided: true, unlit: false } }],
    };
    const procgen: KernelPlugin = { id: 'fake_procgen', install: (k) => k.provide(PROCGEN_SERVICE, { meshes: () => [mesh] } as never) };
    const r = await run({ prefabs: { cam: CAMERA }, entities: [{ id: 'cam', prefab: 'cam', at: [0, 2, -5] }] }, { plugins: [procgen] });
    const drawn = r.frame().meshes.find((b) => b.geometry === geometry)!;
    expect(drawn.count).toBe(1);
    expect(drawn.instances[12]).toBe(3);
    expect(drawn.instances.length).toBe(MESH_INSTANCE_STRIDE);
    expect(drawn.material.doubleSided).toBe(true);
    expect(drawn.castShadows).toBe(true);
  });
});

describe('render to texture', () => {
  it('a feed camera draws into its texture, not a screen; a monitor glows with it; feeds redraw at their rate within the budget', async () => {
    const r = await run({
      prefabs: {
        cam: CAMERA,
        security: { components: { camera: { fov: 70 }, render_texture: { name: 'lobby', width: 320, height: 180, fps: 10 } } },
        tv: { components: { shape: { kind: 'box', size: [1.6, 0.9, 0.05] }, monitor: { feed: 'lobby', brightness: 0.8 } } },
      },
      entities: [{ id: 'cam', prefab: 'cam', at: [0, 1.6, -4] }, { id: 'security', prefab: 'security', at: [10, 3, 0] }, { id: 'tv', prefab: 'tv', at: [0, 1.5, 0] }],
    });
    const frame = r.frame();
    expect(frame.views.map((v) => v.camera)).toEqual([r.id('cam')]);
    const feed = frame.offscreen!.find((o) => o.target === 'lobby')!;
    expect(feed.view.camera).toBe(r.id('security'));
    expect(feed.view.viewport).toEqual({ x: 0, y: 0, width: 320, height: 180 });
    const tv = frame.meshes.find((b) => b.entities.includes(r.id('tv')))!;
    expect(tv.material.emissiveTexture?.source).toEqual({ kind: 'target', target: 'lobby' });
    expect(tv.material.emissive[0]).toBeCloseTo(0.8, 6);
    // 10 fps at 60 frames per second of game time: redrawn about one frame in six.
    let due = 0;
    for (let i = 0; i < 60; i++) {
      r.step();
      if (r.frame().offscreen!.find((o) => o.target === 'lobby')!.due) due++;
    }
    expect(due).toBeGreaterThanOrEqual(5);
    expect(due).toBeLessThanOrEqual(12);
  });

  it('a mirror reflects the first view across its plane with an oblique near plane on the mirror', async () => {
    const r = await run({
      prefabs: { cam: CAMERA, glass: { components: { shape: { kind: 'plane', size: [4, 1, 4] }, mirror: { resolution: 0.5 } } } },
      entities: [{ id: 'cam', prefab: 'cam', at: [0, 2, -5] }, { id: 'glass', prefab: 'glass', at: [0, 0, 0] }],
    });
    const frame = r.frame();
    const mirror = frame.offscreen!.find((o) => o.target.startsWith('mirror:'))!;
    const main = frame.views[0]!;
    expect(mirror.view.mirrored).toBe(true);
    expect(mirror.view.position[1]).toBeCloseTo(-main.position[1], 5);
    expect(mirror.width).toBe(Math.round(main.viewport.width * 0.5));
    // A point on the mirror plane sits on the reflected view's near plane; one above it in front, one below it clipped.
    const clipZ = (p: number[]): number => {
      const m = mirror.view.viewProjection;
      const z = m[2]! * p[0]! + m[6]! * p[1]! + m[10]! * p[2]! + m[14]!;
      const w = m[3]! * p[0]! + m[7]! * p[1]! + m[11]! * p[2]! + m[15]!;
      return z / w;
    };
    expect(clipZ([0, 0, 1])).toBeCloseTo(0, 4);
    expect(clipZ([0, 1, 1])).toBeGreaterThan(0);
    expect(clipZ([0, -1, 1])).toBeLessThan(0);
    const glass = frame.meshes.find((b) => b.entities.includes(r.id('glass')))!;
    expect(glass.material.projected).toBe(true);
    expect(glass.material.baseColorTexture?.source).toEqual({ kind: 'target', target: mirror.target });
  });
});

describe('decals and fog of war in a frame', () => {
  it('turns decal components into boxes, nearest first within the quality\'s budget', async () => {
    const r = await run({
      prefabs: { cam: CAMERA, scorch: { components: { decal: { image: 'images/scorch', size: [2, 1, 2] } } } },
      entities: [{ id: 'cam', prefab: 'cam', at: [0, 2, -5] }, { id: 'a', prefab: 'scorch', at: [0, 0, 1] }, { id: 'b', prefab: 'scorch', at: [0, 0, 8] }],
    }, { binary: { 'assets/images/scorch.png': new Uint8Array(1) } });
    const decals = r.frame().decals!;
    expect(decals.map((d) => d.entity).sort()).toEqual([r.id('a'), r.id('b')].sort());
    // The box is the placement scaled by size: its +x edge is 1 m from its center.
    expect(decals[0]!.matrix[0]).toBe(2);
    expect(decals[0]!.angleFade).toBeCloseTo(Math.cos(Math.PI / 3), 6);
  });

  it('gives a camera with a fog overlay its team\'s cells around where it looks', async () => {
    const service = {
      cell: 2, version: 1, teams: () => ['blue'], visible: () => false, explored: () => false, sees: () => false,
      field: (team: string, minX: number, minZ: number, maxX: number, maxZ: number) => ({
        cell: 2, minX, minZ, cols: (maxX - minX) / 2, rows: (maxZ - minZ) / 2, cells: new Uint8Array(((maxX - minX) / 2) * ((maxZ - minZ) / 2)).fill(team === 'blue' ? 2 : 0),
      }),
    };
    const ai: KernelPlugin = { id: 'fake_ai', install: (k) => k.provide(FOG_OF_WAR_SERVICE, service) };
    const r = await run({
      prefabs: { cam: { components: { camera: { fov: 60, pitch: 50 }, fog_overlay: { team: 'blue' } } } },
      entities: [{ id: 'cam', prefab: 'cam', at: [0, 20, 0] }],
    }, { plugins: [ai] });
    const fog = r.frame().views[0]!.fogOfWar!;
    expect(fog.cells.every((c) => c === 2)).toBe(true);
    expect(Math.abs(fog.minX % 32)).toBe(0);
    expect(fog.explored[3]).toBeCloseTo(0.45, 6);
    const key = fog.key;
    r.step();
    expect(r.frame().views[0]!.fogOfWar!).toBe(fog);
    expect(key).toContain('|blue|');
  });
});

describe('photos and portraits', () => {
  it('captures the last frame from a camera, and a model alone in a studio with a transparent background', async () => {
    const r = await run({
      prefabs: { cam: CAMERA, tree: { components: { model: { model: 'models/tree' } } } },
      entities: [{ id: 'cam', prefab: 'cam', at: [0, 2, -5] }, { id: 'tree', prefab: 'tree' }],
    }, { binary: { 'assets/models/tree.glb': triangle(1) } });
    const engine = r.engine;
    const photo = await engine.photo({ width: 64, height: 32 });
    expect([photo.width, photo.height, photo.pixels.length]).toEqual([64, 32, 64 * 32 * 4]);
    const captured = r.surface.captures[0]!;
    expect(captured.frame.views[0]!.viewport).toEqual({ x: 0, y: 0, width: 64, height: 32 });
    expect(captured.frame.meshes).toBe(r.frame().meshes);
    const portrait = await engine.portrait({ model: 'models/tree' }, { width: 32, height: 32, yaw: 30, pitch: 10, background: null });
    expect(portrait.pixels[3]).toBe(0);
    const studio = r.surface.captures[1]!.frame;
    expect(studio.meshes).toHaveLength(1);
    expect(studio.terrain).toBe(null);
    expect(studio.views[0]!.clear).toEqual([0, 0, 0, 0]);
    // Framed: the model's center projects to the middle of the image.
    const m = studio.views[0]!.viewProjection;
    const c = [-0.5, 0.5, 0]; // glTF x is mirrored on load
    const w = m[3]! * c[0]! + m[7]! * c[1]! + m[11]! * c[2]! + m[15]!;
    expect((m[0]! * c[0]! + m[4]! * c[1]! + m[8]! * c[2]! + m[12]!) / w).toBeCloseTo(0, 4);
    expect(() => engine.photo({ width: 0, height: 10 })).toThrow(/PP3846/);
  });
});

describe('compressed texture variants', () => {
  it('names the KTX2 variants the project has, best family first', () => {
    const files = new Set(['assets/images/bricks.etc2.ktx2', 'assets/images/bricks.bc.ktx2']);
    expect(compressedVariants('assets/images/bricks.png', (p) => files.has(p))).toEqual(['assets/images/bricks.bc.ktx2', 'assets/images/bricks.etc2.ktx2']);
    expect(compressedVariants('assets/images/grass.png', (p) => files.has(p))).toEqual([]);
  });
});
