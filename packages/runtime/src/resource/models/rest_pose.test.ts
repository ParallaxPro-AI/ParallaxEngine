import { describe, expect, it } from 'vitest';
import { POSE_STRIDE, restPose } from './animation.js';
import type { ModelAsset } from './gltf.js';

/** restPose only reads each node's own transform. */
function model(): ModelAsset {
  return {
    nodes: [
      { translation: [1, 2, 3], rotation: [0, 0, 0, 1], scale: [1, 1, 1] },
      { translation: [0, 0.5, 0], rotation: [0, 0.6, 0, 0.8], scale: [2, 3, 4] },
    ],
  } as unknown as ModelAsset;
}

describe('restPose', () => {
  it('lays out every node: translation, rotation, scale', () => {
    const pose = restPose(model());
    expect(pose.length).toBe(2 * POSE_STRIDE);
    expect(Array.from(pose.subarray(0, POSE_STRIDE))).toEqual([1, 2, 3, 0, 0, 0, 1, 1, 1, 1]);
    expect(Array.from(pose.subarray(POSE_STRIDE, 2 * POSE_STRIDE)).map((v) => Math.round(v * 1000) / 1000))
      .toEqual([0, 0.5, 0, 0, 0.6, 0, 0.8, 2, 3, 4]);
  });

  it('hands out a fresh pose every call: writing into one leaves the next untouched', () => {
    const m = model();
    const first = restPose(m);
    first.fill(9);
    const second = restPose(m);
    expect(second).not.toBe(first);
    expect(Array.from(second.subarray(0, 3))).toEqual([1, 2, 3]);
    expect(second[POSE_STRIDE + 9]).toBe(4);
  });
});
