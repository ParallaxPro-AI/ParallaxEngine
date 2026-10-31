import { describe, expect, it } from 'vitest';
import { BILLBOARD_STRIDE, MESH_INSTANCE_STRIDE, ParallaxError, RIBBON_STRIDE, Vec3 } from '../../../core/index.js';
import type { BinaryFiles, EntityId, Frame3d, Geometry3d, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { GameDefinition } from '../../kernel/index.js';
import { RecordingSurface3d, MemoryBinaryFiles } from '../../../platform/headless/render3d.js';
import { visuals } from '../visuals/index.js';
import type { CameraView } from '../visuals/index.js';
import { worldToScreen } from '../visuals/index.js';
import { blendPoses, clipTime, nodeMatrices, POSE_STRIDE, restPose, retarget, sampleClip, skinPalette } from '../../../resource/index.js';
import { buildModel, decompose, loadModel, readContainer } from '../../../resource/index.js';
import type { GltfJson, ModelAsset } from '../../../resource/index.js';
import { compose, cross3, invert, multiply, normalize3, perspective, transformPoint, viewMatrix } from '../../../resource/index.js';
import { capsule, UNIT_SHAPES, unitShape } from '../../../resource/index.js';
import { cascadeSplits, chooseLocalShadows, fitCascades, pointFaceFov, sliceCorners } from './shadow.js';
import { QUALITY_LADDER } from './quality.js';
import { gltfParts, standInCharacter, writeGlb } from '../models/testing.js';
import { models } from '../models/index.js';
import { postOf, render3d } from './index.js';
import type { Render3dPlugin } from './index.js';

const DT = 1 / 60;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ParallaxError) return e.diagnostic.code;
    throw e;
  }
  return 'no error';
}

async function asyncCode(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof ParallaxError) return e.diagnostic.code;
    throw e;
  }
  return 'no error';
}

