/**
 * The surface's scale machinery, headless: texture loading (KTX2 variants, the upload
 * queue, the memory budget's least-recently-drawn eviction), frame pacing (the cap's
 * stride, dynamic resolution), Hi-Z occlusion and its governor, decal projection, fog of
 * war texels, and the render-to-texture pass order.
 */

import { describe, expect, it } from 'vitest';
import { PLAIN_POST } from '../../../core/index.js';
import type { Decal3d, Diagnostic, Frame3d, Material3d, MeshBatch, Texture3d, View3d } from '../../../core/index.js';
import { compose, invert, multiply, perspective, unitShape, viewMatrix } from '../../../resource/index.js';
import { QUALITY_LADDER } from '../../../function/plugins/render3d/quality.js';
import type { Backend3d, BackendTexture, CompressionFamily, TextureImage } from './backend.js';
import { decalFade, decalImages, decalUv, planDecals } from './decals.js';
import { VK_FORMAT, writeKtx2 } from './ktx2.js';
import { HiZ, hizSize, OcclusionGovernor } from './occlusion.js';
import { FrameCap, frameCapStride, pixelBudgetScale, ResolutionGovernor } from './pacing.js';
import { fogTexels, planFrame, sharpenFor, visitPasses } from './plan.js';
import type { PassVisitor } from './plan.js';
import { imageBytes, pickVariant, TextureStore } from './textures.js';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function fakeBackend(families: CompressionFamily[] = []): Backend3d & { made: string[]; destroyed: number } {
  const made: string[] = [];
  const backend = {
    kind: 'webgl2' as const, compressed: families, made, destroyed: 0,
    createTexture: (image: TextureImage) => { made.push(`image ${image.width}x${image.height}`); return { backend: 'webgl2' } as BackendTexture; },
    createCompressedTexture: (image: { width: number }) => { made.push(`ktx2 ${image.width}`); return { backend: 'webgl2' } as BackendTexture; },
    createTextureArray: () => ({ backend: 'webgl2' }) as BackendTexture,
    destroyTexture: () => { backend.destroyed++; },
    target: () => null, dropTarget: () => {}, render: () => {}, takeDepth: () => null, dispose: () => {},
  };
  return backend as unknown as Backend3d & { made: string[]; destroyed: number };
}

const texture = (path: string, variants?: string[]): Texture3d => ({
  id: path, source: { kind: 'file', path, ...(variants !== undefined && { variants }) }, colorSpace: 'srgb', wrapU: 'repeat', wrapV: 'repeat', filter: 'linear',
});

describe('textures: variants, upload queue, memory budget', () => {
  it('picks the first KTX2 variant whose family the GPU samples', () => {
    const v = ['a.bc.ktx2', 'a.astc.ktx2', 'a.etc2.ktx2'];
    expect(pickVariant(v, ['etc2'])).toBe('a.etc2.ktx2');
    expect(pickVariant(v, ['bc', 'etc2'])).toBe('a.bc.ktx2');
    expect(pickVariant(v, [])).toBe(null);
    expect(pickVariant(undefined, ['bc'])).toBe(null);
  });

  it('uploads a compressed variant as is, else decodes the image shrunk to the quality\'s size', async () => {
    const backend = fakeBackend(['bc']);
    const ktx = writeKtx2({ vkFormat: VK_FORMAT.BC1_RGBA_SRGB, width: 8, height: 8, levels: [new Uint8Array(32), new Uint8Array(8), new Uint8Array(8), new Uint8Array(8)] });
    const decoded: number[] = [];
    const store = new TextureStore(backend, {
      bytes: async (path) => (path.endsWith('.ktx2') ? ktx : new Uint8Array(1)),
      decode: async (_b, _m, maxSize) => { decoded.push(maxSize); return { width: 64, height: 32 }; },
    }, () => {});
    store.maxSize = 1024;
    expect(store.ready(texture('a.png', ['a.bc.ktx2']))).toBe(false);
    expect(store.ready(texture('b.png', ['b.etc2.ktx2']))).toBe(false);
    await flush();
    await flush();
    store.upload();
    expect(backend.made.sort()).toEqual(['image 64x32', 'ktx2 8']);
    expect(decoded).toEqual([1024]);
    expect(store.ready(texture('a.png', ['a.bc.ktx2']))).toBe(true);
    expect(store.stats).toMatchObject({ textures: 2, compressed: 1, bytes: 56 + imageBytes(64, 32) });
  });

  it('uploads at most a budget of bytes per frame (at least one texture), oldest first', async () => {
    const backend = fakeBackend();
    const store = new TextureStore(backend, { bytes: async () => new Uint8Array(1), decode: async () => ({ width: 1024, height: 1024 }) }, () => {});
    for (const n of ['a', 'b', 'c']) store.ready(texture(`${n}.png`));
    await flush();
    await flush();
    expect(store.upload(1)).toBe(1);
    expect(store.stats.queued).toBe(2);
    expect(store.upload(imageBytes(1024, 1024) * 1.5)).toBe(2);
    expect(store.stats.queued).toBe(0);
  });

  it('past the budget, evicts the least recently drawn textures, never one drawn in the last two frames', async () => {
    const backend = fakeBackend();
    const store = new TextureStore(backend, { bytes: async () => new Uint8Array(1), decode: async () => ({ width: 64, height: 64 }) }, () => {});
    const all = ['a', 'b', 'c'].map((n) => texture(`${n}.png`));
    for (const t of all) store.ready(t);
    await flush();
    await flush();
    store.upload();
    const one = imageBytes(64, 64);
    // Frame 0: all drawn. Frames 1–3: only c.
    for (const t of all) store.ready(t);
    store.endFrame(10 * one);
    for (let f = 0; f < 3; f++) {
      store.ready(all[2]!);
      expect(store.endFrame(one)).toBe(f === 0 ? 0 : f === 1 ? 2 : 0);
    }
    expect(store.stats).toMatchObject({ textures: 1, bytes: one, evicted: 2 });
    expect(backend.destroyed).toBe(2);
    // An evicted texture loads again on its next draw.
    expect(store.ready(all[0]!)).toBe(false);
  });

  it('reports a texture that fails to load, once', async () => {
    const problems: Diagnostic[] = [];
    const store = new TextureStore(fakeBackend(), { bytes: async () => { throw new Error('HTTP 404'); }, decode: async () => ({ width: 1, height: 1 }) }, (p) => problems.push(p));
    store.ready(texture('gone.png'));
    await flush();
    store.ready(texture('gone.png'));
    expect(problems.map((p) => p.code)).toEqual(['PP3816']);
  });
});

