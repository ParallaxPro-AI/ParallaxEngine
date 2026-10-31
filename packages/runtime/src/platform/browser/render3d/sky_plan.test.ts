/**
 * Planning the outdoors (sky_plan.ts) and generating its shaders: uniform packing per view
 * and per cube face, the water block, the camera-underwater test against the waves, the
 * environment key, and both languages' programs (the GLSL translated from the WGSL).
 */

import { describe, expect, it } from 'vitest';
import { EARTH_ATMOSPHERE, PLAIN_POST, WAVE_FLOATS } from '../../../core/index.js';
import type { Frame3d, Nature3d, Quality3d, Sky3d, View3d, WaterBody3d } from '../../../core/index.js';
import { QUALITY_LADDER } from '../../../function/plugins/render3d/index.js';
import { offsetOf } from './layout.js';
import { BODY_VEC4S, faceSlot, natureFades, NATURE_FIELDS, NATURE_SLOT, planNature, skyFogAmount, viewFadeOf, WATER_FIELDS } from './sky_plan.js';
import { whiteBalance } from './plan.js';
import { glslSky, NATURE_COMMON, wgslSky } from './sky_shaders.js';
import { glslSurface, glslUnderwater, GLSL_WATER_COPY, OCEAN_HORIZON, wgslWater } from './water_shaders.js';
import { FAR } from '../../../function/plugins/visuals/index.js';

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const view = (y: number): View3d => ({
  camera: 1, viewport: { x: 0, y: 0, width: 320, height: 180 }, position: [0, y, 0], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1],
  view: identity, projection: identity, viewProjection: identity, inverseViewProjection: identity, near: 0.1, far: 1000, clear: null, colorVision: 'none',
});

function waves(): Float32Array {
  const w = new Float32Array(WAVE_FLOATS);
  w.set([0, 1, 0.5, Math.sqrt(9.81 * 0.5), 0.4, 0.5, 0, 0]);
  return w;
}

const OCEAN: WaterBody3d = {
  kind: 'ocean', entity: 3, level: 0, center: [0, 0, 0], halfSize: [0, 0], yaw: 0, shape: 'rect', depth: 50, firstWave: 0, waveCount: 1,
  deep: [0.02, 0.1, 0.2], shallow: [0.1, 0.4, 0.4], clarity: 8, foam: 0.5, roughness: 0.04, caustics: 0.6, ripple: 1, calmDistance: 0, ribbon: null,
};

function frame(nature: Nature3d, level: Quality3d['level'] = 'high', y = 2): Frame3d {
  return {
    frame: 1, views: [view(y)], quality: (QUALITY_LADDER as Readonly<Record<string, Quality3d>>)[level]!,
    environment: {
      sky: { zenith: [0.2, 0.4, 0.8], horizon: [0.7, 0.8, 0.9] }, ambient: [0.4, 0.4, 0.45],
      fog: { kind: 'exponential', color: [0.7, 0.8, 0.9], density: 0.002, near: 0, far: 0, volumetric: 0 },
      sun: { direction: [0, -1, 0], color: [1, 1, 1], intensity: 1, shadows: true }, post: PLAIN_POST,
    },
    sunShadow: null, localShadows: [], terrain: null, meshes: [], skinned: [], lights: [], billboards: [], texts: [], lines: [], outlines: [], nature,
  } as unknown as Frame3d;
}

const SKY: Sky3d = {
  model: 'atmosphere', zenith: [0.2, 0.4, 0.8], horizon: [0.7, 0.8, 0.9], toSun: [0, 0.8, 0.6],
  sunColor: [1, 0.95, 0.9], sunIntensity: 1, atmosphere: EARTH_ATMOSPHERE,
  clouds: { coverage: 0.5, density: 0.6, base: 1500, thickness: 800, offset: [100, 0], scale: 2500, darkness: 0 },
  stars: 0, flash: 0, time: 3,
};

