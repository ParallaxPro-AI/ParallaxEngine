/**
 * Clip timelines (pure): which markers playback crosses between two clip times, and how
 * far the root bone travels — both exact across loop wraps, however many a step covers.
 *
 * Playback time is unwrapped clip seconds (it only grows); a looping clip repeats every
 * `duration`, a one-shot holds at its end. A step covers the half-open interval
 * (from, to]; a clip's first step also covers time 0 (`fromStart`), so a marker at 0 fires
 * when the clip starts and again on every wrap, never twice.
 */

import type { ClipMarker, RootSample } from '../../services/index.js';

/** Most loop cycles one step scans; past it the step is a seek, not playback. */
const MAX_CYCLES = 64;

/**
 * Clip times are sums of frame steps (1/60 + 1/60 + … is not exactly 0.5): every
 * comparison treats times within this of each other as equal, the same way at both ends
 * of a step, so a marker fires on the frame that reaches it and never twice.
 */
export const TIME_EPSILON = 1e-7;

export function crossedMarkers(
  markers: readonly ClipMarker[], from: number, to: number, duration: number, loop: boolean, fromStart: boolean,
): ClipMarker[] {
  if (markers.length === 0 || to < from) return [];
  const inWindow = (t: number, lo: number, hi: number, closedLo: boolean): boolean =>
    (closedLo ? t >= lo - TIME_EPSILON : t > lo + TIME_EPSILON) && t <= hi + TIME_EPSILON;
  if (!loop || duration <= 0) {
    const end = Math.min(to, Math.max(duration, 0));
    const start = Math.min(from, Math.max(duration, 0));
    return markers.filter((m) => m.time <= Math.max(duration, 0) && inWindow(m.time, start, end, fromStart));
  }
  const first = Math.floor((from + TIME_EPSILON) / duration);
  const last = Math.min(Math.floor((to + TIME_EPSILON) / duration), first + MAX_CYCLES);
  const timed: [number, ClipMarker][] = [];
  for (let cycle = first; cycle <= last; cycle++) {
    for (const m of markers) {
      // Past the end: never reached. At the very end: the same instant as the next cycle's start.
      if (m.time > duration) continue;
      const t = cycle * duration + (m.time === duration ? 0 : m.time);
      if (inWindow(t, from, to, fromStart && cycle === first)) timed.push([t, m]);
    }
  }
  // In playback order (stable for markers at one instant).
  timed.sort((a, b) => a[0] - b[0]);
  return timed.map(([, m]) => m);
}

/** Shortest signed difference b − a in degrees, in (−180, 180]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % 360;
  if (d > 180) d -= 360;
  else if (d <= -180) d += 360;
  return d;
}

export interface RootDelta {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly yaw: number;
}

export const NO_MOTION: RootDelta = { x: 0, y: 0, z: 0, yaw: 0 };

/**
 * The root's travel from `from` to `to` (unwrapped clip seconds). A looping clip adds one
 * whole cycle's travel (end − start) per wrap, so a walk keeps walking.
 */
export function rootTravel(sample: (time: number) => RootSample, from: number, to: number, duration: number, loop: boolean): RootDelta {
  if (to <= from) return NO_MOTION;
  const diff = (a: RootSample, b: RootSample): RootDelta => ({ x: b.x - a.x, y: b.y - a.y, z: b.z - a.z, yaw: angleDelta(a.yaw, b.yaw) });
  if (!loop || duration <= 0) {
    const end = Math.max(duration, 0);
    return diff(sample(Math.min(from, end)), sample(Math.min(to, end)));
  }
  const wraps = Math.floor(to / duration) - Math.floor(from / duration);
  const local = (t: number): number => t - Math.floor(t / duration) * duration;
  const head = diff(sample(local(from)), sample(local(to)));
  if (wraps === 0) return head;
  const cycle = diff(sample(0), sample(duration));
  return { x: head.x + wraps * cycle.x, y: head.y + wraps * cycle.y, z: head.z + wraps * cycle.z, yaw: head.yaw + wraps * cycle.yaw };
}
