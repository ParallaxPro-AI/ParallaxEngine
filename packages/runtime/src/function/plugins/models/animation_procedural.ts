/**
 * Authored clips: motion written as data, the way a code-based model is geometry written
 * as data. `assets/clips/<name>.clip.json` (`Assets.clips.<name>`, stored "clips/<name>"):
 *
 *   {
 *     "rig": "humanoid",                     // or "quadruped"
 *     "duration": 0.6,
 *     "loop": false,
 *     "events": [{"time": 0.3, "name": "hit"}],
 *     "keys": [
 *       {"time": 0,   "pose": {"RightArm": [0, 0, -80]}},
 *       {"time": 0.2, "ease": "out", "root": {"y": -0.05, "z": 0.06}, "pose": {"Spine": [10, -20, 0]}},
 *       {"time": 0.6, "pose": {"RightArm": [0, 0, -80], "Spine": [0, 0, 0]}}
 *     ]
 *   }
 *
 * Rules (every bone is a track; there are no hidden defaults):
 *   - A pose gives a bone's rotation relative to the rig's bind pose, as Euler degrees
 *     [x, y, z] applied like `Quat.from_euler`: yaw (y), then pitch (x), then roll (z).
 *   - A bone some key names is animated: between the keys that name it, it eases into
 *     each key by that key's `ease` ("smooth" by default; "linear", "in", "out", "step"
 *     = hold, then cut at the key, or any of the engine's eases — "in_cubic",
 *     "out_cubic", "out_back" overshooting and settling, "out_elastic", …: the SDK's
 *     `Ease`); before its first key and after its last it holds.
 *     A bone no key names is not animated, so the layers below keep it (an arm swing over
 *     a walk). `root` is a track the same way.
 *   - `root` moves the whole body: meters on x/y/z (the rig's hips stand 1 m up; the
 *     offset scales to the playing character's hip height) and degrees on `yaw`. On the
 *     humanoid rig a key whose root drops (y < 0) and that poses no leg bone bends both
 *     legs so the feet stay where they were; such clips track the legs at every root key.
 *
 * The rigs face +z with +x on their right, y up. Humanoid T-pose: arms out along ±x.
 *   arm down at the side   LeftArm [0, 0, 90]    RightArm [0, 0, -90]
 *   arm straight up        LeftArm [0, 0, -90]   RightArm [0, 0, 90]
 *   arm forward            LeftArm [0, 90, 0]    RightArm [0, -90, 0]
 *   elbow bend forward     LeftForeArm [0, 90, 0] RightForeArm [0, -90, 0]
 *   knee raised forward    LeftUpLeg [-60, 0, 0] (shin back down: LeftLeg [60, 0, 0])
 *   lean forward           Spine [20, 0, 0];  turn left: Spine [0, -30, 0]
 *
 * An authored clip is compiled to an ordinary clip of its rig (a bone-only model) and
 * retargeted onto whichever character plays it, like a clip of another model.
 */

import { closestMatch, EASE_KINDS, easing } from '../../../core/index.js';
import type { DiagnosticCode } from '../../../core/index.js';
import type { ClipMarker } from '../../services/index.js';
import { qeuler, qmul, qslerp } from '../../../resource/index.js';
import type { Q } from '../../../resource/index.js';
import { canonicalBone } from './animation_retarget.js';
import type { Clip, ClipChannel, ModelAsset, ModelNode } from '../../../resource/index.js';

export type RigName = 'humanoid' | 'quadruped';

/** [name, parent name (null: root), bind translation from the parent]. */
type BoneSpec = readonly [string, string | null, readonly [number, number, number]];

