/**
 * Render scale in the frame plan: per-instance culling for every mesh (views and shadow
 * tiles), Hi-Z occlusion through the plan's hook, level-of-detail fades in the instance
 * records, the viewmodel layer's overlay slot, and impostors (the hemi-octahedral map, a
 * deterministic bake, per-view culling).
 */

import { describe, expect, it } from 'vitest';
import { MESH_INSTANCE_STRIDE, PLAIN_POST, VIEWMODEL_DEPTH } from '../../../core/index.js';
import type { Frame3d, ImpostorSource3d, Material3d, MeshBatch, View3d } from '../../../core/index.js';
import { compose, invert, multiply, perspective, unitShape, viewMatrix } from '../../../resource/index.js';
import { QUALITY_LADDER } from '../../../function/plugins/render3d/quality.js';
import { boundingSphere, frustumPlanes, sphereVisible } from './cull.js';
import { bakeViews, frameDirection, frameWeights, hemiOctDecode, hemiOctEncode, packBake, planImpostors, BAKE_SLOT } from './impostors.js';
import { FADE_FLOAT, FRAME_FIELDS, FRAME_SLOT, MESH_INSTANCE_FLOATS, offsetOf } from './layout.js';
import { planFrame } from './plan.js';
import type { FramePlan, PlanOptions } from './plan.js';

const MATERIAL: Material3d = {
  id: 'm', baseColor: [1, 1, 1, 1], baseColorTexture: null, metallic: 0, roughness: 0.5, metallicRoughnessTexture: null,
  emissive: [0, 0, 0], emissiveTexture: null, alphaMode: 'opaque', alphaCutoff: 0.5, doubleSided: false, unlit: false,
};

function view(camera = 1, eye: [number, number, number] = [0, 0, 0]): View3d {
  const forward: [number, number, number] = [0, 0, 1];
  const v = viewMatrix(eye, [1, 0, 0], [0, 1, 0], forward);
  const p = perspective(60, 1, 0.1, 1000);
  const vp = multiply(p, v);
  return {
    camera, viewport: { x: 0, y: 0, width: 400, height: 400 }, position: eye, right: [1, 0, 0], up: [0, 1, 0], forward,
    view: v, projection: p, viewProjection: vp, inverseViewProjection: invert(vp)!, near: 0.1, far: 1000, clear: null, colorVision: 'none',
  };
}

function instances(...positions: [number, number, number][]): Float32Array {
  const out = new Float32Array(positions.length * MESH_INSTANCE_STRIDE);
  positions.forEach(([x, y, z], i) => {
    out.set(compose(x, y, z, 0, 0, 0, 1, 1, 1, 1), i * MESH_INSTANCE_STRIDE);
    out.set([1, 1, 1, 1], i * MESH_INSTANCE_STRIDE + 16);
  });
  return out;
}

function frame(meshes: MeshBatch[], views: View3d[] = [view()], over: Partial<Frame3d> = {}): Frame3d {
  return {
    frame: 1, views,
    environment: {
      sky: { zenith: [0.2, 0.4, 0.8], horizon: [0.8, 0.9, 1] }, fog: { kind: 'none', color: [0, 0, 0], density: 0, near: 0, far: 0, volumetric: 0 },
      ambient: [0.3, 0.3, 0.3], sun: null, post: PLAIN_POST,
    },
    quality: QUALITY_LADDER.high, sunShadow: null, localShadows: [], terrain: null, meshes, skinned: [], lights: [], billboards: [], texts: [],
    lines: [], outlines: [], ...over,
  };
}

const plan = (f: Frame3d, options: Partial<PlanOptions> = {}): FramePlan => planFrame(f, {
  width: 400, height: 400, ready: () => true, text: () => { throw new Error('no text'); }, ...options,
});

const box = unitShape('box');

