import { describe, expect, it } from 'vitest';
import { ParallaxError, Vec3 } from '../../../core/index.js';
import type { EntityId, ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { EventDef, Fields, GameDefinition, SystemDef } from '../../kernel/index.js';
import { MemoryBinaryFiles, RecordingSurface3d } from '../../../platform/headless/render3d.js';
import { PHYSICS3D_SERVICE } from '../../services/index.js';
import type { WorldHit } from '../../services/index.js';
import { ANIMATION_EVENT, CLIP_FINISHED, visuals } from '../visuals/index.js';
import { nodeMatrices, restPose, sampleClip } from '../../../resource/index.js';
import { ClipLibrary } from './animation_clips.js';
import { solveAim, solveTwoBone } from './animation_ik.js';
import { getRotation, nodePosition, qangle, qeuler, qinv, qmul, qrotate, qslerp, worldRotations } from '../../../resource/index.js';
import type { Q, V3 } from '../../../resource/index.js';
import { Poses } from './animation_pose.js';
import type { PlaybackView } from './animation_pose.js';
import { kneeBend, readClipFile, RIGS } from './animation_procedural.js';
import { canonicalBone, findBone, sampleRetargeted } from './animation_retarget.js';
import { AssetCatalog } from '../../../resource/index.js';
import type { ModelAsset, ModelNode } from '../../../resource/index.js';
import { identity } from '../../../resource/index.js';
import { ModelLibrary } from './library.js';
import { writeGlb } from './testing.js';
import { render3d } from '../render3d/index.js';
import { models } from './index.js';

/** A kernel with no services: poses without physics probes or ragdolls. */
const NO_KERNEL = { tryService: () => undefined } as unknown as Kernel;

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ParallaxError) return e.diagnostic.code;
    throw e;
  }
  return 'no error';
}

const close = (a: readonly number[], b: readonly number[], digits = 4): void => {
  expect(a.length).toBe(b.length);
  a.forEach((v, i) => expect(v).toBeCloseTo(b[i]!, digits));
};

/** Same rotation (q and −q are one rotation). */
const sameRotation = (a: Readonly<Q>, b: Readonly<Q>): void => {
  expect(qangle(qmul(qinv(a), b))).toBeLessThan(0.05);
};

