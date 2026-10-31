import { describe, expect, it } from 'vitest';
import { Color, hasEffects, kw, NO_EFFECTS } from '../../../core/index.js';
import type { EntityId, Frame3d, Material3d, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { Fields, GameDefinition } from '../../kernel/index.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../../../platform/headless/render3d.js';
import {
  bindingId, FRAME_FIELDS, FRAME_SLOT, MATERIAL_FIELDS, MATERIAL_SLOT, offsetOf, packMaterial, srgbToLinear,
} from '../../../platform/browser/render3d/layout.js';
import { packHazes } from '../../../platform/browser/render3d/plan.js';
import { visuals } from '../visuals/index.js';
import { models } from '../models/index.js';
import { render3d } from './index.js';
import { withEffects } from './surface_fx.js';

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const map = new Map(Object.entries(contents).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => [...map.keys()].sort(), read: (p) => map.get(p)! };
}

async function run(prefabs: Record<string, unknown>, entities: unknown[]): Promise<{
  kernel: Kernel; frame(): Frame3d; id(placed: string): EntityId; step(n?: number): void; fields(placed: string, component: string): Fields;
}> {
  const project = files({
    ...Object.fromEntries(Object.entries(prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities },
  });
  const loaded = loadProject(project);
  expect(loaded.diagnostics).toEqual([]);
  const surface = new RecordingSurface3d();
  const plugin = render3d({ surface, files: project });
  const game: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };
  const kernel = new Kernel({
    project: loaded, game, context: {}, fixedStep: DT,
    plugins: [visuals({ dimension: '3d' }), models({ files: project, binary: new MemoryBinaryFiles({}) }), plugin],
  });
  plugin.engine.preload();
  await plugin.engine.whenLoaded();
  kernel.start('main');
  kernel.step(DT);
  const id = (placed: string): EntityId => [...kernel.world.live()].find((r) => r.placedId === placed)!.id;
  return {
    kernel,
    frame: () => surface.last!,
    id,
    step: (n = 1) => { for (let i = 0; i < n; i++) kernel.step(DT); },
    fields: (placed, component) => kernel.world.get(id(placed))!.components.get(component)!,
  };
}

const CAMERA = { components: { camera: { fov: 60 } } };
const BOX = { kind: 'box', size: [1, 1, 1], cast_shadows: true };

const materialOf = (frame: Frame3d, entity: EntityId): Material3d => frame.meshes.find((b) => b.entities.includes(entity))!.material;
const batchOf = (frame: Frame3d, entity: EntityId): Frame3d['meshes'][number] => frame.meshes.find((b) => b.entities.includes(entity))!;

