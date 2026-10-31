import { describe, expect, it } from 'vitest';
import { ParallaxError } from '../diagnostics.js';
import { kw } from '../kwargs.js';
import { wrapAngle } from './angles.js';
import { Color } from './color.js';
import { ease, EASE_KINDS } from './ease.js';
import { NotImplemented } from './not_implemented.js';
import { Quat } from './quat.js';
import { Vec2 } from './vec2.js';
import { Vec3 } from './vec3.js';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (error) {
    return error instanceof ParallaxError ? error.diagnostic.code : 'not a ParallaxError';
  }
  return undefined;
}

describe('Vec2', () => {
  it('implements the arithmetic compiled Python calls', () => {
    const a = new Vec2(1, 2);
    expect(a.__add__(new Vec2(3, 4)).__eq__(new Vec2(4, 6))).toBe(true);
    expect(a.__sub__(new Vec2(1, 1)).__eq__(new Vec2(0, 1))).toBe(true);
    expect(a.__mul__(2).__eq__(new Vec2(2, 4))).toBe(true);
    expect(a.__rmul__(2).__eq__(a.__mul__(2))).toBe(true);
    expect(a.__neg__().__eq__(new Vec2(-1, -2))).toBe(true);
    expect(a.__truediv__(2).__eq__(new Vec2(0.5, 1))).toBe(true);
  });

  it('rejects mutation and division by zero with coded errors', () => {
    const v = new Vec2(1, 2);
    expect(code(() => { v.x = 5; })).toBe('PP3020');
    expect(v.x).toBe(1);
    expect(code(() => v.__truediv__(0))).toBe('PP3021');
  });

  it('measures angles in degrees', () => {
    expect(Vec2.UP.angle()).toBeCloseTo(90);
    expect(Vec2.RIGHT.rotated(90).is_close(Vec2.UP)).toBe(true);
    expect(Vec2.from_angle(180, 2).is_close(new Vec2(-2, 0))).toBe(true);
  });

  it('keeps the zero vector zero when normalized', () => {
    expect(Vec2.ZERO.normalized().__eq__(Vec2.ZERO)).toBe(true);
    expect(new Vec2(3, 4).normalized().length()).toBeCloseTo(1);
  });

  it('hashes equal vectors equally, including 0 and -0', () => {
    expect(new Vec2(0, 1).__hash__()).toBe(new Vec2(-0, 1).__hash__());
    expect(new Vec2(1, 2).__hash__()).not.toBe(new Vec2(2, 1).__hash__());
  });

  it('maps a plane vector onto the 3D ground', () => {
    expect(new Vec2(1, 2).to_ground().__eq__(new Vec3(1, 0, 2))).toBe(true);
  });
});

describe('Vec3', () => {
  it('follows the right-handed, +y-up, +z-forward convention', () => {
    expect(Vec3.RIGHT.cross(Vec3.UP).__eq__(Vec3.FORWARD)).toBe(true);
    expect(Vec3.FORWARD.rotated_y(90).is_close(Vec3.RIGHT)).toBe(true);
    expect(Vec3.from_yaw_pitch(0).is_close(Vec3.FORWARD)).toBe(true);
    expect(Vec3.from_yaw_pitch(90).is_close(Vec3.RIGHT)).toBe(true);
    expect(Vec3.from_yaw_pitch(0, 90).is_close(Vec3.UP)).toBe(true);
  });

  it('is immutable', () => {
    expect(code(() => { new Vec3().z = 1; })).toBe('PP3020');
  });
});

describe('Color', () => {
  it('parses every hex form', () => {
    expect(Color.hex('#fff').__eq__(Color.WHITE)).toBe(true);
    expect(Color.hex('ff0000').__eq__(Color.RED)).toBe(true);
    expect(Color.hex('#00000000').__eq__(Color.CLEAR)).toBe(true);
    expect(code(() => Color.hex('#ggg'))).toBe('PP4101');
  });

  it('is immutable and points at with_alpha for alpha changes', () => {
    expect(code(() => { Color.WHITE.a = 0; })).toBe('PP3020');
    expect(Color.WHITE.with_alpha(0.5).a).toBe(0.5);
  });
});

describe('wrapAngle', () => {
  it('wraps into (-180, 180]', () => {
    expect(wrapAngle(190)).toBe(-170);
    expect(wrapAngle(-180)).toBe(180);
    expect(wrapAngle(720)).toBe(0);
  });
});

