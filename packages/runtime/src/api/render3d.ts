/**
 * `ctx.vfx` in a 3D game (VfxApi in sdk/parallax/__init__.pyi), Python-facing: binds the
 * game's arguments the way CPython does and hands plain values to the render3d plugin.
 *
 *     ctx.vfx.play(Assets.vfx.sparks, at=self.entity, color=Color.RED, scale=1.5)
 *     ctx.vfx.play(Assets.vfx.dust, at=hit_point, direction=normal)
 *     ctx.vfx.play(Effect.explosion, at=barrel.transform.position, scale=1.5)
 *     ctx.vfx.beam(muzzle, hit, color=Color.YELLOW, width=0.04, seconds=0.08)
 *     ctx.vfx.lightning(cloud, ground, branches=4)
 *     self.trail = ctx.vfx.trail(self.entity, color=Color.hex("#8cf"), glow=True)
 *
 * `render3dPlugin` is what boot (or the runtime, for mode="3d") builds: the plugin with
 * this namespace mounted as `ctx.vfx`.
 */

import { Color, fail, ParallaxError, Vec3 } from '../core/index.js';
import type { Capture3d, Rgba } from '../core/index.js';
import { encodePng, render3d } from '../function/plugins/render3d/index.js';
import type { EffectAt3d, Point3, Render3dEngine, Render3dOptions, Render3dPlugin } from '../function/plugins/render3d/index.js';
import { bindArgs } from './kwargs.js';
import { Handle } from './time.js';
import { EffectRef, ModelRef } from './types.js';

function color(value: unknown, where: string): Rgba | null {
  if (value === undefined || value === null) return null;
  if (value instanceof Color) return [value.r, value.g, value.b, value.a];
  return fail('PP3800', `${where} must be a Color or None, got ${String(value)}`, { fix: 'Pass Color(r, g, b) or Color.hex("#rrggbb").' });
}

function number(value: unknown, fallback: number, where: string): number {
  if (value === undefined) return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('PP3800', `${where} must be a number, got ${String(value)}`);
}

function point(value: unknown, where: string): Point3 {
  if (value instanceof Vec3) return [value.x, value.y, value.z];
  return fail('PP3800', `${where} must be a Vec3, got ${String(value)}`, { fix: 'Pass vec3(x, y, z).' });
}

export class VfxApi3d {
  readonly #engine: Render3dEngine;

  constructor(engine: Render3dEngine) {
    this.#engine = engine;
  }

  /** play(effect, *, at, color=None, color_end=None, scale=1, direction=None, count=None) — a one-shot effect. */
  play(...args: unknown[]): void {
    const a = bindArgs('play', args, {
      positional: ['effect'], keyword: ['at', 'color', 'color_end', 'scale', 'direction', 'count'], required: ['effect', 'at'],
    }).args;
    const effect = a['effect'];
    if (!(effect instanceof EffectRef)) {
      fail('PP3800', `vfx.play() takes an effect handle, got ${String(effect)}`, { fix: 'Pass Assets.vfx.<name> (a file in assets/vfx/) or a built-in, Effect.<name>.' });
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

  /** beam(start, end, *, color=None, width=0.05, seconds=0.1, intensity=1) — a short-lived glowing line (tracers, lasers). */
  beam(...args: unknown[]): void {
    const a = bindArgs('beam', args, {
      positional: ['start', 'end'], keyword: ['color', 'width', 'seconds', 'intensity'], required: ['start', 'end'],
    }).args;
    this.#engine.beam(point(a['start'], 'vfx.beam start'), point(a['end'], 'vfx.beam end'), {
      color: color(a['color'], 'vfx.beam color'),
      width: number(a['width'], 0.05, 'vfx.beam width'),
      seconds: number(a['seconds'], 0.1, 'vfx.beam seconds'),
      intensity: number(a['intensity'], 1, 'vfx.beam intensity'),
    });
  }