describe('planNature', () => {
  it('is null without nature, and packs one slot per view plus six cube faces', () => {
    expect(planNature(frame(null as unknown as Nature3d), [view(2)], 320, 180)).toBeNull();
    const plan = planNature(frame({ sky: SKY, water: null, weather: null }), [view(2)], 320, 180)!;
    expect(plan.uniforms.length).toBe(7 * NATURE_SLOT);
    const at = (slot: number, name: string): number => slot * NATURE_SLOT + offsetOf(NATURE_FIELDS, name);
    expect(plan.uniforms[at(0, 'zenith') + 3]).toBe(1);
    expect(plan.uniforms[at(0, 'cloudsA')]).toBe(0.5);
    expect(plan.uniforms[at(0, 'mieParams') + 2]).toBe(EARTH_ATMOSPHERE.planetRadius);
    expect(plan.uniforms[at(faceSlot(plan, 3), 'cubeFace')]).toBe(3);
    expect(plan.uniforms[at(faceSlot(plan, 3), 'cubeFace') + 2]).toBe(1);
    expect(plan.uniforms[at(0, 'ambientLight') + 3]).toBe(2);
  });

  it('keys the environment cube on the sun and the clouds, quantized', () => {
    const key = (sky: Sky3d): string => planNature(frame({ sky, water: null, weather: null }), [view(2)], 320, 180)!.environmentKey;
    expect(key(SKY)).toBe(key({ ...SKY, toSun: [0, 0.801, 0.6] }));
    expect(key(SKY)).not.toBe(key({ ...SKY, toSun: [0, 0.7, 0.71] }));
    expect(key(SKY)).not.toBe(key({ ...SKY, clouds: { ...SKY.clouds!, offset: [600, 0] } }));
  });

  it('packs the water block and knows when the camera is under the waves', () => {
    const water = { time: 0, waves: waves(), bodies: [OCEAN], ripples: new Float32Array([1, 2, 3, 0.5]), rippleCount: 1 };
    const at = (plan: NonNullable<ReturnType<typeof planNature>>, name: string): number => plan.uniforms[offsetOf(NATURE_FIELDS, name)]!;
    const above = planNature(frame({ sky: SKY, water, weather: null }, 'high', 2), [view(2)], 320, 180)!;
    expect(above.bodies).toHaveLength(1);
    expect(above.waterBlock[offsetOf(WATER_FIELDS, 'bodies') + 7]).toBe(50);
    expect(above.waterBlock[offsetOf(WATER_FIELDS, 'bodies') + BODY_VEC4S * 0 + 11]).toBe(1);
    expect(above.waterBlock[offsetOf(WATER_FIELDS, 'ripples') + 2]).toBe(3);
    expect(at(above, 'waterAt')).toBe(-1);
    // At x = z = 0, t = 0 the wave (phase 0) is at its rest height; 1 m down is under it.
    const below = planNature(frame({ sky: SKY, water, weather: null }, 'high', -1), [view(-1)], 320, 180)!;
    expect(at(below, 'waterAt')).toBe(0);
    expect(below.uniforms[offsetOf(NATURE_FIELDS, 'waterAt') + 1]).toBeGreaterThan(-0.45);
    const tooDeep = planNature(frame({ sky: SKY, water, weather: null }, 'high', -60), [view(-60)], 320, 180)!;
    expect(at(tooDeep, 'waterAt')).toBe(-1);
  });
});

