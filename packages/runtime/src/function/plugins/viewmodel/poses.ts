/**
 * Viewmodel poses: keyframed camera-space offsets and turns layered on top of the procedural
 * motion (sdk/parallax/viewmodel.pyi `ViewPose`). A pose starts at rest unless its first key
 * is at 0 and ends at rest unless it holds or has a key at 1; between keys it eases
 * (smoothstep). Built-ins cover the verbs every first-person game needs; a Viewmodel's
 * `poses` replace them by name.
 */

import { Vec3 } from '../../../core/index.js';

export interface PoseKey {
  readonly at: number;
  readonly offset: Vec3;
  readonly turn: Vec3;
}

export interface PoseCue {
  readonly at: number;
  readonly name: string;
}

export interface ViewPose {
  readonly seconds: number;
  readonly keys: readonly PoseKey[];
  readonly cues: readonly PoseCue[];
  readonly hold: boolean;
}

const key = (at: number, offset: [number, number, number], turn: [number, number, number]): PoseKey =>
  ({ at, offset: new Vec3(...offset), turn: new Vec3(...turn) });

/** Turns are degrees (pitch, yaw, roll): pitch + up, yaw + right, roll (rig.ts). */
export const BUILT_IN_POSES: Readonly<Record<string, ViewPose>> = {
  draw: { seconds: 0.45, hold: false, cues: [], keys: [key(0, [0, -0.28, -0.05], [-40, 0, -12]), key(1, [0, 0, 0], [0, 0, 0])] },
  holster: { seconds: 0.4, hold: true, cues: [], keys: [key(0, [0, 0, 0], [0, 0, 0]), key(1, [0, -0.3, -0.05], [-42, 0, -12])] },
  reload: {
    seconds: 1.6, hold: false, cues: [{ at: 0.3, name: 'mag_out' }, { at: 0.65, name: 'mag_in' }],
    keys: [key(0.2, [0.02, -0.08, 0], [-10, -15, 35]), key(0.5, [0.03, -0.12, 0.02], [-18, -18, 40]), key(0.8, [0.02, -0.08, 0], [-10, -15, 35])],
  },
  inspect: {
    seconds: 2.5, hold: false, cues: [],
    keys: [key(0.2, [-0.06, 0.03, 0], [5, 35, 25]), key(0.6, [-0.04, 0.02, 0.02], [-10, 40, -30])],
  },
  throw: {
    seconds: 0.8, hold: false, cues: [{ at: 0.5, name: 'release' }],
    keys: [key(0.35, [0.05, 0.05, -0.15], [30, 0, 10]), key(0.55, [0, -0.05, 0.15], [-25, 0, 0])],
  },
  swing: {
    seconds: 0.5, hold: false, cues: [{ at: 0.45, name: 'hit' }],
    keys: [key(0.25, [0.1, 0.05, -0.05], [20, 40, 30]), key(0.5, [-0.15, -0.1, 0.15], [-20, -50, -20])],
  },
};

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** The pose's offset and turn at `t` (0..1 of its length). */
export function samplePose(pose: ViewPose, t: number): { offset: Vec3; turn: Vec3 } {
  const keys = [...pose.keys].sort((a, b) => a.at - b.at);
  const rest = (at: number): PoseKey => ({ at, offset: Vec3.ZERO, turn: Vec3.ZERO });
  if (keys.length === 0 || keys[0]!.at > 0) keys.unshift(rest(0));
  if (keys[keys.length - 1]!.at < 1) keys.push(pose.hold ? { ...keys[keys.length - 1]!, at: 1 } : rest(1));
  const x = Math.min(1, Math.max(0, t));
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1]!.at < x) i++;
  const a = keys[i]!;
  const b = keys[i + 1]!;
  const span = b.at - a.at;
  const u = span <= 0 ? 1 : smooth((x - a.at) / span);
  return { offset: a.offset.__add__(b.offset.__sub__(a.offset).__mul__(u)), turn: a.turn.__add__(b.turn.__sub__(a.turn).__mul__(u)) };
}

/** Cues passed going from `before` to `now` (fractions; a pose that just started includes 0). */
export function crossedCues(pose: ViewPose, before: number, now: number, started: boolean): string[] {
  return pose.cues.filter((c) => (started ? c.at >= before : c.at > before) && c.at <= now).sort((a, b) => a.at - b.at).map((c) => c.name);
}