const TRIANGLE = {
  nodes: [{ name: 'tri', mesh: 0, translation: [1, 2, 3], rotation: [0, Math.SQRT1_2, 0, Math.SQRT1_2] }],
  meshes: [{
    positions: [0, 0, 0, 1, 0, 0, 0, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
    material: 0,
  }],
  materials: [{
    pbrMetallicRoughness: { baseColorFactor: [0.5, 0.25, 1, 0.5], metallicFactor: 0.2, roughnessFactor: 0.6 },
    emissiveFactor: [1, 0, 0],
    alphaMode: 'BLEND',
    doubleSided: true,
  }],
};

const load = (bytes: Uint8Array, path = 'assets/models/m.glb', more: Record<string, Uint8Array> = {}): Promise<ModelAsset> =>
  loadModel(path, new MemoryBinaryFiles({ [path]: bytes, ...more }));

function cross(g: Geometry3d, t: number): [number, number, number] {
  const i = [g.indices[t]!, g.indices[t + 1]!, g.indices[t + 2]!];
  const p = (k: number): number[] => [g.positions[k * 3]!, g.positions[k * 3 + 1]!, g.positions[k * 3 + 2]!];
  const [a, b, c] = [p(i[0]!), p(i[1]!), p(i[2]!)];
  const e1 = [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!];
  const e2 = [c[0]! - a[0]!, c[1]! - a[1]!, c[2]! - a[2]!];
  return [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
}

// ── glTF ────────────────────────────────────────────────────────────────────────

describe('glTF loading', () => {
  it('reads a .glb: mirrored into the engine\'s handedness, winding reversed, colors to sRGB', async () => {
    const model = await load(writeGlb(TRIANGLE));
    expect(model.nodes).toHaveLength(1);
    const node = model.nodes[0]!;
    expect(node.name).toBe('tri');
    expect(node.translation).toEqual([-1, 2, 3]);
    expect(node.rotation[0]).toBeCloseTo(0);
    expect(node.rotation[1]).toBeCloseTo(-Math.SQRT1_2);
    expect(node.rotation[3]).toBeCloseTo(Math.SQRT1_2);
    const { geometry, material } = model.meshes[0]![0]!;
    expect([...geometry.positions]).toEqual([-0, 0, 0, -1, 0, 0, -0, 1, 0]);
    expect([...geometry.normals]).toEqual([-0, 0, 1, -0, 0, 1, -0, 0, 1]);
    expect([...geometry.indices]).toEqual([0, 2, 1]);
    // glTF's CCW front (+z normal) stays the front: the cross of the reversed triangle points along the normal.
    expect(cross(geometry, 0)[2]).toBeGreaterThan(0);
    expect(geometry.min).toEqual([-1, 0, 0]);
    expect(material.baseColor[0]).toBeCloseTo(0.7354, 3);
    expect(material.baseColor[2]).toBeCloseTo(1);
    expect(material.baseColor[3]).toBe(0.5);
    expect(material.emissive.map((c) => Number(c.toFixed(6)))).toEqual([1, 0, 0]);
    expect(material).toMatchObject({ metallic: 0.2, roughness: 0.6, alphaMode: 'blend', doubleSided: true, unlit: false });
    expect(model.warnings).toEqual([]);
  });

  it('reads .gltf JSON with an external buffer, a data: buffer and an embedded image', async () => {
    const { json, bin } = gltfParts({ ...TRIANGLE, images: [{ bytes: new Uint8Array([137, 80, 78, 71]), mimeType: 'image/png' }] });
    const materials = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
    const external = { ...json, materials, buffers: [{ uri: 'tri%20data.bin', byteLength: bin.byteLength }] };
    const model = await load(new TextEncoder().encode(JSON.stringify(external)), 'assets/models/sub/tri.gltf', {
      'assets/models/sub/tri data.bin': bin,
    });
    expect(model.meshes[0]![0]!.geometry.positions).toHaveLength(9);
    const texture = model.meshes[0]![0]!.material.baseColorTexture!;
    expect(texture.colorSpace).toBe('srgb');
    expect(texture.source.kind).toBe('bytes');
    expect(texture.source.kind === 'bytes' && texture.source.mimeType).toBe('image/png');

    const base64 = btoa(String.fromCharCode(...bin));
    const inline = { ...json, buffers: [{ uri: `data:application/octet-stream;base64,${base64}`, byteLength: bin.byteLength }] };
    const again = await load(new TextEncoder().encode(JSON.stringify(inline)), 'assets/models/inline.gltf');
    expect([...again.meshes[0]![0]!.geometry.indices]).toEqual([0, 2, 1]);
  });

  it('computes flat normals when a primitive has none', async () => {
    const model = await load(writeGlb({ nodes: [{ mesh: 0 }], meshes: [{ positions: [0, 0, 0, 1, 0, 0, 0, 0, 1], indices: [0, 2, 1] }] }));
    const g = model.meshes[0]![0]!.geometry;
    // glTF triangle (0,0,0),(0,0,1),(1,0,0) faces +y; after the mirror it still faces +y.
    for (let v = 0; v < 3; v++) expect(g.normals[v * 3 + 1]).toBeCloseTo(1);
    expect(cross(g, 0)[1]).toBeGreaterThan(0);
  });

  it('reports malformed files and unsupported features with codes', async () => {
    expect(code(() => readContainer('x.glb', new TextEncoder().encode('not json')))).toBe('PP3801');
    expect(code(() => readContainer('x.gltf', new TextEncoder().encode('{"asset":{"version":"1.0"}}')))).toBe('PP3801');
    expect(code(() => readContainer('x.gltf', new TextEncoder().encode(
      '{"asset":{"version":"2.0"},"extensionsRequired":["KHR_draco_mesh_compression"]}',
    )))).toBe('PP3802');
    const truncated = writeGlb(TRIANGLE).subarray(0, 40);
    expect(await asyncCode(() => load(truncated))).toBe('PP3801');
    const { json, bin } = gltfParts(TRIANGLE);
    const sparse = { ...json, accessors: (json['accessors'] as object[]).map((a, i) => (i === 0 ? { ...a, sparse: { count: 1 } } : a)) };
    expect(code(() => buildModel('s.gltf', sparse as GltfJson, [bin]))).toBe('PP3801');
    // Morph targets load (gltf_morph.test.ts); a target without attributes is all zeros.
    const morph = { ...json, meshes: [{ primitives: [{ ...(json['meshes'] as { primitives: object[] }[])[0]!.primitives[0]!, targets: [{}] }] }] };
    const loaded = buildModel('m.gltf', morph as GltfJson, [bin]);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.meshes[0]![0]!.morphs!.names).toEqual(['target0']);
  });

  it('decomposes node matrices into translation, rotation and scale', () => {
    const m = compose(1, 2, 3, 0, Math.sin(0.4), 0, Math.cos(0.4), 2, 3, 4);
    const d = decompose([...m]);
    expect(d.t).toEqual([1, 2, 3]);
    expect(d.s.map((s) => Number(s.toFixed(5)))).toEqual([2, 3, 4]);
    const back = compose(...d.t, ...d.r, ...d.s);
    for (let i = 0; i < 16; i++) expect(back[i]).toBeCloseTo(m[i]!, 5);
  });
});

// ── Animation ──────────────────────────────────────────────────────────────────

describe('animation sampling', () => {
  const clipModel = (interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE'): Promise<ModelAsset> => load(writeGlb({
    nodes: [{ name: 'a' }],
    animations: [{
      name: 'move',
      channels: [{
        node: 0, path: 'translation', interpolation, times: [0, 1, 2],
        values: interpolation === 'CUBICSPLINE'
          ? [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0]
          : [0, 0, 0, 2, 0, 0, 4, 0, 0],
      }],
    }],
  }));
  const xAt = (model: ModelAsset, time: number): number => {
    const pose = restPose(model);
    sampleClip(model.clips.get('move')!, time, pose, null);
    return pose[0]!;
  };

  it('interpolates LINEAR, STEP and CUBICSPLINE keys (mirrored into engine x)', async () => {
    const linear = await clipModel('LINEAR');
    expect(linear.clips.get('move')!.duration).toBe(2);
    expect(xAt(linear, 0.5)).toBeCloseTo(-1);
    expect(xAt(linear, 1.5)).toBeCloseTo(-3);
    expect(xAt(linear, 5)).toBeCloseTo(-4);
    const step = await clipModel('STEP');
    expect(xAt(step, 0.99)).toBeCloseTo(0);
    expect(xAt(step, 1.01)).toBeCloseTo(-2);
    const cubic = await clipModel('CUBICSPLINE');
    expect(xAt(cubic, 0.5)).toBeCloseTo(-1);
    expect(xAt(cubic, 1)).toBeCloseTo(-2);
  });

  it('wraps looping clip time and holds a one-shot at its end', async () => {
    const clip = (await clipModel('LINEAR')).clips.get('move')!;
    expect(clipTime(clip, 5.5, true)).toBeCloseTo(1.5);
    expect(clipTime(clip, 5.5, false)).toBe(2);
    expect(clipTime(clip, -0.5, false)).toBe(0);
  });

  it('crossfades poses (positions lerp, rotations slerp)', () => {
    const a = new Float32Array(POSE_STRIDE);
    const b = new Float32Array(POSE_STRIDE);
    a.set([0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
    b.set([2, 0, 0, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 1, 1, 1]);
    const out = new Float32Array(POSE_STRIDE);
    blendPoses(a, b, 0.5, out);
    expect(out[0]).toBeCloseTo(1);
    expect(out[4]).toBeCloseTo(Math.sin(Math.PI / 8));
    expect(out[6]).toBeCloseTo(Math.cos(Math.PI / 8));
  });

  it('skins: the palette moves vertices with their joints', async () => {
    const model = await load(standInCharacter(['bend'], 1));
    const skin = model.skins[0]!;
    const rest = skinPalette(skin, nodeMatrices(model, restPose(model)));
    // At rest every joint's palette is the identity (bind pose = rest pose).
    for (let j = 0; j < 2; j++) for (let i = 0; i < 16; i++) expect(rest[j * 16 + i]).toBeCloseTo(i % 5 === 0 ? 1 : 0, 5);
    const pose = restPose(model);
    sampleClip(model.clips.get('bend')!, 0.5, pose, null);
    const palette = skinPalette(skin, nodeMatrices(model, pose));
    // The upper joint swung 30° about z (mirrored: -30° in engine space) around (0, 0.5, 0): the top corner moves.
    const top = transformPoint(palette.subarray(16, 32), 0.5, 1, 0);
    const angle = (-30 * Math.PI) / 180;
    expect(top[0]).toBeCloseTo(0.5 * Math.cos(angle) - 0.5 * Math.sin(angle), 4);
    expect(top[1]).toBeCloseTo(0.5 + 0.5 * Math.sin(angle) + 0.5 * Math.cos(angle), 4);
    // The lower joint didn't move.
    expect([...transformPoint(palette.subarray(0, 16), 0.5, 0, 0)].map((v) => Number(v.toFixed(5)))).toEqual([0.5, 0, 0]);
  });

  it('retargets a clip from another model by node name', async () => {
    const target = await load(standInCharacter([], 1));
    const source = await load(standInCharacter(['wave'], 1), 'assets/models/anims.glb');
    const map = retarget(target, source)!;
    expect(map[2]).toBe(target.nodeByName.get('upper'));
    const pose = restPose(target);
    sampleClip(source.clips.get('wave')!, 0.5, pose, map);
    expect(pose[2 * POSE_STRIDE + 6]).toBeCloseTo(Math.cos(Math.PI / 12));
    expect(retarget(target, target)).toBeNull();
  });
});

// ── Primitives and shadows ──────────────────────────────────────────────────────

describe('primitives', () => {
  it.each(UNIT_SHAPES)('%s: unit size, unit normals, every triangle wound outward', (kind) => {
    const g = unitShape(kind);
    expect(g.indices.length % 3).toBe(0);
    for (let k = 0; k < 3; k++) {
      expect(g.min[k]).toBeGreaterThanOrEqual(-0.5 - 1e-6);
      expect(g.max[k]).toBeLessThanOrEqual(0.5 + 1e-6);
    }
    for (let v = 0; v < g.normals.length; v += 3) expect(Math.hypot(g.normals[v]!, g.normals[v + 1]!, g.normals[v + 2]!)).toBeCloseTo(1);
    for (let t = 0; t < g.indices.length; t += 3) {
      const c = cross(g, t);
      const n = [0, 1, 2].map((k) => g.normals[g.indices[t]! * 3 + k]! + g.normals[g.indices[t + 1]! * 3 + k]! + g.normals[g.indices[t + 2]! * 3 + k]!);
      expect(c[0] * n[0]! + c[1] * n[1]! + c[2] * n[2]!).toBeGreaterThan(0);
    }
  });

  it('builds capsules to their real proportions', () => {
    const g = capsule(0.4, 1.8);
    expect(g.min[1]).toBeCloseTo(-0.9);
    expect(g.max[1]).toBeCloseTo(0.9);
    expect(g.max[0]).toBeCloseTo(0.4, 2);
  });
});

function perspectiveView(eye: [number, number, number] = [0, 5, -10], look: [number, number, number] = [0, -0.4472136, 0.8944272]): Frame3d['views'][number] {
  const forward = normalize3(look);
  const right = normalize3(cross3([0, 1, 0], forward));
  const up = cross3(forward, right);
  const view = viewMatrix(eye, right, up, forward);
  const projection = perspective(60, 16 / 9, 0.1, 1000);
  const vp = multiply(projection, view);
  return {
    camera: 1, viewport: { x: 0, y: 0, width: 1280, height: 720 }, position: eye, right, up, forward,
    view, projection, viewProjection: vp, inverseViewProjection: invert(vp)!, near: 0.1, far: 1000, clear: null, colorVision: 'none',
  };
}

describe('sun shadow cascades', () => {
  const high = QUALITY_LADDER.high;
  const sun: [number, number, number] = [0.3, -0.8, 0.5];

  it('splits the shadow distance into growing cascades that end at the distance', () => {
    const splits = cascadeSplits(0.1, 150, 4);
    expect(splits).toHaveLength(4);
    for (let i = 1; i < 4; i++) expect(splits[i]!).toBeGreaterThan(splits[i - 1]!);
    expect(splits[3]).toBe(150);
    // Logarithmic leaning: the first cascade is far shorter than an even quarter.
    expect(splits[0]!).toBeLessThan(150 / 4);
  });

  it('keeps every slice of the view inside its own cascade map', () => {
    const view = perspectiveView();
    const shadow = fitCascades(view, sun, high);
    expect(shadow.cascades).toHaveLength(high.cascades);
    let start = view.near;
    for (const cascade of shadow.cascades) {
      for (const p of sliceCorners(view, start, cascade.far)) {
        const c = transformPoint(cascade.viewProjection, p[0], p[1], p[2]);
        expect(Math.abs(c[0])).toBeLessThanOrEqual(1 + 1e-4);
        expect(Math.abs(c[1])).toBeLessThanOrEqual(1 + 1e-4);
        expect(c[2]).toBeGreaterThanOrEqual(0);
        expect(c[2]).toBeLessThanOrEqual(1);
      }
      start = cascade.far;
    }
  });

  it('is stable: turning the camera keeps each map\'s scale, moving it shifts maps by whole texels', () => {
    const a = fitCascades(perspectiveView([0, 5, -10], [0, 0, 1]), sun, high);
    const turned = fitCascades(perspectiveView([0, 5, -10], [0.6, -0.1, 0.8]), sun, high);
    const moved = fitCascades(perspectiveView([0.013, 5, -10.007], [0, 0, 1]), sun, high);
    a.cascades.forEach((c, i) => {
      expect(turned.cascades[i]!.viewProjection[0]).toBeCloseTo(c.viewProjection[0]!, 6);
      expect(turned.cascades[i]!.texelWorld).toBeCloseTo(c.texelWorld, 9);
      // The map's light-space offset is a whole number of texels (m[12], m[13] are its NDC shift).
      const m = moved.cascades[i]!.viewProjection;
      for (const k of [12, 13]) {
        const texels = (m[k]! * high.shadowMapSize) / 2;
        expect(Math.abs(texels - Math.round(texels))).toBeLessThan(1e-2);
      }
    });
  });
});

describe('point and spot shadows', () => {
  const light = (kind: 'point' | 'spot', x: number, shadows = true) => ({
    kind, color: [1, 1, 1] as const, intensity: 1, position: [x, 1, 0] as const, direction: [0, -1, 0] as const, range: 8, angle: 60,
    shadows, entity: null,
  });

  it('gives tiles nearest first within the budget: a spot takes 1, a point 6', () => {
    const view = perspectiveView([0, 1, -5], [0, 0, 1]);
    const lights = [light('point', 40), light('spot', 2), light('point', 0), light('point', 20), light('spot', 30, false), light('point', 60)];
    const { shadows, dropped } = chooseLocalShadows(lights, view, QUALITY_LADDER.high);
    expect(shadows.map((s) => [s.light, s.tile, s.faces.length])).toEqual([[2, 0, 6], [1, 6, 1], [3, 7, 6]]);
    expect(dropped).toBe(2);
    expect(chooseLocalShadows(lights, view, QUALITY_LADDER.low)).toMatchObject({ shadows: [], dropped: 5 });
  });

  it('point faces look along +x, -x, +y, -y, +z, -z and cover a little over 90 degrees', () => {
    const view = perspectiveView();
    const [s] = chooseLocalShadows([light('point', 0)], view, QUALITY_LADDER.high).shadows;
    const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    s!.faces.forEach((m, i) => {
      const d = dirs[i]!;
      const c = transformPoint(m, d[0]! * 3, 1 + d[1]! * 3, d[2]! * 3);
      expect(Math.abs(c[0])).toBeLessThan(1e-4);
      expect(Math.abs(c[1])).toBeLessThan(1e-4);
      expect(c[2]).toBeGreaterThan(0);
      expect(c[2]).toBeLessThan(1);
    });
    expect(pointFaceFov(1024)).toBeGreaterThan(90);
    expect(pointFaceFov(1024)).toBeLessThan(90.5);
  });
});

// ── The plugin in a kernel ──────────────────────────────────────────────────────

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const NO_GAME: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [] };

