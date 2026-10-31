/**
 * The Performance tab's copyable report, from a real `FrameStats` snapshot (the panel's DOM
 * needs a browser; the report is pure).
 */

import { describe, expect, it } from 'vitest';
import { FrameStats } from '@parallax/runtime/boot';
import type { Kernel } from '@parallax/runtime/kernel';
import { FRAME_PHASES } from '@parallax/runtime/kernel';
import { Quat, Vec3 } from '@parallax/runtime/core';
import { aim, formatCamera, formatReport } from './performance_panel.js';
import type { CameraReport } from './performance_panel.js';

function snapshot(): ReturnType<FrameStats['snapshot']> {
  let clock = 0;
  const kernel = { setProbe: () => {}, world: { *live() { yield { alive: true, behaviors: [{}] }; } } } as unknown as Kernel;
  const stats = new FrameStats({ now: () => clock, heap: () => null });
  stats.connect({
    kernel: () => kernel,
    render: () => ({
      backend: 'webgl2', drawCalls: 9, triangles: 1234, drawCallsByPass: { geometry: 7, shadow: 2 }, trianglesByPass: { geometry: 1000, shadow: 234 },
      instances: 20, renderScale: 1, renderWidth: 800, renderHeight: 600, cpuMs: 0.8,
    }),
  });
  stats.enable();
  stats.tick();
  for (let i = 0; i < 10; i++) {
    clock += 40;
    stats.tick();
    const phases = Object.fromEntries(FRAME_PHASES.map((p) => [p, p === 'update' ? 30 : 0])) as Record<(typeof FRAME_PHASES)[number], number>;
    stats.frame({ frame: i, totalMs: 30, phases, fixedSteps: 1, logic: true, units: [{ kind: 'behavior', id: 'spinner', ms: 30, calls: 4 }], hooks: [] });
  }
  return stats.snapshot();
}

describe('formatReport', () => {
  it('leads with the verdict and covers frame, budget, phases, scripts and renderer', () => {
    const text = formatReport(snapshot(), 'playing');
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^Parallax performance — .* — playing$/);
    expect(text).toContain('webgl2 · drawing 800x600 (render scale 100%)');
    expect(text).toContain('25 fps · 40.00 ms frame vs 16.67 ms target — WELL BELOW TARGET');
    expect(text).toContain('Bound by ENGINE CPU — 30.00 ms of the 40.00 ms frame');
    expect(text).toMatch(/Scripts\s+30\.000 ms\s+100\.0%/);
    expect(text).toMatch(/spinner\s+behavior\s+30\.000/);
    expect(text).toContain('9 draws · 1,234 tris');
    expect(text).toMatch(/geometry\s+7 draws\s+1,000 tris/);
    expect(text.indexOf('VERDICT')).toBeLessThan(text.indexOf('── FRAME'));
  });

  it('says so when nothing was measured', () => {
    const stats = new FrameStats({ now: () => 0, heap: () => null });
    expect(formatReport(stats.snapshot(), 'edit')).toContain('No frames measured yet.');
  });
});

describe('formatCamera', () => {
  const report = (over: Partial<CameraReport> = {}): CameraReport => ({
    mode: 'edit', location: 'http://localhost/edit', scene: 'level_1', dimension: '3d',
    editor: { label: 'editor', position: new Vec3(1, 2, 3), rotation: Quat.from_euler(new Vec3(-20, 90, 0)), fov: 60 },
    rendering: 'editor',
    cameras: [{ label: 'main_camera', position: new Vec3(0, 5, -10), rotation: Quat.IDENTITY, mode: 'perspective', fov: 55, near: 0.1, far: 500, active: true }],
    ...over,
  });

  it('names what renders, then the editor camera and each game camera with pose and lens', () => {
    const text = formatCamera(report());
    expect(text.split('\n')[0]).toBe('Parallax camera — http://localhost/edit — scene level_1 — edit mode');
    expect(text).toContain('rendering through: the editor camera');
    expect(text).toContain('EDITOR CAMERA — rendering');
    expect(text).toMatch(/position\s+\(1\.00, 2\.00, 3\.00\)/);
    expect(text).toMatch(/yaw 90\.0°, pitch 20\.0°/);
    expect(text).toContain('main_camera (active)');
    expect(text).toMatch(/lens\s+fov 55\.0°, near 0\.1, far 500/);
    expect(text).toContain('editor pose as a placement: {"at":[1,2,3],"rotation":[-20,90,0]}');
  });

  it('marks the game camera that renders while playing, and says when the scene has none', () => {
    expect(formatCamera(report({ mode: 'playing', rendering: 'main_camera', editor: null }))).toContain('main_camera (active) — rendering');
    expect(formatCamera(report({ cameras: [] }))).toContain('game cameras: none in the scene');
  });

  it('reads the yaw from +z toward +x', () => {
    expect(aim(Quat.IDENTITY).yaw).toBeCloseTo(0);
    expect(aim(Quat.from_euler(new Vec3(0, 90, 0))).yaw).toBeCloseTo(90);
  });
});