  /** lightning(start, end, *, color=None, width=0.08, seconds=0.25, branches=3) — a forking bolt, re-struck while it shows. */
  lightning(...args: unknown[]): void {
    const a = bindArgs('lightning', args, {
      positional: ['start', 'end'], keyword: ['color', 'width', 'seconds', 'branches'], required: ['start', 'end'],
    }).args;
    this.#engine.lightning(point(a['start'], 'vfx.lightning start'), point(a['end'], 'vfx.lightning end'), {
      color: color(a['color'], 'vfx.lightning color'),
      width: number(a['width'], 0.08, 'vfx.lightning width'),
      seconds: number(a['seconds'], 0.25, 'vfx.lightning seconds'),
      branches: number(a['branches'], 3, 'vfx.lightning branches'),
    });
  }

  /** trail(entity, *, color=None, width=0.1, seconds=0.3, glow=False) — a ribbon following the entity until cancelled or it dies. */
  trail(...args: unknown[]): Handle {
    const a = bindArgs('trail', args, { positional: ['entity'], keyword: ['color', 'width', 'seconds', 'glow'], required: ['entity'] }).args;
    const id = this.#engine.kernel.handles.unwrap(a['entity']);
    if (id === undefined) fail('PP3800', `vfx.trail() takes an entity, got ${String(a['entity'])}`);
    const glow = a['glow'] ?? false;
    if (typeof glow !== 'boolean') fail('PP3800', `vfx.trail glow must be True or False, got ${String(glow)}`);
    return new Handle(this.#engine.trail(id, {
      color: color(a['color'], 'vfx.trail color'),
      width: number(a['width'], 0.1, 'vfx.trail width'),
      seconds: number(a['seconds'], 0.3, 'vfx.trail seconds'),
      glow,
    }));
  }

  /**
   * photo(*, width=1280, height=720, camera=None) — the last drawn frame seen from a camera
   * (default: the first view's) at a size, read back as a `Photo` (its `data_url` once ready).
   */
  photo(...args: unknown[]): Photo {
    const a = bindArgs('photo', args, { positional: [], keyword: ['width', 'height', 'camera'], required: [] }).args;
    const camera = a['camera'] === undefined || a['camera'] === null ? null : this.#engine.kernel.handles.unwrap(a['camera']);
    if (a['camera'] !== undefined && a['camera'] !== null && camera === undefined) fail('PP3848', `vfx.photo(camera=) takes a camera entity, got ${String(a['camera'])}`);
    const width = number(a['width'], 1280, 'vfx.photo width');
    const height = number(a['height'], 720, 'vfx.photo height');
    return new Photo(width, height, this.#engine.photo({ width, height, camera: camera ?? null }));
  }

  /**
   * portrait(subject, *, width=256, height=256, yaw=25, pitch=10, background=None) — an
   * entity's Model as it looks now, or a model at rest (`Assets.models.x`), alone in a studio,
   * read back as a `Photo` (transparent background unless a Color is given).
   */
  portrait(...args: unknown[]): Photo {
    const a = bindArgs('portrait', args, { positional: ['subject'], keyword: ['width', 'height', 'yaw', 'pitch', 'background'], required: ['subject'] }).args;
    const subject = a['subject'];
    const width = number(a['width'], 256, 'vfx.portrait width');
    const height = number(a['height'], 256, 'vfx.portrait height');
    const options = {
      width, height, yaw: number(a['yaw'], 25, 'vfx.portrait yaw'), pitch: number(a['pitch'], 10, 'vfx.portrait pitch'),
      background: color(a['background'], 'vfx.portrait background'),
    };
    if (subject instanceof ModelRef) return new Photo(width, height, this.#engine.portrait({ model: subject.path }, options));
    const id = this.#engine.kernel.handles.unwrap(subject);
    if (id === undefined) fail('PP3848', `vfx.portrait() takes an entity with a Model or a model (Assets.models.<name>), got ${String(subject)}`);
    return new Photo(width, height, this.#engine.portrait({ entity: id }, options));
  }

  #at(value: unknown): EffectAt3d {
    if (value instanceof Vec3) return { point: [value.x, value.y, value.z] };
    const id = this.#engine.kernel.handles.unwrap(value);
    if (id === undefined) {
      fail('PP3800', `vfx.play(at=) takes an entity or a Vec3 in a 3D game, got ${String(value)}`, { fix: 'Pass at=self.entity or at=vec3(x, y, z).' });
    }
    return { entity: id };
  }
}

/**
 * A captured image (`ctx.vfx.photo` / `portrait`): `ready` once read back from the GPU (a
 * frame or two), then `data_url` is a PNG data URL a UI image can show and `pixels` the RGBA
 * bytes; `error` says why it failed (`ready` stays false).
 */
export class Photo {
  readonly width: number;
  readonly height: number;
  ready = false;
  data_url: string | null = null;
  pixels: Uint8Array | null = null;
  error: string | null = null;

  constructor(width: number, height: number, image: Promise<Capture3d>) {
    this.width = width;
    this.height = height;
    image.then((captured) => {
      this.pixels = captured.pixels;
      this.data_url = `data:image/png;base64,${base64(encodePng(captured.width, captured.height, captured.pixels))}`;
      this.ready = true;
    }, (error: unknown) => {
      this.error = error instanceof ParallaxError ? error.diagnostic.message : String((error as Error)?.message ?? error);
    });
  }
}

function base64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

/** The render3d plugin with `ctx.vfx` mounted. */
export function render3dPlugin(options: Omit<Render3dOptions, 'namespace'>): Render3dPlugin {
  return render3d({ ...options, namespace: (engine) => new VfxApi3d(engine) });
}

/** `vfx.play(count=)`: None, or a whole number of particles. */
function countArg(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) fail('PP3800', `vfx.play count= takes a whole number of particles, got ${String(value)}`);
  return value;
}