interface Scene3d {
  readonly kernel: Kernel;
  readonly plugin: Render3dPlugin;
  readonly surface: RecordingSurface3d;
  frame(): Frame3d;
  id(placed: string): EntityId;
  steps(n: number): void;
}

async function scene(
  data: { prefabs: Record<string, unknown>; entities: unknown[]; extra?: Record<string, unknown> },
  binary: Record<string, Uint8Array> = {},
  surface = new RecordingSurface3d(),
): Promise<Scene3d> {
  const project = files({
    ...Object.fromEntries(Object.entries(data.prefabs).map(([id, p]) => [`prefabs/${id}.prefab.json`, p])),
    'scenes/main/scene.json': { entities: data.entities },
    ...Object.fromEntries(Object.keys(binary).map((path) => [path, ''])),
    ...data.extra,
  });
  const loaded = loadProject(project);
  expect(loaded.diagnostics).toEqual([]);
  const plugin = render3d({ surface, files: project });
  const vis = visuals({ dimension: '3d' });
  const kernel = new Kernel({ project: loaded, game: NO_GAME, plugins: [vis, models({ files: project, binary: new MemoryBinaryFiles(binary) }), plugin], context: {}, fixedStep: DT });
  plugin.engine.preload();
  await plugin.engine.whenLoaded();
  kernel.start('main');
  kernel.step(DT);
  return {
    kernel, plugin, surface,
    frame: () => surface.last!,
    id: (placed) => [...kernel.world.live()].find((r) => r.placedId === placed)!.id,
    steps: (n) => { for (let i = 0; i < n; i++) kernel.step(DT); },
  };
}