const HUMANOID_BONES: readonly BoneSpec[] = [
  ['Hips', null, [0, 1, 0]],
  ['Spine', 'Hips', [0, 0.1, 0]],
  ['Spine2', 'Spine', [0, 0.25, 0]],
  ['Neck', 'Spine2', [0, 0.2, 0]],
  ['Head', 'Neck', [0, 0.1, 0]],
  ['LeftArm', 'Spine2', [-0.18, 0.15, 0]],
  ['LeftForeArm', 'LeftArm', [-0.28, 0, 0]],
  ['LeftHand', 'LeftForeArm', [-0.25, 0, 0]],
  ['RightArm', 'Spine2', [0.18, 0.15, 0]],
  ['RightForeArm', 'RightArm', [0.28, 0, 0]],
  ['RightHand', 'RightForeArm', [0.25, 0, 0]],
  ['LeftUpLeg', 'Hips', [-0.1, -0.05, 0]],
  ['LeftLeg', 'LeftUpLeg', [0, -0.45, 0]],
  ['LeftFoot', 'LeftLeg', [0, -0.42, 0]],
  ['RightUpLeg', 'Hips', [0.1, -0.05, 0]],
  ['RightLeg', 'RightUpLeg', [0, -0.45, 0]],
  ['RightFoot', 'RightLeg', [0, -0.42, 0]],
];

const QUADRUPED_BONES: readonly BoneSpec[] = [
  ['Hips', null, [0, 0.5, -0.25]],
  ['Spine', 'Hips', [0, 0.02, 0.25]],
  ['Spine2', 'Spine', [0, 0, 0.25]],
  ['Neck', 'Spine2', [0, 0.06, 0.12]],
  ['Head', 'Neck', [0, 0.1, 0.1]],
  ['Tail1', 'Hips', [0, 0.04, -0.08]],
  ['Tail2', 'Tail1', [0, 0, -0.12]],
  ['Tail3', 'Tail2', [0, 0, -0.12]],
  ['FL_UpperLeg', 'Spine2', [-0.1, -0.06, 0]],
  ['FL_LowerLeg', 'FL_UpperLeg', [0, -0.22, 0]],
  ['FL_Paw', 'FL_LowerLeg', [0, -0.2, 0]],
  ['FR_UpperLeg', 'Spine2', [0.1, -0.06, 0]],
  ['FR_LowerLeg', 'FR_UpperLeg', [0, -0.22, 0]],
  ['FR_Paw', 'FR_LowerLeg', [0, -0.2, 0]],
  ['BL_UpperLeg', 'Hips', [-0.1, -0.05, 0]],
  ['BL_LowerLeg', 'BL_UpperLeg', [0, -0.22, 0]],
  ['BL_Paw', 'BL_LowerLeg', [0, -0.21, 0]],
  ['BR_UpperLeg', 'Hips', [0.1, -0.05, 0]],
  ['BR_LowerLeg', 'BR_UpperLeg', [0, -0.22, 0]],
  ['BR_Paw', 'BR_LowerLeg', [0, -0.21, 0]],
];

function rigModel(name: RigName, bones: readonly BoneSpec[]): ModelAsset {
  const index = new Map(bones.map(([bone], i) => [bone, i]));
  const nodes: ModelNode[] = bones.map(([bone, parent, translation]) => ({
    name: bone,
    parent: parent === null ? -1 : index.get(parent)!,
    children: bones.flatMap(([child, p], i) => (p === bone ? [i] : [])),
    translation: [translation[0], translation[1], translation[2]],
    rotation: [0, 0, 0, 1],
    scale: [1, 1, 1],
    mesh: null,
    skin: null,
  }));
  return {
    path: `rig:${name}`,
    nodes,
    roots: [0],
    order: bones.map((_, i) => i),
    meshes: [],
    skins: [],
    clips: new Map(),
    nodeByName: index,
    warnings: [],
    code: null,
  };
}

/** The bone-only models authored clips are written against. */
export const RIGS: Readonly<Record<RigName, ModelAsset>> = {
  humanoid: rigModel('humanoid', HUMANOID_BONES),
  quadruped: rigModel('quadruped', QUADRUPED_BONES),
};

export interface AuthoredClip {
  readonly path: string;
  readonly rig: RigName;
  readonly duration: number;
  readonly loop: boolean;
  readonly markers: readonly ClipMarker[];
  /** A clip of `RIGS[rig]`. */
  readonly clip: Clip;
}

export interface ClipProblem {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly pointer: string;
  readonly fix?: string;
}

/** A clip key's ease: "smooth", "in", "out", "step", or any engine ease name (core `EASE_KINDS`; "linear" is one). */
export type Ease = string;
const CLIP_EASES: readonly string[] = ['smooth', 'in', 'out', 'step'];
const EASES: readonly string[] = [...CLIP_EASES, ...EASE_KINDS];

