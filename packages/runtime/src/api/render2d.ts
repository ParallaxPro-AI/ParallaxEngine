/**
 * `ctx.vfx` in a 2D game (VfxApi in sdk/parallax/__init__.pyi), Python-facing: binds the
 * game's arguments the way CPython does and hands plain values to the render2d plugin.
 *
 *     ctx.vfx.play(Assets.vfx.sparks, at=self.entity, color=Color.RED, scale=1.5)
 *     ctx.vfx.beam(muzzle, hit, color=Color.YELLOW, width=0.04, seconds=0.08)
 *     self.trail = ctx.vfx.trail(self.entity, color=Color.hex("#8cf"))
 *
 * `render2dPlugin` is what boot (or the runtime, for mode="2d") builds: the plugin with
 * this namespace mounted as `ctx.vfx`.
 */

import { Color, fail, Vec2, Vec3 } from '../core/index.js';
import type { Rgba } from '../core/index.js';
import { render2d } from '../function/plugins/render2d/index.js';
import type { EffectAt, Render2dEngine, Render2dOptions, Render2dPlugin } from '../function/plugins/render2d/index.js';
import { bindArgs } from './kwargs.js';
import { Handle } from './time.js';
import { EffectRef } from './types.js';

function color(value: unknown, where: string): Rgba | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Color) return [value.r, value.g, value.b, value.a];
  return fail('PP3600', `${where} must be a Color or None, got ${String(value)}`, { fix: 'Pass Color(r, g, b) or Color.hex("#rrggbb").' });
}

function number(value: unknown, fallback: number, where: string): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('PP3600', `${where} must be a number, got ${String(value)}`);
}

function point(value: unknown, where: string): [number, number] {
  if (value instanceof Vec2 || value instanceof Vec3) return [value.x, value.y];
  return fail('PP3600', `${where} must be a Vec2 or Vec3, got ${String(value)}`, { fix: 'Pass vec2(x, y) or vec3(x, y, z).' });
}

export class VfxApi {
  readonly #engine: Render2dEngine;

  constructor(engine: Render2dEngine) {
    this.#engine = engine;
  }

  /** play(effect, *, at, color=None, color_end=None, scale=1, direction=None, count=None) — a one-shot effect. */
  play(...args: unknown[]): void {
    const a = bindArgs('play', args, {
      positional: ['effect'], keyword: ['at', 'color', 'color_end', 'scale', 'direction', 'count'], required: ['effect', 'at'],
    }).args;
    const effect = a['effect'];
    if (!(effect instanceof EffectRef)) {
      fail('PP3600', `vfx.play() takes an effect handle, got ${String(effect)}`, { fix: 'Pass Assets.vfx.<name> (a file in assets/vfx/).' });
    }
    const direction = a['direction'];
    this.#engine.play(effect.path, this.#at(a['at']), {
      color: color(a['color'], 'vfx.play color'),
      scale: number(a['scale'], 1, 'vfx.play scale'),
      direction: direction === undefined || direction === null ? null : point(direction, 'vfx.play direction'),
      colorEnd: color(a['color_end'], 'vfx.play color_end'),
      count: countArg(a['count']),
    });
  }

  /** beam(start, end, *, color=None, width=0.05, seconds=0.1) — a short-lived line (tracers, lasers). */
  beam(...args: unknown[]): void {
    const a = bindArgs('beam', args, {
      positional: ['start', 'end'], keyword: ['color', 'width', 'seconds'], required: ['start', 'end'],
    }).args;
    this.#engine.beam(point(a['start'], 'vfx.beam start'), point(a['end'], 'vfx.beam end'), {
      color: color(a['color'], 'vfx.beam color'),
      width: number(a['width'], 0.05, 'vfx.beam width'),
      seconds: number(a['seconds'], 0.1, 'vfx.beam seconds'),
    });
  }

  /** trail(entity, *, color=None, width=0.1) — a line following the entity until cancelled or it dies. */
  trail(...args: unknown[]): Handle {
    const a = bindArgs('trail', args, { positional: ['entity'], keyword: ['color', 'width'], required: ['entity'] }).args;
    const id = this.#engine.kernel.handles.unwrap(a['entity']);
    if (id === undefined) fail('PP3600', `vfx.trail() takes an entity, got ${String(a['entity'])}`);
    return new Handle(this.#engine.trail(id, {
      color: color(a['color'], 'vfx.trail color'),
      width: number(a['width'], 0.1, 'vfx.trail width'),
    }));
  }

  #at(value: unknown): EffectAt {
    if (value instanceof Vec3) return { x: value.x, y: value.y, z: value.z };
    if (value instanceof Vec2) return { x: value.x, y: value.y, z: null };
    const id = this.#engine.kernel.handles.unwrap(value);
    if (id === undefined) {
      fail('PP3600', `vfx.play(at=) takes an entity, a Vec2 or a Vec3, got ${String(value)}`, { fix: 'Pass at=self.entity or at=vec2(x, y).' });
    }
    return { entity: id };
  }
}

/** The render2d plugin with `ctx.vfx` mounted. */
export function render2dPlugin(options: Omit<Render2dOptions, 'namespace'>): Render2dPlugin {
  return render2d({ ...options, namespace: (engine) => new VfxApi(engine) });
}

/** `vfx.play(count=)`: None, or a whole number of particles. */
function countArg(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) fail('PP3600', `vfx.play count= takes a whole number of particles, got ${String(value)}`);
  return value;
}