const CAMERA = { components: { camera: { fov: 60 } } };

describe('render3d in a kernel', () => {
  it('batches repeated shapes into one instanced draw, with per-instance tint and size', async () => {
    const s = await scene({
      prefabs: {
        cam: CAMERA,
        crate: { components: { shape: { kind: 'box', size: [2, 1, 3], color: '#ff0000' } } },
        ball: { components: { shape: { kind: 'sphere', color: '#00ff00', emissive: '#202020' } } },
      },
      entities: [
        { id: 'cam', prefab: 'cam', at: [0, 2, -10] },
        { id: 'a', prefab: 'crate', at: [1, 0, 0] }, { id: 'b', prefab: 'crate', at: [-1, 0, 0] }, { id: 'c', prefab: 'crate', at: [0, 0, 5] },
        { id: 'ball', prefab: 'ball', at: [0, 3, 0] },
      ],
    });
    const frame = s.frame();
    expect(frame.views).toHaveLength(1);
    const boxes = frame.meshes.find((m) => m.geometry.id === 'shape:box')!;
    expect(boxes.count).toBe(3);
    expect(boxes.instances).toHaveLength(3 * MESH_INSTANCE_STRIDE);
    expect(boxes.entities).toEqual([s.id('a'), s.id('b'), s.id('c')]);
    // Instance 0: scale (2, 1, 3) then translate (1, 0, 0); tint red.
    expect([...boxes.instances.subarray(0, 16)]).toEqual([2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 3, 0, 1, 0, 0, 1]);
    expect([...boxes.instances.subarray(16, 20)]).toEqual([1, 0, 0, 1]);
    expect(boxes.castShadows).toBe(true);
    const ball = frame.meshes.find((m) => m.geometry.id === 'shape:sphere')!;
    expect(ball.material.emissive[0]).toBeCloseTo(0x20 / 255);
    expect(ball.material).not.toBe(boxes.material);
  });

  it('projects like the visuals plugin\'s camera math', async () => {
    const s = await scene({
      prefabs: { cam: { components: { camera: { fov: 50, viewport: [0, 0, 1, 1] } } } },
      entities: [{ id: 'cam', prefab: 'cam', at: [3, 4, -12] }],
    });
    const view = s.frame().views[0]!;
    const cameraView = (s.kernel.world.require(s.id('cam')).components.get('camera') as { __view__: CameraView }).__view__;
    for (const p of [new Vec3(0, 0, 0), new Vec3(2, 1, 5), new Vec3(-4, 3, 20)]) {
      const pixel = worldToScreen(cameraView, p);
      const clip = transformPoint(view.viewProjection, p.x, p.y, p.z);
      if (pixel === null) continue;
      expect((clip[0] + 1) / 2 * 1280).toBeCloseTo(pixel.x, 3);
      expect((1 - clip[1]) / 2 * 720).toBeCloseTo(pixel.y, 3);
      expect(clip[2]).toBeGreaterThan(0);
      expect(clip[2]).toBeLessThan(1);
    }
  });

  it('a directional light entity is the sun and casts the shadow map; others are lights', async () => {
    const s = await scene({
      prefabs: {
        cam: CAMERA,
        sun: { components: { light: { kind: 'directional', intensity: 2, shadows: true, color: '#ffeedd' } } },
        lamp: { components: { light: { kind: 'point', range: 6, intensity: 3 } } },
        spot: { components: { light: { kind: 'spot', angle: 40, shadows: true } } },
      },
      entities: [
        { id: 'cam', prefab: 'cam', at: [0, 2, -10] },
        { id: 'sun', prefab: 'sun', rotation: [50, 30, 0] },
        { id: 'lamp', prefab: 'lamp', at: [1, 2, 3] },
        { id: 'spot', prefab: 'spot', at: [0, 5, 0] },
      ],
    });
    const frame = s.frame();
    expect(frame.environment.sun).toMatchObject({ intensity: 2, shadows: true });
    expect(frame.environment.sun!.direction[1]).toBeLessThan(0);
    expect(frame.sunShadow!.cascades).toHaveLength(frame.quality.cascades);
    expect(frame.lights.map((l) => l.kind).sort()).toEqual(['point', 'spot']);
    expect(frame.lights.find((l) => l.kind === 'point')!.position).toEqual([1, 2, 3]);
    const spot = frame.lights.findIndex((l) => l.kind === 'spot');
    expect(frame.localShadows.map((l) => [l.light, l.faces.length])).toEqual([[spot, 1]]);
    expect(s.plugin.engine.takeWarnings()).toEqual([]);
  });

  it('draws text and world bars as billboards, particles as particle batches, beams and trails as ribbons', async () => {
    const s = await scene({
      prefabs: {
        cam: CAMERA,
        sign: { components: { text_mesh: { text: 'Hi [color=#ff0000]there[/color]', size: 0.5, face_camera: true } } },
        gauge: { components: { world_bar: { value: 0.5, color: '#00ff00', bands: [[0.4, 0.6, '#ffff00']] } } },
        smoke: { components: { particles: { effect: 'vfx/smoke' } } },
      },
      entities: [
        { id: 'cam', prefab: 'cam', at: [0, 2, -10] },
        { id: 'sign', prefab: 'sign', at: [0, 3, 0] },
        { id: 'gauge', prefab: 'gauge', at: [2, 0, 0] },
        { id: 'smoke', prefab: 'smoke', at: [-2, 0, 0] },
      ],
      extra: { 'assets/vfx/smoke.vfx.json': { rate: 60, lifetime: 1, speed: 1, size: 0.3 }, 'assets/vfx/pop.vfx.json': { burst: 10 } },
    });
    s.steps(10);
    let frame = s.frame();
    expect(frame.texts).toHaveLength(1);
    expect(frame.texts[0]!.spans.map((sp) => [sp.text, sp.color[0]])).toEqual([['Hi ', 1], ['there', 1]]);
    expect(frame.texts[0]!.spans[1]!.color[1]).toBe(0);
    const bar = frame.billboards.find((b) => b.entity === s.id('gauge'))!;
    expect(bar.count).toBe(3);
    // Background, band 0.4–0.6, fill 0–0.5: the fill's center is a quarter bar left of the anchor.
    expect(bar.data[2 * BILLBOARD_STRIDE + 3]).toBeCloseTo(-0.25);
    expect(bar.data[2 * BILLBOARD_STRIDE + 5]).toBeCloseTo(0.5);
    expect(bar.data[1]).toBeCloseTo(1.5);
    const smoke = frame.particles!.find((b) => b.entity === s.id('smoke'))!;
    expect(smoke.count).toBeGreaterThan(5);
    expect(smoke.blend).toBe('alpha');
    expect([...smoke.data].every(Number.isFinite)).toBe(true);

    const engine = s.plugin.engine;
    engine.play('vfx/pop', { point: [0, 1, 0] }, { direction: [0, 0, 1] });
    engine.beam([0, 0, 0], [0, 0, 10], { seconds: 0.5 });
    const trail = engine.trail(s.id('sign'));
    s.kernel.world.require(s.id('sign')).transform.position = new Vec3(1, 3, 0);
    s.steps(2);
    s.kernel.world.require(s.id('sign')).transform.position = new Vec3(2, 3, 0);
    s.steps(2);
    frame = s.frame();
    expect(frame.particles!.some((b) => b.entity === null && b.count === 10)).toBe(true);
    // The beam: one ribbon from its start to its end (RIBBON_STRIDE numbers per point).
    expect(frame.ribbons!.some((r) => r.entity === null && r.points[RIBBON_STRIDE + 2] === 10 && r.blend === 'additive')).toBe(true);
    expect(frame.ribbons!.some((r) => r.entity === s.id('sign'))).toBe(true);
    trail.cancel();
    s.steps(40);
    expect(s.frame().ribbons).toBeUndefined();
    expect(s.frame().lines).toEqual([]);
  });

  it('poses skinned models from the animator and instances static model meshes', async () => {
    const s = await scene({
      prefabs: {
        cam: CAMERA,
        hero: { components: { model: { model: 'models/hero' }, animator: { default_clip: 'walk' } } },
        statue: { components: { model: { model: 'models/hero', tint: '#ff000080' } } },
      },
      entities: [
        { id: 'cam', prefab: 'cam', at: [0, 2, -10] },
        { id: 'hero', prefab: 'hero', at: [0, 0, 0] },
        { id: 'statue', prefab: 'statue', at: [3, 0, 0] },
      ],
    }, { 'assets/models/hero.glb': standInCharacter(['walk', 'wave'], 1) });
    s.steps(29);
    const frame = s.frame();
    expect(frame.skinned).toHaveLength(2);
    const hero = frame.skinned.find((d) => d.entity === s.id('hero'))!;
    expect(hero.jointCount).toBe(2);
    // Half a second into "walk", the upper joint has swung: its palette isn't the identity.
    expect(Math.abs(hero.palette[16 + 1]!)).toBeGreaterThan(0.3);
    const statue = frame.skinned.find((d) => d.entity === s.id('statue'))!;
    // No animator: the rest pose, identity palettes; tint alpha below 1 blends.
    expect(statue.palette[16 + 1]).toBeCloseTo(0);
    expect(statue.material.alphaMode).toBe('blend');
    expect(statue.castShadows).toBe(false);
    expect(statue.model[12]).toBe(3);
    expect(s.plugin.clipLength('models/hero#wave')).toBe(1);
    expect(s.plugin.clipLength('walk')).toBe(1);
  });

  it('reports a missing clip, a 2D shape kind and a model that is not in the project', async () => {
    const s = await scene({
      prefabs: { cam: CAMERA, hero: { components: { model: { model: 'models/hero' }, animator: { default_clip: 'run' } } } },
      entities: [{ id: 'cam', prefab: 'cam' }],
    }, { 'assets/models/hero.glb': standInCharacter(['walk'], 1) });
    s.kernel.spawn('hero');
    expect(code(() => s.steps(1))).toBe('PP3805');

    const flat = await scene({ prefabs: { cam: CAMERA, star: { components: { shape: { kind: 'polygon' } } } }, entities: [{ id: 'cam', prefab: 'cam' }] });
    flat.kernel.spawn('star');
    expect(code(() => flat.steps(1))).toBe('PP3812');

    const none = await scene({ prefabs: { cam: CAMERA, ghost: { components: { model: { model: 'models/ghost' } } } }, entities: [{ id: 'cam', prefab: 'cam' }] })
      .catch((e: unknown) => e);
    expect((none as ParallaxError).diagnostic.code).toBe('PP2063');
  });

  it('raises a model that failed to load on the next frame', async () => {
    const broken: BinaryFiles = { read: () => Promise.reject(new Error('HTTP 404')) };
    const project = files({
      'prefabs/cam.prefab.json': CAMERA,
      'prefabs/thing.prefab.json': { components: { model: { model: 'models/thing' } } },
      'scenes/main/scene.json': { entities: [{ prefab: 'cam' }, { prefab: 'thing' }] },
      'assets/models/thing.glb': '',
    });
    const plugin = render3d({ surface: new RecordingSurface3d(), files: project });
    const kernel = new Kernel({ project: loadProject(project), game: NO_GAME, plugins: [visuals({ dimension: '3d' }), models({ files: project, binary: broken }), plugin], context: {} });
    kernel.start('main');
    await plugin.engine.whenLoaded();
    expect(code(() => kernel.step(DT))).toBe('PP3804');
  });

  it('without the asset files (data-only runs), missing models draw nothing, missing effects emit nothing, their clips have no frames', async () => {
    const project = files({
      'prefabs/cam.prefab.json': CAMERA,
      'prefabs/thing.prefab.json': { components: { model: { model: 'models/thing' } } },
      'scenes/main/scene.json': { entities: [{ prefab: 'cam' }, { prefab: 'thing' }] },
    });
    const plugin = render3d({ surface: new RecordingSurface3d(), files: project, assetFiles: false });
    const kernel = new Kernel({
      project: loadProject(project), game: NO_GAME, plugins: [visuals({ dimension: '3d' }), models({ files: project, binary: new MemoryBinaryFiles({}), assetFiles: false }), plugin], context: {},
    });
    plugin.engine.preload();
    await plugin.engine.whenLoaded();
    kernel.start('main');
    plugin.engine.play('vfx/sparks', { point: [0, 0, 0] });
    kernel.step(DT);
    expect(plugin.engine.lastFrame!.meshes).toEqual([]);
    expect(plugin.engine.lastFrame!.billboards).toEqual([]);
    expect(plugin.engine.lastFrame!.particles).toBeUndefined();
    expect(plugin.clipLength('models/thing#run')).toBe(0);
    expect(plugin.clipLength('run')).toBe(0);
    expect(code(() => plugin.engine.play('images/oops', { point: [0, 0, 0] }))).toBe('PP2063');
  });

  it('snapshots particles and restores them exactly', async () => {
    const s = await scene({
      prefabs: { cam: CAMERA, fire: { components: { particles: { effect: 'vfx/fire' } } } },
      entities: [{ id: 'cam', prefab: 'cam' }, { id: 'fire', prefab: 'fire', at: [0, 1, 0] }],
      extra: { 'assets/vfx/fire.vfx.json': { rate: 40, lifetime: [0.5, 1], speed: [1, 2], spread: 60, radius: 0.2 } },
    });
    s.steps(20);
    const snapshot = s.kernel.snapshot();
    s.steps(15);
    const later = [...s.frame().particles![0]!.data];
    s.kernel.restore(snapshot);
    s.steps(15);
    expect([...s.frame().particles![0]!.data]).toEqual(later);
  });

  it('draws split screen as one view per active camera, left to right by seat', async () => {
    const s = await scene({
      prefabs: {
        left: { components: { camera: { viewport: [0, 0, 0.5, 1] } } },
      },
      entities: [{ id: 'one', prefab: 'left', at: [0, 1, -5] }],
    });
    const [view] = s.frame().views;
    expect(view!.viewport).toEqual({ x: 0, y: 0, width: 640, height: 720 });
    expect(view!.projection[0]! / view!.projection[5]!).toBeCloseTo(720 / 640);
  });

  it('reports a texture the surface could not load on the next frame', async () => {
    const surface = new RecordingSurface3d({ failing: ['assets/images/rust.png'] });
    const s = await scene({
      prefabs: { cam: CAMERA, crate: { components: { shape: { kind: 'box', texture: 'images/rust' } } } },
      entities: [{ id: 'cam', prefab: 'cam' }, { id: 'crate', prefab: 'crate' }],
      extra: { 'assets/images/rust.png': '' },
    }, {}, surface);
    expect(code(() => s.steps(1))).toBe('PP3816');
  });
});

describe('post settings', () => {
  it('maps the environment\'s resolved post settings onto the port', async () => {
    const { DEFAULT_POST, resolvePost } = await import('../environment/index.js');
    const noir = postOf(resolvePost({ preset: 'noir', fields: { bloom: 0.5 } }, null));
    expect(noir).toMatchObject({ bloom: 0.5, vignette: 0.45, grade: { saturation: 0 } });
    expect(postOf(DEFAULT_POST)).toMatchObject({ exposure: 1, bloom: 0.1, bloomThreshold: 0.5, ambientOcclusion: 1, reflections: true, mode: 'standard', antialias: true });
  });
});
