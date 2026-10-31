/**
 * SurfaceFx and HeatHaze methods (render_schemas.ts): the one-shot effects game code starts —
 * `fx.flash()`, `fx.dissolve_to(1, seconds=0.8)`, `haze.pulse()` — stamped into fields with
 * the game time they started, so a snapshot or replay holds them and every renderer works out
 * the same amounts from `ctx.time.now` (render3d/surface_fx.ts).
 */

import { bindArgs, Color, fail } from '../../../core/index.js';
import type { Fields, Kernel } from '../../kernel/index.js';

function finiteIn(value: unknown, where: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('PP3800', `${where} must be a number, got ${String(value)}`);
  if (value < min || value > max) fail('PP3800', `${where} is ${value}; it must be ${max === Infinity ? `at least ${min}` : `${min} to ${max}`}`);
  return value;
}

/** Where a transition toward `dissolve` stands at `now`: the amount drawn. */
export function dissolveNow(fields: Fields, now: number): number {
  const target = fields['dissolve'] as number;
  const seconds = fields['dissolve_seconds'] as number;
  if (!(seconds > 0)) return target;
  const k = Math.min(1, Math.max(0, (now - (fields['dissolve_at'] as number)) / seconds));
  const from = fields['dissolve_from'] as number;
  return from + (target - from) * k;
}

export function surfaceFxMethods(kernel: () => Kernel): object {
  return {
    /** flash(color=None, *, seconds=None, strength=None): a hit flash fading out over `seconds`. */
    flash(this: Fields, ...args: unknown[]): void {
      const { args: a } = bindArgs('flash', args, { positional: ['color'], keyword: ['seconds', 'strength'] });
      if (a['color'] !== undefined && a['color'] !== null) {
        if (!(a['color'] instanceof Color)) fail('PP3800', 'flash(color=) must be a Color', { fix: 'Pass Color.WHITE, Color(1, 0.2, 0.2) or Color.hex("#ff4040").' });
        this['flash_color'] = a['color'];
      }
      if (a['seconds'] !== undefined) this['flash_seconds'] = finiteIn(a['seconds'], 'flash(seconds=)', 0.01, 60);
      if (a['strength'] !== undefined) this['flash_strength'] = finiteIn(a['strength'], 'flash(strength=)', 0, 1);
      this['flash_at'] = kernel().time.now;
    },
    /** dissolve_to(amount, seconds=1.0): move `dissolve` to amount (0 whole, 1 gone) over seconds, from where it is now. */
    dissolve_to(this: Fields, ...args: unknown[]): void {
      const { args: a } = bindArgs('dissolve_to', args, { positional: ['amount', 'seconds'], required: ['amount'] });
      const amount = finiteIn(a['amount'], 'dissolve_to amount', 0, 1);
      const seconds = a['seconds'] === undefined ? 1 : finiteIn(a['seconds'], 'dissolve_to seconds', 0, 3600);
      const now = kernel().time.now;
      this['dissolve_from'] = dissolveNow(this, now);
      this['dissolve_at'] = now;
      this['dissolve_seconds'] = seconds;
      this['dissolve'] = amount;
    },
    /** The amount drawn now (mid-transition included). */
    get dissolved(): number {
      return dissolveNow(this as unknown as Fields, kernel().time.now);
    },
  };
}

export function heatHazeMethods(kernel: () => Kernel): object {
  return {
    /** pulse(radius=None, *, seconds=None, strength=None): a shockwave ring growing from the entity. */
    pulse(this: Fields, ...args: unknown[]): void {
      const { args: a } = bindArgs('pulse', args, { positional: ['radius'], keyword: ['seconds', 'strength'] });
      if (a['radius'] !== undefined && a['radius'] !== null) this['pulse_radius'] = finiteIn(a['radius'], 'pulse radius', 0, 10000);
      if (a['seconds'] !== undefined) this['pulse_seconds'] = finiteIn(a['seconds'], 'pulse(seconds=)', 0.01, 60);
      if (a['strength'] !== undefined) this['pulse_strength'] = finiteIn(a['strength'], 'pulse(strength=)', 0, 1);
      this['pulse_at'] = kernel().time.now;
    },
  };
}