describe('frame pacing', () => {
  it('caps by whole display refreshes, never below the cap', () => {
    expect(frameCapStride(60, 1000 / 120)).toBe(2);
    expect(frameCapStride(60, 1000 / 144)).toBe(2);
    expect(frameCapStride(60, 1000 / 90)).toBe(1);
    expect(frameCapStride(60, 1000 / 60)).toBe(1);
    expect(frameCapStride(60, 1000 / 240)).toBe(4);
    expect(frameCapStride(30, 16.6)).toBe(2);
    expect(frameCapStride(0, 8)).toBe(1);
  });

  it('draws every other refresh of a 120 Hz display under a 60 cap', () => {
    const cap = new FrameCap();
    const wanted: boolean[] = [];
    for (let i = 0; i < 12; i++) wanted.push(cap.wants(i * (1000 / 120), 60));
    expect(wanted.slice(4)).toEqual([true, false, true, false, true, false, true, false]);
  });

  it('dynamic resolution steps down when frames run long and back up after two seconds on budget, within the pixel budget', () => {
    expect(pixelBudgetScale(3840, 2160, 3_700_000)).toBeCloseTo(Math.sqrt(3_700_000 / (3840 * 2160)), 6);
    expect(pixelBudgetScale(1280, 720, 8_300_000)).toBe(1);
    const g = new ResolutionGovernor();
    let scale = 1;
    for (let i = 0; i < 40; i++) scale = g.update(25, 16.7, 0.6, 1);
    expect(scale).toBeCloseTo(0.9, 6);
    for (let i = 0; i < 300; i++) scale = g.update(30, 16.7, 0.6, 1);
    expect(scale).toBeCloseTo(0.6, 6);
    for (let i = 0; i < 140; i++) scale = g.update(15, 16.7, 0.6, 1);
    expect(scale).toBeCloseTo(0.65, 6);
    expect(sharpenFor(1)).toBe(0);
    expect(sharpenFor(0.8)).toBeCloseTo(0.4, 6);
    expect(sharpenFor(0.5)).toBe(0.45);
  });
});

function view(eye: [number, number, number] = [0, 0, 0], forward: [number, number, number] = [0, 0, 1], camera = 1): View3d {
  const right: [number, number, number] = [forward[2], 0, -forward[0]];
  const v = viewMatrix(eye, right, [0, 1, 0], forward);
  const p = perspective(60, 1, 0.1, 1000);
  const vp = multiply(p, v);
  return {
    camera, viewport: { x: 0, y: 0, width: 400, height: 400 }, position: eye, right, up: [0, 1, 0], forward,
    view: v, projection: p, viewProjection: vp, inverseViewProjection: invert(vp)!, near: 0.1, far: 1000, clear: null, colorVision: 'none',
  };
}