function textFiles(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, typeof v === 'string' ? v : JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

function library(clips: Record<string, unknown>): ClipLibrary {
  const files = textFiles(Object.fromEntries(Object.entries(clips).map(([name, doc]) => [`assets/clips/${name}.clip.json`, doc])));
  const assets = new AssetCatalog(files);
  return new ClipLibrary(new ModelLibrary(new MemoryBinaryFiles(new Map()), assets), assets);
}

/** A bone-only model in engine space: [name, parent, translation, rotation]. */
function rig(path: string, bones: readonly (readonly [string, string | null, V3, Q?])[]): ModelAsset {
  const index = new Map(bones.map(([b], i) => [b, i]));
  const nodes: ModelNode[] = bones.map(([name, parent, t, r]) => ({
    name, parent: parent === null ? -1 : index.get(parent)!, children: bones.flatMap(([c, p], i) => (p === name ? [i] : [])),
    translation: t, rotation: r ?? [0, 0, 0, 1], scale: [1, 1, 1], mesh: null, skin: null,
  }));
  return {
    path, nodes, roots: [0], order: bones.map((_, i) => i), meshes: [], skins: [], clips: new Map(), nodeByName: index, warnings: [], code: null,
  };
}

const posOf = (model: ModelAsset, pose: Float32Array, bone: string): V3 => nodePosition(nodeMatrices(model, pose), findBone(model, bone));

const HUMANOID = RIGS.humanoid;

// ── Names ─────────────────────────────────────────────────────────────────────

describe('bone names', () => {
  it('meet across rigs', () => {
    for (const name of ['mixamorig:LeftUpLeg', 'thigh_l', 'LeftUpperLeg', 'L_Thigh', 'Armature|leftUpLeg']) expect(canonicalBone(name)).toBe('leftupleg');
    expect(canonicalBone('mixamorig:RightForeArm')).toBe('rightforearm');
    expect(canonicalBone('lowerarm.R')).toBe('rightforearm');
    expect(canonicalBone('pelvis')).toBe('hips');
    expect(canonicalBone('Spine1')).toBe('spine1');
    expect(canonicalBone('FL_UpperLeg')).toBe('flupperleg');
  });
});

// ── Authored clips ────────────────────────────────────────────────────────────

describe('authored clips', () => {
  const read = (doc: unknown) => readClipFile('assets/clips/t.clip.json', JSON.stringify(doc));

  it('compile poses relative to the rig bind, easing between keys', () => {
    const { clip } = read({
      rig: 'humanoid', duration: 1, loop: true,
      keys: [{ time: 0, pose: { LeftArm: [0, 0, 90] } }, { time: 1, ease: 'linear', pose: { LeftArm: [0, 0, 0] } }],
    });
    const pose = restPose(HUMANOID);
    sampleClip(clip!.clip, 0, pose, null);
    // Arm down at the side: the forearm hangs below the shoulder.
    const shoulder = posOf(HUMANOID, pose, 'LeftArm');
    const elbow = posOf(HUMANOID, pose, 'LeftForeArm');
    close([elbow[0] - shoulder[0], elbow[1] - shoulder[1], elbow[2] - shoulder[2]], [0, -0.28, 0]);
    sampleClip(clip!.clip, 0.5, pose, null);
    sameRotation(getRotation(pose, HUMANOID.nodeByName.get('LeftArm')!), qeuler(0, 0, 45));
    // Untouched bones have no track.
    expect(clip!.clip.channels.map((c) => HUMANOID.nodes[c.node]!.name)).toEqual(['LeftArm']);
  });

  it('ease keys by any engine ease: out_back overshoots the key and settles on it', () => {
    const { clip, problems } = read({
      rig: 'humanoid', duration: 1,
      keys: [{ time: 0, pose: { LeftArm: [0, 0, 0] } }, { time: 1, ease: 'out_back', pose: { LeftArm: [0, 0, 60] } }],
    });
    expect(problems).toEqual([]);
    const pose = restPose(HUMANOID);
    sampleClip(clip!.clip, 0.8, pose, null);
    // out_back(0.8) ≈ 1.09: past the key's 60°.
    const twist = getRotation(pose, HUMANOID.nodeByName.get('LeftArm')!);
    const angle = 2 * Math.acos(Math.min(1, Math.abs(twist[3]))) * 180 / Math.PI;
    expect(angle).toBeGreaterThan(62);
    sampleClip(clip!.clip, 1, pose, null);
    sameRotation(getRotation(pose, HUMANOID.nodeByName.get('LeftArm')!), qeuler(0, 0, 60));
    expect(read({ rig: 'humanoid', duration: 1, keys: [{ time: 0, ease: 'bouncy', pose: {} }] }).problems.map((p) => p.code)).toEqual(['PP3781']);
  });

  it('documented signs: arm forward, knee up, lean forward', () => {
    const { clip } = read({ rig: 'humanoid', duration: 1, keys: [{ time: 0, pose: { RightArm: [0, -90, 0], LeftUpLeg: [-60, 0, 0], Spine: [20, 0, 0] } }] });
    const pose = restPose(HUMANOID);
    sampleClip(clip!.clip, 0, pose, null);
    const d = (a: string, b: string): V3 => { const p = posOf(HUMANOID, pose, a); const q = posOf(HUMANOID, pose, b); return [q[0] - p[0], q[1] - p[1], q[2] - p[2]]; };
    expect(d('RightArm', 'RightForeArm')[2]).toBeGreaterThan(0.2);
    expect(d('LeftUpLeg', 'LeftLeg')[2]).toBeGreaterThan(0.3);
    expect(d('Spine', 'Spine2')[2]).toBeGreaterThan(0.05);
  });

  it('a root drop bends the knees so the feet stay put', () => {
    const { clip } = read({ rig: 'humanoid', duration: 1, keys: [{ time: 0, root: { y: 0 } }, { time: 1, ease: 'linear', root: { y: -0.3 } }] });
    const rest = restPose(HUMANOID);
    const foot = posOf(HUMANOID, rest, 'LeftFoot');
    const pose = restPose(HUMANOID);
    sampleClip(clip!.clip, 1, pose, null);
    close(posOf(HUMANOID, pose, 'Hips'), [0, 0.7, 0]);
    close(posOf(HUMANOID, pose, 'LeftFoot'), foot, 3);
    expect(posOf(HUMANOID, pose, 'LeftLeg')[2]).toBeGreaterThan(0.1);
    const [thigh, shin, ankle] = kneeBend(0, 0.45, 0.42);
    close([thigh, shin, ankle], [0, 0, 0]);
  });

  it('report problems with codes', () => {
    const codes = (doc: unknown): string[] => read(doc).problems.map((p) => p.code);
    expect(codes({ rig: 'humanoid', duration: 1, keys: [{ time: 0, pose: { LeftAarm: [0, 0, 0] } }] })).toEqual(['PP3782']);
    expect(codes({ rig: 'humanoid', duration: 1, keys: [{ time: 2, pose: {} }] })).toEqual(['PP3783']);
    expect(codes({ rig: 'robot', duration: 1, keys: [] })).toEqual(['PP3781']);
    expect(readClipFile('x', '{nope').problems[0]!.code).toBe('PP3781');
    expect(read({ rig: 'quadruped', duration: 1, keys: [{ time: 0, pose: { Tail1: [20, 0, 0] } }] }).problems).toEqual([]);
  });
});

// ── Retargeting ───────────────────────────────────────────────────────────────

describe('bind-pose-aware retargeting', () => {
  // The same skeleton as the humanoid rig, but the chest bone's rest frame is turned 90° about y
  // (as exporters roll bones); its children's offsets are written in that turned frame.
  const turned = qeuler(0, 90, 0);
  const inChest = (v: V3): V3 => qrotate(qinv(turned), v);
  const target = rig('target', [
    ['mixamorig:Hips', null, [0, 1, 0]],
    ['mixamorig:Spine', 'mixamorig:Hips', [0, 0.1, 0]],
    ['mixamorig:Spine2', 'mixamorig:Spine', [0, 0.25, 0], turned],
    ['mixamorig:LeftArm', 'mixamorig:Spine2', inChest([-0.18, 0.15, 0]), qinv(turned)],
    ['mixamorig:LeftForeArm', 'mixamorig:LeftArm', [-0.28, 0, 0]],
  ]);

  it('applies the source bone\'s change from its bind pose to the target\'s bind pose', () => {
    const { clip } = readClipFile('assets/clips/down.clip.json', JSON.stringify({ rig: 'humanoid', duration: 1, keys: [{ time: 0, pose: { LeftArm: [0, 0, 90] } }] }));
    const pose = restPose(target);
    sampleRetargeted(target, HUMANOID, clip!.clip, 0, pose);
    const shoulder = posOf(target, pose, 'mixamorig:LeftArm');
    const elbow = posOf(target, pose, 'mixamorig:LeftForeArm');
    // Arm down, as on the source — copying the local rotation would have left it out sideways.
    close([elbow[0] - shoulder[0], elbow[1] - shoulder[1], elbow[2] - shoulder[2]], [0, -0.28, 0]);
    // Bones the clip doesn't move keep the pose they had.
    sameRotation(getRotation(pose, 2), turned);
  });

  it('scales root travel by hip height', () => {
    const tall = rig('tall', [['Hips', null, [0, 2, 0]], ['LeftUpLeg', 'Hips', [-0.1, -0.1, 0]]]);
    const { clip } = readClipFile('assets/clips/hop.clip.json', JSON.stringify({ rig: 'humanoid', duration: 1, keys: [{ time: 0, root: { y: 0.1, z: 0.5 } }] }));
    const pose = restPose(tall);
    sampleRetargeted(tall, HUMANOID, clip!.clip, 0, pose);
    close(posOf(tall, pose, 'Hips'), [0, 2.2, 1]);
  });
});

// ── Layers ────────────────────────────────────────────────────────────────────

const CLIPS = {
  walk: { rig: 'humanoid', duration: 1, loop: true, keys: [
    { time: 0, pose: { LeftUpLeg: [-30, 0, 0], RightUpLeg: [30, 0, 0], LeftArm: [0, 0, 80], RightArm: [0, 0, -80] } },
    { time: 0.5, pose: { LeftUpLeg: [30, 0, 0], RightUpLeg: [-30, 0, 0], LeftArm: [0, 0, 80], RightArm: [0, 0, -80] } },
    { time: 1, pose: { LeftUpLeg: [-30, 0, 0], RightUpLeg: [30, 0, 0], LeftArm: [0, 0, 80], RightArm: [0, 0, -80] } },
  ] },
  wave: { rig: 'humanoid', duration: 1, keys: [{ time: 0, pose: { RightArm: [0, 0, 80], RightForeArm: [0, 0, 30] } }] },
  twist: { rig: 'humanoid', duration: 1, keys: [{ time: 0, pose: { Spine: [0, 30, 0] } }] },
  lean: { rig: 'humanoid', duration: 1, keys: [{ time: 0, pose: { Spine: [0, 0, 0] } }, { time: 1, ease: 'linear', pose: { Spine: [20, 0, 0] } }] },
};

const layer = (name: string, samples: [string, number, number][], extra: Partial<PlaybackView['layers'][number]> = {}): PlaybackView['layers'][number] => ({
  name, weight: 1, additive: false, mask: null, samples: samples.map(([clip, time, weight]) => ({ clip, time, loop: false, weight })), ...extra,
});

const NO_IK: PlaybackView['ik'] = { reach: [], look: null, feet: null };

describe('layers', () => {
  const lib = library(CLIPS);
  const poses = new Poses(lib, NO_KERNEL);
  const rot = (pose: Float32Array, bone: string): Q => getRotation(pose, HUMANOID.nodeByName.get(bone)!);

  it('a masked layer drives only its subtree', () => {
    const walk = poses.pose(HUMANOID, { layers: [layer('base', [['clips/walk', 0.25, 1]])] }, 'test');
    const both = poses.pose(HUMANOID, {
      layers: [layer('base', [['clips/walk', 0.25, 1]]), layer('upper', [['clips/wave', 0, 1]], { mask: ['Spine2'] })],
    }, 'test');
    sameRotation(rot(both, 'LeftUpLeg'), rot(walk, 'LeftUpLeg'));
    sameRotation(rot(both, 'RightArm'), qeuler(0, 0, 80));
    // The wave doesn't name the left arm: the walk's swing stays.
    sameRotation(rot(both, 'LeftArm'), qeuler(0, 0, 80));
    // Half weight: halfway from the walk's arm to the wave's.
    const half = poses.pose(HUMANOID, {
      layers: [layer('base', [['clips/walk', 0.25, 1]]), layer('upper', [['clips/wave', 0, 1]], { mask: ['Spine2'], weight: 0.5 })],
    }, 'test');
    sameRotation(rot(half, 'RightArm'), qslerp(qeuler(0, 0, -80), qeuler(0, 0, 80), 0.5));
    expect(code(() => poses.pose(HUMANOID, { layers: [layer('upper', [['clips/wave', 0, 1]], { mask: ['Chest3'] })] }, 'test'))).toBe('PP3780');
  });

  it('blends a layer\'s clips by weight, the rest of a partly covered base being the rest pose', () => {
    const p = poses.pose(HUMANOID, { layers: [layer('base', [['clips/twist', 0, 0.5]])] }, 'test');
    sameRotation(rot(p, 'Spine'), qeuler(0, 15, 0));
  });

  it('additive layers add their change from the first frame on top of the pose', () => {
    const p = poses.pose(HUMANOID, { layers: [layer('base', [['clips/twist', 0, 1]]), layer('lean', [['clips/lean', 1, 1]], { additive: true })] }, 'test');
    sameRotation(rot(p, 'Spine'), qmul(qeuler(0, 30, 0), qeuler(20, 0, 0)));
    const half = poses.pose(HUMANOID, { layers: [layer('base', [['clips/twist', 0, 1]]), layer('lean', [['clips/lean', 1, 1]], { additive: true, weight: 0.5 })] }, 'test');
    sameRotation(rot(half, 'Spine'), qmul(qeuler(0, 30, 0), qeuler(10, 0, 0)));
    // At its first frame an additive layer changes nothing.
    const none = poses.pose(HUMANOID, { layers: [layer('base', [['clips/twist', 0, 1]]), layer('lean', [['clips/lean', 0, 1]], { additive: true })] }, 'test');
    sameRotation(rot(none, 'Spine'), qeuler(0, 30, 0));
  });

  it('root motion takes the root bone\'s travel and heading out of the pose', () => {
    const lib2 = library({ stride: { rig: 'humanoid', duration: 1, keys: [{ time: 0, root: { z: 0, yaw: 0, y: 0 } }, { time: 1, ease: 'linear', root: { z: 1, yaw: 30, y: -0.1 } }] } });
    const p = new Poses(lib2, NO_KERNEL);
    const animator = (mode: PlaybackView['rootMotion']): Fields => ({
      __playback__: { layers: [layer('base', [['clips/stride', 0.5, 1]])], rootMotion: mode, rootBone: null, ik: NO_IK },
    }) as unknown as Fields;
    const free = p.of(HUMANOID, animator('off'), 'test', identity(), 1 as EntityId);
    expect(free[HUMANOID.nodeByName.get('Hips')! * 16 + 14]).toBeCloseTo(0.5);
    const locked = p.of(HUMANOID, animator('transform'), 'test', identity(), 1 as EntityId);
    const hips = HUMANOID.nodeByName.get('Hips')!;
    close([locked[hips * 16 + 12]!, locked[hips * 16 + 13]!, locked[hips * 16 + 14]!], [0, 0.95, 0]);
    // No heading left: the hips' forward is +z again.
    const forward = [locked[hips * 16 + 8]!, locked[hips * 16 + 9]!, locked[hips * 16 + 10]!];
    close(forward, [0, 0, 1]);
  });
});

// ── IK ────────────────────────────────────────────────────────────────────────

describe('ik', () => {
  const limb = (a: string, b: string, c: string) => ({ upper: findBone(HUMANOID, a), middle: findBone(HUMANOID, b), end: findBone(HUMANOID, c) });
  const leg = limb('LeftUpLeg', 'LeftLeg', 'LeftFoot');

  it('two-bone: the end reaches a target in reach, the knee bending toward the pole', () => {
    const pose = restPose(HUMANOID);
    const target: V3 = [-0.1, 0.35, 0.2];
    solveTwoBone(HUMANOID, pose, leg, target, [0, 0, 1], 1);
    close(posOf(HUMANOID, pose, 'LeftFoot'), target, 3);
    expect(posOf(HUMANOID, pose, 'LeftLeg')[2]).toBeGreaterThan(0.2);
    // Bone lengths hold.
    const hip = posOf(HUMANOID, pose, 'LeftUpLeg');
    const knee = posOf(HUMANOID, pose, 'LeftLeg');
    expect(Math.hypot(knee[0] - hip[0], knee[1] - hip[1], knee[2] - hip[2])).toBeCloseTo(0.45, 4);
    // The foot keeps its model-space orientation (identity here).
    sameRotation(worldRotations(HUMANOID, pose)[leg.end]!, [0, 0, 0, 1]);
  });

  it('two-bone: out of reach points straight at the target; weight blends', () => {
    const pose = restPose(HUMANOID);
    solveTwoBone(HUMANOID, pose, limb('RightArm', 'RightForeArm', 'RightHand'), [3, 1.4, 0], [0, 0, -1], 1);
    const s = posOf(HUMANOID, pose, 'RightArm');
    const h = posOf(HUMANOID, pose, 'RightHand');
    expect(h[0] - s[0]).toBeCloseTo(0.53, 2);
    const half = restPose(HUMANOID);
    solveTwoBone(HUMANOID, half, leg, [-0.1, 0.35, 0.2], [0, 0, 1], 0.5);
    const foot = posOf(HUMANOID, half, 'LeftFoot');
    expect(foot[1]).toBeGreaterThan(0.08);
    expect(foot[1]).toBeLessThan(0.35);
  });

  it('aim: the head turns to look, within its limit', () => {
    const bind = worldRotations(HUMANOID, restPose(HUMANOID));
    const head = findBone(HUMANOID, 'Head');
    const pose = restPose(HUMANOID);
    solveAim(HUMANOID, pose, [findBone(HUMANOID, 'Neck'), head], bind, [5, 1.65, 5], 70, 1);
    const forward = qrotate(worldRotations(HUMANOID, pose)[head]!, [0, 0, 1]);
    expect((Math.atan2(forward[0], forward[2]) * 180) / Math.PI).toBeCloseTo(45, 0);
    const limited = restPose(HUMANOID);
    solveAim(HUMANOID, limited, [head], bind, [5, 1.65, -0.01], 70, 1);
    expect(qangle(worldRotations(HUMANOID, limited)[head]!)).toBeCloseTo(70, 0);
  });

  it('foot planting lifts a foot onto a step and drops the hips for a low foot', () => {
    const ground = (left: number, right: number) => ({
      service: () => ({
        raycast: (origin: Vec3): WorldHit => ({ entity: undefined, point: new Vec3(origin.x, origin.x < 0 ? left : right, origin.z), normal: Vec3.UP, distance: 0 }),
      }),
      tryService: () => undefined,
      world: { get: () => undefined },
    }) as unknown as Kernel;
    const feet = { limbs: [{ bones: ['LeftUpLeg', 'LeftLeg', 'LeftFoot'] as const, pole: [0, 0, 1] as const }, { bones: ['RightUpLeg', 'RightLeg', 'RightFoot'] as const, pole: [0, 0, 1] as const }], maxDrop: 0.4, maxStep: 0.4, ground: [], weight: 1 };
    const animator = { __playback__: { layers: [], rootMotion: 'off', rootBone: null, ik: { reach: [], look: null, feet } } } as unknown as Fields;
    const at = (worlds: Float32Array, bone: string): V3 => nodePosition(worlds, findBone(HUMANOID, bone));
    const restFoot = 0.08;
    const step = new Poses(library({}), ground(0.2, 0)).of(HUMANOID, animator, 'test', identity(), 1 as EntityId);
    expect(at(step, 'LeftFoot')[1]).toBeCloseTo(restFoot + 0.2, 3);
    expect(at(step, 'RightFoot')[1]).toBeCloseTo(restFoot, 3);
    expect(at(step, 'Hips')[1]).toBeCloseTo(1, 4);
    const hole = new Poses(library({}), ground(-0.2, 0)).of(HUMANOID, animator, 'test', identity(), 1 as EntityId);
    expect(at(hole, 'Hips')[1]).toBeCloseTo(0.8, 4);
    expect(at(hole, 'LeftFoot')[1]).toBeCloseTo(restFoot - 0.2, 3);
    expect(at(hole, 'RightFoot')[1]).toBeCloseTo(restFoot, 3);
  });
});

// ── End to end ────────────────────────────────────────────────────────────────

/** A skinned humanoid GLB with the canonical bones under "mixamorig:" names (glTF space: x mirrored). */
function humanoidGlb(): Uint8Array {
  const bones = HUMANOID.nodes;
  const nodes = [
    { name: 'body', mesh: 0, skin: 0 },
    ...bones.map((b) => ({
      name: `mixamorig:${b.name}`,
      translation: [-b.translation[0], b.translation[1], b.translation[2]],
      children: b.children.map((c) => c + 1),
    })),
  ];
  const ibm: number[] = [];
  for (let i = 0; i < bones.length; i++) ibm.push(...identity());
  return writeGlb({
    nodes,
    meshes: [{ positions: [0, 0, 0, 0.1, 0, 0, 0, 0.1, 0], joints: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], weights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], indices: [0, 1, 2], material: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } }],
    skins: [{ joints: bones.map((_, i) => i + 1), inverseBind: ibm }],
  });
}

