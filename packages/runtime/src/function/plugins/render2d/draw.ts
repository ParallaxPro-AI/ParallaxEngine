/**
 * Entities → draw commands. Reads the shared rendering components by id, with the SDK's
 * field names (sdk/parallax/__init__.pyi; defined by the visuals plugin):
 *
 *   shape       kind "rect" | "circle" | "ring" | "polygon" (2D kinds), size (full
 *               width/height; a circle's diameter; a polygon's point scale), offset, color,
 *               texture, points (polygon), thickness (ring), corner_radius (rect),
 *               stroke_width / stroke_color (any 2D kind)
 *   sprite      image, size, color (tint), offset, flip_x, flip_y, blend ("additive" adds
 *               its colors), animations, and the animation the visuals plugin's `play()`
 *               records (see `SPRITE_ANIMATION`)
 *   text_mesh   text ([color=…] / [b] markup), size (line height), color
 *   world_bar   value 0..1, offset, color, bands, shown — drawn as rects over the entity
 *   tilemap     tile_size, rows, tiles {image, color} — one image (or rect) per cell, under the rest
 *
 * Per entity the parts draw in that order (shape, sprite, text, bar), at the entity's
 * world z; entities with equal z draw in spawn order.
 */

import { cellCenter, fail, tileGrid, Vec3 } from '../../../core/index.js';
import type { Affine2d, Draw2d, EntityId, Rgba, Stroke2d } from '../../../core/index.js';
import type { EntityRecord, Fields } from '../../kernel/index.js';
import type { AssetCatalog } from './assets.js';
import { refString } from './assets.js';
import { compose } from './placement.js';
import type { Placed2d } from './placement.js';
import { parseMarkup } from './text.js';
import { describe, finite, missingImageColor, multiply, rgba, xy } from './values.js';

export const SHAPE = 'shape';
export const SPRITE = 'sprite';
export const TEXT_MESH = 'text_mesh';
export const WORLD_BAR = 'world_bar';
export const TILEMAP = 'tilemap';

/**
 * The sprite fields the visuals plugin's `Sprite.play(animation)` keeps, beyond the SDK's
 * public ones: the playing animation's name (None: show `image`) and the game time it
 * started at. They are part of the component so snapshots carry them.
 */
export const SPRITE_ANIMATION = { name: 'animation', started: 'animation_started' } as const;

/** 2D shape kinds this renderer draws. */
export const SHAPES_2D = ['rect', 'circle', 'ring', 'polygon'] as const;
const SHAPES_3D = ['box', 'sphere', 'capsule', 'cylinder', 'cone', 'plane'];

/** A world bar's size in meters (the SDK gives it no size field). */
export const BAR_SIZE = [1, 0.12] as const;
const BAR_BACK: Rgba = [0, 0, 0, 0.6];

/** Asset resolution and preloading, shared with the effects. */
export interface Images {
  /**
   * The image file a reference names (PP2063 when none), queued for loading. Null in a
   * data-only run when the file isn't there: the draw falls back to a rect of its color
   * times a per-reference hashed hue (`missingImageColor`), and nothing is fetched.
   */
  image(ref: unknown, where: string): string | null;
}

export function imagesOf(assets: AssetCatalog, load: (path: string) => void): Images {
  const loaded = new Set<string>();
  return {
    image(ref, where) {
      const path = assets.resolve(refString(ref, where), 'images', where);
      if (!assets.loadable(path)) return null;
      if (!loaded.has(path)) {
        loaded.add(path);
        load(path);
      }
      return path;
    },
  };
}

function offsetBy(m: Affine2d, offset: unknown, where: string): Affine2d {
  const [x, y] = xy(offset, where);
  return x === 0 && y === 0 ? m : compose(m, [1, 0, 0, 1, x, y]);
}

function size2(value: unknown, where: string): [number, number] {
  const [w, h] = xy(value, where);
  if (!(w >= 0 && h >= 0)) fail('PP3600', `${where} is (${w}, ${h}); sizes can't be negative`);
  return [w, h];
}

interface AnimationDef {
  readonly frames: readonly unknown[];
  readonly fps: number;
  readonly loop: boolean;
}