describe('frustum culling every mesh', () => {
  it('tests spheres against the six planes of a view-projection (clip z 0..1)', () => {
    const planes = frustumPlanes(view().viewProjection);
    expect(sphereVisible(planes, 0, 0, 10, 0.5)).toBe(true);
    expect(sphereVisible(planes, 0, 0, -10, 0.5)).toBe(false);
    expect(sphereVisible(planes, 0, 0, -0.2, 0.5)).toBe(true);
    expect(sphereVisible(planes, 50, 0, 10, 0.5)).toBe(false);
    expect(sphereVisible(planes, 0, 0, 1200, 0.5)).toBe(false);
    const s: number[] = [];
    boundingSphere(compose(3, 0, 0, 0, 0, 0, 1, 2, 2, 2), 0, [-0.5, -0.5, -0.5], [0.5, 0.5, 0.5], s, 0);
    expect(s[0]).toBe(3);
    expect(s[3]).toBeCloseTo(Math.sqrt(3), 6);
  });

  it('keeps a batch wholly in view as one range, copies the visible part of a batch partly in view, and drops one out of view', () => {
    const inside: MeshBatch = { geometry: box, material: MATERIAL, count: 2, instances: instances([0, 0, 5], [1, 0, 5]), entities: [1, 2], castShadows: false };
    const partly: MeshBatch = { geometry: { ...box, id: 'b2' }, material: MATERIAL, count: 3, instances: instances([0, 0, 5], [0, 0, -5], [0, 1, 6]), entities: [3, 4, 5], castShadows: false };
    const behind: MeshBatch = { geometry: { ...box, id: 'b3' }, material: MATERIAL, count: 1, instances: instances([0, 0, -9]), entities: [6], castShadows: false };
    const p = plan(frame([inside, partly, behind]));
    const opaque = p.views[0]!.opaque;
    expect(opaque.map((i) => [i.geometry.id, i.instanceCount])).toEqual([['shape:box', 2], ['b2', 2]]);
    expect(opaque[0]!.firstInstance).toBe(0);
    const z = (record: number): number => p.instances[record * MESH_INSTANCE_FLOATS + 14]!;
    const copied = opaque[1]!;
    expect([z(copied.firstInstance), z(copied.firstInstance + 1)]).toEqual([5, 6]);
    expect(p.stats).toEqual({ tested: 6, inFrustum: 4, occluded: 0 });
  });

  it('asks the Hi-Z hook about what is in the frustum only, and leaves the shadow casters alone', () => {
    const batch: MeshBatch = { geometry: box, material: MATERIAL, count: 3, instances: instances([0, 0, 5], [0, 0, 20], [0, 0, -5]), entities: [1, 2, 3], castShadows: true };
    const asked: number[] = [];
    const p = plan(frame([batch]), { occluded: (_camera, _x, _y, z) => { asked.push(z); return z > 10; } });
    expect(asked).toEqual([5, 20]);
    expect(p.views[0]!.opaque[0]!.instanceCount).toBe(1);
    expect(p.stats.occluded).toBe(1);
  });

  it('carries level-of-detail fades in the instance records; a fading-out instance casts no shadow', () => {
    const batch: MeshBatch = {
      geometry: box, material: MATERIAL, count: 2, instances: instances([0, 0, 5], [1, 0, 5]), entities: [1, 2], castShadows: true, fades: new Float32Array([0.25, -0.75]),
    };
    const p = plan(frame([batch]));
    expect(p.instances[FADE_FLOAT]).toBe(0.25);
    expect(p.instances[MESH_INSTANCE_FLOATS + FADE_FLOAT]).toBe(-0.75);
    const p2 = plan(frame([{ ...batch, fades: undefined } as unknown as MeshBatch]));
    expect(p2.instances[FADE_FLOAT]).toBe(1);
  });

  it('draws a batch only in the views its mask allows', () => {
    const only: MeshBatch = { geometry: box, material: MATERIAL, count: 1, instances: instances([0, 0, 5]), entities: [1], castShadows: false, views: { only: 2 } };
    const except: MeshBatch = { geometry: { ...box, id: 'e' }, material: MATERIAL, count: 1, instances: instances([0, 0, 5]), entities: [2], castShadows: false, views: { except: 2 } };
    const p = plan(frame([only, except], [view(1), { ...view(2), viewport: { x: 0, y: 0, width: 200, height: 400 } }]));
    expect(p.views[0]!.opaque.map((i) => i.geometry.id)).toEqual(['e']);
    expect(p.views[1]!.opaque.map((i) => i.geometry.id)).toEqual(['shape:box']);
  });
});

describe('the viewmodel layer in the plan', () => {
  it('puts the layer\'s meshes in the view\'s viewmodel lists, with an overlay frame slot holding its projection', () => {
    const v = view(7);
    const p0 = perspective(50, 1, 0.05, 10);
    for (const i of [2, 6, 10, 14]) p0[i] = p0[i]! * VIEWMODEL_DEPTH;
    const ovp = multiply(p0, v.view);
    const withOverlay: View3d = { ...v, overlay: { projection: p0, viewProjection: ovp, inverseViewProjection: invert(ovp)!, near: 0.05, far: 10 } };
    const gun: MeshBatch = { geometry: box, material: MATERIAL, count: 1, instances: instances([0.2, -0.2, 0.5]), entities: [3], castShadows: false, layer: 'viewmodel', views: { only: 7 } };
    const world: MeshBatch = { geometry: { ...box, id: 'w' }, material: MATERIAL, count: 1, instances: instances([0, 0, 5]), entities: [4], castShadows: true };
    const p = plan(frame([gun, world], [withOverlay]));
    const vp = p.views[0]!;
    expect(vp.viewmodel.map((i) => i.geometry.id)).toEqual(['shape:box']);
    expect(vp.opaque.map((i) => i.geometry.id)).toEqual(['w']);
    expect(vp.overlaySlot).toBe(1);
    const at = offsetOf(FRAME_FIELDS, 'viewProjection');
    expect([...p.frames.subarray(FRAME_SLOT + at, FRAME_SLOT + at + 16)]).toEqual([...ovp]);
    // The rest of the overlay slot is the view's own (camera, lights, clusters).
    const cam = offsetOf(FRAME_FIELDS, 'cameraPosition');
    expect([...p.frames.subarray(FRAME_SLOT + cam, FRAME_SLOT + cam + 4)]).toEqual([...p.frames.subarray(cam, cam + 4)]);
  });
});