/** Depth (0..1) of view depth z for the test projection. */
const depthAt = (z: number): number => (1000 / 999.9) * (1 - 0.1 / z);

describe('Hi-Z occlusion', () => {
  const grid = (wallZ: number | null, v = view()): HiZ => {
    const size = hizSize(400, 400);
    const depths = new Float32Array(size.width * size.height).fill(wallZ === null ? 1 : depthAt(wallZ));
    return new HiZ({ width: size.width, height: size.height, depths, viewProjection: Float32Array.from(v.viewProjection), camera: 1, position: [0, 0, 0], forward: [0, 0, 1] });
  };

  it('hides a sphere wholly behind the drawn depth, keeps one in front, near the camera or off the grid', () => {
    const wall = grid(10);
    expect(wall.occluded(0, 0, 30, 1)).toBe(true);
    expect(wall.occluded(0, 0, 5, 1)).toBe(false);
    expect(wall.occluded(0, 0, 10.5, 1)).toBe(false);
    expect(wall.occluded(0, 0, 0.5, 1)).toBe(false);
    expect(wall.occluded(500, 0, 30, 1)).toBe(false);
    expect(grid(null).occluded(0, 0, 30, 1)).toBe(false);
  });

  it('holds only while the camera is where the depth was drawn from', () => {
    const wall = grid(10);
    expect(wall.matches(view())).toBe(true);
    expect(wall.matches(view([0, 0, 2]))).toBe(false);
    expect(wall.matches(view([0, 0, 0], [0.2, 0, 0.98]))).toBe(false);
    expect(wall.matches(view([0, 0, 0], [0, 0, 1], 2))).toBe(false);
  });

  it('the governor suspends after two low-yield samples and probes again later, or at once on a jump', () => {
    const g = new OcclusionGovernor({ sampleFrames: 10, probeAfter: 50 });
    for (let i = 0; i < 20; i++) g.record({ tested: 100, inFrustum: 100, occluded: 1 }, false);
    expect(g.state).toBe('suspended');
    for (let i = 0; i < 49; i++) g.record({ tested: 0, inFrustum: 0, occluded: 0 }, false);
    expect(g.state).toBe('suspended');
    g.record({ tested: 0, inFrustum: 0, occluded: 0 }, false);
    expect(g.state).toBe('active');
    for (let i = 0; i < 30; i++) g.record({ tested: 100, inFrustum: 100, occluded: 40 }, false);
    expect(g.state).toBe('active');
    const h = new OcclusionGovernor({ sampleFrames: 10 });
    for (let i = 0; i < 20; i++) h.record({ tested: 10, inFrustum: 10, occluded: 0 }, false);
    h.record({ tested: 0, inFrustum: 0, occluded: 0 }, true);
    expect(h.state).toBe('active');
  });
});

describe('decals', () => {
  const box = compose(2, 0, 3, 0, 0, 0, 1, 4, 1, 2);
  const decal: Decal3d = {
    matrix: box, inverse: invert(box)!, color: [1, 1, 1, 1], angleFade: Math.cos(Math.PI / 3), order: 0, entity: 1,
    texture: { id: 'scorch', source: { kind: 'file', path: 'assets/images/scorch.png' }, colorSpace: 'srgb', wrapU: 'clamp', wrapV: 'clamp', filter: 'linear' },
  };

  it('maps a surface point inside the box to the image (u along x, v down from +z) and drops points outside', () => {
    expect(decalUv(decal, 2, 0, 3)!.uv).toEqual([0.5, 0.5]);
    expect(decalUv(decal, 0, 0, 2)!.uv).toEqual([0, 1]);
    expect(decalUv(decal, 4, 0.25, 4)!.uv).toEqual([1, 0]);
    expect(decalUv(decal, 4.5, 0, 3)).toBe(null);
    expect(decalUv(decal, 2, 0.6, 3)).toBe(null);
  });

  it('fades on surfaces turning away from the projection, gone at 90°', () => {
    expect(decalFade(decal, [0, 1, 0])).toBe(1);
    expect(decalFade(decal, [0, Math.cos(Math.PI / 3), Math.sin(Math.PI / 3)])).toBeCloseTo(1, 6);
    expect(decalFade(decal, [0, Math.cos(1.3), Math.sin(1.3)])).toBeGreaterThan(0);
    expect(decalFade(decal, [0, Math.cos(1.3), Math.sin(1.3)])).toBeLessThan(1);
    expect(decalFade(decal, [1, 0, 0])).toBe(0);
  });

  it('plans per-view records with their image layers, culled by the view, waiting for images not in the array', () => {
    const behind = { ...decal, matrix: compose(0, 0, -20, 0, 0, 0, 1, 1, 1, 1) };
    const planned = planDecals([decal, behind], [view([0, 5, -5], [0, -0.6, 0.8])], (t) => (t.id === 'scorch' ? 3 : null))!;
    expect(planned.views[0]).toEqual({ first: 0, count: 1 });
    expect(planned.records[36]).toBe(3);
    expect(planDecals([decal], [view()], () => null)).toBe(null);
    expect(decalImages([decal, behind, { ...decal, texture: { ...decal.texture, id: 'a' } }]).map((t) => t.id)).toEqual(['a', 'scorch']);
  });
});

