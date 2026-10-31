/**
 * The minimap's base map, derived from the scene rather than authored: every static thing
 * with a footprint (a Shape, or a non-trigger Collider) on an entity that doesn't move by
 * itself, the terrain's heightfield, and whatever placements say about themselves with
 * `MapFeature` (roads, water, a race path joined in `order`, or `hidden`), and the scene's
 * generated city when the city plugin is present (blocks, parks, buildings, streets drawn
 * as a street map: avenues brighter and wider than side streets). The result is
 * one SVG image (a data URI) in world units, drawn once per scene and moved under the
 * map's window each frame — so a frame costs a few numbers, not a redraw.
 *
 * Plane: 3D maps look down on (x, z) with +z up the image (north); 2D maps use (x, y).
 *
 * The look is the old engine's: a muted gray street-map palette where only the blips are
 * saturated, hill-shaded terrain (paved ground in the city's tones, not the height ramp's
 * grass), and strokes (streets, the race path) that never thin
 * below a readable pixel width however far the map is zoomed out.
 */

import { Color, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { EntityRecord, Kernel } from '../../kernel/index.js';
import { CITY_SERVICE, TERRAIN_SERVICE } from '../../services/index.js';
import type { CityMap, CityMapPoint, TerrainField } from '../../services/index.js';
import { css } from './project.js';
import { COLLIDER, MAP_FEATURE, MAP_ICON, MOVERS, SHAPE } from './schemas.js';
import type { MapFeatureKind } from './schemas.js';

export interface BaseMap {
  /** `data:image/svg+xml` of the map, covering [minU, maxU] × [minV, maxV]. */
  readonly uri: string;
  readonly minU: number;
  readonly minV: number;
  readonly maxU: number;
  readonly maxV: number;
  /** Footprints drawn (for tests and diagnostics). */
  readonly shapes: number;
  /** The city plan it drew (null: none), so a changed city redraws the map. */
  readonly city: CityMap | null;
}

type Kind = Exclude<MapFeatureKind, 'hidden' | 'path'>;

const KIND_COLORS: Readonly<Record<Exclude<MapFeatureKind, 'hidden'>, Color>> = {
  floor: Color.hex('#3c4454'),
  solid: Color.hex('#8e97a8'),
  road: Color.hex('#6b7688'),
  water: Color.hex('#1b3b58'),
  path: Color.hex('#d7dde6'),
};
/** The city layer: ground, built-up fabric a step above it, streets in a hierarchy. */
const CITY_COLORS = {
  block: '#30363f',
  park: '#33402f',
  building: '#3a414c',
  street: '#6b7688',
  avenue: '#a8b3c3',
} as const;
/** The thinnest a stroke gets on screen (CSS px), whatever the zoom. */
const MIN_PX = { street: 1.5, avenue: 2.5, path: 2.5 } as const;
/** Draw order, bottom first. */
const LAYERS: readonly Kind[] = ['floor', 'water', 'road', 'solid'];
/** A footprint this flat (meters) reads as floor, not an obstacle. */
const FLAT = 0.5;
const TERRAIN_SAMPLES = 48;
const TERRAIN_LEVELS = 10;
const SHADE_LEVELS = 3;
/** Height (0..1) → ground colour: grass, soil, rock, snow. */
const TERRAIN_RAMP: readonly (readonly [number, Color])[] = [
  [0, Color.hex('#3f5330')], [0.4, Color.hex('#5d4d36')], [0.75, Color.hex('#5c5c60')], [1, Color.hex('#cfd8e0')],
];

/** Paved terrain layers by name (the terrain's common ground names) draw in the city's
 *  ground tone (a layer named "road" as a street), so a hand-built town reads like the
 *  generated one rather than as grass on the height ramp. */
const CITY_STREET_LAYER = 'road';
const PAVED: Readonly<Record<string, string>> = {
  road: CITY_COLORS.street,
  asphalt: CITY_COLORS.block, tarmac: CITY_COLORS.block, pavement: CITY_COLORS.block, concrete: CITY_COLORS.block,
  plaza: CITY_COLORS.block, cobble: CITY_COLORS.block, cobblestone: CITY_COLORS.block,
};

interface Footprint {
  readonly kind: Kind;
  readonly color: Color;
  /** A polygon (u, v pairs) or an ellipse. */
  readonly polygon?: readonly (readonly [number, number])[];
  readonly ellipse?: { readonly u: number; readonly v: number; readonly ru: number; readonly rv: number; readonly turn: number };
}

interface PathNode {
  readonly order: number;
  readonly u: number;
  readonly v: number;
  readonly width: number;
  readonly loop: boolean;
  readonly color: Color;
}

const ROUND = new Set(['sphere', 'capsule', 'cylinder', 'cone', 'circle', 'ring']);

function num(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** The point's map-plane coordinates. */
export function planeOf(dimension: '2d' | '3d', p: Vec3): [number, number] {
  return dimension === '3d' ? [p.x, p.z] : [p.x, p.y];
}

export class BaseMapBuilder {
  readonly #kernel: Kernel;
  readonly #dimension: '2d' | '3d';

  constructor(kernel: Kernel, dimension: '2d' | '3d') {
    this.#kernel = kernel;
    this.#dimension = dimension;
  }

  /** Whether an entity can change the base map (so adding / removing it rebuilds it). */
  static contributes(record: EntityRecord): boolean {
    if (record.components.has(MAP_FEATURE)) return true;
    if (record.components.has(MAP_ICON) || MOVERS.some((m) => record.components.has(m))) return false;
    const collider = record.components.get(COLLIDER);
    return record.components.has(SHAPE) || (collider !== undefined && collider['trigger'] !== true);
  }

  build(entities: Iterable<EntityId>): BaseMap | null {
    const footprints: Footprint[] = [];
    const path: PathNode[] = [];
    for (const id of entities) {
      const record = this.#kernel.world.get(id);
      if (record === undefined || !BaseMapBuilder.contributes(record)) continue;
      const feature = record.components.get(MAP_FEATURE);
      const kind = (feature?.['kind'] ?? undefined) as MapFeatureKind | undefined;
      if (kind === 'hidden') continue;
      if (kind === 'path') {
        const [u, v] = planeOf(this.#dimension, record.transform.worldPosition());
        path.push({
          order: feature!['order'] as number, u, v, width: feature!['width'] as number, loop: feature!['loop'] === true,
          color: (feature!['color'] as Color | null) ?? KIND_COLORS.path,
        });
        continue;
      }
      const print = this.#footprint(record, kind, (feature?.['color'] ?? null) as Color | null);
      if (print !== undefined) footprints.push(print);
    }
    path.sort((a, b) => a.order - b.order);
    const terrain = this.#dimension === '3d' ? this.#kernel.tryService(TERRAIN_SERVICE)?.current() ?? null : null;
    const city = this.#dimension === '3d' ? this.#kernel.tryService(CITY_SERVICE)?.map() ?? null : null;

    let minU = Infinity;
    let minV = Infinity;
    let maxU = -Infinity;
    let maxV = -Infinity;
    const grow = (u: number, v: number, pad = 0): void => {
      minU = Math.min(minU, u - pad); maxU = Math.max(maxU, u + pad);
      minV = Math.min(minV, v - pad); maxV = Math.max(maxV, v + pad);
    };
    for (const f of footprints) {
      if (f.polygon !== undefined) for (const [u, v] of f.polygon) grow(u, v);
      else if (f.ellipse !== undefined) grow(f.ellipse.u, f.ellipse.v, Math.max(f.ellipse.ru, f.ellipse.rv));
    }
    for (const n of path) grow(n.u, n.v, n.width);
    if (terrain !== null) {
      grow(terrain.minX, terrain.minZ);
      grow(terrain.minX + terrain.width, terrain.minZ + terrain.depth);
    }
    if (city !== null) {
      grow(city.bounds[0], city.bounds[1]);
      grow(city.bounds[2], city.bounds[3]);
    }
    if (!Number.isFinite(minU)) return null;
    const margin = Math.max(2, 0.04 * Math.max(maxU - minU, maxV - minV));
    minU -= margin; minV -= margin; maxU += margin; maxV += margin;

    const parts: string[] = [];
    if (terrain !== null) parts.push(this.#terrain(terrain), terrainPaths(terrain));
    for (const layer of LAYERS) {
      for (const f of footprints) if (f.kind === layer) parts.push(this.#draw(f));
      if (layer === 'water' && city !== null) parts.push(cityLayer(city));
    }
    if (path.length >= 2) {
      const width = path[0]!.width;
      const points = path.map((n) => `${num(n.u)},${num(-n.v)}`);
      if (path.some((n) => n.loop)) points.push(points[0]!);
      const color = path[0]!.color;
      const line = (stroke: string, w: string, extra = ''): string =>
        `<polyline points="${points.join(' ')}" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"${extra}/>`;
      parts.push(line(css(new Color(color.r, color.g, color.b, color.a * 0.22)), num(width * 2.1)));
      parts.push(line(css(color), num(width)));
      parts.push(line(css(color), String(MIN_PX.path), ' vector-effect="non-scaling-stroke"'));
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(minU)} ${num(-maxV)} ${num(maxU - minU)} ${num(maxV - minV)}" preserveAspectRatio="none">${parts.join('')}</svg>`;
    return {
      uri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, minU, minV, maxU, maxV,
      shapes: footprints.length + (path.length >= 2 ? 1 : 0), city,
    };
  }

  #footprint(record: EntityRecord, featureKind: Kind | undefined, featureColor: Color | null): Footprint | undefined {
    const shape = record.components.get(SHAPE);
    const collider = record.components.get(COLLIDER);
    const scale = record.transform.worldScale();
    let kindName: string;
    let size: Vec3;
    let offset: Vec3;
    let color: Color | null = null;
    if (shape !== undefined) {
      kindName = shape['kind'] as string;
      size = shape['size'] as Vec3;
      offset = shape['offset'] as Vec3;
      color = shape['color'] as Color;
    } else if (collider !== undefined && collider['trigger'] !== true) {
      kindName = collider['shape'] as string;
      offset = collider['offset'] as Vec3;
      if (kindName === 'box') size = collider['size'] as Vec3;
      else {
        const r = (collider['radius'] as number) * 2;
        size = new Vec3(r, (collider['height'] as number | undefined) ?? r, r);
      }
      if (kindName === 'mesh' || kindName === 'convex') return undefined; // no footprint without the model's geometry
    } else {
      return undefined;
    }
    const full = new Vec3(size.x * scale.x, size.y * scale.y, size.z * scale.z);
    const height = this.#dimension === '3d' ? (kindName === 'plane' ? 0 : full.y) : Infinity;
    const kind: Kind = featureKind ?? (height <= FLAT ? 'floor' : 'solid');
    const base = KIND_COLORS[kind];
    const fill = featureColor ?? (color !== null && (kind === 'solid' || kind === 'floor') ? base.lerp(color, 0.6) : base);
    const rotation = record.transform.worldRotation();
    const center = record.transform.worldPosition().__add__(rotation.rotate(new Vec3(offset.x * scale.x, offset.y * scale.y, offset.z * scale.z)));
    const [cu, cv] = planeOf(this.#dimension, center);
    const [hu, hv] = this.#dimension === '3d' ? [full.x / 2, full.z / 2] : [full.x / 2, full.y / 2];
    if (ROUND.has(kindName)) {
      const [au, av] = planeOf(this.#dimension, rotation.rotate(Vec3.RIGHT));
      return { kind, color: fill, ellipse: { u: cu, v: cv, ru: hu, rv: hv, turn: (Math.atan2(av, au) * 180) / Math.PI } };
    }
    const corners: [number, number][] = [[-hu, -hv], [hu, -hv], [hu, hv], [-hu, hv]];
    const polygon = corners.map(([du, dv]) => {
      const local = this.#dimension === '3d' ? new Vec3(du, 0, dv) : new Vec3(du, dv, 0);
      return planeOf(this.#dimension, center.__add__(rotation.rotate(local)));
    });
    return { kind, color: fill, polygon };
  }

  #draw(f: Footprint): string {
    const fill = css(f.color);
    if (f.polygon !== undefined) return `<polygon points="${f.polygon.map(([u, v]) => `${num(u)},${num(-v)}`).join(' ')}" fill="${fill}"/>`;
    const e = f.ellipse!;
    return `<ellipse cx="${num(e.u)}" cy="${num(-e.v)}" rx="${num(e.ru)}" ry="${num(e.rv)}" transform="rotate(${num(-e.turn)} ${num(e.u)} ${num(-e.v)})" fill="${fill}"/>`;
  }

  /** The heightfield tinted by height and hill-shaded by slope (light from the north-west),
   *  water below the water level; rows run-length merged. */
  #terrain(field: TerrainField): string {
    const n = Math.max(2, Math.min(TERRAIN_SAMPLES, field.columns, field.rows));
    const du = field.width / n;
    const dv = field.depth / n;
    const span = Math.max(1e-6, field.maxHeight - field.minHeight);
    const water = KIND_COLORS.water;
    const paved = new Map<string, Color>();
    for (const layer of field.layers) {
      const tone = Object.prototype.hasOwnProperty.call(PAVED, layer.name) ? PAVED[layer.name] : undefined;
      if (tone !== undefined) paved.set(layer.name, Color.hex(tone));
    }
    const shade = (x: number, z: number): Color => {
      const h = field.heightAt(x, z);
      if (field.waterLevel !== null && h < field.waterLevel) return water;
      const ground = paved.size > 0 ? paved.get(field.surfaceAt(x, z)) : undefined;
      if (ground !== undefined) return ground;
      const t = Math.round(((h - field.minHeight) / span) * TERRAIN_LEVELS) / TERRAIN_LEVELS;
      let i = 0;
      while (i < TERRAIN_RAMP.length - 2 && t > TERRAIN_RAMP[i + 1]![0]) i++;
      const [t0, c0] = TERRAIN_RAMP[i]!;
      const [t1, c1] = TERRAIN_RAMP[i + 1]!;
      const tint = c0.lerp(c1, Math.max(0, Math.min(1, (t - t0) / (t1 - t0))));
      // Slope toward the north-west light, in cell units: lit faces lighten, far faces darken.
      const dx = field.heightAt(Math.min(x + du, field.minX + field.width), z) - field.heightAt(Math.max(x - du, field.minX), z);
      const dz = field.heightAt(x, Math.min(z + dv, field.minZ + field.depth)) - field.heightAt(x, Math.max(z - dv, field.minZ));
      const lit = Math.round(Math.max(-1, Math.min(1, ((dx / du) - (dz / dv)) * 0.5)) * SHADE_LEVELS) / SHADE_LEVELS;
      return lit >= 0 ? tint.lerp(Color.WHITE, lit * 0.18) : tint.lerp(Color.BLACK, -lit * 0.35);
    };
    const out: string[] = [];
    for (let r = 0; r < n; r++) {
      const v0 = field.minZ + r * dv;
      let start = 0;
      let current = '';
      const flush = (end: number): void => {
        if (current === '') return;
        out.push(`<rect x="${num(field.minX + start * du)}" y="${num(-(v0 + dv))}" width="${num((end - start) * du + 0.01)}" height="${num(dv + 0.01)}" fill="${current}"/>`);
      };
      for (let c = 0; c < n; c++) {
        const x = Math.min(field.minX + (c + 0.5) * du, field.minX + field.width);
        const z = Math.min(v0 + 0.5 * dv, field.minZ + field.depth);
        const fill = css(shade(x, z));
        if (fill !== current) {
          flush(c);
          start = c;
          current = fill;
        }
      }
      flush(n);
    }
    return out.join('');
  }
}

/** The terrain's paved paths (a layer named like a road: see PAVED) as street strokes, at
 *  their width and at the street minimum on screen — the height raster is far too coarse
 *  to show a 10 m road. Only paths painting a distinct street layer ("road") stand out; a
 *  path in the same tone as the paved ground around it draws nothing new. */
function terrainPaths(field: TerrainField): string {
  const out: string[] = [];
  for (const p of field.paths) {
    if (p.paint !== CITY_STREET_LAYER || p.points.length < 2) continue;
    const pts = p.points.map(([x, z]) => `${num(x)},${num(-z)}`);
    if (p.closed) pts.push(pts[0]!);
    const d = `M${pts.join('L')}`;
    out.push(`<path d="${d}" fill="none" stroke="${CITY_COLORS.street}" stroke-width="${num(p.width)}" stroke-linecap="round" stroke-linejoin="round"/>`);
    out.push(`<path d="${d}" fill="none" stroke="${CITY_COLORS.street}" stroke-width="${MIN_PX.street}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>`);
  }
  return out.join('');
}

function polygons(list: readonly (readonly CityMapPoint[])[], fill: string): string {
  if (list.length === 0) return '';
  const d = list.map((q) => `M${q.map(([x, z]) => `${num(x)},${num(-z)}`).join('L')}Z`).join('');
  return `<path d="${d}" fill="${fill}"/>`;
}

/** The city plan: blocks, parks, buildings, then side streets under avenues. Each street
 *  class is stroked twice in one colour — at its real width and at a minimum screen width —
 *  so it reads as a street both zoomed in and on a whole-city view. */
function cityLayer(city: CityMap): string {
  const out = [polygons(city.blocks, CITY_COLORS.block), polygons(city.parks, CITY_COLORS.park), polygons(city.buildings, CITY_COLORS.building)];
  for (const major of [false, true]) {
    const byWidth = new Map<string, string[]>();
    for (const s of city.streets) {
      if (s.major !== major) continue;
      const w = num(s.width);
      let list = byWidth.get(w);
      if (list === undefined) byWidth.set(w, (list = []));
      list.push(`M${num(s.a[0])},${num(-s.a[1])}L${num(s.b[0])},${num(-s.b[1])}`);
    }
    if (byWidth.size === 0) continue;
    const color = major ? CITY_COLORS.avenue : CITY_COLORS.street;
    const all: string[] = [];
    for (const [w, segs] of byWidth) {
      out.push(`<path d="${segs.join('')}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`);
      all.push(...segs);
    }
    out.push(`<path d="${all.join('')}" fill="none" stroke="${color}" stroke-width="${major ? MIN_PX.avenue : MIN_PX.street}" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`);
  }
  return out.join('');
}

/** A viewer entity's heading in degrees (0 = north, 90 = east) on the map plane. */
export function headingOf(dimension: '2d' | '3d', record: EntityRecord): number {
  const f = record.transform.worldRotation().rotate(dimension === '3d' ? Vec3.FORWARD : Vec3.RIGHT);
  return dimension === '3d' ? (Math.atan2(f.x, f.z) * 180) / Math.PI : (Math.atan2(f.x, f.y) * 180) / Math.PI;
}
