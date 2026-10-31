/**
 * Values renderers draw that are derived from component data: TextMesh's styled spans,
 * WorldBar's bands, and how far each EnvironmentZone has blended in around the camera.
 */

import { Color, COLOR_FORMS, fail, parseColor, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { componentEntity } from '../../kernel/index.js';
import type { Fields, Kernel } from '../../kernel/index.js';
import type { EntityRecord } from '../../kernel/index.js';
import { describe } from './args.js';
import { COLLIDER, ENVIRONMENT_ZONE, WORLD_BAR } from './schemas.js';

// ── TextMesh spans ───────────────────────────────────────────────────────────

export interface TextSpan {
  readonly text: string;
  /** Null: the TextMesh's own `color`. */
  readonly color: Color | null;
  readonly bold: boolean;
}

const TAG = /\[(\/?)(b|color)(?:=([^\]]*))?\]/g;

/**
 * `[color=#888]…[/color]` and `[b]…[/b]` markup → spans (nesting allowed). An unknown or
 * unbalanced tag is a coded error, never shown as literal brackets by accident.
 */
export function textSpans(text: string, where = 'text_mesh text'): TextSpan[] {
  const spans: TextSpan[] = [];
  const colors: Color[] = [];
  let bold = 0;
  let last = 0;
  const push = (end: number): void => {
    if (end > last) spans.push({ text: text.slice(last, end), color: colors[colors.length - 1] ?? null, bold: bold > 0 });
  };
  for (const match of text.matchAll(TAG)) {
    push(match.index);
    last = match.index + match[0].length;
    const [, closing, name, value] = match;
    if (name === 'b') {
      if (value !== undefined) fail('PP3740', `${where}: [b] takes no value`, { fix: 'Write [b]…[/b].' });
      if (closing === '/') {
        if (bold === 0) fail('PP3740', `${where}: [/b] without [b]`, { fix: 'Remove it or add the opening [b].' });
        bold--;
      } else bold++;
    } else if (closing === '/') {
      if (colors.length === 0) fail('PP3740', `${where}: [/color] without [color=…]`, { fix: 'Remove it or add the opening tag.' });
      colors.pop();
    } else {
      if (value === undefined) fail('PP3740', `${where}: [color] needs a value`, { fix: 'Write [color=#ff8800]…[/color].' });
      colors.push(Color.hex(value));
    }
  }
  push(text.length);
  if (bold > 0 || colors.length > 0) {
    fail('PP3740', `${where}: ${bold > 0 ? '[b]' : '[color]'} is never closed`, { fix: 'Close it with [/b] or [/color].' });
  }
  return spans;
}

// ── WorldBar bands ───────────────────────────────────────────────────────────

export interface Band {
  readonly from: number;
  readonly to: number;
  readonly color: Color;
}

function bandColor(value: unknown, where: string): Color {
  return parseColor(value) ?? fail('PP3741', `${where} color must be a Color or ${COLOR_FORMS}, got ${describe(value)}`);
}

/** `world_bar.bands` (`[(from, to, color), …]`, in JSON `[[0.4, 0.6, "#4ade80"], …]`) as checked bands. */
export function readBands(value: unknown, where = 'world_bar.bands'): Band[] {
  if (!Array.isArray(value)) fail('PP3741', `${where} must be a list of (from, to, color)`, { fix: 'Write [[0.4, 0.6, "#4ade80"]].' });
  return value.map((band, i) => {
    const at = `${where}[${i}]`;
    if (!Array.isArray(band) || band.length !== 3 || typeof band[0] !== 'number' || typeof band[1] !== 'number') {
      fail('PP3741', `${at} must be (from, to, color)`, { fix: 'Write [0.4, 0.6, "#4ade80"]: a 0..1 range and its colour.' });
    }
    const [from, to] = band as [number, number];
    if (!(from >= 0 && to <= 1 && from <= to)) {
      fail('PP3741', `${at} range ${from}..${to} must lie within 0..1, from ≤ to`);
    }
    return { from, to, color: bandColor(band[2], at) };
  });
}

/**
 * Keeps every `world_bar.bands` in its checked runtime form — frozen `(from, to, Color)`
 * tuples — whether authored in JSON (`"#hex"` colours) or assigned in code, so renderers
 * read Colors (render2d contract). Runs on arrival and before each frame's rigs.
 */
export class Bars {
  readonly #kernelOf: () => Kernel;

  constructor(kernel: () => Kernel) {
    this.#kernelOf = kernel;
  }

  #normalize(fields: Fields, where: string): void {
    const bands = fields['bands'];
    const ready = Array.isArray(bands) && bands.every((b) => Array.isArray(b) && Object.isFrozen(b) && b[2] instanceof Color);
    if (ready) return;
    fields['bands'] = readBands(bands, where).map((b) => Object.freeze([b.from, b.to, b.color]));
  }

  added(records: readonly EntityRecord[]): void {
    for (const record of records) {
      const bar = record.components.get(WORLD_BAR);
      if (bar !== undefined) this.#normalize(bar, `world_bar of "${record.placedId ?? record.prefab ?? record.id}".bands`);
    }
  }

  frame(): void {
    for (const [, bar] of this.#kernelOf().world.query([WORLD_BAR])) this.#normalize(bar as Fields, 'world_bar.bands');
  }
}