describe('surface effects', () => {
  it('rim light and scrolling ride on the material; entities with the same effects share a batch', async () => {
    const r = await run(
      { cam: CAMERA, belt: { components: { shape: BOX, surface_fx: { rim: 1.5, rim_color: '#40c0ff', scroll: [0.5, 0] } } } },
      [{ id: 'cam', prefab: 'cam', at: [0, 1, -5] }, { id: 'a', prefab: 'belt', at: [-1, 0, 0] }, { id: 'b', prefab: 'belt', at: [1, 0, 0] }],
    );
    const frame = r.frame();
    const m = materialOf(frame, r.id('a'));
    expect(m.effects?.rim).toBe(1.5);
    expect(m.effects?.scroll).toEqual([0.5, 0]);
    expect(m.alphaMode).toBe('opaque');
    expect(batchOf(frame, r.id('a'))).toBe(batchOf(frame, r.id('b')));
    expect(batchOf(frame, r.id('a')).castShadows).toBe(true);
    expect(frame.time).toBeCloseTo(r.kernel.time.now, 9);
  });

  it('no effects on: the plain material, untouched', async () => {
    const r = await run(
      { cam: CAMERA, plain: { components: { shape: BOX, surface_fx: {} } } },
      [{ id: 'cam', prefab: 'cam', at: [0, 1, -5] }, { id: 'p', prefab: 'plain', at: [0, 0, 0] }],
    );
    expect(materialOf(r.frame(), r.id('p')).effects).toBeUndefined();
  });

  it('flash() pops to its strength and fades out over its seconds', async () => {
    const r = await run(
      { cam: CAMERA, crate: { components: { shape: BOX, surface_fx: {} } } },
      [{ id: 'cam', prefab: 'cam', at: [0, 1, -5] }, { id: 'c', prefab: 'crate', at: [0, 0, 0] }],
    );
    const fx = r.fields('c', 'surface_fx') as Fields & { flash(...args: unknown[]): void };
    fx.flash(new Color(1, 0, 0), kw({ seconds: 0.2, strength: 1 }));
    r.step();
    const first = materialOf(r.frame(), r.id('c')).effects!;
    expect(first.flashColor).toEqual([1, 0, 0]);
    expect(first.flash).toBeGreaterThan(0.85);
    r.step(6);
    const later = materialOf(r.frame(), r.id('c')).effects!.flash;
    expect(later).toBeLessThan(first.flash);
    expect(later).toBeGreaterThan(0);
    r.step(12);
    expect(materialOf(r.frame(), r.id('c')).effects).toBeUndefined();
  });

  it('dissolve_to() moves the amount over its seconds, and a dissolving or holographic surface casts no shadow', async () => {
    const r = await run(
      { cam: CAMERA, ghost: { components: { shape: BOX, surface_fx: {} } }, holo: { components: { shape: BOX, surface_fx: { hologram: 1 } } } },
      [{ id: 'cam', prefab: 'cam', at: [0, 1, -5] }, { id: 'g', prefab: 'ghost', at: [0, 0, 0] }, { id: 'h', prefab: 'holo', at: [2, 0, 0] }],
    );
    const fx = r.fields('g', 'surface_fx') as Fields & { dissolve_to(...args: unknown[]): void; dissolved: number };
    fx.dissolve_to(1, 0.5);
    r.step(15);
    const half = materialOf(r.frame(), r.id('g')).effects!.dissolve;
    expect(half).toBeGreaterThan(0.4);
    expect(half).toBeLessThan(0.6);
    expect(fx.dissolved).toBeCloseTo(half, 6);
    expect(batchOf(r.frame(), r.id('g')).castShadows).toBe(false);
    r.step(20);
    expect(materialOf(r.frame(), r.id('g')).effects!.dissolve).toBe(1);
    // A hologram is see-through: blended and shadowless.
    const holo = batchOf(r.frame(), r.id('h'));
    expect(holo.material.alphaMode).toBe('blend');
    expect(holo.castShadows).toBe(false);
  });

  it('heat haze: a steady shimmer above the entity, and a pulse ring that grows and fades', async () => {
    const r = await run(
      { cam: CAMERA, fire: { components: { heat_haze: { radius: 2, strength: 0.5, height: 1 } } } },
      [{ id: 'cam', prefab: 'cam', at: [0, 1, -5] }, { id: 'f', prefab: 'fire', at: [0, 0, 3] }],
    );
    expect(r.frame().hazes).toEqual([{ position: [0, 1, 3], radius: 2, strength: 0.5, ring: 0 }]);
    const haze = r.fields('f', 'heat_haze') as Fields & { pulse(...args: unknown[]): void };
    haze.pulse(10, kw({ seconds: 1 }));
    r.step(30);
    const ring = r.frame().hazes!.find((h) => h.ring > 0)!;
    expect(ring.radius).toBeGreaterThan(4);
    expect(ring.radius).toBeLessThan(6);
    expect(ring.strength).toBeGreaterThan(0.2);
    expect(ring.strength).toBeLessThan(0.3);
    r.step(40);
    expect(r.frame().hazes!.filter((h) => h.ring > 0)).toEqual([]);
  });

  it('refuses bad method arguments with a coded error', async () => {
    const r = await run(
      { cam: CAMERA, crate: { components: { shape: BOX, surface_fx: {} } } },
      [{ id: 'cam', prefab: 'cam', at: [0, 1, -5] }, { id: 'c', prefab: 'crate', at: [0, 0, 0] }],
    );
    const fx = r.fields('c', 'surface_fx') as Fields & { dissolve_to(...args: unknown[]): void; flash(...args: unknown[]): void };
    expect(() => fx.dissolve_to(2)).toThrow(/PP3800|0 to 1/);
    expect(() => fx.flash('red')).toThrow(/Color/);
  });
});

