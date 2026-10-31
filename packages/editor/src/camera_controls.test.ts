import { describe, expect, it } from 'vitest';
import { Quat, Vec3 } from '@parallax/runtime/core';
import {
  distanceTo, flyLevel, flyRate, flySpeedAfterWheel, FLY_SPEED, lookRotation, orbit, ORBIT_DISTANCE, pivotOf,
  wheelPixels, yawPitch, zoom2dWheel, zoomOrbit,
} from './camera_controls.js';
import { shortcutFor } from './shortcuts.js';

const close = (a: number, b: number, eps = 1e-6): void => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('orbit mode', () => {
  const pose = { position: new Vec3(0, 0, -10), rotation: Quat.IDENTITY, fov: 60 };

  it('orbits about the pivot ahead, keeping its distance', () => {
    const turned = orbit(pose, 100, 40, 10);
    const pivot = pivotOf(turned, 10);
    close(pivot.x, 0);
    close(pivot.y, 0);
    close(pivot.z, 0);
    close(turned.position.length(), 10);
    // 0.005 rad per pixel: 100 px right is 0.5 rad of yaw; dragging down looks down.
    close(yawPitch(turned.rotation).yaw, 0.5 * 180 / Math.PI);
    expect(yawPitch(turned.rotation).pitch).toBeLessThan(0);
  });

  it('zooms toward the pivot by 1 + deltaY × 0.001, clamped', () => {
    const out = zoomOrbit(pose, 10, 100);
    close(out.distance, 11);
    close(out.pose.position.z, -11);
    const inward = zoomOrbit(pose, 10, -100);
    close(inward.distance, 9);
    expect(zoomOrbit(pose, 1, -5000).distance).toBe(ORBIT_DISTANCE.min);
  });

  it('keeps a framed point as the pivot', () => {
    close(distanceTo(pose, new Vec3(0, 3, 4), 15), 14);
    expect(distanceTo(pose, new Vec3(0, 0, -20), 15)).toBe(15);
  });
});

describe('fly mode', () => {
  it('moves on the ground plane whatever the pitch', () => {
    const pose = { position: new Vec3(0, 5, 0), rotation: lookRotation(0, -60), fov: 60 };
    const moved = flyLevel(pose, 0, 0, 2);
    close(moved.position.y, 5);
    close(moved.position.z, 2);
    const strafed = flyLevel(pose, 1, 1, 0);
    close(strafed.position.x, 1);
    close(strafed.position.y, 6);
  });

  it('flies twice as fast with Shift and faster with altitude', () => {
    expect(flyRate(10, false, 0)).toBe(10);
    expect(flyRate(10, true, 5)).toBe(20);
    expect(flyRate(10, false, 40)).toBe(40);
  });

  it('the wheel sets the fly speed', () => {
    expect(flySpeedAfterWheel(10, -100)).toBe(20);
    expect(flySpeedAfterWheel(10, 1000)).toBe(FLY_SPEED.min);
  });
});

describe('wheel', () => {
  it('reads line and page deltas as pixels', () => {
    expect(wheelPixels({ deltaY: 3, deltaMode: 1 })).toBe(48);
    expect(wheelPixels({ deltaY: 100, deltaMode: 0 })).toBe(100);
  });

  it('2D zooms by 1 + deltaY × 0.001 about the pointer', () => {
    const pose = { position: new Vec3(0, 0, -10), rotation: Quat.IDENTITY, size: 5 };
    const zoomed = zoom2dWheel(pose, 100, { x: 4, y: 2 });
    close(zoomed.size!, 5.5);
    const k = zoomed.size! / 5;
    close((4 - zoomed.position.x) / k, 4);
  });
});

describe('product shortcuts', () => {
  const key = (k: string, mods: Partial<KeyboardEvent> = {}) => ({ key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods });

  it('binds 1–5, duplicate and select all', () => {
    expect(shortcutFor(key('1'), 'edit')).toBe('translate');
    expect(shortcutFor(key('2'), 'edit')).toBe('rotate');
    expect(shortcutFor(key('3'), 'edit')).toBe('scale');
    expect(shortcutFor(key('4'), 'edit')).toBe('camera-mode');
    expect(shortcutFor(key('5'), 'edit')).toBe('space');
    expect(shortcutFor(key('d', { ctrlKey: true }), 'edit')).toBe('duplicate');
    expect(shortcutFor(key('A', { metaKey: true }), 'edit')).toBe('select-all');
  });

  it('leaves W / E / R to the camera while it flies', () => {
    expect(shortcutFor(key('w'), 'edit', { flying: true })).toBeNull();
    expect(shortcutFor(key('e'), 'edit', { flying: true })).toBeNull();
    expect(shortcutFor(key('1'), 'edit', { flying: true })).toBe('translate');
  });

  it('in a text field only Escape and Ctrl + S / Z / Y / P are shortcuts', () => {
    expect(shortcutFor(key('Delete'), 'edit', { typing: true })).toBeNull();
    expect(shortcutFor(key('a', { ctrlKey: true }), 'edit', { typing: true })).toBeNull();
    expect(shortcutFor(key('d', { ctrlKey: true }), 'edit', { typing: true })).toBeNull();
    expect(shortcutFor(key('z', { ctrlKey: true }), 'edit', { typing: true })).toBe('undo');
    expect(shortcutFor(key('S', { metaKey: true }), 'edit', { typing: true })).toBe('save');
    expect(shortcutFor(key('Escape'), 'edit', { typing: true })).toBe('escape');
  });
});
