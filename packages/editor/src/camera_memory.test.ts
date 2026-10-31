import { describe, expect, it } from 'vitest';
import { Quat, Vec3 } from '@parallax/runtime/core';
import type { CameraPose } from './session/index.js';
import { CameraMemory, cameraKey, decodePose, encodePose, projectKey } from './camera_memory.js';
import type { PoseStorage } from './camera_memory.js';

function memoryStorage(): PoseStorage & { data: Map<string, string>; writes: number } {
  const data = new Map<string, string>();
  const store = {
    data, writes: 0,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { store.writes++; data.set(k, v); },
  };
  return store;
}

const pose = (x: number, fov = 50): CameraPose => ({ position: new Vec3(x, 2, -3), rotation: Quat.from_euler(new Vec3(20, 30, 0)), fov });

describe('camera memory', () => {
  it('keys by project and scene', () => {
    expect(projectKey('boxes')).toBe('boxes');
    expect(projectKey('boxes', '?project=my_game&x=1')).toBe('my_game:boxes');
    expect(cameraKey('my_game:boxes', 'main')).toBe('parallax-editor:camera:my_game:boxes:main');
  });

  it('round-trips a pose per scene, and nothing for a scene never viewed', () => {
    const storage = memoryStorage();
    const memory = new CameraMemory('p', storage);
    expect(memory.load('main')).toBeUndefined();
    memory.save('main', pose(1));
    memory.save('cave', { position: new Vec3(4, 5, 6), rotation: Quat.IDENTITY, size: 7 });
    const again = new CameraMemory('p', storage); // a reload
    const main = again.load('main')!;
    expect(main.position.x).toBeCloseTo(1);
    expect(main.position.z).toBeCloseTo(-3);
    expect(main.rotation.y).toBeCloseTo(pose(1).rotation.y, 4);
    expect(main.fov).toBe(50);
    expect(again.load('cave')!.size).toBe(7);
    expect(new CameraMemory('other', storage).load('main')).toBeUndefined();
  });

  it('writes only when the camera moved', () => {
    const storage = memoryStorage();
    const memory = new CameraMemory('p', storage);
    expect(memory.save('main', pose(1))).toBe(true);
    expect(memory.save('main', pose(1))).toBe(false);
    expect(memory.save('main', pose(2))).toBe(true);
    expect(storage.writes).toBe(2);
  });

  it('ignores stored junk and survives missing or throwing storage', () => {
    expect(decodePose(null)).toBeUndefined();
    expect(decodePose({ p: [1, 2], r: [0, 0, 0, 1] })).toBeUndefined();
    expect(decodePose({ p: [1, 2, 3], r: [0, 0, 0, 0] })).toBeUndefined();
    expect(decodePose({ p: [1, 2, 'x'], r: [0, 0, 0, 1] })).toBeUndefined();
    expect(decodePose({ p: [1, 2, 3], r: [0, 0, 0, 2], fov: -1 })).toEqual({ position: new Vec3(1, 2, 3), rotation: Quat.IDENTITY });
    expect(decodePose(encodePose(pose(3)))!.position.x).toBe(3);
    const storage = memoryStorage();
    storage.data.set(cameraKey('p', 'main'), '{not json');
    expect(new CameraMemory('p', storage).load('main')).toBeUndefined();
    const throwing: PoseStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } };
    expect(new CameraMemory('p', throwing).load('main')).toBeUndefined();
    expect(new CameraMemory('p', throwing).save('main', pose(1))).toBe(false);
    expect(new CameraMemory('p', undefined).save('main', pose(1))).toBe(false);
  });
});
