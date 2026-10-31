import { describe, expect, it } from 'vitest';
import { colorVisionMatrix, colorVisionFilterValues, MESH_INSTANCE_STRIDE, ParallaxError, PLAIN_POST } from '../../../core/index.js';
import type { Frame3d, Geometry3d, Light3d, Material3d, Quality3d, Text3d, Texture3d, View3d } from '../../../core/index.js';
import { compose, invert, multiply, perspective, viewMatrix } from '../../../resource/index.js';
import { unitShape } from '../../../resource/index.js';
import { QUALITY_LADDER } from '../../../function/plugins/render3d/quality.js';
import { chooseLocalShadows, fitCascades } from '../../../function/plugins/render3d/shadow.js';
import type { GpuAdapter, GpuDevice, GpuLike } from './backend.js';
import { GeometryCache } from './backend.js';
import { buildClusters, lightClusterBox, sliceMapping, sliceOf } from './clusters.js';
import { environmentKey, environmentMips, irradiance, skyLighting } from './ibl.js';
import {
  CASTER_SLOT, DATA_ROW, FRAME_FIELDS, FRAME_SLOT, floatsOf, LIGHT_TEXELS, MATERIAL_FIELDS, MATERIAL_SLOT, MESH_INSTANCE_FLOATS, normalMatrix,
  offsetOf, OUTLINE_FIELDS, packLights, packMaterial, srgbToLinear, TERRAIN_FIELDS, UNIFORM_ALIGN,
} from './layout.js';
import { atlasColumns, boxVisible, passFlags, planFrame, selectLights, sunOnScreen, visitPasses } from './plan.js';
import type { FramePlan, PassVisitor, PlanOptions } from './plan.js';
import { ENV_FIELDS, glslPost, POST_BINDINGS, POST_PASSES, toGlsl, VIEW_PASSES, wgslPost } from './post_shaders.js';
import type { PostPass, PostVariant } from './post_shaders.js';
import { selectBackend } from './select.js';
import type { BackendCanvas } from './select.js';
import { AGX_INSET, AGX_OUTSET, GLSL_DEPTH_REMAP, GLSL_UNITS, glsl, sceneVariants, wgsl } from './shaders.js';
import { textLines } from './text.js';
import { WebGl2Backend } from './webgl2.js';
import { WebGpuBackend } from './webgpu.js';
import { edgeIndices } from './wireframe.js';

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ParallaxError) return e.diagnostic.code;
    throw e;
  }
  return 'no error';
}

// ── Layout ─────────────────────────────────────────────────────────────────────

describe('uniform and data layout', () => {
  it('fits every block in whole 256-byte slots', () => {
    expect((FRAME_SLOT * 4) % UNIFORM_ALIGN).toBe(0);
    expect(FRAME_SLOT).toBeGreaterThanOrEqual(floatsOf(FRAME_FIELDS));
    for (const fields of [MATERIAL_FIELDS, TERRAIN_FIELDS, OUTLINE_FIELDS, ENV_FIELDS]) expect(floatsOf(fields) * 4).toBeLessThanOrEqual(UNIFORM_ALIGN);
    expect((CASTER_SLOT * 4) % UNIFORM_ALIGN).toBe(0);
    for (const f of FRAME_FIELDS) expect(offsetOf(FRAME_FIELDS, f.name) % 4).toBe(0);
  });

  it('computes normal matrices as the inverse-transpose of the model 3×3', () => {
    const m = compose(1, 2, 3, 0.2, 0.3, 0.1, Math.sqrt(1 - 0.14), 2, 0.5, 3);
    const out = new Float32Array(12);
    normalMatrix(m, 0, out, 0);
    const inv = invert(m)!;
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) expect(out[c * 4 + r]).toBeCloseTo(inv[r * 4 + c]!, 5);
  });

  it('packs materials in linear color, with their normal and occlusion map settings', () => {
    const out = new Float32Array(MATERIAL_SLOT);
    packMaterial({ ...MATERIAL, normalTexture: BRICKS, normalScale: 0.5, occlusionTexture: BRICKS, occlusionStrength: 0.7 }, out, 0);
    expect(out[0]).toBeCloseTo(srgbToLinear(0.5));
    expect(out[9]).toBeCloseTo(0.5);
    expect([...out.subarray(12, 16)].map((v) => +v.toFixed(3))).toEqual([0.5, 0.7, 1, 1]);
    packMaterial(MATERIAL, out, 0);
    expect([...out.subarray(12, 16)]).toEqual([1, 1, 0, 0]);
  });

  it('packs material layers: clearcoat, transmission, subsurface (linear), anisotropy (radians)', () => {
    const out = new Float32Array(MATERIAL_SLOT);
    packMaterial({ ...MATERIAL, layers: { clearcoat: 1, clearcoatRoughness: 0.1, transmission: 0.9, subsurface: 0.5, subsurfaceColor: [1, 0.5, 0.5], anisotropy: -0.6, anisotropyRotation: 90 } }, out, 0);
    expect([...out.subarray(16, 20)].map((v) => +v.toFixed(3))).toEqual([1, 0.1, 0.9, 0.5]);
    expect(out[21]).toBeCloseTo(srgbToLinear(0.5));
    expect(out[23]).toBeCloseTo(-0.6);
    expect(out[24]).toBeCloseTo(Math.PI / 2);
  });

  it('packs lights four texels each, with their shadow tile and spot cone', () => {
    const spot = light('spot', [1, 2, 3], 5);
    const data = packLights([light('point', [0, 0, 0], 4), spot], new Map([[spot, 7]]));
    expect(data.length).toBe(DATA_ROW * 4);
    const o = LIGHT_TEXELS * 4;
    expect([...data.subarray(o, o + 4)]).toEqual([1, 2, 3, 5]);
    expect(data[o + 7]).toBe(2);
    expect(data[o + 12]).toBe(7);
    expect(data[12]).toBe(-1);
    expect(data[o + 13]!).toBeGreaterThan(data[o + 11]!);
  });
});

// ── Shaders ────────────────────────────────────────────────────────────────────