describe('surface effects on the GPU side', () => {
  const plain: Material3d = {
    id: 'm', baseColor: [1, 1, 1, 1], baseColorTexture: null, metallic: 0, roughness: 1, metallicRoughnessTexture: null, emissive: [0, 0, 0],
    emissiveTexture: null, alphaMode: 'opaque', alphaCutoff: 0.5, doubleSided: false, unlit: false,
  };
  const fxAt = offsetOf(MATERIAL_FIELDS, 'fxRim');

  it('the material block fits one 256-byte slot', () => {
    expect(MATERIAL_SLOT).toBe(64);
  });

  it('packs nothing for a plain material, and the effect fields for one with effects', () => {
    const out = new Float32Array(MATERIAL_SLOT).fill(7);
    packMaterial(plain, out, 0, 10);
    expect([...out.subarray(fxAt, fxAt + 28)].every((v) => v === 0)).toBe(true);
    expect(hasEffects(NO_EFFECTS)).toBe(false);
    const fx = withEffects(plain, { ...NO_EFFECTS, rim: 2, rimColor: [1, 1, 1], rimPower: 4, dissolve: 0.25, scroll: [0.3, -0.25] });
    packMaterial(fx, out, 0, 10);
    expect(out[fxAt]).toBeCloseTo(2, 6);
    expect(out[fxAt + 3]).toBe(4);
    expect(out[offsetOf(MATERIAL_FIELDS, 'fxDissolve')]).toBe(0.25);
    expect(out[offsetOf(MATERIAL_FIELDS, 'fxDissolve') + 3]).toBe(1);
    // The scroll's phase this frame (fract of speed × time): 0.3 × 10 = 3 → 0; -0.25 × 10 = -2.5 → 0.5.
    const uv = offsetOf(MATERIAL_FIELDS, 'fxUv');
    expect(out[uv]).toBeCloseTo(0, 5);
    expect(out[uv + 1]).toBeCloseTo(0.5, 5);
    expect(out[uv + 3]).toBe(10);
    // Colors go in linear.
    const edge = offsetOf(MATERIAL_FIELDS, 'fxEdge');
    expect(out[edge + 1]).toBeCloseTo(srgbToLinear(0.55) * 3, 5);
  });

  it('an effect material binds its base material\'s textures (animated values never add bindings)', () => {
    const fx = withEffects(plain, { ...NO_EFFECTS, flash: 0.5 });
    expect(fx.id).not.toBe(plain.id);
    expect(bindingId(fx)).toBe('m');
    expect(bindingId(plain)).toBe('m');
  });

  it('packs the strongest hazes in front of the view into the frame block', () => {
    const view = { position: [0, 0, 0], forward: [0, 0, 1], near: 0.1 } as unknown as Frame3d['views'][number];
    const frame = {
      time: 5,
      hazes: [
        { position: [0, 0, 5], radius: 1, strength: 0.2, ring: 0 },
        { position: [0, 0, -20], radius: 1, strength: 1, ring: 0 },
        { position: [1, 0, 8], radius: 3, strength: 0.9, ring: 0.3 },
      ],
    } as unknown as Frame3d;
    const out = new Float32Array(FRAME_SLOT);
    packHazes(frame, view, out, (name) => offsetOf(FRAME_FIELDS, name));
    const at = offsetOf(FRAME_FIELDS, 'haze');
    expect([out[at], out[at + 1]]).toEqual([2, 5]);
    const spots = offsetOf(FRAME_FIELDS, 'hazeAt');
    expect([...out.subarray(spots, spots + 8)]).toEqual([1, 0, 8, 3, 0, 0, 5, 1]);
    const shapes = offsetOf(FRAME_FIELDS, 'hazeShape');
    expect(out[shapes]).toBeCloseTo(0.9, 6);
    expect(out[shapes + 1]).toBeCloseTo(0.3, 6);
  });
});
