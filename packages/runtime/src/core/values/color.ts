import { fail } from '../diagnostics.js';
import { hashNumbers } from '../hash.js';

/** Immutable straight-alpha RGBA color, components sRGB 0..1 as authored (renderers linearize). */
export class Color {
  static readonly WHITE = new Color(1, 1, 1);
  static readonly BLACK = new Color(0, 0, 0);
  static readonly RED = new Color(1, 0, 0);
  static readonly GREEN = new Color(0, 1, 0);
  static readonly BLUE = new Color(0, 0, 1);
  static readonly YELLOW = new Color(1, 1, 0);
  static readonly CLEAR = new Color(0, 0, 0, 0);

  readonly #r: number;
  readonly #g: number;
  readonly #b: number;
  readonly #a: number;

  constructor(r: number, g: number, b: number, a = 1) {
    this.#r = r;
    this.#g = g;
    this.#b = b;
    this.#a = a;
  }

  get r(): number { return this.#r; }
  set r(_value: number) { immutable('r'); }
  get g(): number { return this.#g; }
  set g(_value: number) { immutable('g'); }
  get b(): number { return this.#b; }
  set b(_value: number) { immutable('b'); }
  get a(): number { return this.#a; }
  set a(_value: number) { immutable('a'); }

  /** "#rgb", "#rrggbb" or "#rrggbbaa". */
  static hex(value: string): Color {
    const digits = value.startsWith('#') ? value.slice(1) : value;
    const full = digits.length === 3 ? [...digits].map((c) => c + c).join('') : digits;
    if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(full)) {
      fail('PP4101', `Not a hex color: "${value}"`, { fix: 'Use "#rgb", "#rrggbb" or "#rrggbbaa".' });
    }
    const channel = (i: number): number => parseInt(full.slice(i, i + 2), 16) / 255;
    return new Color(channel(0), channel(2), channel(4), full.length === 8 ? channel(6) : 1);
  }

  with_alpha(a: number): Color { return new Color(this.r, this.g, this.b, a); }

  lerp(o: Color, t: number): Color {
    return new Color(
      this.r + (o.r - this.r) * t,
      this.g + (o.g - this.g) * t,
      this.b + (o.b - this.b) * t,
      this.a + (o.a - this.a) * t,
    );
  }

  __eq__(o: unknown): boolean {
    return o instanceof Color && o.r === this.r && o.g === this.g && o.b === this.b && o.a === this.a;
  }

  __hash__(): number { return hashNumbers(this.r, this.g, this.b, this.a); }

  /** The stored form (saves write colors as [r, g, b, a]). */
  toJSON(): [number, number, number, number] { return [this.r, this.g, this.b, this.a]; }
  /** Python `repr`/`str` (pyrt): the same as toString. */
  __repr__(): string { return this.toString(); }

  toString(): string { return `Color(${this.r}, ${this.g}, ${this.b}, ${this.a})`; }
}

/** The forms every authored colour field accepts, for messages and docs. */
export const COLOR_FORMS = '"#rrggbb", "#rrggbbaa", [r, g, b] or [r, g, b, a] (sRGB, 0–1)';

const HEX_COLOR = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * THE parser for colours in authored data (scene blocks, specs, schemas, model files, effects,
 * cinematics): "#rrggbb", "#rrggbbaa" (also "#rgb"), [r, g, b] or [r, g, b, a], every channel
 * sRGB 0..1 as authored (alpha defaults to 1). A Color passes through. null: not a colour.
 * Only the shape is checked; range rules (0..1, non-negative, emissive above 1) are the field's.
 */
export function parseColor(value: unknown): Color | null {
  if (value instanceof Color) return value;
  if (typeof value === 'string') return HEX_COLOR.test(value) ? Color.hex(value) : null;
  if (Array.isArray(value) && (value.length === 3 || value.length === 4) && value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return new Color(value[0] as number, value[1] as number, value[2] as number, (value[3] as number | undefined) ?? 1);
  }
  return null;
}

function immutable(channel: string): never {
  fail('PP3020', `Color is immutable; cannot assign .${channel}`, {
    fix: channel === 'a' ? 'Use `color.with_alpha(value)`.' : 'Construct a new Color(r, g, b, a).',
  });
}
