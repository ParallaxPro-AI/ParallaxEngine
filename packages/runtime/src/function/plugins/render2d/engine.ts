/**
 * The 2D renderer for one kernel: each frame (the kernel's 'render' hook) it advances the
 * effects in game time, resolves the camera view, turns every visible entity into draw
 * commands, sorts them back to front and hands the frame to the surface.
 *
 * Images are queued for loading as entities arrive (so a scene's art is decoding before
 * its first frame) and whenever a field starts naming a new one. A reference to a file
 * that isn't in the project is PP2063 at that moment; a file the surface fails to load is
 * reported by the surface and raised on the next frame.
 */

import { ENVIRONMENT_SERVICE, FOG_OF_WAR_SERVICE, RENDER_POSE_SERVICE } from '../../services/index.js';
import { fail, ParallaxError } from '../../../core/index.js';
import type { Draw2d, EntityId, Fog2d, Frame2d, LineDraw, RenderSurface2d, Rgba, Ripple2d } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import type { EntityRecord, Fields, Handle, Kernel } from '../../kernel/index.js';
import type { AssetCatalog } from './assets.js';
import { refString } from './assets.js';
import { entityDraws, imagesOf, preloadEntity } from './draw.js';
import type { Images } from './draw.js';
import { EffectLibrary } from './effects.js';
import { ParticleSystem, particlesState } from './particles.js';
import type { EmitterSource } from './particles.js';
import { Placements } from './placement.js';
import { lighting2d } from './lighting.js';
import { post2d } from './post.js';
import { firstCameraRig, resolveView } from './view.js';
import type { CameraRig2d } from './view.js';
import { finite, WHITE } from './values.js';

export const PARTICLES = 'particles';
/** The visuals plugin's `heat_haze`: in 2D its `pulse()` is a shockwave ripple (the steady shimmer is 3D only). */
export const HEAT_HAZE = 'heat_haze';

/** A `heat_haze` pulse as a ripple at `now`, while its ring grows (as render3d's hazesOf draws it). */
export function pulseRipple(haze: Fields, x: number, y: number, now: number): Ripple2d | null {
  const at = haze['pulse_at'];
  if (typeof at !== 'number') return null;
  const t = (now - at) / finite(haze['pulse_seconds'], 'heat_haze.pulse_seconds');
  if (!(t >= 0 && t < 1)) return null;
  const full = finite(haze['pulse_radius'], 'heat_haze.pulse_radius');
  const strength = finite(haze['pulse_strength'], 'heat_haze.pulse_strength') * (1 - t) * (1 - t);
  return full > 0 && strength > 0 ? { x, y, radius: Math.max(0.01, full * t), width: Math.max(0.01, full * 0.35), strength } : null;
}

/** Seconds of movement a trail shows behind its entity. */
export const TRAIL_SECONDS = 0.3;

/** Where a one-shot effect plays: on an entity (its position and z now), or a point (z null: on top). */
export type EffectAt = { readonly entity: EntityId } | { readonly x: number; readonly y: number; readonly z: number | null };

/** `vfx.play(count=)`: a whole number of particles, 0 or more (null: the effect's own). */
function checkCount(count: number | null, code: 'PP3600'): number | null {
  if (count !== null && !(Number.isInteger(count) && count >= 0 && count <= 10000)) {
    fail(code, `vfx.play count is ${count}; it must be a whole number of particles 0..10000`, { fix: 'e.g. count=12 for a small pop, count=80 for a big one.' });
  }
  return count;
}

export interface PlayOptions {
  readonly color?: Rgba | null;
  readonly scale?: number;
  /** A direction (any length but zero) replacing the effect's own. */
  readonly direction?: readonly [number, number] | null;
  /** The colour the particles fade to, replacing the effect's end colour. */
  readonly colorEnd?: Rgba | null;
  /** Particles in all, replacing the effect's burst/rate total. */
  readonly count?: number | null;
}

export interface BeamOptions {
  readonly color?: Rgba | null;
  readonly width?: number;
  readonly seconds?: number;
}

export interface TrailOptions {
  readonly color?: Rgba | null;
  readonly width?: number;
}

interface Beam {
  readonly points: readonly number[];
  readonly width: number;
  readonly color: Rgba;
  readonly until: number;
}

interface Trail {
  entity: EntityId | null;
  readonly width: number;
  readonly color: Rgba;
  /** x, y, game time — oldest first. */
  readonly samples: number[];
  active: boolean;
}

export interface Render2dEngineOptions {
  readonly surface: RenderSurface2d;
  readonly assets: AssetCatalog;
  readonly rig?: (kernel: Kernel) => CameraRig2d;
}

