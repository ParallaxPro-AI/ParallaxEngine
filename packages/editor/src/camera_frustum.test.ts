/**
 * The camera gizmo's geometry: the frustum's shape from a resolved camera view, clipping
 * against the editor view, and click hit-testing.
 */

import { describe, expect, it } from 'vitest';
import { Quat, Vec3 } from '@parallax/runtime/core';
import { frustumSegments, nearestSegment, screenSegments, segmentDistance } from './camera_frustum.js';
import type { FrustumCamera } from './camera_frustum.js';

const camera = (over: Partial<FrustumCamera> = {}): FrustumCamera => ({
  mode: 'perspective', position: new Vec3(0, 0, 0), rotation: Quat.IDENTITY, fov: 90, size: 5, near: 0.5, far: 1000, aspect: 2, ...over,
});

/** A toy view looking down +z from the origin: x/y projected 1:1, depth = z. */
const view = { position: new Vec3(0, 0, 0), forward: new Vec3(0, 0, 1), near: 0.1, far: 100, project: (p: Vec3) => ({ x: p.x, y: p.y, depth: p.z }) };

describe('frustumSegments', () => {
  it('draws near and far rectangles, their joins, the edges to the eye and an up marker', () => {
    const segs = frustumSegments(camera(), 2);
    // 4 near + 4 far + 4 joins + 4 to the eye + 3 for the up triangle.
    expect(segs).toHaveLength(19);
    const zs = new Set(segs.flatMap(([a, b]) => [a.z, b.z]).map((z) => +z.toFixed(4)));
    expect(zs.has(0.5)).toBe(true);
    expect(zs.has(2)).toBe(true);
    // fov 90: the far rectangle's half-height equals its distance; aspect 2 doubles the width.
    const far = segs.flatMap(([a, b]) => [a, b]).filter((p) => Math.abs(p.z - 2) < 1e-6);
    expect(Math.max(...far.map((p) => p.x))).toBeCloseTo(4);
    // The up marker rises above the far rectangle's top edge (y = 2).
    expect(Math.max(...far.map((p) => p.y))).toBeCloseTo(3);
  });

  it('caps the display length at the camera\'s far plane, and follows its rotation', () => {
    const short = frustumSegments(camera({ far: 1 }), 10);
    expect(Math.max(...short.flatMap(([a, b]) => [a.z, b.z]))).toBeCloseTo(1);
    // Turned 90° about y: the camera looks down +x.
    const turned = frustumSegments(camera({ rotation: Quat.from_euler(new Vec3(0, 90, 0)) }), 2);
    expect(Math.max(...turned.flatMap(([a, b]) => [a.x, b.x]))).toBeCloseTo(2);
  });

  it('draws an orthographic camera as a box (no edges to the eye)', () => {
    const segs = frustumSegments(camera({ mode: 'orthographic', size: 1, aspect: 1 }), 2);
    expect(segs).toHaveLength(15);
    for (const [a] of segs.slice(0, 12)) expect(Math.abs(a.x)).toBeCloseTo(1);
  });
});

describe('screenSegments', () => {
  it('projects segments in front of the view and clips those crossing behind it', () => {
    const out = screenSegments(view, [
      [new Vec3(0, 0, 5), new Vec3(10, 0, 5)],
      [new Vec3(0, 0, -5), new Vec3(0, 0, 5)],
      [new Vec3(0, 0, -5), new Vec3(0, 0, -1)],
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ x0: 0, y0: 0, x1: 10, y1: 0 });
    // The crossing segment starts at the near plane.
    expect(out[1]!.x0).toBeCloseTo(0);
  });
});

describe('hit testing', () => {
  it('measures distance to a segment and picks the nearest camera within the slop', () => {
    const s = { x0: 0, y0: 0, x1: 10, y1: 0 };
    expect(segmentDistance(5, 3, s)).toBeCloseTo(3);
    expect(segmentDistance(-4, 3, s)).toBeCloseTo(5);
    const drawn = [{ id: 1, segments: [s] }, { id: 2, segments: [{ x0: 0, y0: 4, x1: 10, y1: 4 }] }];
    expect(nearestSegment(drawn, 5, 3, 6)).toBe(2);
    expect(nearestSegment(drawn, 5, 1, 6)).toBe(1);
    expect(nearestSegment(drawn, 5, 40, 6)).toBeNull();
  });
});