describe('outdoor shaders', () => {
  it('generate WGSL with every entry point, and GLSL with no WGSL left in it', () => {
    const sky = wgslSky(1, 'flat');
    for (const entry of ['fn vs', 'fn composite_fs', 'fn face_fs']) expect(sky).toContain(entry);
    const water = wgslWater();
    for (const entry of ['fn under_fs', 'fn grid_vs', 'fn ribbon_vs', 'fn surface_fs']) expect(water).toContain(entry);
    const glsl = [glslSky(0, false, 'flat').fragment, glslSky(2, true, 'volumetric').fragment, glslSky(1, false, 'volumetric').fragment, glslUnderwater().fragment, glslSurface(false).vertex,
      glslSurface(true).fragment, GLSL_WATER_COPY.fragment];
    for (const source of glsl) {
      expect(source.startsWith('#version 300 es')).toBe(true);
      expect(source).not.toMatch(/\bnat\.|\bwat\.|\bvec[234]<|\bf32\b|\blet\b|\bfn\b/);
    }
    // GLSL needs every function before its first use: the shared code is ordered so.
    const defined: string[] = [];
    for (const match of NATURE_COMMON.matchAll(/fn (\w+)\(|(\w+)\(/g)) {
      if (match[1] !== undefined) defined.push(match[1]);
      else if (/^[a-z]/.test(match[2]!) && NATURE_COMMON.includes(`fn ${match[2]}(`)) expect(defined).toContain(match[2]);
    }
  });
});

describe('cloud mode', () => {
  const plan = (level: Quality3d['level']): NonNullable<ReturnType<typeof planNature>> =>
    planNature(frame({ sky: SKY, water: null, weather: null }, level), [view(2)], 320, 180)!;

  it('follows the quality ladder: flat below high, volumetric at high', () => {
    expect(QUALITY_LADDER.low.volumetricClouds).toBe(false);
    expect(QUALITY_LADDER.medium.volumetricClouds).toBe(false);
    expect(QUALITY_LADDER.high.volumetricClouds).toBe(true);
    expect(plan('low').clouds).toBe('flat');
    expect(plan('medium').clouds).toBe('flat');
    expect(plan('high').clouds).toBe('volumetric');
  });

  it('rebuilds the environment cube when the mode changes', () => {
    const medium = plan('medium').environmentKey;
    expect(medium).toContain(':flat:');
    expect(plan('high').environmentKey).toContain(':volumetric:');
    expect(medium).not.toBe(plan('high').environmentKey);
  });

  // The sky (fullSky) and the environment cube's faces call the mode's cloud function, never the other's.
  const calls = (source: string, fn: string): number => source.match(new RegExp(`\\b${fn}\\(`, 'g'))?.length ?? 0;

  it.each([0, 1, 2])('quality %i: both languages draw the same clouds in each mode', (q) => {
    for (const [mode, used, unused] of [['flat', 'flatClouds', 'cloudsAlong'], ['volumetric', 'cloudsAlong', 'flatClouds']] as const) {
      const sources = [wgslSky(q, mode), glslSky(q, false, mode).fragment, glslSky(q, true, mode).fragment];
      for (const source of sources) {
        expect(source).not.toContain('CLOUDS_TOWARD');
        // One definition plus the sky's and the cube face's calls (the face program includes both bodies).
        expect(calls(source, used)).toBe(3);
        expect(calls(source, unused)).toBe(1);
      }
    }
  });

  it('flat clouds read the scene\'s clouds: coverage, density, height, drift, scale, darkness, and the sun', () => {
    const body = NATURE_COMMON.slice(NATURE_COMMON.indexOf('fn flatClouds('), NATURE_COMMON.indexOf('fn starsToward('));
    // cloudCover reads coverage (cloudsA.x) and the drift and scale (cloudsB.xy, cloudsB.z).
    for (const field of ['nat.cloudsA.x', 'nat.cloudsA.y', 'nat.cloudsA.z', 'nat.cloudsA.w', 'nat.cloudsB.z', 'nat.cloudsB.w', 'nat.toSun', 'nat.sunColor', 'cloudCover(']) {
      expect(body).toContain(field);
    }
    // One 2D layer: no march, no 3D density.
    expect(body).not.toMatch(/\bfor \(|cloudDensity\(/);
  });
});

describe('sky fog and white balance', () => {
  const fog = { color: [0.5, 0.5, 0.5] as const, near: 0, far: 0, density: 0, volumetric: 0 };
  it('fogs the horizon as much as the far plane is fogged', () => {
    expect(skyFogAmount({ ...fog, kind: 'none' }, 1000)).toBe(0);
    expect(skyFogAmount({ ...fog, kind: 'exponential', density: 0.01 }, 100)).toBeCloseTo(1 - Math.exp(-1));
    expect(skyFogAmount({ ...fog, kind: 'linear', near: 20, far: 80 }, 50)).toBeCloseTo(0.5);
    expect(skyFogAmount({ ...fog, kind: 'linear', near: 20, far: 80 }, 500)).toBe(1);
  });

  it('warms and cools white while keeping its luminance', () => {
    expect(whiteBalance(0)).toEqual([1, 1, 1]);
    const lum = (c: readonly number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    const warm = whiteBalance(0.5);
    const cool = whiteBalance(-0.5);
    expect(lum(warm)).toBeCloseTo(1);
    expect(lum(cool)).toBeCloseTo(1);
    expect(warm[0]).toBeGreaterThan(warm[2]);
    expect(cool[2]).toBeGreaterThan(cool[0]);
  });
});

describe('the far fade: the world ends in its own sky', () => {
  const at = (plan: NonNullable<ReturnType<typeof planNature>>, slot: number, name: string, k = 0): number =>
    plan.uniforms[slot * NATURE_SLOT + offsetOf(NATURE_FIELDS, name) + k]!;

  it('fades every view just short of its far plane, in the outdoor passes when they draw the sky', () => {
    expect(viewFadeOf({ far: 1000 })).toEqual({ start: 550, end: 970 });
    const f = frame({ sky: SKY, water: { time: 0, waves: waves(), bodies: [OCEAN], ripples: new Float32Array(0), rippleCount: 0 }, weather: null } as unknown as Nature3d);
    const plan = planNature(f, [view(2)], 320, 180)!;
    expect(at(plan, 0, 'viewFade', 0)).toBe(550);
    expect(at(plan, 0, 'viewFade', 1)).toBe(970);
    expect(natureFades(f, view(2))).toBe(true);
    // The cube's faces never fade.
    expect(at(plan, faceSlot(plan, 0), 'viewFade', 1)).toBe(0);
    // A camera background is drawn by the scene's sky pass, whose surfaces fade toward it there.
    const clear: View3d = { ...view(2), clear: [0, 0, 0, 1] };
    expect(natureFades(f, clear)).toBe(false);
    expect(at(planNature(f, [clear], 320, 180)!, 0, 'viewFade', 1)).toBe(0);
  });

  it('has a fade entry in both languages, over the composite sky', () => {
    expect(wgslSky(1, 'flat')).toContain('@fragment fn fade_fs');
    const glsl = glslSky(1, 'fade', 'flat').fragment;
    expect(glsl).toContain('fragColor = farFade(');
    expect(glsl).not.toMatch(/\bnat\.|\bwat\.|\bvec[234]<|\bf32\b|\blet\b|\bfn\b/);
    const body = wgslSky(2, 'volumetric');
    const fade = body.slice(body.indexOf('fn farFade('), body.indexOf('fn environmentFace('));
    expect(fade).toContain('fogOverSky(dir, fullSky(eye, dir))');
  });

  it('carries an ocean past every far plane, and fogs the water as the ground (height fog)', () => {
    const water = wgslWater();
    expect(water).toContain(`sign(g) * ${OCEAN_HORIZON.toFixed(1)}`);
    expect(OCEAN_HORIZON).toBeGreaterThan(FAR * 2);
    const fog = water.slice(water.indexOf('fn applyFog('), water.indexOf('fn underwater('));
    expect(fog).toContain('nat.fogHeight.x');
  });
});