// ── EnvironmentZone blending ─────────────────────────────────────────────────

/** Whether a world point is inside an entity's collider shape (trigger volumes). */
export function insideCollider(record: EntityRecord, collider: Fields, point: Vec3, dimension: '2d' | '3d'): boolean {
  const local = record.transform.toLocal(point).__sub__(collider['offset'] as Vec3);
  const size = collider['size'] as Vec3;
  const radius = collider['radius'] as number;
  const height = collider['height'] as number;
  switch (collider['shape']) {
    case 'box':
      return Math.abs(local.x) <= size.x / 2 && Math.abs(local.y) <= size.y / 2 && (dimension === '2d' || Math.abs(local.z) <= size.z / 2);
    case 'sphere':
      return local.length() <= radius;
    case 'circle':
      return Math.hypot(local.x, local.y) <= radius;
    case 'capsule': {
      const half = Math.max(0, height / 2 - radius);
      const y = Math.max(-half, Math.min(half, local.y));
      return (dimension === '2d' ? Math.hypot(local.x, local.y - y) : Math.hypot(local.x, local.y - y, local.z)) <= radius;
    }
    case 'cylinder':
      return Math.abs(local.y) <= height / 2 && Math.hypot(local.x, local.z) <= radius;
    default:
      return fail('PP3742', `An EnvironmentZone's collider shape "${String(collider['shape'])}" has no inside test`, {
        fix: 'Give the zone a box, sphere, circle, capsule or cylinder trigger collider.',
      });
  }
}

export interface SavedZone { readonly id: number; readonly weight: number }

/**
 * Each zone's weight moves toward 1 while the reference point (the seat-0 active camera)
 * is inside its trigger collider and toward 0 outside, at 1/`blend` per second (blend 0:
 * at once). Environment renderers blend each set override by its weight
 * (`environment_zone.__weight__`), zones in spawn order.
 */
export class Zones {
  readonly #kernelOf: () => Kernel;
  #kernel(): Kernel { return this.#kernelOf(); }
  readonly #dimension: '2d' | '3d';
  readonly #weights = new Map<EntityId, number>();

  constructor(kernel: () => Kernel, dimension: '2d' | '3d') {
    this.#kernelOf = kernel;
    this.#dimension = dimension;
  }

  #collider(record: EntityRecord): Fields {
    const collider = record.components.get(COLLIDER);
    if (collider === undefined) {
      const name = record.placedId ?? record.prefab ?? `entity ${record.id}`;
      fail('PP3743', `The EnvironmentZone on "${name}" has no collider to define its volume`, {
        fix: 'Add a trigger collider ({"shape": "box", "size": [...], "trigger": true}) to the same entity.',
      });
    }
    return collider;
  }

  added(records: readonly EntityRecord[], reference: () => Vec3 | null): void {
    const at = records.some((r) => r.components.has(ENVIRONMENT_ZONE)) ? reference() : null;
    for (const record of records) {
      if (!record.components.has(ENVIRONMENT_ZONE) || this.#weights.has(record.id)) continue;
      const collider = this.#collider(record);
      // A zone spawned around the camera blends in over its `blend` like one entered (SDK);
      // only `blend` 0 applies at once.
      const instant = (record.components.get(ENVIRONMENT_ZONE)!['blend'] as number) <= 0;
      this.#weights.set(record.id, instant && at !== null && insideCollider(record, collider, at, this.#dimension) ? 1 : 0);
    }
  }

  removed(records: readonly EntityRecord[]): void {
    for (const record of records) this.#weights.delete(record.id);
  }

  changed(record: EntityRecord, reference: () => Vec3 | null): void {
    if (!record.components.has(ENVIRONMENT_ZONE)) this.#weights.delete(record.id);
    else this.added([record], reference);
  }

  clear(): void {
    this.#weights.clear();
  }

  frame(dt: number, at: Vec3 | null): void {
    for (const [id, weight] of this.#weights) {
      const record = this.#kernel().world.get(id);
      const zone = record?.components.get(ENVIRONMENT_ZONE);
      if (record === undefined || zone === undefined) continue;
      const inside = at !== null && insideCollider(record, this.#collider(record), at, this.#dimension);
      const blend = zone['blend'] as number;
      const step = blend <= 0 ? 1 : dt / blend;
      this.#weights.set(id, inside ? Math.min(1, weight + step) : Math.max(0, weight - step));
    }
  }

  weight(fields: Fields): number {
    const weight = this.#weights.get(componentEntity(fields));
    if (weight === undefined) fail('PP3744', 'This EnvironmentZone is not in the world');
    return weight;
  }

  snapshot(): SavedZone[] {
    return [...this.#weights].map(([id, weight]) => ({ id, weight }));
  }

  restore(saved: readonly SavedZone[]): void {
    this.#weights.clear();
    for (const record of this.#kernel().world.live()) if (record.components.has(ENVIRONMENT_ZONE)) this.#weights.set(record.id, 0);
    for (const s of saved) if (this.#weights.has(s.id as EntityId)) this.#weights.set(s.id as EntityId, s.weight);
  }
}
