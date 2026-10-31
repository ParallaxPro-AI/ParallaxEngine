/**
 * Depth of field (dof.ts): which views get the pass and what it packs, where `visitPasses`
 * runs it, and its shaders — the WGSL validated by naga when it is installed (as
 * wgsl_check.test.ts does for the rest), the GLSL checked for the same uniforms and taps.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Quality3d, View3d } from '../../../core/index.js';
import { DOF_FLOATS, DOF_MAX_RADIUS, DOF_SAMPLES, glslDof, GLSL_DOF_COPY, planDepthOfField, WGSL_DOF_COPY, wgslDof } from './dof.js';
import { visitPasses } from './plan.js';
import type { FramePlan, PassVisitor, ViewPlan } from './plan.js';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function view(extra: Partial<View3d> = {}): View3d {
  return {
    camera: 1, viewport: { x: 0, y: 0, width: 1920, height: 1080 }, position: [1, 2, 3], right: [1, 0, 0], up: [0, 1, 0], forward: [0, 0, 1],
    view: IDENTITY, projection: IDENTITY, viewProjection: IDENTITY, inverseViewProjection: IDENTITY, near: 0.1, far: 500, clear: null,
    colorVision: 'none', depthOfField: { focusDistance: 8, focusRange: 3, maxBlur: 6 }, ...extra,
  };
}

const quality = (level: Quality3d['level']): Quality3d => ({ level } as Quality3d);

describe('planDepthOfField', () => {
  it('packs the camera, the focus and the blur scaled to the view height', () => {
    const plan = planDepthOfField(view({ viewport: { x: 10, y: 20, width: 960, height: 540 } }), quality('medium'), false, 1920, 1080)!;
    expect(plan.samples).toBe(DOF_SAMPLES.medium);
    expect(plan.uniforms.length).toBe(DOF_FLOATS);
    expect([...plan.uniforms.slice(16, 36)]).toEqual([1, 2, 3, 8, 0, 0, 1, 3, 10, 20, 960, 540, 1920, 1080, 1 / 1920, 1 / 1080, 3, 0, 0, 0].map((n) => Math.fround(n)));
  });

  it('nothing to blur: no DepthOfField, a tiny blur, a mirror, wireframe; huge blurs are capped', () => {
    expect(planDepthOfField(view({ depthOfField: null }), quality('high'), false, 1920, 1080)).toBeNull();
    expect(planDepthOfField(view({ depthOfField: { focusDistance: 1, focusRange: 1, maxBlur: 0.2 } }), quality('high'), false, 1920, 1080)).toBeNull();
    expect(planDepthOfField(view({ mirrored: true }), quality('high'), false, 1920, 1080)).toBeNull();
    expect(planDepthOfField(view(), quality('high'), true, 1920, 1080)).toBeNull();
    expect(planDepthOfField(view({ depthOfField: { focusDistance: 1, focusRange: 1, maxBlur: 64 } }), quality('low'), false, 3840, 2160)!.uniforms[32])
      .toBe(DOF_MAX_RADIUS);
  });
});

describe('the pass order', () => {
  it('runs after the screen light and before outlines, bloom and the final pass, only for views with it', () => {
    const order: string[] = [];
    const vp = (slot: number, dof: boolean): ViewPlan => ({
      viewport: { x: 0, y: 0, width: 10, height: 10 }, frameSlot: slot, target: null, fog: null, terrain: null, camera: slot,
      opaque: [], transparent: [], viewmodel: [], viewmodelTransparent: [], overlaySlot: null, mirrored: false, billboards: [],
      lines: { first: 0, count: 0 }, overlayBillboards: [], overlayLines: { first: 0, count: 0 }, outlines: [],
      depthOfField: dof ? planDepthOfField(view(), quality('low'), false, 10, 10) : null,
    } as unknown as ViewPlan);
    const views = [vp(0, true), vp(1, false)];
    const plan = {
      flags: { ao: 'off', reflections: false, resolve: false, volumetric: false, godRays: true, outlines: true, bloomLevels: 2 },
      environment: {}, shadowTiles: [], groups: [{ target: null, views }], nature: null, decals: null,
    } as unknown as FramePlan;
    const note = (name: string) => (v?: ViewPlan | number): void => { order.push(typeof v === 'object' ? `${v.frameSlot}:${name}` : name); };
    const visitor = new Proxy({}, { get: (_t, name: string) => note(name) }) as PassVisitor;
    visitPasses(plan, visitor);
    expect(order.filter((o) => /godRays|depthOfField|outlines|bloom|final/.test(o))).toEqual([
      '0:godRays', '0:depthOfField', '0:outlines', '1:godRays', '1:outlines', 'bloom', '0:final', '1:final',
    ]);
  });
});

const NAGA = [join(homedir(), '.cargo', 'bin', 'naga'), '/opt/homebrew/bin/naga', '/usr/local/bin/naga'].find((p) => existsSync(p));

describe('shaders', () => {
  it('both languages read the same uniforms and take the same taps', () => {
    for (const samples of Object.values(DOF_SAMPLES)) {
      expect(wgslDof(samples)).toContain(`const SAMPLES: i32 = ${samples};`);
      expect(glslDof(samples).fragment).toContain(`const int SAMPLES = ${samples};`);
    }
    for (const name of ['inverseViewProjection', 'eye', 'forward', 'viewport', 'targetSize', 'params']) {
      expect(wgslDof(12)).toContain(`${name}:`);
      expect(glslDof(12).fragment).toContain(` ${name};`);
    }
    expect(GLSL_DOF_COPY.fragment).toContain('texelFetch(source');
  });

  it.runIf(NAGA !== undefined)('naga validates the WGSL modules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dof-'));
    try {
      const failures: string[] = [];
      const modules: [string, string][] = [['copy', WGSL_DOF_COPY], ...Object.values(DOF_SAMPLES).map((n): [string, string] => [`blur ${n}`, wgslDof(n)])];
      for (const [name, source] of modules) {
        const file = join(dir, 'shader.wgsl');
        writeFileSync(file, source);
        try {
          execFileSync(NAGA!, [file], { stdio: 'pipe' });
        } catch (error) {
          failures.push(`${name}: ${String((error as { stderr?: unknown }).stderr ?? error).slice(0, 400)}`);
        }
      }
      expect(failures).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