function animationDef(animations: unknown, name: string, where: string): AnimationDef {
  const table = typeof animations === 'object' && animations !== null ? (animations as Record<string, unknown>) : {};
  const def = table[name] as Record<string, unknown> | undefined;
  if (def === undefined) {
    return fail('PP3609', `${where} plays "${name}", which its prefab's animations don't have`, {
      fix: `Animations: ${Object.keys(table).join(', ') || '(none)'}.`,
    });
  }
  const frames = def['frames'];
  const fps = def['fps'];
  if (!Array.isArray(frames) || frames.length === 0 || typeof fps !== 'number' || !(fps > 0)) {
    return fail('PP3609', `${where} animation "${name}" needs a non-empty "frames" list and an "fps" above 0`, {
      fix: 'Write {"frames": ["run_0", "run_1"], "fps": 12, "loop": true}.',
    });
  }
  return { frames, fps, loop: def['loop'] !== false };
}

/** The image a sprite shows now: its animation's current frame, else `image`. */
function spriteImage(sprite: Fields, now: number, where: string): unknown {
  const name = sprite[SPRITE_ANIMATION.name];
  if (!(SPRITE_ANIMATION.name in sprite)) {
    const table = sprite['animations'];
    if (typeof table === 'object' && table !== null && Object.keys(table).length > 0) {
      fail('PP9600', `${where} has animations but no "${SPRITE_ANIMATION.name}" field to know which one plays`, {
        fix: 'The visuals plugin must declare sprite.animation and sprite.animation_started (render2d contract).',
      });
    }
  }
  if (name === null || name === undefined) return sprite['image'];
  const def = animationDef(sprite['animations'], String(name), where);
  const elapsed = Math.max(0, now - finite(sprite[SPRITE_ANIMATION.started], `${where}.${SPRITE_ANIMATION.started}`));
  const index = Math.floor(elapsed * def.fps + 1e-9);
  return def.frames[def.loop ? index % def.frames.length : Math.min(index, def.frames.length - 1)];
}

/** A shape's outline, or undefined when `stroke_width` is 0. */
function strokeOf(shape: Fields, where: string): Stroke2d | undefined {
  const width = shape['stroke_width'] === undefined ? 0 : finite(shape['stroke_width'], `${where}.stroke_width`);
  if (!(width > 0)) return undefined;
  return { width, color: rgba(shape['stroke_color'], `${where}.stroke_color`) };
}

function polygonPoints(shape: Fields, w: number, h: number, where: string): number[] {
  const points = shape['points'];
  if (!Array.isArray(points) || points.length < 3) {
    fail('PP3608', `${where} kind "polygon" needs at least 3 points, got ${Array.isArray(points) ? points.length : describe(points)}`, {
      fix: 'Give the corners in order: "points": [[-1, 0], [1, 0], [0, 2]] (local meters, scaled by size).',
    });
  }
  const out: number[] = [];
  points.forEach((p, i) => {
    const [x, y] = xy(p, `${where}.points[${i}]`);
    out.push(x * w, y * h);
  });
  return out;
}