export function ease(kind: Ease, u: number): number {
  switch (kind) {
    case 'smooth': return u * u * (3 - 2 * u);
    case 'in': return u * u;
    case 'out': return 1 - (1 - u) * (1 - u);
    case 'step': return u < 1 ? 0 : 1;
    default: return easing(kind)(u);
  }
}

/** Baked keys per second (plus every authored key time). */
const BAKE_RATE = 60;
const LEG_BONES = ['LeftUpLeg', 'LeftLeg', 'LeftFoot', 'RightUpLeg', 'RightLeg', 'RightFoot'];

interface RootKey { readonly x: number; readonly y: number; readonly z: number; readonly yaw: number }
interface Key { readonly time: number; readonly ease: Ease; readonly pose: ReadonlyMap<string, readonly [number, number, number]>; readonly root: RootKey | null }

type RawObject = Readonly<Record<string, unknown>>;
const isObject = (v: unknown): v is RawObject => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Read and compile a clip file. Problems are collected; `clip` is undefined when there are any. */
export function readClipFile(path: string, text: string): { readonly clip?: AuthoredClip; readonly problems: readonly ClipProblem[] } {
  const problems: ClipProblem[] = [];
  const report = (pointer: string, message: string, fix?: string, code: DiagnosticCode = 'PP3781'): void => {
    problems.push({ code, message, pointer, ...(fix !== undefined && { fix }) });
  };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    report('', `${path} is not valid JSON (${(error as Error).message})`);
    return { problems };
  }
  if (!isObject(doc)) {
    report('', `${path} must hold an object`);
    return { problems };
  }
  const known = ['rig', 'duration', 'loop', 'events', 'keys'];
  for (const key of Object.keys(doc)) {
    if (!known.includes(key)) report(`/${key}`, `A clip has no key "${key}"`, ((g) => (g !== undefined ? `Did you mean "${g}"?` : `Keys: ${known.join(', ')}.`))(closestMatch(key, known)));
  }
  const rig = doc['rig'];
  if (rig !== 'humanoid' && rig !== 'quadruped') {
    report('/rig', `"rig" must be "humanoid" or "quadruped", got ${JSON.stringify(rig)}`);
    return { problems };
  }
  const duration = doc['duration'];
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    report('/duration', `"duration" must be a number of seconds above 0, got ${JSON.stringify(duration)}`);
    return { problems };
  }
  const loop = doc['loop'] ?? false;
  if (typeof loop !== 'boolean') report('/loop', `"loop" must be true or false, got ${JSON.stringify(loop)}`);
  const model = RIGS[rig];
  const boneNames = model.nodes.map((n) => n.name);
  const boneOf = (name: string): string | undefined => {
    if (model.nodeByName.has(name)) return name;
    const key = canonicalBone(name);
    return boneNames.find((b) => canonicalBone(b) === key);
  };

  const markers: ClipMarker[] = [];
  const rawEvents = doc['events'] ?? [];
  if (!Array.isArray(rawEvents)) report('/events', '"events" must be a list');
  else rawEvents.forEach((e, i) => {
    const time = isObject(e) ? e['time'] : undefined;
    const name = isObject(e) ? e['name'] : undefined;
    if (!isObject(e) || typeof time !== 'number' || time < 0 || time > duration || typeof name !== 'string' || name === '') {
      report(`/events/${i}`, `events[${i}] must be {"time": 0–${duration}, "name": "..."}, got ${JSON.stringify(e)}`);
      return;
    }
    markers.push({ time, name });
  });
  markers.sort((a, b) => a.time - b.time);

  const keys: Key[] = [];
  const rawKeys = doc['keys'];
  if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
    report('/keys', '"keys" must be a non-empty list of {"time": ..., "pose": {...}}');
    return { problems };
  }
  rawKeys.forEach((k, i) => {
    const at = `/keys/${i}`;
    if (!isObject(k)) { report(at, `keys[${i}] must be an object`); return; }
    for (const key of Object.keys(k)) {
      if (!['time', 'ease', 'pose', 'root'].includes(key)) report(`${at}/${key}`, `A key has no "${key}"`, 'Keys hold "time", "ease", "pose" and "root".');
    }
    const time = k['time'];
    if (typeof time !== 'number' || time < 0 || time > duration) { report(`${at}/time`, `keys[${i}].time must be from 0 to ${duration}, got ${JSON.stringify(time)}`, undefined, 'PP3783'); return; }
    const e = k['ease'] ?? 'smooth';
    if (typeof e !== 'string' || !EASES.includes(e)) report(`${at}/ease`, `keys[${i}].ease must be one of ${EASES.map((x) => `"${x}"`).join(', ')}, got ${JSON.stringify(e)}`);
    const pose = new Map<string, readonly [number, number, number]>();
    if (k['pose'] !== undefined) {
      if (!isObject(k['pose'])) report(`${at}/pose`, `keys[${i}].pose must map bone names to [x, y, z] degrees`);
      else for (const [bone, value] of Object.entries(k['pose'])) {
        const name = boneOf(bone);
        if (name === undefined) {
          const guess = closestMatch(bone, boneNames);
          report(`${at}/pose/${bone}`, `The ${rig} rig has no bone "${bone}"`, guess !== undefined ? `Did you mean "${guess}"?` : `Bones: ${boneNames.join(', ')}.`, 'PP3782');
          continue;
        }
        if (!Array.isArray(value) || value.length !== 3 || !value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
          report(`${at}/pose/${bone}`, `keys[${i}].pose.${bone} must be [x, y, z] degrees, got ${JSON.stringify(value)}`);
          continue;
        }
        pose.set(name, [value[0] as number, value[1] as number, value[2] as number]);
      }
    }
    let root: RootKey | null = null;
    if (k['root'] !== undefined) {
      const r = k['root'];
      if (!isObject(r) || Object.entries(r).some(([key, v]) => !['x', 'y', 'z', 'yaw'].includes(key) || typeof v !== 'number' || !Number.isFinite(v))) {
        report(`${at}/root`, `keys[${i}].root must be {"x", "y", "z" (meters), "yaw" (degrees)} numbers, got ${JSON.stringify(r)}`);
      } else {
        root = { x: (r['x'] as number | undefined) ?? 0, y: (r['y'] as number | undefined) ?? 0, z: (r['z'] as number | undefined) ?? 0, yaw: (r['yaw'] as number | undefined) ?? 0 };
      }
    }
    if (pose.size === 0 && root === null && k['pose'] === undefined) report(at, `keys[${i}] has neither "pose" nor "root"`, 'A key sets bone rotations, the root, or both.');
    keys.push({ time, ease: e as Ease, pose, root });
  });
  if (problems.length > 0) return { problems };
  keys.sort((a, b) => a.time - b.time);
  return { clip: compile(path, rig, duration, loop as boolean, markers, keys), problems };
}

