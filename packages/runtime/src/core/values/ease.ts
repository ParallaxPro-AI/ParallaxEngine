/**
 * The engine's easing curves (SDK `Ease`): one table that every timed thing in the engine
 * eases by — `math.ease`, tweens (`transform.move_to(ease=)`), model joint moves
 * (`Model.pose(seconds=, ease=)`), camera and UI transitions. Each maps t in [0, 1] to the
 * eased fraction (0 → 0, 1 → 1; the `back` and `elastic` curves overshoot in between —
 * `in_*` before the start, `out_*` past the end, `in_out_*` both).
 */

/** Back overshoot (≈10%) and its in-out form (Penner's constants). */
const BACK = 1.70158;
const BACK_IN_OUT = BACK * 1.525;
const ELASTIC = (2 * Math.PI) / 3;
const ELASTIC_IN_OUT = (2 * Math.PI) / 4.5;

import { fail } from '../diagnostics.js';

const CURVES: Readonly<Record<string, (t: number) => number>> = {
  linear: (t) => t,
  in_quad: (t) => t * t,
  out_quad: (t) => 1 - (1 - t) * (1 - t),
  in_out_quad: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  in_cubic: (t) => t * t * t,
  out_cubic: (t) => 1 - (1 - t) ** 3,
  in_out_cubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  in_back: (t) => (BACK + 1) * t * t * t - BACK * t * t,
  out_back: (t) => 1 + (BACK + 1) * (t - 1) ** 3 + BACK * (t - 1) ** 2,
  in_out_back: (t) => (t < 0.5
    ? ((2 * t) ** 2 * ((BACK_IN_OUT + 1) * 2 * t - BACK_IN_OUT)) / 2
    : ((2 * t - 2) ** 2 * ((BACK_IN_OUT + 1) * (t * 2 - 2) + BACK_IN_OUT) + 2) / 2),
  in_elastic: (t) => {
    if (t === 0 || t === 1) return t;
    return -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * ELASTIC);
  },
  out_elastic: (t) => {
    if (t === 0 || t === 1) return t;
    return 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ELASTIC) + 1;
  },
  in_out_elastic: (t) => {
    if (t === 0 || t === 1) return t;
    return t < 0.5
      ? -(2 ** (20 * t - 10) * Math.sin((20 * t - 11.125) * ELASTIC_IN_OUT)) / 2
      : (2 ** (-20 * t + 10) * Math.sin((20 * t - 11.125) * ELASTIC_IN_OUT)) / 2 + 1;
  },
  out_bounce: (t) => {
    const n1 = 7.5625;
    const d1 = 2.75;
    if (t < 1 / d1) return n1 * t * t;
    if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
    if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
    return n1 * (t -= 2.625 / d1) * t + 0.984375;
  },
};

/** The curves, pinned to exactly 0 and 1 at the ends (float error would leave a joint a hair short of its limit). */
export const EASES: Readonly<Record<string, (t: number) => number>> = Object.fromEntries(
  Object.entries(CURVES).map(([kind, curve]) => [kind, (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : curve(t))]),
);

/** The ease names, in SDK order. */
export const EASE_KINDS: readonly string[] = Object.keys(EASES);

/** The easing function for `kind`, or PP3033 naming the valid kinds. */
export function easing(kind: unknown): (t: number) => number {
  const fn = typeof kind === 'string' ? EASES[kind] : undefined;
  if (fn === undefined) {
    fail('PP3033', `Unknown ease ${JSON.stringify(kind)}`, { fix: `Use one of ${EASE_KINDS.join(', ')}.` });
  }
  return fn;
}

/** `kind` at t (clamped to [0, 1]). */
export function ease(kind: string, t: number): number {
  return easing(kind)(Math.min(1, Math.max(0, t)));
}
