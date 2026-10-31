import { describe, expect, it } from 'vitest';
import { Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { ModelAsset } from '../../../resource/index.js';
import type { EntityRecord, World } from '../../kernel/index.js';
import { animationStride, PoseHold, posesOnFrame } from './animation_lod.js';
import type { Poses } from './animation_pose.js';
import { WorldMatrices } from './fields.js';
import type { ModelLibrary } from './library.js';
import { ModelPoser } from './poser.js';

describe('animation level of detail', () => {
  it('poses every frame near, every 2nd from 40 m, every 4th from 80 m, scaled by the quality', () => {
    expect([0, 39.9, 40, 79.9, 80, 500].map((d) => animationStride(d))).toEqual([1, 1, 2, 2, 4, 4]);
    expect([19.9, 20, 40].map((d) => animationStride(d, 0.5))).toEqual([1, 2, 4]);
  });

  it('staggers entities by id so a crowd re-poses evenly, not all on one frame', () => {
    const due = (frame: number): number => [0, 1, 2, 3, 4, 5, 6, 7].filter((id) => posesOnFrame(frame, id as EntityId, 4)).length;
    expect([0, 1, 2, 3].map(due)).toEqual([2, 2, 2, 2]);
    expect(posesOnFrame(7, 3 as EntityId, 1)).toBe(true);
  });

  it('holds a pose for the frames in between, then asks for a fresh one', () => {
    const hold = new PoseHold();
    const model = {} as ModelAsset;
    const worlds = new Float32Array(16);
    const one = 1 as EntityId;
    // Entity 1 at stride 2: due on odd frames ((frame + 1) % 2 === 0).
    hold.frame(); // frame 1: due
    expect(hold.reuse(one, model, 2)).toBeUndefined();
    hold.keep(one, model, worlds);
    hold.frame(); // frame 2: held
    expect(hold.reuse(one, model, 2)).toBe(worlds);
    hold.frame(); // frame 3: due again
    expect(hold.reuse(one, model, 2)).toBeUndefined();
    // Another model of the same entity (a level-of-detail model) is held apart.
    hold.frame();
    expect(hold.reuse(one, {} as ModelAsset, 2)).toBeUndefined();
  });

  it('measures distance to the nearest eye; without eyes every pose is exact', () => {
    const hold = new PoseHold();
    expect(hold.stride(500, 0, 0)).toBe(1);
    hold.setEyes([[0, 0, 0], [100, 0, 0]], 1);
    expect(hold.stride(50, 0, 0)).toBe(2);
    expect(hold.stride(10, 0, 0)).toBe(1);
    expect(hold.stride(0, 0, 300)).toBe(4);
  });
});

describe('ModelPoser with animation level of detail', () => {
  const asset = { path: 'm.glb', code: undefined } as unknown as ModelAsset;

  function rig(x: number, options: { ragdoll?: boolean } = {}) {
    const record = {
      id: 2, parent: null, prefab: undefined,
      components: new Map<string, Record<string, unknown>>([
        ['model', { model: 'm.glb', offset: new Vec3(0, 0, 0) }],
        ['animator', {}],
      ]),
      transform: { position: new Vec3(x, 0, 0), rotation: new Quat(0, 0, 0, 1), scale: new Vec3(1, 1, 1) },
    } as unknown as EntityRecord;
    const world = { peek: () => undefined } as unknown as World;
    const library = { resolve: (ref: string) => ref, get: () => asset } as unknown as ModelLibrary;
    let calls = 0;
    const poses = {
      of: () => {
        calls++;
        return new Float32Array(16).fill(calls);
      },
      ragdolled: () => options.ragdoll === true,
    } as unknown as Poses;
    const poser = new ModelPoser(world, library, poses, new WorldMatrices(world, () => undefined), () => 0);
    return { record, poser, calls: () => calls };
  }

  /** Pose over `frames` frames as render3d does (frame, then the renderer's posed()); the number of fresh poses. */
  function run(x: number, frames: number, eyes: boolean, options: { ragdoll?: boolean; fresh?: boolean } = {}): number {
    const { record, poser, calls } = rig(x, options);
    if (eyes) poser.hold.setEyes([[0, 0, 0]], 1);
    for (let f = 0; f < frames; f++) {
      poser.frame();
      poser.posed(record, options.fresh === true);
    }
    return calls();
  }

  it('re-poses a far animator a quarter as often, and a near one every frame', () => {
    // Plus one: the first frame has nothing held yet, so it poses even off its turn.
    expect(run(10, 40, true)).toBe(40);
    expect(run(60, 40, true)).toBe(20 + 1);
    expect(run(120, 40, true)).toBe(10 + 1);
  });

  it('never holds without eyes (headless), for fresh requests, or for a ragdoll', () => {
    expect(run(120, 40, false)).toBe(40);
    expect(run(120, 40, true, { fresh: true })).toBe(40);
    expect(run(120, 40, true, { ragdoll: true })).toBe(40);
  });

  it('hands the held pose back unchanged between poses', () => {
    const { record, poser } = rig(120);
    poser.hold.setEyes([[0, 0, 0]], 1);
    const seen: Float32Array[] = [];
    for (let f = 0; f < 8; f++) {
      poser.frame();
      seen.push(poser.posed(record)!.worlds);
    }
    // Frame 1 (nothing held), then entity 2's turns at stride 4: frames 2 and 6.
    expect(new Set(seen).size).toBe(3);
    expect(seen[2]).toBe(seen[1]);
    expect(seen[5]).not.toBe(seen[4]);
  });
});