function shapeDraws(out: Draw2d[], shape: Fields, at: Placed2d, entity: EntityId, images: Images, where: string): void {
  const kind = String(shape['kind']);
  if (SHAPES_3D.includes(kind)) {
    fail('PP3607', `${where} is a 3D shape ("${kind}"); a 2D game draws ${SHAPES_2D.map((k) => `"${k}"`).join(', ')}`, {
      fix: kind === 'sphere' ? 'Use "kind": "circle".' : 'Use "kind": "rect" (or "polygon" with points).',
    });
  }
  const [w, h] = size2(shape['size'], `${where}.size`);
  const m = offsetBy(at.m, shape['offset'], `${where}.offset`);
  const offset = shape['offset'];
  const z = at.z + (offset instanceof Vec3 ? offset.z : 0);
  const color = rgba(shape['color'], `${where}.color`);
  const stroke = strokeOf(shape, where);
  const extra = stroke === undefined ? {} : { stroke };
  if (kind === 'polygon') {
    out.push({ kind: 'polygon', z, entity, transform: m, points: polygonPoints(shape, w, h, where), fill: color, ...extra });
    return;
  }
  const textureRef = shape['texture'];
  const texture = textureRef === null || textureRef === undefined ? null : images.image(textureRef, `${where}.texture`);
  // A data-only run without the texture file: its hashed stand-in color (see missingImageColor).
  const fill = texture === null && textureRef !== null && textureRef !== undefined
    ? multiply(color, missingImageColor(refString(textureRef, `${where}.texture`))) : color;
  if (kind === 'circle' || kind === 'ring') {
    if (kind === 'ring') {
      const thickness = shape['thickness'] === undefined ? 0.1 : finite(shape['thickness'], `${where}.thickness`);
      if (!(thickness > 0)) {
        fail('PP3608', `${where} kind "ring" has thickness ${thickness}, so it draws nothing`, {
          fix: 'Give the band a width in meters ("thickness": 0.1), or use "circle" for a filled disc.',
        });
      }
      // A band as wide as the radius (or wider) is a filled disc.
      const hole: [number, number] = [Math.max(0, w - 2 * thickness), Math.max(0, h - 2 * thickness)];
      const ring = hole[0] > 0 && hole[1] > 0 ? { hole } : {};
      out.push({ kind: 'ellipse', z, entity, transform: m, size: [w, h], fill, image: texture, ...ring, ...extra });
      return;
    }
    out.push({ kind: 'ellipse', z, entity, transform: m, size: [w, h], fill, image: texture, ...extra });
  } else if (texture !== null) {
    out.push({ kind: 'image', z, entity, transform: m, image: texture, size: [w, h], tint: fill, flipX: false, flipY: false });
    if (stroke !== undefined) out.push({ kind: 'rect', z, entity, transform: m, size: [w, h], fill: [0, 0, 0, 0], stroke });
  } else {
    const r = shape['corner_radius'] === undefined ? 0 : Math.min(finite(shape['corner_radius'], `${where}.corner_radius`), w / 2, h / 2);
    out.push({ kind: 'rect', z, entity, transform: m, size: [w, h], fill, ...(r > 0 ? { radius: r } : {}), ...extra });
  }
}

function spriteDraws(out: Draw2d[], sprite: Fields, at: Placed2d, entity: EntityId, images: Images, now: number, where: string): void {
  const size = size2(sprite['size'], `${where}.size`);
  const m = offsetBy(at.m, sprite['offset'], `${where}.offset`);
  const tint = rgba(sprite['color'], `${where}.color`);
  const ref = spriteImage(sprite, now, where);
  // Absent (an older snapshot) or "normal": painted over; only "additive" is carried.
  const additive = sprite['blend'] === 'additive' && { blend: 'additive' as const };
  if (ref === null || ref === undefined) {
    out.push({ kind: 'rect', z: at.z, entity, transform: m, size, fill: tint, ...additive });
    return;
  }
  const image = images.image(ref, `${where}.image`);
  if (image === null) {
    out.push({ kind: 'rect', z: at.z, entity, transform: m, size, fill: multiply(tint, missingImageColor(refString(ref, `${where}.image`))), ...additive });
    return;
  }
  out.push({
    kind: 'image', z: at.z, entity, transform: m, image, size, tint,
    flipX: sprite['flip_x'] === true, flipY: sprite['flip_y'] === true, ...additive,
  });
}

function textDraws(out: Draw2d[], text: Fields, at: Placed2d, entity: EntityId, where: string): void {
  const content = text['text'];
  if (typeof content !== 'string') fail('PP3600', `${where}.text must be a string, got ${describe(content)}`);
  if (content === '') return;
  const size = finite(text['size'], `${where}.size`);
  out.push({ kind: 'text', z: at.z, entity, transform: at.m, size, spans: parseMarkup(content, rgba(text['color'], `${where}.color`)) });
}

function barDraws(out: Draw2d[], bar: Fields, at: Placed2d, entity: EntityId, where: string): void {
  if (bar['shown'] !== true) return;
  const value = Math.min(1, Math.max(0, finite(bar['value'], `${where}.value`)));
  const [ox, oy] = xy(bar['offset'], `${where}.offset`);
  const [w, h] = BAR_SIZE;
  const x = at.m[4] + ox;
  const y = at.m[5] + oy;
  const left = x - w / 2;
  const rect = (from: number, to: number, fill: Rgba): void => {
    if (to <= from) return;
    out.push({ kind: 'rect', z: at.z, entity, transform: [1, 0, 0, 1, left + (from + to) / 2 * w, y], size: [(to - from) * w, h], fill });
  };
  rect(0, 1, BAR_BACK);
  const bands = bar['bands'];
  if (!Array.isArray(bands)) fail('PP3600', `${where}.bands must be a list of (from, to, color)`);
  for (const [i, band] of bands.entries()) {
    if (!Array.isArray(band) || band.length !== 3) fail('PP3600', `${where}.bands[${i}] must be (from, to, color)`);
    const from = Math.max(0, finite(band[0], `${where}.bands[${i}] from`));
    const to = Math.min(1, finite(band[1], `${where}.bands[${i}] to`));
    rect(from, to, rgba(band[2], `${where}.bands[${i}] color`));
  }
  rect(0, value, rgba(bar['color'], `${where}.color`));
}