const MATERIAL: Material3d = {
  id: 'm', baseColor: [1, 1, 1, 1], baseColorTexture: null, metallic: 0, roughness: 0.5, metallicRoughnessTexture: null,
  emissive: [0, 0, 0], emissiveTexture: null, alphaMode: 'opaque', alphaCutoff: 0.5, doubleSided: false, unlit: false,
};

function frame(over: Partial<Frame3d> = {}): Frame3d {
  const instances = new Float32Array(20);
  instances.set(compose(0, 0, 5, 0, 0, 0, 1, 1, 1, 1));
  instances.set([1, 1, 1, 1], 16);
  const mesh: MeshBatch = { geometry: unitShape('box'), material: MATERIAL, count: 1, instances, entities: [1], castShadows: false };
  return {
    frame: 1, views: [view()],
    environment: {
      sky: { zenith: [0.2, 0.4, 0.8], horizon: [0.8, 0.9, 1] }, fog: { kind: 'none', color: [0, 0, 0], density: 0, near: 0, far: 0, volumetric: 0 },
      ambient: [0.3, 0.3, 0.3], sun: null, post: { ...PLAIN_POST, bloom: 0.5 },
    },
    quality: QUALITY_LADDER.high, sunShadow: null, localShadows: [], terrain: null, meshes: [mesh], skinned: [], lights: [], billboards: [],
    texts: [], lines: [], outlines: [], ...over,
  };
}

describe('render to texture and fog of war in the plan', () => {
  it('draws each due offscreen view whole into its target before the screen; only the screen blooms', () => {
    const feed = { ...view([5, 2, 0], [-1, 0, 0], 9), viewport: { x: 0, y: 0, width: 256, height: 128 } };
    const p = planFrame(frame({ offscreen: [
      { target: 'lobby', width: 256, height: 128, view: feed, due: true },
      { target: 'later', width: 256, height: 128, view: feed, due: false },
    ] }), { width: 400, height: 400, ready: () => true, text: () => { throw new Error('no text'); } });
    expect(p.groups.map((g) => g.target?.id ?? 'screen')).toEqual(['lobby', 'screen']);
    expect(p.views.map((v) => v.target)).toEqual(['lobby', null]);
    const order: string[] = [];
    const visit = (name: string) => (v: { frameSlot: number }): number => order.push(`${v.frameSlot}:${name}`);
    const visitor = {
      environment: () => order.push('environment'), shadows: () => order.push('shadows'), scene: visit('scene'), ao: visit('ao'),
      reflections: visit('reflections'), resolve: visit('resolve'), nature: visit('nature'), decals: visit('decals'), fogOfWar: visit('fog'),
      transparent: visit('transparent'), volumetric: visit('volumetric'), godRays: visit('godRays'), outlines: visit('outlines'),
      bloom: () => order.push('bloom'), final: visit('final'), overlay: visit('overlay'), target: (t: { id: string }) => order.push(`target:${t.id}`),
      present: () => order.push('present'),
    } as unknown as PassVisitor;
    visitPasses(p, visitor);
    expect(order).toEqual(['environment', '0:scene', '0:final', 'target:lobby', '1:scene', 'bloom', '1:final', 'present']);
  });

  it('a mirror\'s target larger than the render size draws at the largest size that fits, keeping its aspect', () => {
    const p = planFrame(frame({ offscreen: [{ target: 'big', width: 1000, height: 500, view: view(), due: true }] }), {
      width: 400, height: 400, ready: () => true, text: () => { throw new Error('no text'); },
    });
    expect(p.groups[0]!.target).toEqual({ id: 'big', width: 400, height: 200 });
  });

  it('turns fog cells into texels: seen 0, explored 128, unexplored 255', () => {
    const fog = { key: 'k', cell: 2, minX: -4, minZ: -4, cols: 3, rows: 1, cells: new Uint8Array([3, 2, 0]), unexplored: [0, 0, 0, 1] as const, explored: [0, 0, 0, 0.5] as const };
    expect([...fogTexels({ ...view(), fogOfWar: fog })!.texels]).toEqual([0, 128, 255]);
    expect(fogTexels(view())).toBe(null);
  });
});
