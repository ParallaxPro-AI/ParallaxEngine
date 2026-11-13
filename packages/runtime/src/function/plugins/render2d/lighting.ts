/**
 * 2D lighting from the scene's `light` components (the visuals plugin's Light, read by id):
 *
 *   point        a pool of light, (1 - d / range)² · intensity, in its color
 *   spot         the same, inside a cone of `angle` degrees around the entity's +x axis
 *   directional  no position in 2D: adds its color × intensity to the ambient light
 *
 *   light_grid   light per cell: each cell's `levels` color, blended between cell centers
 *                (a tile world's sunlight and torchlight, flood-filled by the game)
 *
 * The scene is multiplied by the light map, so lights reveal colors up to their authored
 * brightness; the ambient (the environment's, plus directional lights) is the floor. A
 * scene with no Light or LightGrid component has no lighting at all (drawn as authored).
 *
 * `lightAt` is the light map's value at a point — the surfaces draw this function
 * (Canvas2D: radial gradients with `LIGHT_FALLOFF_STOPS`), and tests check it.
 */

import { fail } from '../../../core/index.js';
import type { Light2d, LightGrid2d, Lighting2d } from '../../../core/index.js';
import type { Color } from '../../../core/index.js';
import type { Fields, World } from '../../kernel/index.js';
import { lightShare } from '../../services/index.js';
import type { ResolvedEnvironment } from '../../services/index.js';
import { angleOf } from './placement.js';
import type { Placements } from './placement.js';
import { finite } from './values.js';

export const LIGHT = 'light';
export const LIGHT_GRID = 'light_grid';

/** Each world's grids as last built, by entity: rebuilt only when their key changes. */
const GRID_CACHE = new WeakMap<World, Map<number, LightGrid2d>>();

/**
 * A light grid's cells as RGBA bytes (top row first). PP3615 for a character with no
 * level, PP3616 for a bad cell size or rows — the same codes as a tilemap's.
 */
function lightGrid(world: World, id: number, f: Fields, x: number, y: number): LightGrid2d {
  const where = `entity ${id} light_grid`;
  const size = f['cell_size'] as { x: number; y: number } | undefined;
  const offset = f['offset'] as { x: number; y: number } | undefined;
  const cellWidth = size?.x ?? NaN;
  const cellHeight = size?.y ?? NaN;
  if (!(cellWidth > 0 && cellHeight > 0)) fail('PP3616', `${where}.cell_size is (${cellWidth}, ${cellHeight}); both must be above 0`);
  const rows = f['rows'];
  if (!Array.isArray(rows) || !rows.every((r) => typeof r === 'string')) {
    fail('PP3616', `${where}.rows must be a list of strings (top row first, one character per cell)`);
  }
  const levels = (f['levels'] ?? {}) as Readonly<Record<string, unknown>>;
  const lines = rows as string[];
  const minX = x + (offset?.x ?? 0);
  const minY = y + (offset?.y ?? 0);
  const levelKey = Object.entries(levels).map(([k, c]) => `${k}${rgb(c).join(',')}`).join(';');
  const key = `${minX},${minY},${cellWidth},${cellHeight}|${levelKey}|${lines.join('\n')}`;
  let cache = GRID_CACHE.get(world);
  if (cache === undefined) GRID_CACHE.set(world, (cache = new Map()));
  const cached = cache.get(id);
  if (cached !== undefined && cached.key === key) return cached;
  const cols = lines.reduce((n, line) => Math.max(n, line.length), 0);
  const cells = new Uint8ClampedArray(cols * lines.length * 4);
  const bytes = new Map<string, readonly [number, number, number]>();
  for (const [k, c] of Object.entries(levels)) bytes.set(k, rgb(c).map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255)) as [number, number, number]);
  lines.forEach((line, row) => {
    for (let col = 0; col < cols; col++) {
      const i = (row * cols + col) * 4;
      cells[i + 3] = 255;
      const ch = line[col];
      if (ch === undefined || ch === ' ' || ch === '.') continue;
      const b = bytes.get(ch);
      if (b === undefined) {
        fail('PP3615', `${where}.rows[${row}] column ${col} is "${ch}", which is not in levels`, {
          fix: `Levels: ${Object.keys(levels).map((k) => `"${k}"`).join(', ') || '(none)'}; use " " or "." for an unlit cell.`,
        });
      }
      cells[i] = b[0];
      cells[i + 1] = b[1];
      cells[i + 2] = b[2];
    }
  });
  const grid: LightGrid2d = { key, minX, minY, cellWidth, cellHeight, cols, rows: lines.length, cells, entity: id };
  cache.set(id, grid);
  return grid;
}

/** Ambient light when the scene has no environment provider. */
export const DEFAULT_AMBIENT_2D: readonly [number, number, number] = [0.25, 0.25, 0.3];

function rgb(value: unknown): [number, number, number] {
  const c = value as Color;
  return [c.r, c.g, c.b];
}

/**
 * The frame's lighting, or null when no visible entity has a Light. A light's `when` scales
 * its intensity by the environment's day/night (`lightShare`); one that is out still counts
 * (the scene stays lit by its ambient, dark at night).
 */