describe('end to end: a humanoid walks, runs, waves and steps', () => {
  const leg = (amount: number) => [
    { time: 0, pose: { LeftUpLeg: [-amount, 0, 0], RightUpLeg: [amount, 0, 0] } },
    { time: 0.5, pose: { LeftUpLeg: [amount, 0, 0], RightUpLeg: [-amount, 0, 0] } },
    { time: 1, pose: { LeftUpLeg: [-amount, 0, 0], RightUpLeg: [amount, 0, 0] } },
  ];
  const project = {
    'assets/clips/idle.clip.json': { rig: 'humanoid', duration: 2, loop: true, keys: [{ time: 0, pose: { Spine: [0, 0, 0] } }, { time: 1, pose: { Spine: [2, 0, 0] } }, { time: 2, pose: { Spine: [0, 0, 0] } }] },
    'assets/clips/walk.clip.json': { rig: 'humanoid', duration: 1, loop: true, keys: leg(25), events: [{ time: 0.25, name: 'footstep' }, { time: 0.75, name: 'footstep' }] },
    'assets/clips/run.clip.json': { rig: 'humanoid', duration: 1, loop: true, keys: leg(50).map((k) => ({ ...k, time: k.time * 0.6 })).map((k, i) => (i === 2 ? { ...k, time: 1 } : k)), events: [{ time: 0.15, name: 'footstep' }, { time: 0.45, name: 'footstep' }] },
    'assets/clips/wave.clip.json': { rig: 'humanoid', duration: 1.5, keys: [
      { time: 0, pose: { RightArm: [0, 0, -80] } }, { time: 0.3, pose: { RightArm: [0, 0, 80], RightForeArm: [0, 0, 20] } },
      { time: 0.6, pose: { RightForeArm: [0, 0, -20] } }, { time: 0.9, pose: { RightForeArm: [0, 0, 20] } }, { time: 1.5, pose: { RightArm: [0, 0, -80], RightForeArm: [0, 0, 0] } },
    ] },
    'assets/models/hero.glb': '',
    'prefabs/hero.prefab.json': {
      components: {
        model: { model: 'models/hero' },
        animator: {
          params: { speed: 0 },
          layers: [
            { name: 'base', states: { move: { blend: { param: 'speed', clips: [{ at: 0, clip: 'clips/idle' }, { at: 2, clip: 'clips/walk' }, { at: 6, clip: 'clips/run' }] } } } },
            { name: 'upper', mask: ['Spine2'] },
          ],
        },
      },
    },
    'scenes/main/scene.json': { entities: [{ id: 'hero', prefab: 'hero' }] },
  };

  it('plays the graph headless, with events at exact times and the wave over the run', async () => {
    const files = textFiles(project);
    const loaded = loadProject(files);
    expect(loaded.diagnostics).toEqual([]);
    const surface = new RecordingSurface3d();
    const modelsPlugin = models({ files, binary: new MemoryBinaryFiles(new Map([['assets/models/hero.glb', humanoidGlb()]])) });
    const plugin = render3d({ surface, files });
    const heard: [string, number, unknown][] = [];
    let kernel: Kernel;
    const listen = (event: EventDef): SystemDef => ({
      id: `hear_${event.id}`, scenes: [], handlers: [{ event, method: 'on' }],
      create: () => ({ on: (_c: unknown, e: Fields) => { heard.push([event.id, Math.round(kernel.time.now * 1000) / 1000, e['name'] ?? e['clip']]); } }),
    });
    const game: GameDefinition = { components: [], resources: [], events: [], behaviors: [], systems: [listen(ANIMATION_EVENT), listen(CLIP_FINISHED)] };
    kernel = new Kernel({ project: loaded, game, plugins: [visuals({ dimension: '3d' }), modelsPlugin, plugin], context: {}, fixedStep: 1 / 20 });
    plugin.engine.preload();
    await plugin.engine.whenLoaded();
    kernel.start('main');
    const id = [...kernel.world.live()].find((r) => r.placedId === 'hero')!.id;
    const animator = kernel.world.require(id).components.get('animator') as unknown as {
      set_param(n: string, v: number): void; play_once(c: string, kw: object): void; readonly clip: string;
    };
    const steps = (n: number): void => { for (let i = 0; i < n; i++) kernel.step(1 / 20); };
    const joint = (bone: string): V3 => {
      const draw = surface.last!.skinned[0]!;
      const j = HUMANOID.nodeByName.get(bone)!;
      return [draw.palette[j * 16 + 12]!, draw.palette[j * 16 + 13]!, draw.palette[j * 16 + 14]!];
    };

    // Walking from t = 0: footsteps at 0.25 and 0.75 of each 1 s cycle, on the frame that reaches them.
    animator.set_param('speed', 2);
    steps(21);
    expect(heard).toEqual([['animation_event', 0.25, 'footstep'], ['animation_event', 0.75, 'footstep']]);
    expect(animator.clip).toBe('clips/walk');

    // Running, and a wave on the upper body over it.
    animator.set_param('speed', 6);
    animator.play_once('clips/wave', { layer: 'upper', fade: 0.1 });
    heard.length = 0;
    steps(7);
    const hand = joint('RightHand');
    const shoulder = joint('RightArm');
    expect(hand[1]).toBeGreaterThan(shoulder[1] + 0.3);
    // The legs swing as the run does, under the wave.
    const thigh = joint('LeftUpLeg');
    const knee = joint('LeftLeg');
    expect(Math.abs(knee[2] - thigh[2])).toBeGreaterThan(0.05);
    steps(30);
    expect(heard.filter(([e]) => e === 'animation_event').length).toBeGreaterThanOrEqual(4);
    expect(heard.filter(([e]) => e === 'clip_finished')).toEqual([['clip_finished', 2.55, 'clips/wave']]); // started at 1.05 s, 1.5 s long
    // After the wave the arm is back where the base layer has it.
    steps(4);
    expect(joint('RightHand')[1]).toBeLessThan(joint('RightArm')[1] + 0.05);
  });
});
