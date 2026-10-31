/**
 * Utility scoring for `utility` nodes: each option's score is its `base` times every
 * consideration's score. A consideration maps one blackboard number through a response
 * curve onto [0, 1], blended by `weight` — `1 - weight × (1 - curve(x))` — so weight 0
 * ignores it and weight 1 applies it fully (a half-weight consideration can at most halve
 * the option). Pure functions.
 *
 * Curves over x normalized to t = clamp((x - min) / (max - min), 0, 1):
 *   linear t · inverse 1 - t · quadratic t² · inverse_quadratic (1 - t)² ·
 *   smoothstep 3t² - 2t³ · step (t ≥ 0.5) · bool (the raw value's truthiness)
 */

import { truthy } from './blackboard.js';
import type { Value } from './blackboard.js';

export const CURVES = ['linear', 'inverse', 'quadratic', 'inverse_quadratic', 'smoothstep', 'step', 'bool'] as const;
export type Curve = (typeof CURVES)[number];

export interface Consideration {
  readonly key: string;
  readonly curve: Curve;
  readonly min: number;
  readonly max: number;
  readonly weight: number;
}

/** A consideration's score; a missing or non-number value (except for `bool`) scores 0. */
export function considerationScore(c: Consideration, value: Value | undefined): number {
  let s: number;
  if (c.curve === 'bool') s = truthy(value) ? 1 : 0;
  else if (typeof value !== 'number') s = 0;
  else {
    const t = Math.min(1, Math.max(0, (value - c.min) / (c.max - c.min)));
    switch (c.curve) {
      case 'linear': s = t; break;
      case 'inverse': s = 1 - t; break;
      case 'quadratic': s = t * t; break;
      case 'inverse_quadratic': s = (1 - t) * (1 - t); break;
      case 'smoothstep': s = t * t * (3 - 2 * t); break;
      case 'step': s = t >= 0.5 ? 1 : 0; break;
    }
  }
  return 1 - Math.min(1, c.weight) * (1 - s);
}

export function optionScore(base: number, considerations: readonly Consideration[], read: (key: string) => Value | undefined): number {
  let score = base;
  for (const c of considerations) score *= considerationScore(c, read(c.key));
  return score;
}

/**
 * The option to run: the highest score, the current option getting `hysteresis` added so
 * near-ties don't flap; ties go to the earlier option. -1 when every score is 0.
 */
export function chooseOption(scores: readonly number[], current: number | undefined, hysteresis: number): number {
  let best = -1;
  let bestScore = 0;
  scores.forEach((raw, i) => {
    const score = raw > 0 && i === current ? raw + hysteresis : raw;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}
