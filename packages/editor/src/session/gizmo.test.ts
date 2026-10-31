import { describe, expect, it } from 'vitest';
import { Quat, Vec3 } from '@parallax/runtime/core';
import { axisAngle, GizmoDrag, gizmoHandles, hitHandle } from './gizmo.js';
import type { Pose } from './gizmo.js';
import { lookAt } from './test_fixtures.js';
import { view2d } from './view_math.js';
import type { ScreenView } from './view_math.js';

const POSE: Pose = { position: new Vec3(0, 0, 0), rotation: Quat.IDENTITY, scale: Vec3.ONE };
// Views hold float32 matrices: rays are good to about 1e-5.
const near = (a: Vec3, b: Vec3, digits = 3): void => {
  expect(a.x).toBeCloseTo(b.x, digits); expect(a.y).toBeCloseTo(b.y, digits); expect(a.z).toBeCloseTo(b.z, digits);
};

function rayAt(view: ScreenView, world: Vec3): ReturnType<ScreenView['ray']> {
  const p = view.project(world)!;
  return view.ray(p.x, p.y);
}

describe('view math', () => {
  it('projects and unprojects consistently, and sizes pixels by depth', () => {
    const view = lookAt(new Vec3(0, 5, -10), Vec3.ZERO);
    const p = view.project(Vec3.ZERO)!;
    expect(p.x).toBeCloseTo(400, 6);
    expect(p.y).toBeCloseTo(300, 6);
    const ray = view.ray(p.x, p.y);
    near(ray.direction, new Vec3(0, -5, 10).normalized());
    expect(view.project(new Vec3(0, 5, -20))).toBeNull();
    expect(view.pixelSize(new Vec3(0, 5, 10))).toBeGreaterThan(view.pixelSize(Vec3.ZERO));
  });

  it('2D: world ↔ screen through the camera center, half-height and roll', () => {
    const view = view2d({ center: [10, 0], halfHeight: 5, angle: 90, background: null, viewport: [0, 0, 1, 1] }, { width: 800, height: 600 });
    const p = view.project(new Vec3(10, 1, 0));
    // Rolled 90°: world +y is screen right.
    expect(p!.x).toBeCloseTo(400 + 60, 6);
    expect(p!.y).toBeCloseTo(300, 6);
    const back = view.ray(p!.x, p!.y);
    expect(back.origin.x).toBeCloseTo(10, 6);
    expect(back.origin.y).toBeCloseTo(1, 6);
  });
});

describe('GizmoDrag', () => {
  const view = lookAt(new Vec3(4, 6, -8), Vec3.ZERO);

  it('translates along an axis: the closest point to the pointer ray, snapped', () => {
    const drag = new GizmoDrag({ mode: 'translate', handle: 'x', space: 'world', pose: POSE, ray: rayAt(view, Vec3.ZERO), view });
    near(drag.update(rayAt(view, new Vec3(1.3, 0, 0))).position, new Vec3(1.3, 0, 0));
    near(drag.update(rayAt(view, new Vec3(1.3, 0, 0)), { translate: 0.5 }).position, new Vec3(1.5, 0, 0));
    // Off the axis: the entity stays on it.
    const off = drag.update(rayAt(view, new Vec3(2, 0, 3))).position;
    expect(off.y).toBe(0);
    expect(off.z).toBe(0);
  });

  it('translates in local space along the entity\'s own axes', () => {
    const pose = { ...POSE, rotation: axisAngle(Vec3.UP, 90) };
    const local = pose.rotation.rotate(Vec3.RIGHT);
    const drag = new GizmoDrag({ mode: 'translate', handle: 'x', space: 'local', pose, ray: rayAt(view, Vec3.ZERO), view });
    const moved = drag.update(rayAt(view, local.__mul__(2))).position;
    near(moved, local.__mul__(2));
  });

  it('translates in a plane and in the view plane', () => {
    const drag = new GizmoDrag({ mode: 'translate', handle: 'xz', space: 'world', pose: POSE, ray: rayAt(view, Vec3.ZERO), view });
    near(drag.update(rayAt(view, new Vec3(1, 0, 2))).position, new Vec3(1, 0, 2));
    const screen = new GizmoDrag({ mode: 'translate', handle: 'screen', space: 'world', pose: POSE, ray: rayAt(view, Vec3.ZERO), view });
    const target = view.right.__mul__(1.5).__add__(view.up.__mul__(-0.5));
    near(screen.update(rayAt(view, target)).position, target);
  });

  it('rotates about an axis by the angle swept around the center, snapped, past 180°', () => {
    const drag = new GizmoDrag({ mode: 'rotate', handle: 'y', space: 'world', pose: POSE, ray: rayAt(view, new Vec3(1, 0, 0)), view });
    const steps = [new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1)];
    let pose = POSE;
    for (const s of steps) pose = drag.update(rayAt(view, s), { rotate: 5 });
    // +x → +z → -x → -z about +y is -270° (left-handed: +x turns to +z for a negative yaw).
    expect(Math.abs(drag.degrees)).toBeCloseTo(270, 1);
    near(pose.rotation.rotate(Vec3.RIGHT), new Vec3(0, 0, -1));
  });

  it('scales along a local axis by the distance ratio, and uniformly in the view plane', () => {
    const start = { ...POSE, scale: new Vec3(2, 1, 1) };
    const drag = new GizmoDrag({ mode: 'scale', handle: 'x', space: 'world', pose: start, ray: rayAt(view, new Vec3(1, 0, 0)), view });
    near(drag.update(rayAt(view, new Vec3(1.5, 0, 0))).scale, new Vec3(3, 1, 1));
    near(drag.update(rayAt(view, new Vec3(1.6, 0, 0)), { scale: 0.5 }).scale, new Vec3(3, 1, 1));
    const p = view.right.__mul__(1);
    const uniform = new GizmoDrag({ mode: 'scale', handle: 'uniform', space: 'local', pose: POSE, ray: rayAt(view, p), view });
    near(uniform.update(rayAt(view, p.__mul__(2))).scale, new Vec3(2, 2, 2));
  });

  it('refuses a handle the mode has (PP9620) and keeps the last pose when the ray runs parallel', () => {
    expect(() => new GizmoDrag({ mode: 'rotate', handle: 'xy', space: 'world', pose: POSE, ray: rayAt(view, Vec3.ZERO), view })).toThrow(/PP9620/);
    const drag = new GizmoDrag({ mode: 'translate', handle: 'x', space: 'world', pose: POSE, ray: rayAt(view, Vec3.ZERO), view });
    const moved = drag.update(rayAt(view, new Vec3(1, 0, 0)));
    expect(drag.update({ origin: new Vec3(0, 0, 0), direction: Vec3.RIGHT })).toBe(moved);
  });
});