export class Render2dEngine {
  readonly kernel: Kernel;
  readonly #surface: RenderSurface2d;
  readonly #images: Images;
  readonly #particles: ParticleSystem;
  readonly #placements: Placements;
  readonly #rig: CameraRig2d;
  #beams: Beam[] = [];
  #trails: Trail[] = [];
  #last: Frame2d | undefined;
  #fog: Fog2d | null = null;

  /**
   * The camera's fog of war (`fog_overlay`): its team's cells over the view (the ai plugin's
   * grid, x and z read as x and y), re-read only when the service's version or the
   * rectangle (snapped to 16-cell blocks) changes.
   */
  #fogOf(camera: EntityRecord | undefined, view: Frame2d['view']): Fog2d | null {
    const overlay = camera?.components.get('fog_overlay');
    const service = this.kernel.tryService(FOG_OF_WAR_SERVICE);
    if (overlay === undefined || service === undefined) return null;
    const color = (value: unknown): Rgba => {
      const c = value as { r: number; g: number; b: number; a: number };
      return [c.r, c.g, c.b, c.a];
    };
    const team = overlay['team'] as string;
    const size = this.#surface.size();
    const halfWidth = view.halfHeight * (size.width * view.viewport[2]) / Math.max(1, size.height * view.viewport[3]);
    const reach = Math.hypot(halfWidth, view.halfHeight);
    const block = service.cell * 16;
    const snap = (v: number, up: boolean): number => (up ? Math.ceil(v / block) : Math.floor(v / block)) * block;
    const [cx, cy] = view.center;
    const rect = [snap(cx - reach, false), snap(cy - reach, false), snap(cx + reach, true), snap(cy + reach, true)] as const;
    const key = `${service.version}|${team}|${rect.join(',')}`;
    const unexplored = color(overlay['unexplored']);
    const explored = color(overlay['explored']);
    if (this.#fog === null || this.#fog.key !== key) {
      const field = service.field(team, rect[0], rect[1], rect[2], rect[3]);
      this.#fog = { key, cell: field.cell, minX: field.minX, minY: field.minZ, cols: field.cols, rows: field.rows, cells: field.cells, unexplored, explored };
    } else if (this.#fog.unexplored.join() !== unexplored.join() || this.#fog.explored.join() !== explored.join()) {
      this.#fog = { ...this.#fog, unexplored, explored };
    }
    return this.#fog;
  }
  #forward: ((effect: Json) => void) | null = null;

  constructor(kernel: Kernel, options: Render2dEngineOptions) {
    this.kernel = kernel;
    this.#surface = options.surface;
    this.#images = imagesOf(options.assets, (path) => options.surface.load(path));
    this.#particles = new ParticleSystem(new EffectLibrary(options.assets, (path) => options.surface.load(path)));
    this.#placements = new Placements(kernel.world, () => kernel.tryService(RENDER_POSE_SERVICE));
    this.#rig = options.rig?.(kernel) ?? firstCameraRig(kernel.world);
  }

  /** The last frame drawn (tests, tools). */
  get lastFrame(): Frame2d | undefined {
    return this.#last;
  }

  get particles(): ParticleSystem {
    return this.#particles;
  }

  // ── Kernel wiring ────────────────────────────────────────────────────────────

  added(records: readonly EntityRecord[]): void {
    for (const record of records) {
      preloadEntity(record, this.#images);
      this.#syncEmitter(record);
    }
  }

  changed(record: EntityRecord): void {
    preloadEntity(record, this.#images);
    this.#syncEmitter(record);
  }

  removed(records: readonly EntityRecord[]): void {
    for (const record of records) {
      this.#particles.detach(record.id);
      for (const trail of this.#trails) if (trail.entity === record.id) this.#endTrail(trail);
    }
  }

  sceneLoading(seed: number): void {
    this.#particles.reset(seed);
    this.#beams = [];
    for (const trail of this.#trails) this.#endTrail(trail);
    this.#trails = [];
  }

  /** Particles are saved; beams and trails are short-lived handles and, like timers, are not. */
  snapshot(): Json {
    return this.#particles.snapshot() as unknown as Json;
  }

  restore(state: Json): void {
    this.#beams = [];
    for (const trail of this.#trails) this.#endTrail(trail);
    this.#trails = [];
    this.#particles.restore(particlesState(state), (id) => this.kernel.world.isAlive(id));
  }

  // ── ctx.vfx ──────────────────────────────────────────────────────────────────

  play(effect: string, at: EffectAt, options: PlayOptions = {}): void {
    const scale = options.scale ?? 1;
    if (!(Number.isFinite(scale) && scale > 0)) fail('PP3600', `vfx.play scale is ${scale}; it must be above 0`);
    let direction: number | null = null;
    if (options.direction !== undefined && options.direction !== null) {
      const [dx, dy] = options.direction;
      if (dx === 0 && dy === 0) fail('PP3600', 'vfx.play direction is zero', { fix: 'Pass a non-zero direction, or leave it out.' });
      direction = (Math.atan2(dy, dx) * 180) / Math.PI;
    }
    let point: { x: number; y: number; z: number | null };
    if ('entity' in at) {
      // A destroyed entity still has its place until teardown (effects on death read it).
      const record = this.kernel.world.peek(at.entity);
      if (record === undefined) fail('PP3002', 'vfx.play(at=) names an entity that no longer exists');
      this.#placements.clear();
      const placed = this.#placements.of(record);
      point = { x: placed.m[4], y: placed.m[5], z: placed.z };
    } else {
      point = { x: at.x, y: at.y, z: at.z };
    }
    const count = checkCount(options.count ?? null, 'PP3600');
    this.#particles.play(effect, { ...point, color: options.color ?? null, scale, direction, colorEnd: options.colorEnd ?? null, count }, 'vfx.play effect');
    this.#forward?.({
      kind: 'vfx', effect, at: [point.x, point.y, point.z], color: options.color === undefined || options.color === null ? null : [...options.color],
      scale, direction: options.direction === undefined || options.direction === null ? null : [...options.direction],
      ...(options.colorEnd !== undefined && options.colorEnd !== null && { color_end: [...options.colorEnd] }), ...(count !== null && { count }),
    });
  }

  beam(start: readonly [number, number], end: readonly [number, number], options: BeamOptions = {}): void {
    const width = options.width ?? 0.05;
    const seconds = options.seconds ?? 0.1;
    if (!(width > 0)) fail('PP3600', `vfx.beam width is ${width}; it must be above 0`);
    if (!(seconds >= 0)) fail('PP3600', `vfx.beam seconds is ${seconds}; it can't be negative`);
    this.#beams.push({ points: [...start, ...end], width, color: options.color ?? WHITE, until: this.kernel.time.now + seconds });
    this.#forward?.({
      kind: 'beam', start: [...start], end: [...end], color: options.color === undefined || options.color === null ? null : [...options.color],
      width, seconds,
    });
  }

  /**
   * Hear every one-shot effect (vfx.play, vfx.beam) as plain data, entity positions resolved
   * (a net server forwards them to clients, DESIGN §6.5); null stops. Trails are not one-shots.
   */
  forwardTo(listener: ((effect: Json) => void) | null): void {
    this.#forward = listener;
  }

  /** Play an effect another machine's `forwardTo` heard (a client, from its server). */
  replay(effect: Json): void {
    const e = effect as Record<string, Json>;
    const rgba = (c: Json | undefined): Rgba | null => (Array.isArray(c) ? (c as number[]) as unknown as Rgba : null);
    const pair = (p: Json | undefined): [number, number] => {
      const a = p as number[];
      return [a[0]!, a[1]!];
    };
    if (e['kind'] === 'vfx') {
      const at = e['at'] as (number | null)[];
      this.play(e['effect'] as string, { x: at[0]!, y: at[1]!, z: at[2] ?? null }, {
        color: rgba(e['color']), scale: e['scale'] as number, direction: e['direction'] === null ? null : pair(e['direction']),
        colorEnd: e['color_end'] === undefined ? null : rgba(e['color_end']), count: (e['count'] as number | undefined) ?? null,
      });
    } else if (e['kind'] === 'beam') {
      this.beam(pair(e['start']), pair(e['end']), { color: rgba(e['color']), width: e['width'] as number, seconds: e['seconds'] as number });
    } else {
      fail('PP9355', `The server forwarded an unknown 2D effect ${JSON.stringify(e['kind'])}`);
    }
  }

  trail(entity: EntityId, options: TrailOptions = {}): Handle {
    if (!this.kernel.world.isAlive(entity)) fail('PP3002', 'vfx.trail names an entity that was destroyed');
    const width = options.width ?? 0.1;
    if (!(width > 0)) fail('PP3600', `vfx.trail width is ${width}; it must be above 0`);
    const trail: Trail = { entity, width, color: options.color ?? WHITE, samples: [], active: true };
    this.#trails.push(trail);
    return {
      cancel: () => this.#endTrail(trail),
      get active() { return trail.active; },
    };
  }

  // ── The frame ────────────────────────────────────────────────────────────────

  render(): void {
    const problem = this.#surface.takeProblems()[0];
    if (problem !== undefined) throw new ParallaxError(problem);
    const kernel = this.kernel;
    const world = kernel.world;
    const now = kernel.time.now;
    this.#placements.clear();

    for (const id of this.#particles.emitterEntities()) {
      if (world.get(id)?.components.has(PARTICLES) !== true) this.#particles.detach(id);
    }
    // An effect may have been reassigned since its entity arrived.
    for (const [id] of world.query([PARTICLES])) this.#syncEmitter(world.get(id)!);
    this.#particles.step(kernel.time.dt, (id) => this.#emitterSource(id));
    this.#beams = this.#beams.filter((b) => b.until >= now);
    this.#trails = this.#trails.filter((t) => t.active);
    for (const trail of this.#trails) this.#sample(trail, now);

    const camera = this.#rig.active();
    const view = resolveView(
      world, this.#placements, camera, camera === undefined ? [0, 0] : this.#rig.offset(camera), this.#surface.size(),
      () => kernel.tryService(ENVIRONMENT_SERVICE)?.resolve().clear,
    );

    const commands: Draw2d[] = [];
    const hidden = new Set<number>();
    const ripples: Ripple2d[] = this.#particles.ripples();
    for (const record of world.live()) {
      const at = this.#placements.of(record);
      if (!at.visible) {
        hidden.add(record.id);
        continue;
      }
      entityDraws(commands, record, at, this.#images, now);
      const haze = record.components.get(HEAT_HAZE);
      if (haze !== undefined) {
        const ripple = pulseRipple(haze, at.m[4], at.m[5], now);
        if (ripple !== null) ripples.push(ripple);
      }
    }
    for (const draw of this.#particles.draws()) if (draw.entity === null || !hidden.has(draw.entity)) commands.push(draw);
    for (const trail of this.#trails) {
      if (trail.samples.length >= 6 && trail.entity !== null && !hidden.has(trail.entity)) commands.push(this.#trailLine(trail));
    }
    for (const beam of this.#beams) {
      commands.push({ kind: 'line', z: Infinity, entity: null, points: beam.points, width: beam.width, color: beam.color });
    }
    commands.sort((a, b) => a.z - b.z);

    const environment = kernel.tryService(ENVIRONMENT_SERVICE)?.resolve();
    const ambient = environment?.ambient;
    const lighting = lighting2d(world, this.#placements, ambient === undefined ? undefined : [ambient.r, ambient.g, ambient.b], environment);
    const fog = this.#fogOf(camera === undefined ? undefined : world.get(camera as EntityId), view);
    const post = post2d(environment?.post);
    const frame: Frame2d = {
      frame: kernel.time.frame, view, commands, lighting, ...(fog !== null && { fog }), ...(ripples.length > 0 && { ripples }),
      ...(post !== null && { post }),
    };
    this.#last = frame;
    this.#surface.draw(frame);
  }

  #syncEmitter(record: EntityRecord): void {
    const particles = record.components.get(PARTICLES);
    if (particles === undefined) {
      this.#particles.detach(record.id);
      return;
    }
    const name = record.prefab === undefined ? `entity ${record.id}` : `prefab "${record.prefab}"`;
    this.#particles.attach(record.id, refString(particles['effect'], `${name} particles.effect`), `${name} particles.effect`);
  }

  #emitterSource(id: EntityId): EmitterSource {
    const record = this.kernel.world.get(id)!;
    const particles = record.components.get(PARTICLES) as Fields;
    const at = this.#placements.of(record);
    return {
      x: at.m[4], y: at.m[5], z: at.z,
      emitting: particles['emitting'] === true,
      rateScale: finite(particles['rate_scale'], 'particles.rate_scale'),
    };
  }

  #sample(trail: Trail, now: number): void {
    const record = trail.entity === null ? undefined : this.kernel.world.get(trail.entity);
    const s = trail.samples;
    if (record !== undefined) {
      const at = this.#placements.of(record);
      const n = s.length;
      if (n === 0 || s[n - 3] !== at.m[4] || s[n - 2] !== at.m[5]) s.push(at.m[4], at.m[5], now);
      else s[n - 1] = now;
    }
    let drop = 0;
    while (drop < s.length && s[drop + 2]! < now - TRAIL_SECONDS) drop += 3;
    // Keep one sample older than the window so the line reaches back the whole way.
    if (drop >= 3) s.splice(0, drop - 3);
  }

  #trailLine(trail: Trail): LineDraw {
    const points: number[] = [];
    for (let i = 0; i < trail.samples.length; i += 3) points.push(trail.samples[i]!, trail.samples[i + 1]!);
    const record = this.kernel.world.get(trail.entity!)!;
    return { kind: 'line', z: this.#placements.of(record).z, entity: trail.entity, points, width: trail.width, color: trail.color };
  }

  #endTrail(trail: Trail): void {
    trail.active = false;
    trail.entity = null;
  }
}