const structMembers = (source: string, name: string): string[] => {
  const body = new RegExp(`struct ${name} \\{([^}]*)\\}`).exec(source)?.[1] ?? '';
  return [...body.matchAll(/(\w+):/g)].map((m) => m[1]!);
};
const blockMembers = (source: string, name: string): string[] => {
  const body = new RegExp(`uniform ${name} \\{([^}]*)\\}`).exec(source)?.[1] ?? '';
  return [...body.matchAll(/(\w+)(?:\[\d+\])?;/g)].map((m) => m[1]!);
};
const wgslLocations = (source: string, struct: string): number[] => {
  const body = new RegExp(`struct ${struct} \\{([^}]*)\\}`).exec(source)?.[1] ?? '';
  return [...body.matchAll(/@location\((\d+)\)/g)].map((m) => Number(m[1])).sort((a, b) => a - b);
};
const glslLocations = (source: string): number[] =>
  [...source.matchAll(/layout\(location = (\d+)\) in /g)].map((m) => Number(m[1])).sort((a, b) => a - b);
/** Names of functions a source defines, in order. */
const wgslFunctions = (s: string): string[] => [...s.matchAll(/\bfn (\w+)\(/g)].map((m) => m[1]!).filter((n) => n !== 'vs' && n !== 'fs');
const glslFunctions = (s: string): string[] => [...s.matchAll(/^(?:vec[234]|uvec2|ivec2|float|int|uint|mat[34]|void|bool|Layers|Ground|Surf) (\w+)\(/gm)].map((m) => m[1]!).filter((n) => n !== 'main');

describe('scene shaders: WGSL and GLSL parity', () => {
  const variants = sceneVariants().map((v) => [`${v.pass} ${JSON.stringify(v.variant)}`, v] as const);

  it.each(variants)('%s: same entry points, uniform blocks, vertex inputs and functions', (_name, { pass, variant }) => {
    const w = wgsl(pass, variant);
    const g = glsl(pass, variant);
    expect(w).toMatch(/@vertex fn vs\(/);
    if (pass === 'caster') expect(w).not.toMatch(/@fragment/);
    else expect(w).toMatch(/@fragment fn fs\(/);
    expect(g.vertex.startsWith('#version 300 es')).toBe(true);
    expect(g.fragment.startsWith('#version 300 es')).toBe(true);
    const glslAll = g.vertex + g.fragment;
    for (const [block, fields] of [['Frame', FRAME_FIELDS], ['Material', MATERIAL_FIELDS], ['Terrain', TERRAIN_FIELDS], ['Outline', OUTLINE_FIELDS]] as const) {
      expect(w.includes(`struct ${block} `)).toBe(glslAll.includes(`uniform ${block} `));
      if (w.includes(`struct ${block} `)) {
        expect(structMembers(w, block)).toEqual(fields.map((f) => f.name));
        expect(blockMembers(glslAll, block)).toEqual(fields.map((f) => f.name));
      }
    }
    const inputStruct = pass === 'billboard' ? 'InstanceIn' : 'VertexIn';
    expect(wgslLocations(w, inputStruct)).toEqual(glslLocations(g.vertex));
    expect(w.includes('skinMatrix')).toBe(variant.skinned === true);
    expect(g.vertex.includes('skinMatrix')).toBe(variant.skinned === true);
    // GLSL fetches bone matrices from a texture (`joint`); WGSL indexes a storage buffer.
    const sorted = (list: string[]): string[] => [...new Set(list.filter((f) => f !== 'joint'))].sort();
    expect(sorted(glslFunctions(g.vertex + g.fragment))).toEqual(sorted(wgslFunctions(w)));
    // Second render target exactly when the variant asks for one.
    expect(w.includes('@location(1) surface')).toBe(variant.mrt === true);
    expect(g.fragment.includes('fragSurface')).toBe(variant.mrt === true);
  });

  it('every GLSL vertex shader remaps clip depth to -1..1; WGSL never does', () => {
    for (const { pass, variant } of sceneVariants()) {
      expect(glsl(pass, variant).vertex.trimEnd().split('\n').at(-2)!.trim()).toBe(GLSL_DEPTH_REMAP);
      expect(wgsl(pass, variant)).not.toContain('* 2.0 - gl_Position');
    }
  });

  it('shadow lookups flip v for WebGPU textures only, and lighting code matches statement for statement', () => {
    const w = wgsl('mesh');
    const g = glsl('mesh').fragment;
    expect(w.match(/0\.5 - ndc\.y \* 0\.5/g)).toHaveLength(2);
    expect(g.match(/0\.5 \+ ndc\.y \* 0\.5/g)).toHaveLength(2);
    const statements = (s: string): string[] => [...s.matchAll(/(?:let|var|float|vec[234]|int|uvec2) (\w+) = /g)].map((m) => m[1]!);
    for (const fn of ['brdf', 'localShadow', 'shadeLight', 'lighting', 'cascadeShadow', 'sunShadow', 'perturb', 'envBrdf', 'clusterOf']) {
      const wb = new RegExp(`fn ${fn}\\([\\s\\S]*?\\n}`).exec(w)![0];
      const gb = new RegExp(`\\w+ ${fn}\\([^)]*\\) \\{[\\s\\S]*?\\n}`).exec(g)![0];
      expect(statements(gb), fn).toEqual(statements(wb));
    }
  });

  it('every GLSL sampler has a texture unit, and no program samples two names on one unit', () => {
    for (const { pass, variant } of sceneVariants()) {
      const g = glsl(pass, variant);
      const names = [...(g.vertex + g.fragment).matchAll(/uniform (?:sampler2D|sampler2DShadow|usampler2D|samplerCube) (\w+);/g)].map((m) => m[1]!);
      const units = names.map((n) => (GLSL_UNITS as Record<string, number>)[n]);
      expect(units.every((u) => u !== undefined), names.join()).toBe(true);
      expect(new Set(units).size).toBe(units.length);
    }
  });

  it('both backends treat clockwise triangles as front faces (the port\'s outward cross product)', async () => {
    const { readFileSync } = await import('node:fs');
    const read = (f: string): string => readFileSync(new URL(f, import.meta.url), 'utf8');
    expect(read('./webgpu.ts')).toContain("frontFace: 'cw'");
    expect(read('./webgl2.ts')).toContain('gl.frontFace(gl.CW)');
  });
});

describe('post shaders: one source, both languages', () => {
  const variants: [PostPass, PostVariant][] = [
    ...POST_PASSES.map((p) => [p, {}] as [PostPass, PostVariant]),
    ['ao', { scale: 2, samples: 8 }], ['aoBlur', { scale: 2 }], ['present', { fxaa: false }], ['godRays', { samples: 40 }],
  ];

  it.each(variants)('%s %j: declares its bindings in both languages, the same functions, one entry', (pass, variant) => {
    const w = wgslPost(pass, variant);
    const g = glslPost(pass, variant);
    expect(w).toMatch(/@fragment fn fs\(/);
    expect(g.fragment).toMatch(/void main\(\)/);
    for (const b of POST_BINDINGS[pass]) {
      if (b.kind === 'linear') continue;
      expect(w).toContain(b.kind === 'env' ? 'var<uniform> env: Env' : `var ${b.name}:`);
      expect(g.fragment).toContain(b.kind === 'env' ? 'uniform Env {' : ` ${b.name};`);
      if (b.kind !== 'env') expect((GLSL_UNITS as Record<string, number>)[b.name]).toBeDefined();
    }
    expect(glslFunctions(g.fragment).filter((n) => !['shadowTap', 'cascadeShadow', 'sunShadow', 'uvOf', 'texelOf', 'luminance', 'toDisplay', 'octEncode', 'octDecode', 'skyColor', 'applyFog'].includes(n)))
      .toEqual(wgslFunctions(w).filter((n) => !['shadowTap', 'cascadeShadow', 'sunShadow', 'uvOf', 'texelOf', 'luminance', 'toDisplay', 'octEncode', 'octDecode', 'skyColor', 'applyFog'].includes(n)));
    expect(w.includes('var<uniform> frame: Frame;')).toBe(pass !== 'envSky' && pass !== 'envPrefilter');
    expect(w.includes(`@group(${VIEW_PASSES.includes(pass) ? 1 : 0}) @binding(0) var`)).toBe(true);
  });

  it('refuses a body it cannot translate', () => {
    expect(() => toGlsl('fn f(a: f32) -> f32 {\n  let b = a;\n  return b;\n}')).toThrow(/untyped declaration/);
    expect(toGlsl('fn f(a: vec2<f32>) -> f32 {\n  let b: f32 = a.x;\n  return b;\n}')).toBe('float f(vec2 a) {\n  float b = a.x;\n  return b;\n}');
  });

  it('tone maps with AgX: black stays black, mid gray lands mid, highlights roll off below white, monotonic', () => {
    const nums = (list: string): number[] => list.split(',').map(Number);
    const inset = nums(AGX_INSET);
    const outset = nums(AGX_OUTSET);
    const mul = (m: number[], v: number[]): number[] => [0, 1, 2].map((r) => m[r]! * v[0]! + m[3 + r]! * v[1]! + m[6 + r]! * v[2]!);
    const curve = (x: number): number => {
      const x2 = x * x; const x4 = x2 * x2;
      return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
    };
    const agx = (c: number): number => {
      let x = mul(inset, [c, c, c]).map((v) => (Math.min(4.026069, Math.max(-12.47393, Math.log2(Math.max(v, 1e-10)))) + 12.47393) / 16.499999);
      x = x.map((v) => Math.max(curve(v), 0) ** 1.35);
      return Math.min(1, Math.max(0, mul(outset, x)[1]!));
    };
    expect(agx(0)).toBeLessThan(0.01);
    expect(agx(0.18)).toBeGreaterThan(0.25);
    expect(agx(0.18)).toBeLessThan(0.6);
    expect(agx(16)).toBeLessThan(1.0001);
    let last = -1;
    for (const c of [0.01, 0.05, 0.1, 0.3, 1, 3, 10]) {
      expect(agx(c)).toBeGreaterThan(last);
      last = agx(c);
    }
    expect(wgslPost('final')).toContain(AGX_INSET);
    expect(glslPost('final').fragment).toContain(AGX_INSET);
  });
});

// ── Planning fixtures ──────────────────────────────────────────────────────────

const MATERIAL: Material3d = {
  id: 'm', baseColor: [0.5, 0.5, 0.5, 1], baseColorTexture: null, metallic: 0, roughness: 0.5, metallicRoughnessTexture: null,
  emissive: [0, 0, 0], emissiveTexture: null, alphaMode: 'opaque', alphaCutoff: 0.5, doubleSided: false, unlit: false,
};
const GLASS: Material3d = { ...MATERIAL, id: 'glass', alphaMode: 'blend' };
const BRICKS: Texture3d = { id: 'bricks', source: { kind: 'file', path: 'assets/images/bricks.png' }, colorSpace: 'srgb', wrapU: 'repeat', wrapV: 'repeat', filter: 'linear' };
const BUMPS: Texture3d = { ...BRICKS, id: 'bumps', colorSpace: 'linear' };

function light(kind: Light3d['kind'], position: [number, number, number], range = 6, shadows = false): Light3d {
  return { kind, color: [1, 1, 1], intensity: 1, position, direction: [0, -1, 0], range, angle: 60, shadows, entity: null };
}

function view(eye: [number, number, number], x = 0, facing: 1 | -1 = 1, camera = 1): View3d {
  const forward: [number, number, number] = [0, 0, facing];
  const right: [number, number, number] = [facing, 0, 0];
  const v = viewMatrix(eye, right, [0, 1, 0], forward);
  const p = perspective(60, 1, 0.1, 1000);
  const vp = multiply(p, v);
  return {
    camera, viewport: { x, y: 0, width: 400, height: 400 }, position: eye, right, up: [0, 1, 0], forward,
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

function chunk(id: string, x: number, z: number): Geometry3d {
  return { ...unitShape('plane'), id, colors: new Float32Array(16).fill(0.25), min: [x, 0, z], max: [x + 10, 1, z + 10] };
}

function frame(over: Partial<Frame3d> = {}, quality: Quality3d = QUALITY_LADDER.high): Frame3d {
  const box = unitShape('box');
  const palette = (n: number): Float32Array => new Float32Array(n * 16);
  const skinned = { ...box, id: 'skinned', joints: new Uint16Array(box.positions.length / 3 * 4), weights: new Float32Array(box.positions.length / 3 * 4) };
  const views = [view([0, 0, -10]), view([0, 0, 30], 400, 1, 2)];
  const sunDirection: [number, number, number] = [0, -1, 0.2];
  const lights = [light('point', [0, 1, 0], 6, true), light('spot', [3, 3, 0], 8, true), light('directional', [0, 0, 0])];
  return {
    frame: 1,
    views,
    environment: {
      sky: { zenith: [0.2, 0.4, 0.8], horizon: [0.8, 0.9, 1] },
      fog: { kind: 'exponential', color: [0.5, 0.5, 0.5], density: 0.01, near: 0, far: 0, volumetric: 0.5 },
      ambient: [0.3, 0.3, 0.3],
      sun: { direction: sunDirection, color: [1, 1, 1], intensity: 2, shadows: true },
      post: { ...PLAIN_POST, ambientOcclusion: 1, reflections: true, bloom: 0.5, godRays: 0.5 },
    },
    quality,
    sunShadow: fitCascades(views[0]!, sunDirection, quality),
    localShadows: chooseLocalShadows(lights, views[0], quality).shadows,
    terrain: {
      tiles: [chunk('ahead', -5, 0), chunk('behind', -5, -60)].map((geometry, i) => ({ geometry, palette: [0], morphStart: 40 + i, morphEnd: 60 + i, level: i })),
      materials: [{ texture: null, tile: 8, color: [0.4, 0.6, 0.3], tint: [1, 1, 1], roughness: 0.9, detail: null, detailTile: 1, detailStrength: 0, pattern: 'grass', variation: 0.5, relief: 1, normal: null, recolor: false }],
    },
    meshes: [
      { geometry: box, material: MATERIAL, count: 3, instances: instances([0, 0, 0], [2, 0, 0], [4, 0, 0]), entities: [1, 2, 3], castShadows: true },
      { geometry: box, material: GLASS, count: 2, instances: instances([0, 0, 5], [0, 0, 15]), entities: [4, 5], castShadows: false },
      { geometry: box, material: { ...MATERIAL, id: 'brick', baseColorTexture: BRICKS, normalTexture: BUMPS }, count: 1, instances: instances([1, 1, 1]), entities: [6], castShadows: true },
    ],
    skinned: [
      { geometry: skinned, material: MATERIAL, model: compose(0, 0, 0, 0, 0, 0, 1, 1, 1, 1), tint: [1, 1, 1, 1], palette: palette(3), jointCount: 3, entity: 7, castShadows: true },
      { geometry: skinned, material: MATERIAL, model: compose(1, 0, 0, 0, 0, 0, 1, 1, 1, 1), tint: [1, 1, 1, 1], palette: palette(5), jointCount: 5, entity: 8, castShadows: true },
    ],
    lights,
    billboards: [
      { layer: 'scene', shape: 'circle', image: null, count: 2, data: new Float32Array(24), entity: 9 },
      { layer: 'overlay', shape: 'square', image: null, count: 1, data: new Float32Array(12), entity: 11 },
    ],
    texts: [{ entity: 10, position: [0, 2, 0], size: 0.5, spans: [{ text: 'Hi\nthere', color: [1, 1, 1, 1], bold: false }], faceCamera: true, right: [1, 0, 0], up: [0, 1, 0] }],
    lines: [
      { layer: 'scene', points: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0]), width: 0.1, color: [1, 0, 0, 1], entity: null },
      { layer: 'overlay', points: new Float32Array([0, 0, 0, 0, 1, 0]), width: 0.1, color: [1, 1, 0, 1], entity: null },
    ],
    outlines: [{ entity: 2, color: [1, 0, 0], width: 3, throughWalls: true, fill: 0.25 }, { entity: 7, color: [0, 1, 0], width: 2, throughWalls: false, fill: 0 }],
    ...over,
  };
}

const textOf = (t: Text3d): ReturnType<PlanOptions['text']> => ({ width: 2 * t.size, height: textLines(t.spans).length * t.size, texture: { id: 'text', text: t } });

function plan(f: Frame3d, ready: (t: Texture3d) => boolean = () => true): FramePlan {
  return planFrame(f, { width: 800, height: 400, ready, text: textOf });
}

function order(p: FramePlan): string[] {
  const out: string[] = [];
  const visitor: PassVisitor = {
    environment: () => out.push('environment'),
    shadows: (tiles) => out.push(`shadows:${tiles.length}`),
    scene: (v) => out.push(`${v.frameSlot}:scene`),
    ao: (v) => out.push(`${v.frameSlot}:ao`),
    reflections: (v) => out.push(`${v.frameSlot}:reflections`),
    resolve: (v) => out.push(`${v.frameSlot}:resolve`),
    nature: (v) => out.push(`${v.frameSlot}:nature`),
    decals: (v) => out.push(`${v.frameSlot}:decals`),
    fogOfWar: (v) => out.push(`${v.frameSlot}:fogOfWar`),
    target: (t) => out.push(`target:${t.id}`),
    transparent: (v) => out.push(`${v.frameSlot}:transparent`),
    volumetric: (v) => out.push(`${v.frameSlot}:volumetric`),
    godRays: (v) => out.push(`${v.frameSlot}:godRays`),
    outlines: (v) => out.push(`${v.frameSlot}:outlines`),
    bloom: (levels) => out.push(`bloom:${levels}`),
    final: (v) => out.push(`${v.frameSlot}:final`),
    overlay: (v) => out.push(`${v.frameSlot}:overlay`),
    present: () => out.push('present'),
  };
  visitPasses(p, visitor);
  return out;
}

describe('frame planning', () => {
  it('runs every pass on high: environment, shadows, per view scene → post, bloom, per view final + overlay, present', () => {
    const p = plan(frame());
    expect(order(p)).toEqual([
      'environment', `shadows:${p.shadowTiles.length}`,
      '0:scene', '0:ao', '0:reflections', '0:resolve', '0:transparent', '0:volumetric', '0:godRays', '0:outlines',
      '1:scene', '1:ao', '1:reflections', '1:resolve', '1:transparent', '1:volumetric', '1:godRays', '1:outlines',
      `bloom:${QUALITY_LADDER.high.bloomLevels}`,
      '0:final', '0:overlay', '1:final', '1:overlay', 'present',
    ]);
  });

  it('the quality ladder decides the costly passes; the scene\'s post settings decide the rest', () => {
    const low = plan(frame({}, QUALITY_LADDER.low));
    expect(low.flags).toMatchObject({ gbuffer: false, ao: 'off', reflections: false, resolve: false, volumetric: false, godRays: false, bloomLevels: 3 });
    expect(low.shadowTiles.filter((t) => t.atlas === 'local')).toHaveLength(0);
    expect(low.shadowTiles.filter((t) => t.atlas === 'sun')).toHaveLength(1);
    expect(order(low).filter((s) => /ao|resolve|reflections|volumetric|godRays/.test(s))).toEqual([]);
    expect(plan(frame({}, QUALITY_LADDER.medium)).flags).toMatchObject({ ao: 'half', reflections: false, resolve: true, godRays: true, volumetric: false });
    const plain = frame();
    const off = plan({ ...plain, environment: { ...plain.environment, post: { ...plain.environment.post, bloom: 0, ambientOcclusion: 0, reflections: false, godRays: 0, edges: 1 } } });
    expect(off.flags).toMatchObject({ gbuffer: true, ao: 'off', resolve: false, bloomLevels: 0, godRays: false });
    const wire = plan({ ...plain, environment: { ...plain.environment, post: { ...plain.environment.post, mode: 'wireframe' } } });
    expect(wire.flags).toMatchObject({ wireframe: true, gbuffer: false, ao: 'off', reflections: false });
    expect(passFlags(QUALITY_LADDER.high, { ...PLAIN_POST, pixelate: 4 }, plain.environment.fog, false, true, true).fxaa).toBe(false);
  });

  it('keeps instanced batches whole, sorts blended instances far to near per view', () => {
    const base = frame();
    const p = plan({ ...base, views: [base.views[0]!, view([0, 0, 30], 400, -1, 2)] });
    const [near, far] = p.views;
    expect(near!.opaque.map((i) => [i.materialSlot, i.instanceCount, i.skinned])).toEqual([[0, 3, false], [2, 1, false], [0, 1, true], [0, 1, true]]);
    const z = (first: number): number => p.instances[first * MESH_INSTANCE_FLOATS + 14]!;
    expect(near!.transparent.map((i) => z(i.firstInstance))).toEqual([15, 5]);
    expect(far!.transparent.map((i) => z(i.firstInstance))).toEqual([5, 15]);
  });

  it('draws transmissive (glass) materials with the transparent ones, far to near', () => {
    const f = frame();
    const glass = { ...MATERIAL, id: 'visor', layers: { clearcoat: 0, clearcoatRoughness: 0, transmission: 1, subsurface: 0, subsurfaceColor: [1, 1, 1] as const, anisotropy: 0, anisotropyRotation: 0 } };
    const p = plan({ ...f, meshes: [...f.meshes, { geometry: unitShape('box'), material: glass, count: 1, instances: instances([0, 0, 10]), entities: [20], castShadows: true }] });
    expect(p.views[0]!.transparent.map((i) => i.material.id)).toEqual(['glass', 'visor', 'glass']);
    expect(p.views[0]!.opaque.some((i) => i.material.id === 'visor')).toBe(false);
  });

  it('lays skinned palettes end to end and points each instance at its own', () => {
    const p = plan(frame());
    const skinned = p.views[0]!.opaque.filter((i) => i.skinned);
    expect(skinned.map((i) => p.instances[i.firstInstance * MESH_INSTANCE_FLOATS + 19])).toEqual([0, 3]);
    expect(p.palette).toHaveLength(8 * 16);
  });

  it('leaves out draws whose textures (normal maps too) are still loading', () => {
    expect(plan(frame(), (t) => t !== BUMPS).views[0]!.opaque.some((i) => i.material.id === 'brick')).toBe(false);
    expect(plan(frame()).views[0]!.opaque.some((i) => i.material.id === 'brick')).toBe(true);
  });

  it('culls terrain per view; particles and beams are scene layers, bars, text and debug lines overlay', () => {
    const p = plan(frame());
    expect(p.views[0]!.terrain!.tiles.map((t) => t.geometry.id)).toEqual(['ahead']);
    expect(p.views[1]!.terrain).toBeNull();
    expect(boxVisible(p.frames.subarray(0, 16), [-1, -1, 5], [1, 1, 6])).toBe(true);
    expect(p.views[0]!.billboards.map((b) => b.count)).toEqual([2]);
    expect(p.views[0]!.overlayBillboards.map((b) => b.count)).toEqual([1, 1]);
    expect(p.billboards[p.views[0]!.overlayBillboards[1]!.first * 20 + 13]).toBe(1);
    expect(p.views[0]!.lines).toEqual({ first: 0, count: 12 });
    expect(p.views[0]!.overlayLines).toEqual({ first: 12, count: 6 });
  });

  it('tiles the sun\'s cascades and the shadowed lights into their atlases, culling casters per tile', () => {
    const p = plan(frame());
    const sun = p.shadowTiles.filter((t) => t.atlas === 'sun');
    const local = p.shadowTiles.filter((t) => t.atlas === 'local');
    expect(sun).toHaveLength(4);
    expect(sun.map((t) => [t.x, t.y])).toEqual([[0, 0], [2048, 0], [0, 2048], [2048, 2048]]);
    expect(p.sunAtlas).toBe(4096);
    expect(local).toHaveLength(7);
    expect(p.localAtlas).toBe(QUALITY_LADDER.high.localShadowSize * atlasColumns(16));
    expect(new Set(p.shadowTiles.map((t) => t.slot)).size).toBe(p.shadowTiles.length);
    expect(p.casters.length).toBe(p.shadowTiles.length * CASTER_SLOT);
    // Each tile draws only the casters its light can see.
    expect(local.some((t) => t.casters.length < sun[0]!.casters.length)).toBe(true);
    // Light texture: the directional light, then the shadowed lights nearest first — the spot (tile 0), the point (tiles 1–6).
    const tileOf = (i: number): number => p.lights[i * LIGHT_TEXELS * 4 + 12]!;
    expect([tileOf(0), tileOf(1), tileOf(2)]).toEqual([-1, 0, 1]);
  });

  it('selects lights: directional first, then shadowed, then by reach; at most the quality allows', () => {
    const v = view([0, 0, 0]);
    const lights = [...Array.from({ length: 12 }, (_, i) => light('point', [i * 10, 0, 0], 1)), light('directional', [500, 0, 0]), light('point', [200, 0, 0], 1, true)];
    const chosen = selectLights(lights, new Set([lights[13]!]), v, 5);
    expect(chosen).toHaveLength(5);
    expect(chosen[0]!.kind).toBe('directional');
    expect(chosen[1]!.position[0]).toBe(200);
    expect(chosen[2]!.position[0]).toBe(0);
  });

  it('collects each outlined entity\'s drawn instances with its color, width and fill', () => {
    const p = plan(frame());
    const items = p.views[0]!.outlines;
    expect(items.map((o) => [o.item.skinned, o.item.instanceCount, o.throughWalls])).toEqual([[false, 1, true], [true, 1, false]]);
    const slot = items[0]!.slot * MATERIAL_SLOT;
    expect(p.materials[slot]).toBeCloseTo(1);
    expect(p.materials[slot + 3]).toBeCloseTo(3.25);
    expect(p.frames[offsetOf(FRAME_FIELDS, 'style') + 2]).toBe(3);
  });

  it('packs each view\'s camera, viewport, clusters, sun and colour vision', () => {
    const f = frame();
    const p = plan({ ...f, views: [{ ...f.views[0]!, colorVision: 'deuteranopia' }, f.views[1]!] });
    const at = (slot: number, name: string): number => slot * FRAME_SLOT + offsetOf(FRAME_FIELDS, name);
    expect([...p.frames.subarray(at(1, 'cameraPosition'), at(1, 'cameraPosition') + 3)]).toEqual([0, 0, 30]);
    expect([...p.frames.subarray(at(1, 'viewport'), at(1, 'viewport') + 4)]).toEqual([400, 0, 400, 400]);
    expect(p.frames[at(1, 'clusterParams') + 3]).toBe(16 * 9 * 24);
    expect(p.frames[at(0, 'sunColor') + 3]).toBe(4);
    expect(p.frames[at(0, 'colorVision0') + 3]).toBe(1);
    expect(p.frames[at(1, 'colorVision0') + 3]).toBe(0);
    const m = colorVisionMatrix('deuteranopia');
    expect(p.frames[at(0, 'colorVision1') + 1]).toBeCloseTo(m[4]!, 5);
  });

  it('places the sun on screen only when it is in front of the camera', () => {
    const v = view([0, 0, 0]);
    const [x, y, facing] = sunOnScreen(v, [0, 0, -1]);
    expect([x, y]).toEqual([0.5, 0.5]);
    expect(facing).toBeCloseTo(1);
    expect(sunOnScreen(v, [0, 0, 1])[2]).toBe(0);
    expect(sunOnScreen(v, [0.2, -0.2, -1])[0]).toBeLessThan(0.5);
  });

  it('frees GPU geometry that went unused', () => {
    const freed: string[] = [];
    const cache = new GeometryCache<string>((g: Geometry3d) => g.id, (v) => freed.push(v), 2);
    cache.get(unitShape('box'));
    for (let i = 0; i < 4; i++) cache.endFrame();
    expect(freed).toEqual(['shape:box']);
    expect(cache.size).toBe(0);
  });
});

describe('clustered lights', () => {
  const v = view([0, 0, -10]);
  const dims = { x: 16, y: 9, z: 24 };

  it('slices view depth logarithmically', () => {
    const m = sliceMapping(0.1, 1000, 24);
    expect(sliceOf(0.1, m, 24)).toBe(0);
    expect(sliceOf(999, m, 24)).toBe(23);
    let last = 0;
    for (let d = 0.2; d < 1000; d *= 1.5) {
      expect(sliceOf(d, m, 24)).toBeGreaterThanOrEqual(last);
      last = sliceOf(d, m, 24);
    }
  });

  it('lists a light in every cluster its range can touch (sampled), and in none behind the camera', () => {
    const m = sliceMapping(v.near, v.far, dims.z);
    const lights = [light('point', [1, 0.5, 4], 3), light('point', [-6, 2, 20], 5), light('point', [0, 0, -30], 5), light('spot', [0, 0, -9.95], 2)];
    const plan = buildClusters(lights, 0, [v], dims, DATA_ROW);
    expect(lightClusterBox(lights[2]!, v, dims, m, v.far)).toBeNull();
    const listed = (cx: number, cy: number, cz: number): number[] => {
      const c = (cz * dims.y + cy) * dims.x + cx;
      const first = plan.grid[c * 2]!;
      return [...plan.items.subarray(first, first + plan.grid[c * 2 + 1]!)];
    };
    // Points inside each light's range, projected to their cluster, must list the light.
    for (const [i, l] of lights.entries()) {
      if (i === 2) continue;
      for (let k = 0; k < 200; k++) {
        const a = k * 2.399; const r = l.range * Math.sqrt((k % 10) / 10); const h = ((k % 7) / 7) * 2 - 1;
        const p = [l.position[0] + Math.cos(a) * r * Math.sqrt(1 - h * h), l.position[1] + h * r, l.position[2] + Math.sin(a) * r * Math.sqrt(1 - h * h)];
        const depth = p[2]! - v.position[2];
        if (depth <= v.near) continue;
        const clip = [0, 1, 3].map((row) => v.viewProjection[row]! * p[0]! + v.viewProjection[4 + row]! * p[1]! + v.viewProjection[8 + row]! * p[2]! + v.viewProjection[12 + row]!);
        const nx = clip[0]! / clip[2]!; const ny = clip[1]! / clip[2]!;
        if (Math.abs(nx) > 1 || Math.abs(ny) > 1) continue;
        const cx = Math.min(15, Math.floor(((nx + 1) / 2) * 16)); const cy = Math.min(8, Math.floor(((1 - ny) / 2) * 9));
        expect(listed(cx, cy, sliceOf(depth, m, dims.z))).toContain(i);
      }
    }
  });

  it('puts every view\'s clusters end to end and skips directional lights', () => {
    const lights = [light('directional', [0, 0, 0]), light('point', [0, 0, 0], 4)];
    const p = buildClusters(lights, 1, [v, view([0, 0, 30], 400)], dims, DATA_ROW);
    expect(p.views.map((x) => x.base)).toEqual([0, 16 * 9 * 24]);
    expect([...p.items].filter((i) => i === 0)).toHaveLength(p.items.length - [...p.items].filter((i) => i === 1).length);
    expect(p.grid.length % (DATA_ROW * 2)).toBe(0);
  });
});

describe('image-based lighting', () => {
  it('an upward face gets the authored ambient; walls less, faces toward the ground least; a bright zenith lights upward faces more', () => {
    const flat = skyLighting([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    expect(irradiance(flat.sh, [0, 1, 0])).toBeCloseTo(1, 3);
    expect(irradiance(flat.sh, [1, 0, 0])).toBeLessThan(1);
    expect(irradiance(flat.sh, [1, 0, 0])).toBeCloseTo(irradiance(flat.sh, [0, 0, -1]), 2);
    expect(irradiance(flat.sh, [0, -1, 0])).toBeLessThan(irradiance(flat.sh, [1, 0, 0]));
    expect(flat.meanLuminance).toBeCloseTo(0.5, 2);
    // The clear-day preset's sky is brighter at the horizon than overhead: the ground still gets the most light.
    const clear = skyLighting([0.042, 0.198, 0.665], [0.398, 0.632, 0.913]);
    expect(irradiance(clear.sh, [0, 1, 0])).toBeCloseTo(1, 3);
    expect(irradiance(clear.sh, [1, 0, 0])).toBeLessThan(1);
    expect(irradiance(clear.sh, [0, 1, 0])).toBeGreaterThan(irradiance(clear.sh, [0, -1, 0]) * 1.5);
    const day = skyLighting([0.2, 0.4, 1], [0.05, 0.05, 0.05]);
    expect(irradiance(day.sh, [0, 1, 0])).toBeGreaterThan(irradiance(day.sh, [1, 0, 0]));
    expect(irradiance(day.sh, [1, 0, 0])).toBeGreaterThan(irradiance(day.sh, [0, -1, 0]));
  });

  it('rebuilds the cube only when the sky changes, mips down to 4 texels', () => {
    expect(environmentKey([0.1, 0.2, 0.3], [0.4, 0.5, 0.6], 64)).toBe(environmentKey([0.1, 0.2, 0.3], [0.4, 0.5, 0.6], 64));
    expect(environmentKey([0.1, 0.2, 0.3], [0.4, 0.5, 0.6], 64)).not.toBe(environmentKey([0.1, 0.2, 0.31], [0.4, 0.5, 0.6], 64));
    expect(environmentMips(128)).toBe(6);
    expect(environmentMips(32)).toBe(4);
  });
});

describe('wireframe edges', () => {
  it('lists each triangle edge once, also across split vertices', () => {
    // A unit box: 12 cube edges + 6 face diagonals.
    expect(edgeIndices(unitShape('box')).length / 2).toBe(18);
  });
});

describe('colour vision', () => {
  it('is the identity for none and leaves grays gray for every mode', () => {
    expect(colorVisionMatrix('none')).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    for (const mode of ['protanopia', 'deuteranopia', 'tritanopia'] as const) {
      const m = colorVisionMatrix(mode);
      for (let r = 0; r < 3; r++) expect(m[r * 3]! + m[r * 3 + 1]! + m[r * 3 + 2]!).toBeCloseTo(1, 2);
      expect(colorVisionFilterValues(mode).split(' ')).toHaveLength(20);
    }
    // Pure red and pure green, identical in blue before, differ in blue after (the lost red/green difference moves there).
    const m = colorVisionMatrix('deuteranopia');
    expect(Math.abs(m[6]! - m[7]!)).toBeGreaterThan(0.1);
  });
});

// ── Backend selection ──────────────────────────────────────────────────────────

function canvas(contexts: { webgpu?: unknown; webgl2?: unknown }): BackendCanvas & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    getContext(kind: string) {
      asked.push(kind);
      return (contexts as Record<string, unknown>)[kind] ?? null;
    },
  } as BackendCanvas & { asked: string[] };
}

function gpu(adapter: GpuAdapter | null | Error): GpuLike {
  return {
    requestAdapter: () => (adapter instanceof Error ? Promise.reject(adapter) : Promise.resolve(adapter)),
    getPreferredCanvasFormat: () => 'bgra8unorm',
  };
}

const fakeDevice = (log: string[] = []): GpuDevice => ({ destroy: () => log.push('destroy') } as unknown as GpuDevice);
const adapterOf = (device: GpuDevice | Error): GpuAdapter => ({
  requestDevice: () => (device instanceof Error ? Promise.reject(device) : Promise.resolve(device)),
});

describe('backend selection', () => {
  const GL = { gl: true };
  const CTX = { configure: () => {} };

  it('takes WebGPU when an adapter, a device and a canvas context are there', async () => {
    const c = canvas({ webgpu: CTX, webgl2: GL });
    const s = await selectBackend({ gpu: gpu(adapterOf(fakeDevice())), canvas: c });
    expect(s.kind).toBe('webgpu');
    expect(s.kind === 'webgpu' && s.format).toBe('bgra8unorm');
    expect(c.asked).toEqual(['webgpu']);
  });

  it.each([
    ['no navigator.gpu', undefined, /no WebGPU/],
    ['no adapter', gpu(null), /no WebGPU adapter/],
    ['requestAdapter throws', gpu(new Error('blocked')), /requestAdapter failed \(blocked\)/],
    ['requestDevice throws', gpu(adapterOf(new Error('lost'))), /requestDevice failed \(lost\)/],
  ] as const)('falls back to WebGL2 when there is %s', async (_label, g, reason) => {
    const c = canvas({ webgpu: CTX, webgl2: GL });
    const s = await selectBackend({ gpu: g, canvas: c });
    expect(s.kind).toBe('webgl2');
    expect(s.fallbackReason).toMatch(reason);
    expect(c.asked).toEqual(['webgl2']);
  });

  it('releases the WebGPU device when the canvas has no WebGPU context', async () => {
    const log: string[] = [];
    const s = await selectBackend({ gpu: gpu(adapterOf(fakeDevice(log))), canvas: canvas({ webgl2: GL }) });
    expect(s.kind).toBe('webgl2');
    expect(log).toEqual(['destroy']);
  });

  it('honours a preference, and fails with a code when nothing can draw', async () => {
    const c = canvas({ webgpu: CTX, webgl2: GL });
    expect((await selectBackend({ gpu: gpu(adapterOf(fakeDevice())), canvas: c, prefer: 'webgl2' })).kind).toBe('webgl2');
    const failed = (p: Promise<unknown>): Promise<string> => p.then(() => 'no error', (e: ParallaxError) => e.diagnostic.code);
    expect(await failed(selectBackend({ gpu: undefined, canvas: canvas({ webgl2: GL }), prefer: 'webgpu' }))).toBe('PP9807');
    expect(await failed(selectBackend({ gpu: undefined, canvas: canvas({}) }))).toBe('PP9807');
  });
});

// ── Backends against recording fakes ───────────────────────────────────────────

/** A WebGL2 context that accepts every call and records them by name. */
function fakeGl(): { gl: WebGL2RenderingContext; calls: string[] } {
  const calls: string[] = [];
  const constants = new Map<string, number>();
  const constant = (name: string): number => {
    if (!constants.has(name)) constants.set(name, constants.size + 1);
    return constants.get(name)!;
  };
  const values: Record<string, (...args: unknown[]) => unknown> = {
    getParameter: () => 256,
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getUniformBlockIndex: () => 0,
    getUniformLocation: () => ({}),
    getShaderInfoLog: () => '',
    getProgramInfoLog: () => '',
    checkFramebufferStatus: () => constant('FRAMEBUFFER_COMPLETE'),
  };
  const gl = new Proxy({}, {
    get(_target, prop: string) {
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return constant(prop);
      return (...args: unknown[]) => {
        calls.push(prop);
        return values[prop]?.(...args) ?? {};
      };
    },
  }) as WebGL2RenderingContext;
  return { gl, calls };
}

/** A WebGPU device whose objects accept every call; render-pass calls are recorded. */
function fakeGpu(): { device: GpuDevice; calls: string[] } {
  const calls: string[] = [];
  const object = (name: string, extra: Record<string, unknown> = {}): unknown => new Proxy(extra, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      if (prop === 'then') return undefined;
      return (...args: unknown[]) => {
        calls.push(`${name}.${prop}`);
        void args;
        return object(`${name}.${prop}()`);
      };
    },
  });
  const texture = (d: { size: number[] }): unknown => object('texture', { width: d.size[0], height: d.size[1] });
  const device = {
    queue: object('queue'),
    limits: { maxTextureDimension2D: 8192 },
    createBuffer: (d: { size: number }) => object('buffer', { size: d.size }),
    createTexture: texture,
    createSampler: () => ({}),
    createShaderModule: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createRenderPipeline: () => ({}),
    createBindGroup: () => ({}),
    createCommandEncoder: () => object('encoder', { beginRenderPass: () => { calls.push('beginRenderPass'); return object('pass'); }, finish: () => ({}) }),
    destroy: () => {},
  } as unknown as GpuDevice;
  return { device, calls };
}

const count = (calls: string[], name: string): number => calls.filter((c) => c === name).length;

/** Mesh draws a plan issues: shadow casters and terrain per tile, then per view opaque + transparent + outlines. */
function meshDraws(p: FramePlan): number {
  const shadow = p.shadowTiles.reduce((n, t) => n + t.casters.length + (t.terrain?.tiles.length ?? 0), 0);
  return shadow + p.views.reduce((n, v) => n + v.opaque.length + v.transparent.length + v.outlines.length, 0);
}

describe('backends execute a plan (recorded, no GPU)', () => {
  it('WebGL2: links each program once, one draw per planned item, builds the environment once', () => {
    const { gl, calls } = fakeGl();
    const backend = new WebGl2Backend(gl);
    const p = plan(frame());
    const texture = backend.createTexture({ width: 4, height: 4 }, BRICKS);
    backend.render(p, () => texture);
    expect(count(calls, 'drawElementsInstanced')).toBe(meshDraws(p));
    expect(count(calls, 'drawElements')).toBe(1);
    expect(count(calls, 'drawArraysInstanced')).toBe(2 * 3);
    const programs = count(calls, 'linkProgram');
    const first = count(calls, 'drawArrays');
    calls.length = 0;
    backend.render(p, () => texture);
    expect(count(calls, 'linkProgram')).toBe(0);
    const mips = environmentMips(QUALITY_LADDER.high.environmentSize);
    expect(first - count(calls, 'drawArrays')).toBe(6 + 6 * mips);
    expect(programs).toBeGreaterThan(15);
  });

  it('WebGL2: refuses a device whose uniform alignment doesn\'t divide 256', () => {
    const { gl } = fakeGl();
    const odd = new Proxy(gl, { get: (t, p: string) => (p === 'getParameter' ? () => 384 : (t as unknown as Record<string, unknown>)[p]) });
    expect(code(() => new WebGl2Backend(odd))).toBe('PP9805');
  });

  it('WebGL2: refuses a device that cannot render floating-point targets', () => {
    const { gl } = fakeGl();
    const none = new Proxy(gl, { get: (t, p: string) => (p === 'getExtension' ? () => null : (t as unknown as Record<string, unknown>)[p]) });
    expect(code(() => new WebGl2Backend(none))).toBe('PP9810');
  });

  it('WebGPU: the same draws as WebGL2, one render pass per target change', () => {
    const { device, calls } = fakeGpu();
    const context = { configure: () => {}, getCurrentTexture: () => ({ createView: () => ({}), width: 800, height: 400, destroy: () => {} }) };
    const backend = new WebGpuBackend(device, context, 'bgra8unorm');
    const texture = backend.createTexture({ width: 4, height: 4 }, BRICKS);
    const p = plan(frame());
    backend.render(p, () => texture);
    calls.length = 0;
    backend.render(p, () => texture);
    expect(count(calls, 'pass.drawIndexed')).toBe(meshDraws(p) + 1);
    // 2 atlases; per view scene, ao + blur, reflections, resolve, transparent, volumetric, god rays, outlines, final, overlay;
    // bloom prefilter + 2 down + 2 up (BLOOM_LEVELS 3); present.
    expect(count(calls, 'beginRenderPass')).toBe(2 + 2 * 11 + 5 + 1);
    expect(count(calls, 'queue.submit')).toBe(1);
  });

  it('WebGPU: an empty frame still presents', () => {
    const { device, calls } = fakeGpu();
    const context = { configure: () => {}, getCurrentTexture: () => ({ createView: () => ({}), width: 1, height: 1, destroy: () => {} }) };
    const backend = new WebGpuBackend(device, context, 'bgra8unorm');
    backend.render(plan(frame({ views: [], sunShadow: null, localShadows: [] })), () => { throw new Error('no textures'); });
    calls.length = 0;
    backend.render(plan(frame({ views: [], sunShadow: null, localShadows: [] })), () => { throw new Error('no textures'); });
    expect(count(calls, 'beginRenderPass')).toBe(1);
  });
});