describe('Quat.look_rotation', () => {
  it('turns +z to forward with +y up, matches from_euler, and handles looking straight up', () => {
    const q = Quat.look_rotation(new Vec3(1, 0, 0));
    expect(q.rotate(Vec3.FORWARD).is_close(Vec3.RIGHT, 1e-9)).toBe(true);
    expect(q.is_close(Quat.from_euler(new Vec3(0, 90, 0)))).toBe(true);
    const down = Quat.look_rotation(new Vec3(0, 0, 5).__add__(new Vec3(0, -5, 0)));
    expect(down.rotate(Vec3.FORWARD).is_close(new Vec3(0, -1, 1).normalized(), 1e-9)).toBe(true);
    expect(down.rotate(Vec3.UP).y).toBeGreaterThan(0);
    const up = Quat.look_rotation(Vec3.UP);
    expect(up.rotate(Vec3.FORWARD).is_close(Vec3.UP, 1e-9)).toBe(true);
    const tilted = Quat.look_rotation(Vec3.FORWARD, kw({ up: Vec3.RIGHT }));
    expect(tilted.rotate(Vec3.UP).is_close(Vec3.RIGHT, 1e-9)).toBe(true);
    expect(() => Quat.look_rotation(Vec3.ZERO)).toThrow(/PP3021/);
    expect(() => Quat.look_rotation(Vec3.FORWARD, kw({ upp: Vec3.UP }))).toThrow(/PP3030[\s\S]*Did you mean "up"/);
    // Keyword arguments on other value methods bind like CPython's.
    const v = Vec3.from_yaw_pitch(90, kw({ length: 2 }));
    expect(v.is_close(new Vec3(2, 0, 0), kw({ tolerance: 1e-9 }))).toBe(true);
    expect(Vec2.from_angle(0, kw({ length: 3 })).x).toBeCloseTo(3);
    expect(new Vec3(1, 2.5, 3).__repr__()).toBe('Vec3(1, 2.5, 3)');
    expect(Quat.IDENTITY.__repr__()).toBe('Quat(0, 0, 0, 1)');
  });
});

describe('eases', () => {
  it('every curve runs 0 → 0 and 1 → 1', () => {
    for (const kind of EASE_KINDS) {
      expect([kind, ease(kind, 0)]).toEqual([kind, 0]);
      expect([kind, ease(kind, 1)]).toEqual([kind, 1]);
    }
  });

  it('back and elastic curves overshoot where they should; cubic matches t³', () => {
    expect(ease('in_cubic', 0.5)).toBe(0.125);
    expect(ease('out_cubic', 0.5)).toBe(0.875);
    expect(ease('in_out_cubic', 0.25)).toBe(0.0625);
    expect(ease('in_back', 0.2)).toBeLessThan(0);
    expect(ease('out_back', 0.8)).toBeGreaterThan(1);
    expect(ease('in_out_back', 0.1)).toBeLessThan(0);
    expect(ease('in_out_back', 0.9)).toBeGreaterThan(1);
    expect(ease('in_out_back', 0.5)).toBeCloseTo(0.5, 12);
    expect(ease('in_elastic', 0.9)).toBeLessThan(0);
    expect(ease('in_out_elastic', 0.5)).toBeCloseTo(0.5, 12);
    // out_back peaks about 10% past the end.
    const peak = Math.max(...Array.from({ length: 101 }, (_, i) => ease('out_back', i / 100)));
    expect(peak).toBeGreaterThan(1.09);
    expect(peak).toBeLessThan(1.11);
  });
});

describe('vector operators', () => {
  it('a Vec3 takes a Vec2 as (x, y, 0); other operand types are NotImplemented', () => {
    const p = new Vec3(1, 2, 5);
    expect(p.__add__(new Vec2(1, 0))).toEqual(new Vec3(2, 2, 5));
    expect(p.__sub__(new Vec2(0, 2))).toEqual(new Vec3(1, 0, 5));
    expect(p.__radd__(new Vec2(1, 1))).toEqual(new Vec3(2, 3, 5));
    expect(p.__rsub__(new Vec2(1, 1))).toEqual(new Vec3(0, -1, -5));
    expect(new Vec2(1, 0).__add__(p as unknown as Vec2)).toBe(NotImplemented);
    expect(p.__mul__(p as unknown as number)).toBe(NotImplemented);
    expect(new Vec2(1, 1).__truediv__('2' as unknown as number)).toBe(NotImplemented);
    expect(p.__mul__(true as unknown as number)).toEqual(p);
  });

  it('methods name the conversion when given the other vector type', () => {
    expect(code(() => new Vec3(0, 0, 0).distance_to(new Vec2(1, 1) as unknown as Vec3))).toBe('PP3007');
    expect(code(() => new Vec2(0, 0).dot(new Vec3(1, 1, 1) as unknown as Vec2))).toBe('PP3007');
  });
});

