import { describe, expect, it } from 'vitest';
import { Vec3 } from '../../../core/index.js';
import type { SceneDoc } from '../../../resource/index.js';
import { buildField, rayTerrain, readTerrainSpec } from './index.js';

function hill() {
  const scene: SceneDoc = {
    id: 'level', path: 'scenes/level/scene.json', tags: [], ui: [], init: {}, entities: [], regions: new Map(),
    plugins: { terrain: { size: [100, 100], base_height: 2, hills: [{ center: [0, 0], radius: 15, height: 12, feather: 10 }], layers: ['grass'], holes: [{ center: [30, 30], radius: 3 }] } },
  };
  return buildField(readTerrainSpec(scene)!, 'level', 1);
}

describe('rayTerrain', () => {
  const field = hill();

  it('meets the surface where the ray crosses it, not the y = 0 plane below', () => {
    // A camera up and to the south, looking at the hilltop.
    const top = new Vec3(0, field.heightAt(0, 0), 0);
    const origin = new Vec3(0, 60, -60);
    const hit = rayTerrain(field, origin, top.__sub__(origin), 1e4)!;
    expect(hit.distance_to(top)).toBeLessThan(0.05);
    expect(Math.abs(hit.y - field.heightAt(hit.x, hit.z))).toBeLessThan(1e-6);
    // Straight down onto a flank.
    const flank = rayTerrain(field, new Vec3(12, 50, 5), new Vec3(0, -1, 0), 1e4)!;
    expect(flank.y).toBeCloseTo(field.heightAt(12, 5), 4);
    expect(flank.y).toBeGreaterThan(2.5);
  });

  it('misses: a ray that leaves the field, points up, or falls through a hole', () => {
    expect(rayTerrain(field, new Vec3(0, 50, 0), new Vec3(0, 1, 0), 1e4)).toBeNull();
    expect(rayTerrain(field, new Vec3(200, 50, 0), new Vec3(0, -1, 0), 1e4)).toBeNull();
    expect(rayTerrain(field, new Vec3(30, 50, 30), new Vec3(0, -1, 0), 1e4)).toBeNull();
    expect(rayTerrain(field, new Vec3(0, 50, -60), new Vec3(0, -0.5, 1), 5)).toBeNull(); // too short
  });
});
