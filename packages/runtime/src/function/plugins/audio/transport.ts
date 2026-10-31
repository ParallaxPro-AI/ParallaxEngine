/**
 * The beat clock: a tempo map from seconds to beats, for music that the game follows (a
 * rhythm game's notes, a combat layer entering on the bar, a sting landing on the downbeat).
 *
 * Time is the audio's clock — `kernel.time.realNow`, the `time` of every AudioFrame — not
 * game time: hitstop and slow motion never shift it. While the game is paused the music is
 * held, and its beat with it (the engine runs the clock on real time less the held time) —
 * unless the track opts out with `"pauses": false`, when both keep going. Beat 0 is
 * where the track's first beat is (`offset` seconds into it); tempo changes append a
 * segment anchored where the old tempo left off, so beats and seconds never jump.
 *
 * Pure arithmetic: `collectBeats` finds the beats a frame crossed (the plugin's `beat`
 * event), `nextBoundary` the time a quantized sound starts at (sent as its `delay`).
 */

export interface TempoSegment {
  /** Beat at which the segment begins. */
  readonly beat: number;
  /** Clock seconds at that beat. */
  readonly time: number;
  readonly bpm: number;
}

export interface TempoMap {
  readonly segments: readonly TempoSegment[];
  readonly beatsPerBar: number;
}

export const MIN_BPM = 1;
export const MAX_BPM = 999;
const EPS = 1e-9;

export function tempoMap(bpm: number, anchor: number, beatsPerBar = 4): TempoMap {
  return { segments: [{ beat: 0, time: anchor, bpm }], beatsPerBar };
}

function byBeat(map: TempoMap, beat: number): TempoSegment {
  let seg = map.segments[0]!;
  for (const s of map.segments) if (s.beat <= beat + EPS) seg = s;
  return seg;
}

function byTime(map: TempoMap, time: number): TempoSegment {
  let seg = map.segments[0]!;
  for (const s of map.segments) if (s.time <= time + EPS) seg = s;
  return seg;
}

export function timeAtBeat(map: TempoMap, beat: number): number {
  const seg = byBeat(map, beat);
  return seg.time + ((beat - seg.beat) * 60) / seg.bpm;
}

export function beatAtTime(map: TempoMap, time: number): number {
  const seg = byTime(map, time);
  return seg.beat + ((time - seg.time) * seg.bpm) / 60;
}

/** The tempo in force at a time. */
export function bpmAt(map: TempoMap, time: number): number {
  return byTime(map, time).bpm;
}

/** The map with a new tempo from `time` on (continuous at the seam; a change at the last segment's start replaces its tempo). */
export function changeTempo(map: TempoMap, time: number, bpm: number): TempoMap {
  const last = map.segments[map.segments.length - 1]!;
  if (time <= last.time + EPS) {
    return { ...map, segments: [...map.segments.slice(0, -1), { ...last, bpm }] };
  }
  return { ...map, segments: [...map.segments, { beat: beatAtTime(map, time), time, bpm }] };
}

/** The first grid point at or after `beat` on a `division`-beat grid (`strict`: after). */
export function nextBoundaryBeat(beat: number, division: number, strict = false): number {
  const q = beat / division;
  return (strict ? Math.floor(q + EPS) + 1 : Math.ceil(q - EPS)) * division;
}

/** Clock seconds of the next `division`-beat boundary at or after `time`. */
export function nextBoundary(map: TempoMap, time: number, division: number): number {
  return timeAtBeat(map, nextBoundaryBeat(beatAtTime(map, time), division));
}

export interface ScheduledBeat {
  /** Whole beats since beat 0. */
  readonly beat: number;
  readonly bar: number;
  /** 0-based beat within its bar. */
  readonly beatInBar: number;
  readonly time: number;
}

export function barOf(map: TempoMap, beat: number): number {
  return Math.floor(beat / map.beatsPerBar + EPS);
}

/**
 * Whole beats from `fromBeat` whose time is at or before `until` (at most `limit`), and the
 * beat to resume from next time.
 */
export function collectBeats(map: TempoMap, fromBeat: number, until: number, limit = 64): { beats: ScheduledBeat[]; next: number } {
  const beats: ScheduledBeat[] = [];
  let b = fromBeat;
  while (beats.length < limit) {
    const time = timeAtBeat(map, b);
    if (time > until + EPS) break;
    const bar = barOf(map, b);
    beats.push({ beat: b, bar, beatInBar: b - bar * map.beatsPerBar, time });
    b++;
  }
  return { beats, next: b };
}
