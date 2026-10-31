/**
 * CPU animation sampling: a model's pose at an animator's playback (clip, time, crossfade),
 * its nodes' model-space matrices, and the bone palettes the GPU skins with.
 *
 * A pose is `POSE_STRIDE` numbers per node: translation (3), rotation quaternion (4),
 * scale (3). Clip time wraps for looping clips and holds at the ends otherwise. Layers,
 * retargeting and IK build on these (`animation_pose.ts`).
 */

import type { Clip, ClipChannel, ModelAsset, ModelSkin } from './gltf.js';
import { POSE_STRIDE } from './animation_math.js';
import { compose, multiply, slerp } from './matrix.js';

export { POSE_STRIDE } from './animation_math.js';

export function restPose(model: ModelAsset): Float32Array {
  const pose = new Float32Array(model.nodes.length * POSE_STRIDE);
  model.nodes.forEach((node, i) => {
    pose.set(node.translation, i * POSE_STRIDE);
    pose.set(node.rotation, i * POSE_STRIDE + 3);
    pose.set(node.scale, i * POSE_STRIDE + 7);
  });
  return pose;
}

/**
 * Clip-source node → target node, matched by exact name; null when the clip belongs to
 * the model. This copies local transforms, which is right only between rigs that share a
 * bind pose; animators retarget with `animation_retarget.ts`, which accounts for it.
 */
export function retarget(target: ModelAsset, source: ModelAsset): Int32Array | null {
  if (target === source) return null;
  const map = new Int32Array(source.nodes.length).fill(-1);
  source.nodes.forEach((node, i) => {
    const t = target.nodeByName.get(node.name);
    if (node.name !== '' && t !== undefined) map[i] = t;
  });
  return map;
}

/** Clip time for `time` seconds of playback: wrapped when looping, clamped otherwise. */
export function clipTime(clip: Clip, time: number, loop: boolean): number {
  if (clip.duration <= 0) return 0;
  if (!loop) return Math.min(Math.max(time, 0), clip.duration);
  const t = time % clip.duration;
  return t < 0 ? t + clip.duration : t;
}

function sampleChannel(channel: ClipChannel, t: number, out: Float32Array, o: number): void {
  const { times, values, interpolation } = channel;
  const width = channel.path === 'rotation' ? 4 : 3;
  const cubic = interpolation === 'CUBICSPLINE';
  const valueAt = (k: number, c: number): number => (cubic ? values[(k * 3 + 1) * width + c]! : values[k * width + c]!);
  const n = times.length;
  if (n === 0) return;
  if (n === 1 || t <= times[0]!) {
    for (let c = 0; c < width; c++) out[o + c] = valueAt(0, c);
    return;
  }
  if (t >= times[n - 1]!) {
    for (let c = 0; c < width; c++) out[o + c] = valueAt(n - 1, c);
    return;
  }
  // Binary search for the key at or before t.
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid;
  }
  const t0 = times[lo]!;
  const dt = times[hi]! - t0;
  const u = dt > 0 ? (t - t0) / dt : 0;
  if (interpolation === 'STEP') {
    for (let c = 0; c < width; c++) out[o + c] = valueAt(lo, c);
    return;
  }
  if (cubic) {
    const u2 = u * u;
    const u3 = u2 * u;
    const h00 = 2 * u3 - 3 * u2 + 1;
    const h10 = u3 - 2 * u2 + u;
    const h01 = -2 * u3 + 3 * u2;
    const h11 = u3 - u2;
    for (let c = 0; c < width; c++) {
      const p0 = valueAt(lo, c);
      const m0 = values[(lo * 3 + 2) * width + c]! * dt;
      const p1 = valueAt(hi, c);
      const m1 = values[(hi * 3) * width + c]! * dt;
      out[o + c] = h00 * p0 + h10 * m0 + h01 * p1 + h11 * m1;
    }
    if (width === 4) {
      const l = Math.hypot(out[o]!, out[o + 1]!, out[o + 2]!, out[o + 3]!) || 1;
      for (let c = 0; c < 4; c++) out[o + c] = out[o + c]! / l;
    }
    return;
  }
  if (width === 4) {
    slerp(values, lo * 4, values, hi * 4, u, out, o);
    return;
  }
  for (let c = 0; c < 3; c++) out[o + c] = values[lo * 3 + c]! + (values[hi * 3 + c]! - values[lo * 3 + c]!) * u;
}

/**
 * Write a clip's pose at `time` (clip seconds, already wrapped) over `pose` (nodes the
 * clip doesn't animate keep what `pose` holds). `map` retargets another model's clip.
 */
export function sampleClip(clip: Clip, time: number, pose: Float32Array, map: Int32Array | null): void {
  for (const channel of clip.channels) {
    const node = map === null ? channel.node : map[channel.node]!;
    if (node < 0) continue;
    const offset = node * POSE_STRIDE + (channel.path === 'translation' ? 0 : channel.path === 'rotation' ? 3 : 7);
    sampleChannel(channel, time, pose, offset);
  }
}

/** out = a crossfaded into b by w (0: a, 1: b). */
export function blendPoses(a: Float32Array, b: Float32Array, w: number, out: Float32Array): void {
  for (let i = 0; i < a.length; i += POSE_STRIDE) {
    for (let c = 0; c < 3; c++) out[i + c] = a[i + c]! + (b[i + c]! - a[i + c]!) * w;
    slerp(a, i + 3, b, i + 3, w, out, i + 3);
    for (let c = 7; c < 10; c++) out[i + c] = a[i + c]! + (b[i + c]! - a[i + c]!) * w;
  }
}

/** Every node's model-space matrix (16 numbers per node) for a pose. Unreached nodes stay zero. */
export function nodeMatrices(model: ModelAsset, pose: Float32Array): Float32Array {
  const worlds = new Float32Array(model.nodes.length * 16);
  const local = new Float32Array(16);
  for (const i of model.order) {
    const p = i * POSE_STRIDE;
    compose(pose[p]!, pose[p + 1]!, pose[p + 2]!, pose[p + 3]!, pose[p + 4]!, pose[p + 5]!, pose[p + 6]!, pose[p + 7]!, pose[p + 8]!, pose[p + 9]!, local);
    const parent = model.nodes[i]!.parent;
    const target = worlds.subarray(i * 16, i * 16 + 16);
    if (parent === -1) target.set(local);
    else multiply(worlds.subarray(parent * 16, parent * 16 + 16), local, target);
  }
  return worlds;
}

/** A skin's bone palette: joint model-space matrix × inverse bind matrix, 16 numbers per joint. */
export function skinPalette(skin: ModelSkin, worlds: Float32Array): Float32Array {
  const palette = new Float32Array(skin.joints.length * 16);
  skin.joints.forEach((joint, j) => {
    multiply(worlds.subarray(joint * 16, joint * 16 + 16), skin.inverseBind.subarray(j * 16, j * 16 + 16), palette.subarray(j * 16, j * 16 + 16));
  });
  return palette;
}