/** Knee and ankle angles that keep a foot under the hip as the hip drops (degrees: thigh, shin, foot). */
export function kneeBend(drop: number, thigh: number, shin: number): [number, number, number] {
  const reach = thigh + shin;
  const d = Math.min(reach, Math.max(reach * 0.2, reach - drop));
  const hip = Math.acos(Math.min(1, Math.max(-1, (thigh * thigh + d * d - shin * shin) / (2 * thigh * d))));
  const knee = Math.acos(Math.min(1, Math.max(-1, (thigh * thigh + shin * shin - d * d) / (2 * thigh * shin))));
  const deg = 180 / Math.PI;
  const bend = Math.PI - knee;
  return [-hip * deg, bend * deg, (hip - bend) * deg];
}

interface TrackKey<T> { readonly time: number; readonly ease: Ease; readonly value: T }

function at<T>(track: readonly TrackKey<T>[], time: number, mix: (a: T, b: T, u: number) => T): T {
  if (time <= track[0]!.time) return track[0]!.value;
  const last = track[track.length - 1]!;
  if (time >= last.time) return last.value;
  let i = 0;
  while (track[i + 1]!.time <= time) i++;
  const a = track[i]!;
  const b = track[i + 1]!;
  const span = b.time - a.time;
  return mix(a.value, b.value, span > 0 ? ease(b.ease, (time - a.time) / span) : 1);
}