export function lighting2d(
  world: World, placements: Placements, ambient: readonly [number, number, number] | undefined,
  environment?: Pick<ResolvedEnvironment, 'isNight' | 'night'>,
): Lighting2d | null {
  const lights: Light2d[] = [];
  const grids: LightGrid2d[] = [];
  const base = [...(ambient ?? DEFAULT_AMBIENT_2D)] as [number, number, number];
  let any = false;
  for (const [id, grid] of world.query([LIGHT_GRID])) {
    const at = placements.of(world.get(id)!);
    if (!at.visible) continue;
    any = true;
    grids.push(lightGrid(world, id, grid as Fields, at.m[4], at.m[5]));
  }
  for (const [id, light] of world.query([LIGHT])) {
    const record = world.get(id)!;
    const at = placements.of(record);
    if (!at.visible) continue;
    any = true;
    const f = light as Fields;
    const color = rgb(f['color']);
    const intensity = finite(f['intensity'], `entity ${id} light.intensity`) * lightShare(f['when'], environment);
    if (intensity <= 0) continue;
    if (f['kind'] === 'directional') {
      for (let k = 0; k < 3; k++) base[k] = base[k]! + color[k]! * intensity;
      continue;
    }
    lights.push({
      kind: f['kind'] === 'spot' ? 'spot' : 'point',
      x: at.m[4], y: at.m[5], color, intensity,
      radius: finite(f['range'], `entity ${id} light.range`),
      direction: angleOf(at.m),
      cone: finite(f['angle'], `entity ${id} light.angle`),
      ...(typeof f['inner_angle'] === 'number' && { inner: Math.min(f['inner_angle'], finite(f['angle'], `entity ${id} light.angle`)) }),
      entity: id,
    });
  }
  return any ? { ambient: base, lights, ...(grids.length > 0 && { grids }) } : null;
}

/** Strength of one light at a world point (0..intensity), before its color. */
export function lightFalloff(light: Light2d, x: number, y: number): number {
  const dx = x - light.x;
  const dy = y - light.y;
  const d = Math.hypot(dx, dy);
  if (light.radius <= 0 || d >= light.radius) return 0;
  if (light.kind === 'spot' && d > 0) {
    const toward = (Math.atan2(dy, dx) * 180) / Math.PI;
    const off = Math.abs(((toward - light.direction + 540) % 360) - 180);
    if (off > light.cone / 2) return 0;
    const inner = light.inner;
    if (inner !== undefined && off > inner / 2) {
      const f = 1 - d / light.radius;
      const edge = 1 - (off - inner / 2) / Math.max(1e-6, (light.cone - inner) / 2);
      return f * f * light.intensity * edge * edge * (3 - 2 * edge);
    }
  }
  const f = 1 - d / light.radius;
  return f * f * light.intensity;
}

/** A light grid's color at a world point (0..1 per channel): bilinear between cell centers, clamped at the edges; 0 outside. */
export function gridLightAt(grid: LightGrid2d, x: number, y: number): [number, number, number] {
  const w = grid.cols * grid.cellWidth;
  const h = grid.rows * grid.cellHeight;
  if (grid.cols === 0 || grid.rows === 0 || x < grid.minX || y < grid.minY || x > grid.minX + w || y > grid.minY + h) return [0, 0, 0];
  // Image space: u right, v down from the top row.
  const u = Math.min(grid.cols - 1, Math.max(0, (x - grid.minX) / grid.cellWidth - 0.5));
  const v = Math.min(grid.rows - 1, Math.max(0, (grid.minY + h - y) / grid.cellHeight - 0.5));
  const c0 = Math.floor(u);
  const r0 = Math.floor(v);
  const c1 = Math.min(grid.cols - 1, c0 + 1);
  const r1 = Math.min(grid.rows - 1, r0 + 1);
  const fu = u - c0;
  const fv = v - r0;
  const at = (c: number, r: number, k: number): number => grid.cells[(r * grid.cols + c) * 4 + k]! / 255;
  const out: [number, number, number] = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const top = at(c0, r0, k) * (1 - fu) + at(c1, r0, k) * fu;
    const bottom = at(c0, r1, k) * (1 - fu) + at(c1, r1, k) * fu;
    out[k] = top * (1 - fv) + bottom * fv;
  }
  return out;
}

/** The light map at a world point: ambient plus every light grid and light, per channel, clamped to 1. */
export function lightAt(lighting: Lighting2d, x: number, y: number): [number, number, number] {
  const out: [number, number, number] = [lighting.ambient[0], lighting.ambient[1], lighting.ambient[2]];
  for (const grid of lighting.grids ?? []) {
    const g = gridLightAt(grid, x, y);
    for (let k = 0; k < 3; k++) out[k] = out[k]! + g[k]!;
  }
  for (const light of lighting.lights) {
    const s = lightFalloff(light, x, y);
    for (let k = 0; k < 3; k++) out[k] = out[k]! + light.color[k]! * s;
  }
  return [Math.min(1, out[0]), Math.min(1, out[1]), Math.min(1, out[2])];
}