function tilemapDraws(out: Draw2d[], tilemap: Fields, at: Placed2d, entity: EntityId, images: Images, where: string): void {
  const grid = tileGrid(tilemap, where);
  const tiles = tilemap['tiles'] as Readonly<Record<string, Fields>>;
  const size: [number, number] = [grid.width, grid.height];
  const looks = new Map<string, { image: string | null; fill: Rgba }>();
  for (const cell of grid.cells) {
    let look = looks.get(cell.key);
    if (look === undefined) {
      const tile = tiles[cell.key]!;
      const ref = tile['image'];
      const image = ref === null || ref === undefined ? null : images.image(ref, `${where}.tiles.${cell.key}.image`);
      const color = rgba(tile['color'], `${where}.tiles.${cell.key}.color`);
      const missing = image === null && ref !== null && ref !== undefined;
      look = { image, fill: missing ? multiply(color, missingImageColor(refString(ref, `${where}.tiles.${cell.key}.image`))) : color };
      looks.set(cell.key, look);
    }
    const [x, y] = cellCenter(grid, cell.col, cell.row);
    const m = compose(at.m, [1, 0, 0, 1, x, y]);
    out.push(look.image === null
      ? { kind: 'rect', z: at.z, entity, transform: m, size, fill: look.fill }
      : { kind: 'image', z: at.z, entity, transform: m, image: look.image, size, tint: look.fill, flipX: false, flipY: false });
  }
}

/** One entity's draw commands, appended to `out`. */
export function entityDraws(out: Draw2d[], record: EntityRecord, at: Placed2d, images: Images, now: number): void {
  const name = record.prefab === undefined ? `entity ${record.id}` : `prefab "${record.prefab}"`;
  const tilemap = record.components.get(TILEMAP);
  if (tilemap !== undefined) tilemapDraws(out, tilemap, at, record.id, images, `${name} tilemap`);
  const shape = record.components.get(SHAPE);
  if (shape !== undefined) shapeDraws(out, shape, at, record.id, images, `${name} shape`);
  const sprite = record.components.get(SPRITE);
  if (sprite !== undefined) spriteDraws(out, sprite, at, record.id, images, now, `${name} sprite`);
  const text = record.components.get(TEXT_MESH);
  if (text !== undefined) textDraws(out, text, at, record.id, `${name} text_mesh`);
  const bar = record.components.get(WORLD_BAR);
  if (bar !== undefined) barDraws(out, bar, at, record.id, `${name} world_bar`);
}

/** Every image a sprite or shape could show (its image, texture and animation frames), for preloading. */
export function preloadEntity(record: EntityRecord, images: Images): void {
  const name = record.prefab === undefined ? `entity ${record.id}` : `prefab "${record.prefab}"`;
  const sprite = record.components.get(SPRITE);
  if (sprite !== undefined) {
    if (sprite['image'] !== null && sprite['image'] !== undefined) images.image(sprite['image'], `${name} sprite.image`);
    const table = sprite['animations'];
    if (typeof table === 'object' && table !== null) {
      for (const [anim, def] of Object.entries(table as Record<string, unknown>)) {
        const frames = (def as { frames?: unknown } | null)?.frames;
        if (!Array.isArray(frames)) continue;
        frames.forEach((frame, i) => images.image(frame, `${name} sprite.animations.${anim}.frames[${i}]`));
      }
    }
  }
  const tilemap = record.components.get(TILEMAP);
  if (tilemap !== undefined) {
    for (const [key, tile] of Object.entries((tilemap['tiles'] ?? {}) as Record<string, Fields>)) {
      if (tile['image'] !== null && tile['image'] !== undefined) images.image(tile['image'], `${name} tilemap.tiles.${key}.image`);
    }
  }
  const shape = record.components.get(SHAPE);
  if (shape !== undefined && shape['texture'] !== null && shape['texture'] !== undefined) {
    images.image(shape['texture'], `${name} shape.texture`);
  }
}

