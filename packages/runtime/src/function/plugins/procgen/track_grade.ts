/**
 * The ground a race track asks for, read straight from a scene's placements (plain JSON, no
 * kernel): the procgen plugin serves it as TERRAIN_GRADING_SERVICE, and the terrain plugin bakes it into the heightfield before anything spawns, so the
 * corridor under a Track is graded (eased onto a smoothed profile along the centerline,
 * flat across) and optionally painted — the road, its run-off and its barriers sit on it,
 * and foliage that avoids the painted layer stays off it.
 *
 * A placement counts when it sets both `spline` and `track` inline with `spline.ground`
 * "terrain" and `track.grade` not null. Its control points are placed by the placement's
 * `at` and yaw (`rotation[1]`); scale is ignored. The widths follow the Track's own
 * defaults (TRACK_DEFAULTS), so the graded strip always covers the built cross-section.
 */

import type { Json, JsonObject, SceneDoc } from '../../../resource/index.js';
import type { TerrainGradePath } from '../../services/index.js';

/** The Track component's defaults that decide its footprint (schemas.ts uses these too). */
export const TRACK_DEFAULTS = {
  width: 18,
  kerbs: { on: 'corners', width: 1.1 },
  runoff: { kind: 'gravel', width: 3.5 },
  barrier: { kind: 'armco', gap: 0.5 },
  grade: { feather: 10 },
} as const;

/** Half the road, plus kerb, run-off and the gap to the barrier: where the barrier stands. */
export function trackBarrierOffset(f: {
  readonly width: number; readonly kerbs: string; readonly kerbWidth: number; readonly runoff: string; readonly runoffWidth: number; readonly barrierGap: number;
}): number {
  return f.width / 2 + (f.kerbs === 'none' ? 0 : f.kerbWidth) + (f.runoff === 'none' ? 0 : f.runoffWidth) + f.barrierGap;
}

export type TrackGradePath = TerrainGradePath;

const num = (o: JsonObject, key: string, fallback: number): number => {
  const v = o[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};
const str = (o: JsonObject, key: string, fallback: string): string => {
  const v = o[key];
  return typeof v === 'string' ? v : fallback;
};
/** A nested record of the Track (`kerbs`, `runoff`, …); absent or malformed: empty (its defaults). */
const sub = (o: JsonObject, key: string): JsonObject => {
  const v = o[key];
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? v as JsonObject : {};
};

/** Grading (and painting) paths for every graded Track placed in the scene; malformed data is skipped (procgen reports it). */
export function trackGradePaths(scene: SceneDoc): TrackGradePath[] {
  const out: TrackGradePath[] = [];
  for (const placement of scene.entities) {
    const spline = placement.components['spline'];
    const track = placement.components['track'];
    if (spline === undefined || track === undefined) continue;
    if (spline['ground'] !== 'terrain' || track['grade'] === null) continue;
    const raw = spline['points'];
    if (!Array.isArray(raw)) continue;
    const at = placement.at ?? [0, 0, 0];
    const ax = at[0] ?? 0;
    const az = at.length >= 3 ? at[2] ?? 0 : 0;
    const rotation = placement.rotation;
    const yaw = (Array.isArray(rotation) ? rotation[1] ?? 0 : 0) * Math.PI / 180;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const points: [number, number][] = [];
    for (const p of raw as Json[]) {
      if (!Array.isArray(p) || p.length < 3 || !p.every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
      const [x, , z] = p as number[];
      points.push([ax + x! * c + z! * s, az - x! * s + z! * c]);
    }
    const closed = spline['closed'] === true;
    if (points.length < (closed ? 3 : 2)) continue;
    const width = Math.max(1, num(track, 'width', TRACK_DEFAULTS.width));
    const kerbs = sub(track, 'kerbs');
    const runoff = sub(track, 'runoff');
    const gap = num(sub(track, 'barrier'), 'gap', TRACK_DEFAULTS.barrier.gap);
    const grade = sub(track, 'grade');
    const barrier = trackBarrierOffset({
      width,
      kerbs: str(kerbs, 'on', TRACK_DEFAULTS.kerbs.on),
      kerbWidth: num(kerbs, 'width', TRACK_DEFAULTS.kerbs.width),
      runoff: str(runoff, 'kind', TRACK_DEFAULTS.runoff.kind),
      runoffWidth: num(runoff, 'width', TRACK_DEFAULTS.runoff.width),
      barrierGap: gap,
    });
    const feather = Math.max(0, num(grade, 'feather', TRACK_DEFAULTS.grade.feather));
    // Flat a meter past the barrier posts, eased back to the natural ground over `feather`.
    out.push({ layer: null, points, closed, width: 2 * (barrier + 1), feather, strength: 1, flatten: { feather, offset: 0 } });
    const layer = grade['paint'];
    if (typeof layer === 'string' && layer !== '') {
      // Under the built strip (road, kerbs, run-off) and a little past it: hidden by the geometry, but the
      // terrain's layer queries (surface_at, foliage avoid) see the track.
      const shoulder = barrier - gap;
      out.push({ layer, points, closed, width: 2 * (shoulder + 0.5), feather: 2, strength: 1, flatten: null });
    }
  }
  return out;
}