describe('impostors', () => {
  it('the hemi-octahedral map round-trips directions and puts frame centers on their own directions', () => {
    for (const d of [[0, 1, 0], [1, 0, 0], [0, 0, -1], [0.3, 0.5, -0.8], [-0.6, 0.2, 0.7]]) {
      const l = Math.hypot(d[0]!, d[1]!, d[2]!);
      const [u, v] = hemiOctEncode(d[0]! / l, d[1]! / l, d[2]! / l);
      const back = hemiOctDecode(u, v);
      for (let k = 0; k < 3; k++) expect(back[k]).toBeCloseTo(d[k]! / l, 5);
    }
    const dir = frameDirection(3, 5, 8);
    const w = frameWeights(dir[0], dir[1], dir[2], 8);
    expect(w.frames[0]).toEqual([3, 5]);
    expect(w.weights[0]).toBeCloseTo(1, 5);
    const between = frameWeights(0.2, 0.7, 0.1, 8);
    expect(between.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6);
    // Below the horizon: the lowest ring, never NaN.
    expect(frameWeights(0, -1, 0.001, 8).weights.every(Number.isFinite)).toBe(true);
  });

  const source: ImpostorSource3d = {
    id: 'impostor:tree', parts: [{ geometry: box, material: MATERIAL, matrix: compose(0, 1, 0, 0, 0, 0, 1, 1, 2, 1) }],
    center: [0, 1, 0], radius: 1.5, frames: 8, frameSize: 64,
  };

  it('bakes deterministically: one orthographic view per frame, the sphere framed, the flipped (WebGL2) bake mirrored in y only', () => {
    const a = bakeViews(source);
    const b = bakeViews(source);
    expect(a).toHaveLength(64);
    expect(a.map((m) => [...m])).toEqual(b.map((m) => [...m]));
    expect([...packBake(source, false)]).toEqual([...packBake(source, false)]);
    expect(packBake(source, false).length).toBe(64 * BAKE_SLOT);
    for (const m of a) {
      // The sphere's center lands at the middle of the frame, mid-depth.
      const c = [0, 1, 0];
      const clip = [0, 1, 2].map((r) => m[r]! * c[0]! + m[4 + r]! * c[1]! + m[8 + r]! * c[2]! + m[12 + r]!);
      expect(clip[0]).toBeCloseTo(0, 5);
      expect(clip[1]).toBeCloseTo(0, 5);
      expect(clip[2]).toBeCloseTo(0.5, 5);
    }
    const flipped = bakeViews(source, true);
    const m = a[20]!;
    const f = flipped[20]!;
    for (let k = 0; k < 16; k++) expect(f[k]).toBeCloseTo(k % 4 === 1 ? -m[k]! : m[k]!, 6);
  });

  it('plans each view\'s visible instances contiguously', () => {
    const batch = { source, count: 3, instances: new Float32Array([0, 0, 50, 1, 0, 1, 0, 0, 0, 0, -50, 1, 0, 1, 0, 0, 3, 0, 80, 2, 1.2, 0.5, 0, 0]), entities: [1, 2, 3] };
    const planned = planImpostors([batch], [view()], () => true)!;
    expect(planned.sources).toEqual([source]);
    expect(planned.views[0]).toEqual([{ source, slot: 0, first: 0, count: 2 }]);
    expect([...planned.instances.subarray(8, 16)]).toEqual([3, 0, 80, 2, 1.2000000476837158, 0.5, 0, 0]);
    expect(planImpostors([batch], [view()], () => false)).not.toBe(null);
    const textured = { ...source, parts: [{ ...source.parts[0]!, material: { ...MATERIAL, baseColorTexture: { id: 't', source: { kind: 'file' as const, path: 'x.png' }, colorSpace: 'srgb' as const, wrapU: 'repeat' as const, wrapV: 'repeat' as const, filter: 'linear' as const } } }] };
    expect(planImpostors([{ ...batch, source: textured }], [view()], () => false)).toBe(null);
  });
});
