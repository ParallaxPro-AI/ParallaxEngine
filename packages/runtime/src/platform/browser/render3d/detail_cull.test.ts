/**
 * Detail culling (`Quality3d.detailPixels`): instances whose bounding sphere projects under
 * the quality's pixel radius are left out of a view, and casters under that many texels out
 * of a shadow tile; the viewmodel layer never is.
 */

import { describe, expect, it } from 'vitest';
import { MESH_INSTANCE_STRIDE, PLAIN_POST } from '../../../core/index.js';
import type { Frame3d, Material3d, MeshBatch, Quality3d, View3d } from '../../../core/index.js';
import { compose, invert, multiply, orthographic, perspective, unitShape, viewMatrix } from '../../../resource/index.js';
import { QUALITY_LADDER } from '../../../function/plugins/render3d/quality.js';
import { pixelScale, sphereSmall } from './cull.js';
import { MeshPlan } from './plan_meshes.js';
import { planFrame } from './plan.js';

const MATERIAL: Material3d = {
  id: 'm', baseColor: [1, 1, 1, 1], baseColorTexture: null, metallic: 0, roughness: 0.5, metallicRoughnessTexture: null,
  emissive: [0, 0, 0], emissiveTexture: null, alphaMode: 'opaque', alphaCutoff: 0.5, doubleSided: false, unlit: false,
};
const box = unitShape('box');
/** A unit box's bounding-sphere radius. */
const R = Math.sqrt(3) / 2;

function view(): View3d {
  const forward: [number, number, number] = [0, 0, 1];
  const v = viewMatrix([0, 0, 0], [1, 0, 0], [0, 1, 0], forward);
  const p = perspective(60, 1, 0.1, 1000);
  const vp = multiply(p, v);
  return {
    camera: 1, viewport: { x: 0, y: 0, width: 400, height: 400 }, position: [0, 0, 0], right: [1, 0, 0], up: [0, 1, 0], forward,
    view: v, projection: p, viewProjection: vp, inverseViewProjection: invert(vp)!, near: 0.1, far: 1000, clear: null, colorVision: 'none',
  };
}

/** Boxes of edge `size` at points. */
function boxes(size: number, ...at: [number, number, number][]): Float32Array {
  const out = new Float32Array(at.length * MESH_INSTANCE_STRIDE);
  at.forEach(([x, y, z], i) => {
    out.set(compose(x, y, z, 0, 0, 0, 1, size, size, size), i * MESH_INSTANCE_STRIDE);
    out.set([1, 1, 1, 1], i * MESH_INSTANCE_STRIDE + 16);
  });
  return out;
}

function frame(meshes: MeshBatch[], quality: Quality3d = QUALITY_LADDER.high): Frame3d {
  return {
    frame: 1, views: [view()],
    environment: {
      sky: { zenith: [0.2, 0.4, 0.8], horizon: [0.8, 0.9, 1] }, fog: { kind: 'none', color: [0, 0, 0], density: 0, near: 0, far: 0, volumetric: 0 },
      ambient: [0.3, 0.3, 0.3], sun: null, post: PLAIN_POST,
    },
    quality, sunShadow: null, localShadows: [], terrain: null, meshes, skinned: [], lights: [], billboards: [], texts: [], lines: [], outlines: [],
  };
}

const batch = (instances: Float32Array, count: number, extra: Partial<MeshBatch> = {}): MeshBatch => ({
  geometry: box, material: MATERIAL, count, instances, entities: Array.from({ length: count }, (_, i) => i + 1), castShadows: true, ...extra,
});