function compile(path: string, rig: RigName, duration: number, loop: boolean, markers: readonly ClipMarker[], authored: readonly Key[]): AuthoredClip {
  const model = RIGS[rig];
  const keys = rig === 'humanoid' ? withKneeBends(authored) : authored;
  const times = new Set<number>();
  for (let i = 0; i <= Math.ceil(duration * BAKE_RATE); i++) times.add(Math.min(duration, i / BAKE_RATE));
  for (const k of keys) times.add(k.time);
  const grid = [...times].sort((a, b) => a - b);
  const channels: ClipChannel[] = [];
  const euler = (v: readonly [number, number, number]): Q => qeuler(v[0], v[1], v[2]);
  const rotationTracks = new Map<string, TrackKey<Q>[]>();
  for (const k of keys) {
    for (const [bone, v] of k.pose) {
      const track = rotationTracks.get(bone) ?? [];
      track.push({ time: k.time, ease: k.ease, value: euler(v) });
      rotationTracks.set(bone, track);
    }
  }
  const rootTrack: TrackKey<RootKey>[] = keys.flatMap((k) => (k.root === null ? [] : [{ time: k.time, ease: k.ease, value: k.root }]));
  const mixRoot = (a: RootKey, b: RootKey, u: number): RootKey => ({
    x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u, yaw: a.yaw + (b.yaw - a.yaw) * u,
  });
  const hips = model.nodeByName.get('Hips')!;
  const rotationChannel = (node: number, value: (t: number) => Q): ClipChannel => {
    const values = new Float32Array(grid.length * 4);
    grid.forEach((t, i) => values.set(value(t), i * 4));
    return { node, path: 'rotation', interpolation: 'LINEAR', times: Float32Array.from(grid), values };
  };
  for (const [bone, track] of rotationTracks) {
    const node = model.nodeByName.get(bone)!;
    if (node === hips && rootTrack.length > 0) continue;
    channels.push(rotationChannel(node, (t) => at(track, t, qslerp)));
  }
  if (rootTrack.length > 0) {
    const rest = model.nodes[hips]!.translation;
    const values = new Float32Array(grid.length * 3);
    grid.forEach((t, i) => {
      const r = at(rootTrack, t, mixRoot);
      values.set([rest[0] + r.x, rest[1] + r.y, rest[2] + r.z], i * 3);
    });
    channels.push({ node: hips, path: 'translation', interpolation: 'LINEAR', times: Float32Array.from(grid), values });
    const hipsPose = rotationTracks.get('Hips');
    channels.push(rotationChannel(hips, (t) => {
      const yaw = at(rootTrack, t, mixRoot).yaw;
      const own: Q = hipsPose === undefined ? [0, 0, 0, 1] : at(hipsPose, t, qslerp);
      return qmul(qeuler(0, yaw, 0), own);
    }));
  }
  return { path, rig, duration, loop, markers, clip: { name: path, duration, channels } };
}

/** Humanoid root drops bend the knees (see the module docs). */
function withKneeBends(keys: readonly Key[]): readonly Key[] {
  const posesLegs = (k: Key): boolean => LEG_BONES.some((b) => k.pose.has(b));
  if (!keys.some((k) => k.root !== null && k.root.y < 0 && !posesLegs(k))) return keys;
  const bones = HUMANOID_BONES;
  const thigh = Math.abs(bones.find((b) => b[0] === 'LeftLeg')![2][1]);
  const shin = Math.abs(bones.find((b) => b[0] === 'LeftFoot')![2][1]);
  return keys.map((k) => {
    if (k.root === null || posesLegs(k)) return k;
    const [a, b, c] = kneeBend(Math.max(0, -k.root.y), thigh, shin);
    const pose = new Map(k.pose);
    for (const side of ['Left', 'Right']) {
      pose.set(`${side}UpLeg`, [a, 0, 0]);
      pose.set(`${side}Leg`, [b, 0, 0]);
      pose.set(`${side}Foot`, [c, 0, 0]);
    }
    return { ...k, pose };
  });
}
