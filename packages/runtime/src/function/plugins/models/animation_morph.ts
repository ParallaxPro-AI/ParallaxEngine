/**
 * Morph target weight channels (glTF `weights` animation paths) sampled at a clip time:
 * LINEAR, STEP and CUBICSPLINE, one value per target. `Poses.morphs` blends them by layer.
 */

import type { MorphChannel } from '../../../resource/index.js';

/** A channel's weights at clip time `t` (seconds) into `out` (its `count` targets). */
export function sampleMorphChannel(channel: MorphChannel, t: number, out: Float32Array | number[]): void {
  const { times, values, count, interpolation } = channel;
  const cubic = interpolation === 'CUBICSPLINE';
  const valueAt = (k: number, c: number): number => (cubic ? values[(k * 3 + 1) * count + c]! : values[k * count + c]!);
  const n = times.length;
  if (n === 0) return;
  if (n === 1 || t <= times[0]!) {
    for (let c = 0; c < count; c++) out[c] = valueAt(0, c);
    return;
  }
  if (t >= times[n - 1]!) {
    for (let c = 0; c < count; c++) out[c] = valueAt(n - 1, c);
    return;
  }
  let k = 0;
  while (k + 1 < n && times[k + 1]! <= t) k++;
  const t0 = times[k]!;
  const dt = times[k + 1]! - t0;
  const u = dt > 0 ? (t - t0) / dt : 0;
  for (let c = 0; c < count; c++) {
    if (interpolation === 'STEP') out[c] = valueAt(k, c);
    else if (!cubic) out[c] = valueAt(k, c) + (valueAt(k + 1, c) - valueAt(k, c)) * u;
    else {
      const p0 = valueAt(k, c);
      const p1 = valueAt(k + 1, c);
      const m0 = values[(k * 3 + 2) * count + c]! * dt;
      const m1 = values[((k + 1) * 3) * count + c]! * dt;
      const u2 = u * u;
      const u3 = u2 * u;
      out[c] = (2 * u3 - 3 * u2 + 1) * p0 + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * p1 + (u3 - u2) * m1;
    }
  }
}