describe('gizmo handles on screen', () => {
  const view = lookAt(new Vec3(4, 6, -8), Vec3.ZERO);

  it('lays the arms out at a constant pixel length and hit-tests them', () => {
    const layout = gizmoHandles(view, POSE, 'translate', 'world', 100);
    const x = layout.shapes.find((s) => s.handle === 'x')!;
    const [ax, ay, bx, by] = x.points as [number, number, number, number];
    const center = view.project(Vec3.ZERO)!;
    expect(Math.hypot(bx - ax, by - ay)).toBeGreaterThan(50);
    expect(Math.hypot(bx - ax, by - ay)).toBeLessThanOrEqual(101);
    expect(ax).toBeCloseTo(center.x, 6);
    expect(hitHandle(layout, (ax + bx * 3) / 4, (ay + by * 3) / 4)).toBe('x');
    const plane = layout.shapes.find((s) => s.handle === 'xz')!;
    const cx = (plane.points[0]! + plane.points[4]!) / 2;
    const cy = (plane.points[1]! + plane.points[5]!) / 2;
    expect(hitHandle(layout, cx, cy)).toBe('xz');
    expect(hitHandle(layout, 5, 5)).toBeNull();
    // At twice the distance, the same pixel size means twice the meters.
    const far = gizmoHandles(view, { ...POSE, position: new Vec3(-4, -6, 8) }, 'translate', 'world', 100);
    expect(far.length / layout.length).toBeCloseTo(2, 1);
  });

  it('2D gizmos have only the plane handles', () => {
    const flat = view2d({ center: [0, 0], halfHeight: 5, angle: 0, background: null, viewport: [0, 0, 1, 1] }, { width: 800, height: 600 });
    expect(gizmoHandles(flat, POSE, 'translate', 'world').shapes.map((s) => s.handle)).toEqual(['x', 'y', 'xy']);
    expect(gizmoHandles(flat, POSE, 'rotate', 'world').shapes.map((s) => s.handle)).toEqual(['z']);
    const drag = new GizmoDrag({ mode: 'rotate', handle: 'z', space: 'world', pose: POSE, ray: flat.ray(...pixel(flat, new Vec3(1, 0, 0))), view: flat });
    const turned = drag.update(flat.ray(...pixel(flat, new Vec3(0, 1, 0))));
    expect(turned.rotation.angle()).toBeCloseTo(90, 4);
  });
});

function pixel(view: ScreenView, world: Vec3): [number, number] {
  const p = view.project(world)!;
  return [p.x, p.y];
}