describe('projected size', () => {
  it('is the focal length in pixels over view depth for a perspective view', () => {
    const vp = view().viewProjection;
    const scale = pixelScale(vp, 400, 400);
    expect(scale).toBeCloseTo(200 / Math.tan(Math.PI / 6), 3);
    // A 0.1 m sphere: 3.46 px at 10 m, 0.35 px at 100 m.
    expect(sphereSmall(vp, scale, 0.5, 0, 0, 10, 0.1)).toBe(false);
    expect(sphereSmall(vp, scale, 0.5, 0, 0, 100, 0.1)).toBe(true);
    // A sphere around the eye is never small; detail 0 is off.
    expect(sphereSmall(vp, scale, 0.5, 0, 0, 0.05, 0.1)).toBe(false);
    expect(sphereSmall(vp, scale, 0, 0, 0, 900, 0.001)).toBe(false);
  });

  it('is texels per meter for an orthographic map, independent of depth', () => {
    const vp = orthographic(-50, 50, -50, 50, 0.1, 400);
    const scale = pixelScale(vp, 2048, 2048);
    expect(scale).toBeCloseTo(2048 / 100, 6);
    expect(sphereSmall(vp, scale, 0.5, 0, 0, 10, 0.02)).toBe(true);
    expect(sphereSmall(vp, scale, 0.5, 0, 0, 300, 0.05)).toBe(false);
  });
});

describe('detail culling in the frame plan', () => {
  const plan = (f: Frame3d) => planFrame(f, { width: 400, height: 400, ready: () => true, text: () => { throw new Error('no text'); } });

  it('leaves out instances too small to see, keeping the rest of their batch as one draw', () => {
    // 1 cm boxes: 0.6 px at 5 m (kept on high, 0.5 px), 0.3 px at 10 m (culled).
    const p = plan(frame([batch(boxes(0.01, [0, 0, 5], [0, 0, 10], [0, 0, 4]), 3)]));
    const opaque = p.views[0]!.opaque;
    expect(opaque.map((i) => i.instanceCount)).toEqual([2]);
    expect(p.stats).toEqual({ tested: 3, inFrustum: 2, occluded: 0 });
  });

  it('culls by the quality: what high draws at 400 m, low leaves out', () => {
    // A unit box: R · 346 / d px — 0.75 px at 400 m.
    const far = batch(boxes(1, [0, 0, 400]), 1);
    expect(plan(frame([far], QUALITY_LADDER.high)).views[0]!.opaque.length).toBe(1);
    expect(plan(frame([far], QUALITY_LADDER.low)).views[0]!.opaque.length).toBe(0);
    expect(plan(frame([far], { ...QUALITY_LADDER.low, detailPixels: 0 })).views[0]!.opaque.length).toBe(1);
    expect((R * pixelScale(view().viewProjection, 400, 400)) / 400).toBeCloseTo(0.75, 2);
  });

  it('never culls the viewmodel layer', () => {
    const vm = batch(boxes(0.001, [0, 0, 5]), 1, { layer: 'viewmodel' });
    const tinyView = { ...view(), overlay: { projection: view().projection, viewProjection: view().viewProjection, inverseViewProjection: view().inverseViewProjection, near: 0.1, far: 1000 } };
    const p = plan({ ...frame([vm]), views: [tinyView] });
    expect(p.views[0]!.viewmodel.length).toBe(1);
  });

  it('leaves casters smaller than their shadow tile texels out of the tile', () => {
    const f = frame([batch(boxes(0.01, [0, 0, 10]), 1), batch(boxes(1, [0, 0, 10]), 1, { geometry: { ...box, id: 'big' } })]);
    const meshes = new MeshPlan(f, { ready: () => true, slotOf: () => 0 });
    const vp = orthographic(-50, 50, -50, 50, 0.1, 400);
    // 100 m over 2048 texels: the 1 cm box is 0.18 texels across its radius; the 1 m box 18.
    expect(meshes.forTile(vp, 2048).map((i) => i.geometry.id)).toEqual(['big']);
    expect(meshes.detailCulledCasters).toBe(1);
    // Without the tile's size (or with detail off) every caster in the frustum casts.
    expect(meshes.forTile(vp).length).toBe(2);
  });
});
