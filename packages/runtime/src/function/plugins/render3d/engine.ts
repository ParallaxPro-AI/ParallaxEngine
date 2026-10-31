/**
 * The 3D renderer for one kernel. Each frame (the kernel's 'render' hook, after visuals
 * resolved the cameras in 'ui') it advances effects in game time, builds a `Frame3d` from
 * the world — views, environment, terrain, the block world (voxels service), lights,
 * instanced meshes, skinned meshes, billboards, text and lines — and hands it to the
 * surface.
 *
 * Models are the models plugin's (the `model_poses` service: loaded, posed, socketed);
 * `preload` and `whenLoaded` reach it for boot. Parts of a model the loader doesn't read,
 * and settings this renderer doesn't draw, are warnings (`takeWarnings`).
 */

import { diagnostic, fail, isAssetUrl, isRemoteAsset, ParallaxError, remoteAssetUrl, Vec3 } from '../../../core/index.js';
import type {
  BillboardBatch, Capture3d, Decal3d, Diagnostic, EntityId, Environment3d, Frame3d, Geometry3d, Haze3d, Light3d, Line3d, Outline3d, ParticleBatch3d,
  RenderSurface3d, Rgba, Ribbon3d, SkinnedDraw, Sun3d, Terrain3d, Text3d, Texture3d, View3d,
} from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import type { EntityRecord, Fields, Handle, Kernel } from '../../kernel/index.js';
import {
  AUDIO_SERVICE, CAMERAS_SERVICE, CITY_SERVICE, DEFORMABLE_MESH_SOURCES, ENVIRONMENT_SERVICE, FOLIAGE_SERVICE, MODEL_POSE_SERVICE, PROCGEN_SERVICE, RENDER_POSE_SERVICE, SCREENS_SERVICE,
  TERRAIN_SERVICE, VOXELS_SERVICE, WIND_SERVICE, lightShare,
} from '../../services/index.js';
import type { ModelPoseSource } from '../../services/index.js';
import type { AssetCatalog } from '../../../resource/index.js';
import { compose, modelOffsetMatrix, multiply, nodeMatrices, refString, restPose, skinPalette } from '../../../resource/index.js';
import type { M4, ModelAsset } from '../../../resource/index.js';
import {
  barDraw, Batches, CAMERA, LIGHT, lightOf, Materials, MODEL, nameOf, OUTLINE, outlineOf, PARTICLES, Placements, shapeDraw, SHAPE, TEXT_MESH,
  textDraw, WORLD_BAR, WORLD_DRAW,
} from './draw.js';
import type { BatchSink, Placed3d } from './draw.js';
import { EffectLibrary } from './effects.js';
import { sceneEnvironment, terrainField, waterDraw } from './environment.js';
import { GeneratedDraws } from './generated.js';
import { NatureDraws } from './sky_frame.js';
import { ViewLayers } from './layers.js';
import { drawnBounds, photoFrame, portraitFrame, portraitView } from './capture.js';
import type { PortraitOptions } from './capture.js';
import { chooseDecals, DECAL, decalOf } from './decals.js';
import { FogOverlays } from './fog_of_war.js';
import { Impostors } from './impostor.js';
import { chooseLod, LOD, lodBands } from './lod.js';
import type { LodBands } from './lod.js';
import { ModelDraws } from './model_draw.js';
import { StaticMerge, StaticRoots } from './static_merge.js';
import { RenderTargets, surfaceSwap } from './render_targets.js';
import { effectsHideShadow, effectsOf, effectsSwap, HEAT_HAZE, hazesOf, SURFACE_FX } from './surface_fx.js';
import { ParticleSystem3d, particlesState } from './particles.js';
import type { EffectEvent, EmitterSource, ParticleDraw } from './particles.js';
import { FIRE_FLIPBOOK, SMOKE_FLIPBOOK } from './flipbook.js';
import { beamRibbons, lightningRibbons, seedOf, trailRibbon } from './ribbons.js';
import { colorVisionOf, qualityOf } from './quality.js';
import { chooseLocalShadows, fitCascades } from './shadow.js';
import { cameraViewOf, resolveViews, viewFor } from './view.js';
import { FoliageDraws } from './foliage.js';
import { GrassDraws } from './grass.js';
import { TerrainDraws } from './terrain.js';
import { windVisuals } from './wind_streaks.js';
import { VoxelDraws } from './voxels.js';

/** Seconds of movement a trail shows behind its entity (the default). */
export const TRAIL_SECONDS = 0.3;

export type Point3 = readonly [number, number, number];

export type EffectAt3d = { readonly entity: EntityId } | { readonly point: Point3 };

/** `vfx.play(count=)`: a whole number of particles, 0 or more (null: the effect's own). */
function checkCount(count: number | null, code: 'PP3800'): number | null {
  if (count !== null && !(Number.isInteger(count) && count >= 0 && count <= 10000)) {
    fail(code, `vfx.play count is ${count}; it must be a whole number of particles 0..10000`, { fix: 'e.g. count=12 for a small pop, count=80 for a big one.' });
  }
  return count;
}

export interface PlayOptions3d {
  readonly color?: Rgba | null;
  readonly scale?: number;
  readonly direction?: Point3 | null;
  /** The colour the particles fade to, replacing the effect's end colour (children too). */
  readonly colorEnd?: Rgba | null;
  /** Particles in all of the effect itself (its children keep their own), replacing its burst/rate total. */
  readonly count?: number | null;
}

export interface LineOptions {
  readonly color?: Rgba | null;
  readonly width?: number;
  readonly seconds?: number;
  /** Beams: a linear multiplier on the color (above 1 blooms). */
  readonly intensity?: number;
}

export interface LightningOptions {
  readonly color?: Rgba | null;
  readonly width?: number;
  readonly seconds?: number;
  /** Forks off the main channel. */
  readonly branches?: number;
}

export interface TrailOptions {
  readonly color?: Rgba | null;
  readonly width?: number;
  /** Seconds of movement shown (default TRAIL_SECONDS). */
  readonly seconds?: number;
  /** Additive with a bright core (energy, tracers), else a soft alpha strip. */
  readonly glow?: boolean;
}

interface TimedLine {
  readonly points: Float32Array;
  readonly width: number;
  readonly color: Rgba;
  readonly until: number;
  readonly seconds: number;
  readonly intensity: number;
}

interface Bolt {
  readonly start: Point3;
  readonly end: Point3;
  readonly width: number;
  readonly color: Rgba;
  readonly branches: number;
  readonly seed: number;
  readonly seconds: number;
  readonly born: number;
}

interface Trail {
  entity: EntityId | null;
  readonly width: number;
  readonly color: Rgba;
  readonly seconds: number;
  readonly glow: boolean;
  /** x, y, z, game time — oldest first. */
  readonly samples: number[];
  active: boolean;
}

const WHITE: Rgba = [1, 1, 1, 1];
const LIGHTNING_BLUE: Rgba = [0.72, 0.82, 1, 1];

export interface Render3dEngineOptions {
  readonly surface: RenderSurface3d;
  readonly assets: AssetCatalog;
}

/** A 1×1 white RGBA PNG: the stand-in for an image a data-only run doesn't have. */
const WHITE_TEXTURE: Texture3d = {
  id: 'builtin:white',
  source: {
    kind: 'bytes', mimeType: 'image/png',
    bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31,
      21, 196, 137, 0, 0, 0, 11, 73, 68, 65, 84, 120, 156, 99, 248, 15, 4, 0, 9, 251, 3, 253, 251, 94, 107, 43, 0, 0, 0, 0, 73, 69,
      78, 68, 174, 66, 96, 130]),
  },
  colorSpace: 'srgb', wrapU: 'repeat', wrapV: 'repeat', filter: 'nearest',
};

export class Render3dEngine {
  readonly kernel: Kernel;
  readonly #surface: RenderSurface3d;
  readonly #assets: AssetCatalog;
  readonly #particles: ParticleSystem3d;
  readonly #placements: Placements;
  readonly #materials = new Materials();
  /** Model entities drawn (`model_draw.ts`): looks, palettes, morphs. */
  readonly #modelDraws = new ModelDraws();
  /** First-person view layers (`layers.ts`). */
  readonly #layers: ViewLayers;
  /** Procgen meshes and surface overlays (`generated.ts`). */
  readonly #generated = new GeneratedDraws();
  /** Sky model, clouds, water, weather (B3: `sky_frame.ts`). */
  readonly #nature = new NatureDraws();
  /** Far instances drawn as impostors (`impostor.ts`); sources kept per model. */
  readonly #impostors = new Impostors();
  /** Camera feeds and mirrors (`render_targets.ts`). */
  readonly #targets: RenderTargets;
  /** Fog of war over the ground (`fog_of_war.ts`). */
  readonly #fog = new FogOverlays();
  /** Static entities' merged chunks (`static_merge.ts`). */
  readonly #merge = new StaticMerge();
  readonly #statics: StaticRoots;
  readonly #textures = new Map<string, Texture3d>();
  readonly #voxels = new VoxelDraws();
  /** The terrain's CDLOD tiles (terrain.ts), scattered foliage (foliage.ts) and grass (grass.ts). */
  readonly terrain = new TerrainDraws();
  readonly foliage = new FoliageDraws();
  readonly grass = new GrassDraws();
  #beams: TimedLine[] = [];
  #bolts: Bolt[] = [];
  /** Effect sound loops playing, by audio key. */
  #loops = new Set<string>();
  #debug: TimedLine[] = [];
  #trails: Trail[] = [];
  #warnings: Diagnostic[] = [];
  readonly #warned = new Set<string>();
  /** The light entity drawn as the sun this frame (left out of `lights`). */
  #sunLight: Light3d | undefined;
  #last: Frame3d | undefined;
  #forward: ((effect: Json) => void) | null = null;
  /** Game seconds of frames the frame cap skipped (effects step through them on the next drawn frame). */
  #skipped = 0;

  constructor(kernel: Kernel, options: Render3dEngineOptions) {
    this.kernel = kernel;
    this.#surface = options.surface;
    this.#assets = options.assets;
    this.#particles = new ParticleSystem3d(new EffectLibrary(options.assets));
    this.#placements = new Placements(kernel.world, () => kernel.tryService(RENDER_POSE_SERVICE));
    this.#layers = new ViewLayers(kernel.world);
    this.#statics = new StaticRoots(kernel.world);
    this.#targets = new RenderTargets(kernel.world);
  }

  /** The models plugin's posed models. */
  get #models(): ModelPoseSource {
    return this.kernel.service(MODEL_POSE_SERVICE);
  }

  get lastFrame(): Frame3d | undefined {
    return this.#last;
  }

  get particles(): ParticleSystem3d {
    return this.#particles;
  }

  /** Warnings since the last call: model parts not read, settings not drawn. Boot logs them. */
  takeWarnings(): readonly Diagnostic[] {
    const warnings = [...this.#models.takeWarnings(), ...this.#warnings];
    this.#warnings = [];
    return warnings;
  }

  /**
   * Seconds in a clip (the visuals plugin's `clipLength`). With the playing `entity`, a
   * bare clip name is a clip of that entity's own model (as the animator plays it);
   * without one, a bare name must have one length across the loaded models (PP3806).
   */
  clipLength(clip: string, entity?: EntityId): number {
    return this.#models.clipLength(clip, entity);
  }

  /** Queue every model the project's prefabs and scenes name (and clips' models), so they load before the first frame. */
  preload(): void {
    this.#models.preload();
  }

  /** Resolves when every model requested so far has loaded (or failed: raised on the next frame). */
  whenLoaded(): Promise<void> {
    return this.#models.whenLoaded();
  }

  // ── Kernel wiring ────────────────────────────────────────────────────────────

  added(records: readonly EntityRecord[]): void {
    for (const record of records) this.changed(record);
  }

  changed(record: EntityRecord): void {
    this.#syncEmitter(record);
  }

  removed(records: readonly EntityRecord[]): void {
    for (const record of records) {
      this.#particles.detach(record.id);
      this.#modelDraws.forget(record.id);
      for (const trail of this.#trails) if (trail.entity === record.id) this.#endTrail(trail);
    }
  }

  sceneLoading(seed: number): void {
    this.#particles.reset(seed);
    this.#clearLines();
  }

  /** Particles are saved; beams, trails and debug lines are short-lived and, like timers, are not. */
  snapshot(): Json {
    return this.#particles.snapshot() as unknown as Json;
  }

  restore(state: Json): void {
    this.#clearLines();
    this.#particles.restore(particlesState(state), (id) => this.kernel.world.isAlive(id));
  }

  // ── ctx.vfx and debug lines ──────────────────────────────────────────────────

  play(effect: string, at: EffectAt3d, options: PlayOptions3d = {}): void {
    const scale = options.scale ?? 1;
    if (!(Number.isFinite(scale) && scale > 0)) fail('PP3800', `vfx.play scale is ${scale}; it must be above 0`);
    let direction: Point3 | null = null;
    if (options.direction !== undefined && options.direction !== null) {
      const [x, y, z] = options.direction;
      const l = Math.hypot(x, y, z);
      if (!(l > 0)) fail('PP3800', 'vfx.play direction is zero', { fix: 'Pass a non-zero direction, or leave it out.' });
      direction = [x / l, y / l, z / l];
    }
    let position: Point3;
    if ('entity' in at) {
      const record = this.kernel.world.peek(at.entity);
      if (record === undefined) fail('PP3002', 'vfx.play(at=) names an entity that no longer exists');
      this.#placements.clear();
      const m = this.#placements.of(record).m;
      position = [m[12]!, m[13]!, m[14]!];
    } else {
      position = at.point;
    }
    const count = checkCount(options.count ?? null, 'PP3800');
    this.#particles.play(effect, { position, color: options.color ?? null, scale, direction, colorEnd: options.colorEnd ?? null, count }, 'vfx.play effect');
    this.#forward?.({
      kind: 'vfx', effect, at: [...position], color: options.color === undefined || options.color === null ? null : [...options.color],
      scale, direction: direction === null ? null : [...direction],
      ...(options.colorEnd !== undefined && options.colorEnd !== null && { color_end: [...options.colorEnd] }), ...(count !== null && { count }),
    });
  }

  beam(start: Point3, end: Point3, options: LineOptions = {}): void {
    const line = this.#timed([...start, ...end], options, 0.05, 0.1, 'vfx.beam');
    this.#beams.push(line);
    this.#forward?.({
      kind: 'beam', start: [...start], end: [...end], color: [...line.color], width: line.width,
      seconds: options.seconds ?? 0.1, intensity: line.intensity,
    });
  }

  /** A branching lightning bolt from start to end, re-struck a few times a second while it shows. */
  lightning(start: Point3, end: Point3, options: LightningOptions = {}): void {
    const width = options.width ?? 0.08;
    const seconds = options.seconds ?? 0.25;
    const branches = options.branches ?? 3;
    if (!(width > 0)) fail('PP3800', `vfx.lightning width is ${width}; it must be above 0`);
    if (!(seconds > 0)) fail('PP3800', `vfx.lightning seconds is ${seconds}; it must be above 0`);
    if (!(Number.isInteger(branches) && branches >= 0 && branches <= 16)) fail('PP3800', `vfx.lightning branches is ${branches}; it must be a whole number 0–16`);
    if (![...start, ...end].every(Number.isFinite)) fail('PP3800', 'vfx.lightning needs two finite 3D points');
    const color = options.color ?? LIGHTNING_BLUE;
    // The shape is a hash of the call (render-only): every machine that replays it strikes the same bolt.
    const seed = seedOf(...start, ...end, this.kernel.time.now, this.#bolts.length);
    this.#bolts.push({ start, end, width, color, branches, seed, seconds, born: this.kernel.time.now });
    this.#forward?.({ kind: 'lightning', start: [...start], end: [...end], color: [...color], width, seconds, branches });
  }

  /**
   * Hear every one-shot effect (vfx.play, vfx.beam, vfx.lightning) as plain data, entity positions resolved
   * (a net server forwards them to clients, DESIGN §6.5); null stops. Trails are not one-shots.
   */
  forwardTo(listener: ((effect: Json) => void) | null): void {
    this.#forward = listener;
  }

  /** Play an effect another machine's `forwardTo` heard (a client, from its server). */
  replay(effect: Json): void {
    const e = effect as Record<string, Json>;
    const rgba = (c: Json | undefined): Rgba | null => (Array.isArray(c) ? (c as number[]) as unknown as Rgba : null);
    const point = (p: Json | undefined): Point3 => {
      const a = p as number[];
      return [a[0]!, a[1]!, a[2]!];
    };
    if (e['kind'] === 'vfx') {
      this.play(e['effect'] as string, { point: point(e['at']) }, {
        color: rgba(e['color']), scale: e['scale'] as number, direction: e['direction'] === null ? null : point(e['direction']),
        colorEnd: e['color_end'] === undefined ? null : rgba(e['color_end']), count: (e['count'] as number | undefined) ?? null,
      });
    } else if (e['kind'] === 'beam') {
      this.beam(point(e['start']), point(e['end']), {
        color: rgba(e['color']), width: e['width'] as number, seconds: e['seconds'] as number, intensity: (e['intensity'] as number | undefined) ?? 1,
      });
    } else if (e['kind'] === 'lightning') {
      this.lightning(point(e['start']), point(e['end']), {
        color: rgba(e['color']), width: e['width'] as number, seconds: e['seconds'] as number, branches: e['branches'] as number,
      });
    } else {
      fail('PP9355', `The server forwarded an unknown 3D effect ${JSON.stringify(e['kind'])}`);
    }
  }

  /** A debug line (DebugApi.line): drawn for `seconds` of game time (0: this frame only). */
  debugLine(points: readonly number[], options: LineOptions = {}): void {
    this.#debug.push(this.#timed(points, options, 0.02, 0, 'debug.line'));
  }

  trail(entity: EntityId, options: TrailOptions = {}): Handle {
    if (!this.kernel.world.isAlive(entity)) fail('PP3002', 'vfx.trail names an entity that was destroyed');
    const width = options.width ?? 0.1;
    if (!(width > 0)) fail('PP3800', `vfx.trail width is ${width}; it must be above 0`);
    const seconds = options.seconds ?? TRAIL_SECONDS;
    if (!(seconds > 0 && seconds <= 10)) fail('PP3800', `vfx.trail seconds is ${seconds}; it must be above 0 and at most 10`);
    const trail: Trail = { entity, width, color: options.color ?? WHITE, seconds, glow: options.glow === true, samples: [], active: true };
    this.#trails.push(trail);
    return {
      cancel: () => this.#endTrail(trail),
      get active() { return trail.active; },
    };
  }

  #timed(points: readonly number[], options: LineOptions, defaultWidth: number, defaultSeconds: number, what: string): TimedLine {
    const width = options.width ?? defaultWidth;
    const seconds = options.seconds ?? defaultSeconds;
    if (!(width > 0)) fail('PP3800', `${what} width is ${width}; it must be above 0`);
    if (!(seconds >= 0)) fail('PP3800', `${what} seconds is ${seconds}; it can't be negative`);
    if (points.length < 6 || points.length % 3 !== 0 || !points.every(Number.isFinite)) {
      fail('PP3800', `${what} needs at least two finite 3D points`);
    }
    const intensity = options.intensity ?? 1;
    if (!(intensity >= 0 && Number.isFinite(intensity))) fail('PP3800', `${what} intensity is ${intensity}; it must be 0 or more`);
    return { points: Float32Array.from(points), width, color: options.color ?? WHITE, until: this.kernel.time.now + seconds, seconds, intensity };
  }

  // ── Photos and portraits (capture.ts) ────────────────────────────────────────

  #capture(): (frame: Frame3d, width: number, height: number) => Promise<Capture3d> {
    const surface = this.#surface;
    if (surface.capture === undefined) {
      return fail('PP3845', 'This renderer surface cannot capture images', { fix: 'Photos and portraits need the browser surface or the headless recorder.' });
    }
    return (frame, width, height) => surface.capture!(frame, width, height);
  }

  #size(width: number, height: number, what: string): void {
    if (!(Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1 && width <= 4096 && height <= 4096)) {
      fail('PP3846', `${what} size is ${width} × ${height}; each side must be a whole number from 1 to 4096`);
    }
  }

  /** A photo: the last drawn frame seen from `camera` (default: the first view's) at a size, read back. */
  photo(options: { readonly width: number; readonly height: number; readonly camera?: EntityId | null }): Promise<Capture3d> {
    this.#size(options.width, options.height, 'photo');
    const capture = this.#capture();
    const last = this.#last;
    if (last === undefined || last.views.length === 0) {
      return Promise.reject(new ParallaxError(diagnostic('PP3847', 'A photo was asked for before anything was drawn', { fix: 'Take photos once the game is running (after its first frame).' })));
    }
    const id = options.camera ?? (last.views[0]!.camera as EntityId);
    const record = this.kernel.world.get(id);
    if (record === undefined || !record.components.has('camera')) {
      fail('PP3848', `photo(camera=) names ${record === undefined ? 'an entity that no longer exists' : `${nameOf(record)}, which has no Camera`}`);
    }
    const view = viewFor(record, cameraViewOf(record), { x: 0, y: 0, width: options.width, height: options.height }, colorVisionOf(this.kernel), last.quality.viewDistance);
    return capture(photoFrame(last, view), options.width, options.height);
  }

  /**
   * A portrait: an entity's Model as posed and looked now, a model reference at rest, or a
   * model already built outside the game (`asset`: an editor's preview of a file the project
   * doesn't hold yet), alone in a studio (capture.ts), read back.
   */
  portrait(subject: { readonly entity: EntityId } | { readonly model: string } | { readonly asset: ModelAsset }, options: PortraitOptions): Promise<Capture3d> {
    this.#size(options.width, options.height, 'portrait');
    const capture = this.#capture();
    const models = this.#models;
    const batches = new Batches();
    const skinned: SkinnedDraw[] = [];
    const origin: Placed3d = { m: compose(0, 0, 0, 0, 0, 0, 1, 1, 1, 1), visible: true };
    if ('entity' in subject) {
      const record = this.kernel.world.get(subject.entity);
      const fields = record?.components.get(MODEL);
      if (record === undefined || fields === undefined) fail('PP3848', 'portrait() takes an entity with a Model, or a model reference');
      this.#modelDraws.draw(models, batches, skinned, this.#materials, record, fields, origin);
    } else {
      const asset = 'asset' in subject ? subject.asset : models.get(models.resolve(subject.model, 'portrait model'));
      if (asset === undefined) {
        return Promise.reject(new ParallaxError(diagnostic('PP3849', `portrait(): the model ${'model' in subject ? subject.model : '(given)'} hasn't loaded`, {
          fix: 'Portraits of models named only in code need the model loaded first (name it in a prefab, or wait a frame).',
        })));
      }
      const worlds = nodeMatrices(asset, restPose(asset));
      for (const n of asset.order) {
        const node = asset.nodes[n]!;
        if (node.mesh === null) continue;
        for (const primitive of asset.meshes[node.mesh] ?? []) {
          if (node.skin !== null && primitive.geometry.joints !== null) {
            const skin = asset.skins[node.skin]!;
            skinned.push({
              geometry: primitive.geometry, material: primitive.material, model: origin.m, tint: [1, 1, 1, 1], palette: skinPalette(skin, worlds),
              jointCount: skin.joints.length, entity: -1, castShadows: false,
            });
          } else {
            batches.add(primitive.geometry, primitive.material, false, worlds.subarray(n * 16, n * 16 + 16), [1, 1, 1, 1], null);
          }
        }
      }
    }
    const meshes = batches.close();
    const bounds = drawnBounds(meshes, skinned);
    if (bounds === null) {
      return Promise.reject(new ParallaxError(diagnostic('PP3849', 'portrait(): the model draws nothing (still loading, or no file in this run)', {
        fix: 'Ask for portraits once the model has loaded; a data-only run has no model files.',
      })));
    }
    const view = portraitView(bounds, options, -1);
    return capture(portraitFrame(meshes, skinned, view, qualityOf(this.kernel, this.#surface.deviceTier), this.kernel.time.frame), options.width, options.height);
  }

  // ── The frame ────────────────────────────────────────────────────────────────

  render(): void {
    const surfaceProblem = this.#surface.takeProblems()[0];
    if (surfaceProblem !== undefined) throw new ParallaxError(surfaceProblem);
    const kernel = this.kernel;
    const world = kernel.world;
    const now = kernel.time.now;
    const quality = qualityOf(kernel, this.#surface.deviceTier);
    // The frame cap: a skipped display refresh builds no frame; effects catch up on the next.
    if (this.#surface.wantsFrame?.(quality.frameCap) === false) {
      this.#skipped += kernel.time.dt;
      return;
    }
    const models = this.#models;
    // The models plugin's render hook ran first: poses are fresh and socketed entities are on their sockets.
    this.#modelDraws.frame();
    this.#placements.clear();

    for (const id of this.#particles.emitterEntities()) {
      if (world.get(id)?.components.has(PARTICLES) !== true) this.#particles.detach(id);
    }
    for (const [id] of world.query([PARTICLES])) this.#syncEmitter(world.get(id)!);
    this.#particles.step(kernel.time.dt + this.#skipped, (id) => this.#emitterSource(id));
    this.#skipped = 0;

    const layers = this.#layers;
    layers.frame();
    const colorVision = colorVisionOf(kernel);
    const views = this.#fog.apply(kernel, layers.withOverlays(resolveViews(world, this.#surface.size(), colorVision, quality.viewDistance)));
    // Far animated models are re-posed every few frames from here on (models/animation_lod.ts).
    models.animationLod?.(views.map((v) => v.position), quality.lodScale);
    const targets = this.#targets;
    const offscreen = targets.frame(views[0], quality, colorVision, kernel.time.realNow, (r) => this.#placements.of(r).m);
    const impostors = this.#impostors;

    const batches = new Batches();
    const statics = this.#statics;
    statics.frame();
    const merge = this.#merge;
    merge.fallback = batches;
    const skinned: SkinnedDraw[] = [];
    const texts: Text3d[] = [];
    const billboards: BillboardBatch[] = [];
    const lights: Light3d[] = [];
    const dayNight = kernel.tryService(ENVIRONMENT_SERVICE)?.resolve();
    const outlines: Outline3d[] = [];
    const hidden = new Set<number>();
    const decals: Decal3d[] = [];
    const hazes: Haze3d[] = [];
    // `data`: a normal map (linear); one with no file is no map rather than plain white.
    const texture = (ref: unknown, where: string, data = false): Texture3d | null => {
      const t = this.#imageTexture(this.#assets.resolve(refString(ref, where), 'images', where), 'repeat', 'linear', data ? 'linear' : 'srgb');
      return data && t === WHITE_TEXTURE ? null : t;
    };

    for (const record of world.live()) {
      const at = this.#placements.of(record);
      if (!at.visible) {
        hidden.add(record.id);
        continue;
      }
      const style = layers.styleOf(record);
      const shape = record.components.get(SHAPE);
      const model = record.components.get(MODEL);
      const lod = record.components.get(LOD);
      // Surface effects (surface_fx.ts) go on over a monitor's or mirror's swap.
      const fx = record.components.get(SURFACE_FX);
      const effects = fx === undefined ? null : effectsOf(record, fx, now);
      const targetSwap = surfaceSwap(record, targets);
      const swap = effects === null ? targetSwap : effectsSwap(fx!, effects, targetSwap);
      const drawn = effectsHideShadow(effects) ? { ...style, shadows: false } : style;
      // Static entities' meshes merge into world chunks (static_merge.ts), unless they are on a layer, outlined or have effects.
      const chunk = style === WORLD_DRAW && lod === undefined && !record.components.has(OUTLINE) && fx === undefined ? statics.chunkOf(record) : null;
      if (chunk !== null) merge.chunk = chunk;
      const sink: BatchSink = chunk === null ? batches : merge;
      if (lod === undefined || style.layer === 'viewmodel') {
        if (shape !== undefined) shapeDraw(sink, this.#materials, record, shape, at, texture, drawn, swap);
        if (model !== undefined) {
          this.#modelDraws.draw(models, sink, skinned, this.#materials, record, model, at, drawn, null, undefined, swap);
          // A first-person body in its own view: the view layer's Model options, no second shadow.
          const own = layers.bodyView(record);
          if (own !== null) this.#modelDraws.draw(models, batches, skinned, this.#materials, record, model, at, own.style, own.options);
        }
      } else {
        const where = `${nameOf(record)} lod`;
        const bands = lodBands(lod, quality, where);
        for (const { band, fade } of chooseLod(bands, nearestView(views, at.m))) {
          const faded = { ...style, fade };
          if (band === 0) {
            if (shape !== undefined) shapeDraw(batches, this.#materials, record, shape, at, texture, faded);
            if (model !== undefined) this.#modelDraws.draw(models, batches, skinned, this.#materials, record, model, at, faded);
            continue;
          }
          if (model === undefined) continue;
          const asset = lodModel(models, record, bands, band, where);
          if (asset === undefined) continue;
          if (bands.impostor && band === bands.starts.length) impostors.add(asset, withOffset(at.m, model, where), fade, record.id);
          else this.#modelDraws.draw(models, batches, skinned, this.#materials, record, model, at, faded, null, asset);
        }
      }
      const light = record.components.get(LIGHT);
      if (light !== undefined) {
        // when="night"/"day": scaled by the hour, left out while it is off.
        const share = lightShare(light['when'], dayNight);
        if (share > 0) lights.push(lightOf(record, light, at, share));
      }
      const text = record.components.get(TEXT_MESH);
      if (text !== undefined) {
        const draw = textDraw(record, text, at);
        if (draw !== null) texts.push(draw);
      }
      const bar = record.components.get(WORLD_BAR);
      if (bar !== undefined) {
        const draw = barDraw(record, bar, at);
        if (draw !== null) billboards.push(draw);
      }
      const outline = record.components.get(OUTLINE);
      if (outline !== undefined) outlines.push(outlineOf(record, outline));
      const haze = record.components.get(HEAT_HAZE);
      if (haze !== undefined) hazes.push(...hazesOf(record, haze, [at.m[12]!, at.m[13]!, at.m[14]!], now));
      const decal = record.components.get(DECAL);
      if (decal !== undefined) {
        const drawn = decalOf(record, decal, at, (ref, where) => this.#imageTexture(this.#assets.resolve(refString(ref, where), 'images', where), 'clamp'));
        if (drawn !== null) decals.push(drawn);
      }
    }
    // Effects: particles (alpha far to near, then additive), their lights, hazes, sounds and camera shakes.
    const particles = this.#particleBatches(this.#particles.draws(views[0]?.position ?? null), hidden);
    for (const light of this.#particles.lights()) {
      lights.push({
        kind: 'point', color: [light.color[0], light.color[1], light.color[2]], intensity: light.intensity, position: light.position,
        direction: [0, -1, 0], range: light.range, angle: 0, shadows: false, entity: light.entity,
      });
    }
    for (const haze of this.#particles.hazes()) hazes.push(haze);
    this.#effectEvents(this.#particles.takeEvents());

    const environment = this.#withSun(sceneEnvironment(kernel, (ref) => this.#authoredImage(ref, 'The skybox')), lights);
    const nature = this.#nature.build(kernel, views, environment, quality);
    billboards.push(...nature.billboards);
    const frameLights = lights.filter((l) => l !== this.#sunLight);
    const local = chooseLocalShadows(frameLights, views[0], quality);
    if (local.dropped > 0) {
      this.#warnOnce(`light-shadows:${quality.level}`, 'PP3815',
        `${local.dropped} point or spot light${local.dropped === 1 ? '' : 's'} with shadows=True got no shadow: quality "${quality.level}" has ${quality.localShadowTiles} shadow tiles (a spot light takes 1, a point light 6), given to the nearest lights first`,
        'Turn shadows off on lights where they matter least, or use spot lights; low quality draws sun shadows only.');
    }

    const field = terrainField(kernel);
    let terrain: Terrain3d | null = null;
    const meshes = [...batches.close(), ...merge.close()];
    if (field !== null) {
      const service = kernel.service(TERRAIN_SERVICE);
      terrain = this.terrain.draw(field, service.tiles()!, views, quality, (ref) => this.#imageTexture(this.#authoredImage(ref, `Scene "${field.scene}" terrain texture`), 'repeat'), service.splatMap());
      if (this.terrain.takeDropped()) {
        this.#warnOnce(`terrain-palette:${field.scene}`, 'PP3830',
          `Scene "${field.scene}" terrain: some tiles blend more than 4 layers; each draws its 4 strongest and folds the rest in`,
          'Keep at most 4 layers overlapping within ~32 m (move or shrink a paint, or merge similar layers).');
      }
      const water = waterDraw(field);
      if (water !== null && !nature.hidesTerrainWater) meshes.push(water);
    }
    const generated = [
      ...kernel.tryService(PROCGEN_SERVICE)?.meshes() ?? [],...kernel.tryService(CITY_SERVICE)?.meshes() ?? [],
    ];
    if (generated.length > 0) meshes.push(...this.#generated.draws(generated, (path, data) => this.#imageTexture(path, 'repeat', 'linear', data === true ? 'linear' : 'srgb')));
    const blockWorld = kernel.tryService(VOXELS_SERVICE)?.current() ?? null;
    meshes.push(...this.#voxels.draws(blockWorld, (ref) => this.#imageTexture(this.#authoredImage(ref, 'A block texture'), 'repeat', 'nearest')));
    // Deformable meshes (cloth, soft bodies) as generated meshes; in-world UI screens.
    const deformable = DEFORMABLE_MESH_SOURCES.flatMap((key) => kernel.tryService(key)?.meshes() ?? []);
    if (deformable.length > 0) meshes.push(...this.#generated.draws(deformable, (path) => this.#imageTexture(path, 'repeat')));
    meshes.push(...(kernel.tryService(SCREENS_SERVICE)?.draws() ?? []));

    this.#beams = this.#beams.filter((b) => b.until >= now);
    this.#bolts = this.#bolts.filter((b) => b.born + b.seconds >= now);
    this.#debug = this.#debug.filter((d) => d.until >= now);
    this.#trails = this.#trails.filter((t) => t.active);
    const lines: Line3d[] = [];
    const ribbons: Ribbon3d[] = [];
    for (const trail of this.#trails) {
      this.#sample(trail, now);
      if (trail.samples.length >= 8 && trail.entity !== null && !hidden.has(trail.entity)) {
        const ribbon = trailRibbon(trail.samples, trail, trail.entity);
        if (ribbon !== null) ribbons.push(ribbon);
      }
    }
    for (const beam of this.#beams) {
      const p = beam.points;
      const left = beam.seconds > 0 ? (beam.until - now) / beam.seconds : 1;
      ribbons.push(...beamRibbons([p[0]!, p[1]!, p[2]!], [p[3]!, p[4]!, p[5]!], beam.width, beam.color, 2 * beam.intensity, left));
    }
    for (const bolt of this.#bolts) ribbons.push(...lightningRibbons({ ...bolt, age: now - bolt.born }));
    for (const line of this.#debug) lines.push({ layer: 'overlay', points: line.points, width: line.width, color: line.color, entity: null });

    // Vegetation and visible wind (foliage.ts, grass.ts, wind_streaks.ts).
    const wind = kernel.tryService(WIND_SERVICE);
    const foliage = kernel.tryService(FOLIAGE_SERVICE);
    if (foliage !== undefined) {
      const drawn = this.foliage.draw(foliage, views, quality, wind, now, kernel.time.realNow, models);
      meshes.push(...drawn.meshes);
      billboards.push(...drawn.billboards);
      impostors.include(drawn.impostors);
    }
    const grassLayers = foliage?.grass() ?? [];
    if (grassLayers.length > 0 || (field !== null && field.brush.length > 0)) {
      meshes.push(...this.grass.draw(grassLayers, foliage?.revision ?? 0, field, views, quality, wind, this.foliage.governor.scale, now));
    }
    if (wind !== undefined) {
      const visible = windVisuals(wind, views[0], now);
      lines.push(...visible.lines);
      billboards.push(...visible.billboards);
    }

    lines.push(...nature.lines);
    const frame: Frame3d = {
      frame: kernel.time.frame,
      views,
      environment,
      quality,
      sunShadow: environment.sun?.shadows === true && views.length > 0 ? fitCascades(views[0]!, environment.sun.direction, quality, environment.shadowDistance ?? null) : null,
      localShadows: local.shadows,
      terrain,
      meshes,
      skinned,
      lights: frameLights,
      billboards,
      texts,
      lines,
      outlines,
      nature: nature.frame,
      impostors: impostors.close(),
      decals: chooseDecals(decals, views[0]?.position ?? null, quality.maxDecals),
      offscreen,
      time: now,
      ...(hazes.length > 0 && { hazes }),
      ...(particles.length > 0 && { particles }),
      ...(ribbons.length > 0 && { ribbons }),
    };
    this.#last = frame;
    this.#surface.draw(frame);
  }

  /** Particle draws as the port's batches: alpha-blended emitters far to near, then additive ones. */
  #particleBatches(draws: readonly ParticleDraw[], hidden: ReadonlySet<number>): ParticleBatch3d[] {
    const shown = draws.filter((d) => d.entity === null || !hidden.has(d.entity));
    const alpha = shown.filter((d) => d.def.blend === 'alpha').sort((a, b) => b.distance - a.distance);
    const additive = shown.filter((d) => d.def.blend === 'additive');
    return [...alpha, ...additive].map((draw) => {
      const def = draw.def;
      const image = def.flipbook === 'fire' ? FIRE_FLIPBOOK : def.flipbook === 'smoke' ? SMOKE_FLIPBOOK
        : def.image === null ? null : this.#imageTexture(def.image, 'clamp');
      return {
        blend: def.blend, shape: def.shape, image, frames: def.frames, facing: def.facing, soft: def.soft, lit: def.lit,
        intensity: def.intensity, count: draw.count, data: draw.data, entity: draw.entity,
      };
    });
  }

  /** Effects that burst this frame: their sounds play, cameras near them shake; continuous emitters' sound loops follow them. */
  #effectEvents(events: readonly EffectEvent[]): void {
    const audio = this.kernel.tryService(AUDIO_SERVICE);
    const calm = this.kernel.registry.resources.has('settings') && this.kernel.resource('settings')['reduced_motion'] === true;
    for (const event of events) {
      const { def, position, scale } = event;
      if (def.sound !== null && event.entity === null && audio !== undefined) audio.play({ sound: def.sound, at: new Vec3(...position) });
      const shake = def.shake;
      if (shake === null || calm) continue;
      for (const live of this.kernel.tryService(CAMERAS_SERVICE)?.live() ?? []) {
        const d = Math.hypot(live.position.x - position[0], live.position.y - position[1], live.position.z - position[2]);
        const reach = shake.radius * scale;
        if (d >= reach) continue;
        const near = 1 - d / reach;
        const camera = this.kernel.world.get(live.entity)?.components.get(CAMERA) as { shake?: (...a: unknown[]) => void } | undefined;
        camera?.shake?.(shake.intensity * Math.sqrt(scale) * near * near, shake.seconds);
      }
    }
    if (audio === undefined) return;
    const playing = new Set<string>();
    for (const loop of this.#particles.loops()) {
      const key = `vfx:${loop.entity}`;
      playing.add(key);
      audio.loop(key, { sound: loop.sound, at: new Vec3(...loop.position) });
    }
    for (const key of this.#loops) if (!playing.has(key)) audio.stop(key);
    this.#loops = playing;
  }

  /**
   * The sun: the brightest directional light entity that casts shadows, else the environment's
   * sun, else the brightest shadowless one. Every other directional light is a shadowless fill
   * (a sky bounce, a rim), so a fill entity beside the environment's sun adds to it.
   */
  #withSun(scene: Environment3d, lights: readonly Light3d[]): Environment3d {
    let best: Light3d | undefined;
    let fill: Light3d | undefined;
    for (const light of lights) {
      if (light.kind !== 'directional') continue;
      if (light.shadows) {
        if (best === undefined || light.intensity > best.intensity) best = light;
      } else if (fill === undefined || light.intensity > fill.intensity) {
        fill = light;
      }
    }
    if (best === undefined && scene.sun === null) best = fill;
    this.#sunLight = best;
    if (best === undefined) return scene;
    const upward = upwardSun(best.direction);
    if (upward !== null) {
      const record = best.entity === null ? undefined : this.kernel.world.get(best.entity as EntityId);
      const who = record === undefined ? `entity ${best.entity}` : nameOf(record);
      this.#warnOnce(`sun-upward:${best.entity}`, 'PP3817', `The sun (${who}'s directional light) shines upward: ${upward}`,
        'A directional light travels along its entity\'s +z, and a positive first rotation angle tilts it down: '
        + 'rotation [40, yaw, 0] is a sun 40° above the horizon. Flip the sign of the first angle.');
    }
    const sun: Sun3d = { direction: best.direction, color: best.color, intensity: best.intensity, shadows: best.shadows };
    return { ...scene, sun };
  }

  #warnOnce(key: string, code: `PP${number}`, message: string, fix: string): void {
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.#warnings.push(diagnostic(code, message, { severity: 'warning', fix }));
  }

  /**
   * An image a game's data names where it is drawn (terrain layers, block faces): its handle
   * ("images/road") resolved to the file, or a hosted URL as written. A file path or a bare
   * name is PP2063 naming the handle, as for every asset reference.
   */
  #authoredImage(written: string, where: string): string {
    return isAssetUrl(written) ? written : this.#assets.resolve(written, 'images', where);
  }

  #imageTexture(written: string, wrap: 'repeat' | 'clamp', filter: 'linear' | 'nearest' = 'linear', colorSpace: 'srgb' | 'linear' = 'srgb'): Texture3d {
    // Terrain, voxel and generated-mesh textures arrive as written: a hosted URL is normalized here.
    const path = remoteAssetUrl(written) ?? written;
    // Data-only runs: an image with no file is plain white, so the surface keeps its base
    // color and nothing is fetched (as a model with no file draws nothing).
    // A hosted asset (a URL) where the run can't fetch it (headless) is drawn the same way.
    if (isRemoteAsset(path) ? !this.#assets.remote : !this.#assets.checked && !this.#assets.has(path)) return WHITE_TEXTURE;
    const key = (filter === 'linear' ? `${path}|${wrap}` : `${path}|${wrap}|${filter}`) + (colorSpace === 'linear' ? '|linear' : '');
    let texture = this.#textures.get(key);
    if (texture === undefined) {
      // Hosted assets have no precompressed variants (`parallax build` writes them beside project files).
      const variants = isRemoteAsset(path) ? [] : compressedVariants(path, (p) => this.#assets.has(p));
      texture = { id: key, source: { kind: 'file', path, ...(variants.length > 0 && { variants }) }, colorSpace, wrapU: wrap, wrapV: wrap, filter };
      this.#textures.set(key, texture);
    }
    return texture;
  }

  #syncEmitter(record: EntityRecord): void {
    const particles = record.components.get(PARTICLES);
    if (particles === undefined) {
      this.#particles.detach(record.id);
      return;
    }
    const where = `${nameOf(record)} particles.effect`;
    this.#particles.attach(record.id, refString(particles['effect'], where), where);
  }

  #emitterSource(id: EntityId): EmitterSource {
    const record = this.kernel.world.get(id)!;
    const particles = record.components.get(PARTICLES) as Fields;
    const m = this.#placements.of(record).m;
    return {
      position: [m[12]!, m[13]!, m[14]!],
      emitting: particles['emitting'] === true,
      rateScale: particles['rate_scale'] as number,
    };
  }

  #sample(trail: Trail, now: number): void {
    const record = trail.entity === null ? undefined : this.kernel.world.get(trail.entity);
    const s = trail.samples;
    if (record !== undefined) {
      const m = this.#placements.of(record).m;
      const n = s.length;
      if (n === 0 || s[n - 4] !== m[12] || s[n - 3] !== m[13] || s[n - 2] !== m[14]) s.push(m[12]!, m[13]!, m[14]!, now);
      else s[n - 1] = now;
    }
    let drop = 0;
    while (drop < s.length && s[drop + 3]! < now - trail.seconds) drop += 4;
    if (drop >= 4) s.splice(0, drop - 4);
  }

  #endTrail(trail: Trail): void {
    trail.active = false;
    trail.entity = null;
  }

  #clearLines(): void {
    this.#beams = [];
    this.#bolts = [];
    this.#debug = [];
    for (const trail of this.#trails) this.#endTrail(trail);
    this.#trails = [];
  }
}

/** Meters from a world matrix's origin to the nearest view's eye (Infinity with no view). */
export function nearestView(views: readonly View3d[], m: ArrayLike<number>): number {
  let best = Infinity;
  for (const view of views) {
    best = Math.min(best, Math.hypot(m[12]! - view.position[0], m[13]! - view.position[1], m[14]! - view.position[2]));
  }
  return best;
}

/**
 * The model a level-of-detail band draws: a level's model, or for the impostor band the
 * last level that has one (else the entity's own); undefined while it loads or when the
 * band draws nothing.
 */
function lodModel(models: ModelPoseSource, record: EntityRecord, bands: LodBands, band: number, where: string): ModelAsset | undefined {
  let ref: string | null = null;
  const last = band === bands.starts.length && bands.impostor ? bands.models.length : band;
  if (band <= bands.models.length) ref = bands.models[band - 1] ?? null;
  else for (let i = last - 1; i >= 0 && ref === null; i--) ref = bands.models[i] ?? null;
  if (ref === null && band <= bands.models.length) return undefined;
  if (ref === null) return models.posed(record.id)?.asset;
  return models.get(models.resolve(ref, `${where} model`));
}

/** A model's model → world matrix: its entity's placement, then `Model.offset` and `rotation_offset`. */
function withOffset(m: M4, fields: Fields, where: string): M4 {
  return multiply(m, modelOffsetMatrix(fields, `${where} model`));
}

/** Block-compression families of precompressed variants, best first (the surface takes the first its GPU samples). */
export const VARIANT_FAMILIES = ['bc', 'astc', 'etc2'] as const;

/** An image's precompressed KTX2 variants in the project (`bricks.png` → `bricks.bc.ktx2`, …, as `parallax build` writes them). */
export function compressedVariants(path: string, has: (path: string) => boolean): string[] {
  const dot = path.lastIndexOf('.');
  const stem = dot > path.lastIndexOf('/') ? path.slice(0, dot) : path;
  return VARIANT_FAMILIES.map((family) => `${stem}.${family}.ktx2`).filter(has);
}

/**
 * Why a sun with this direction of travel lights the world from below, or null when it
 * shines down. A sun more than ~1° under the horizon (travelling up) reaches only
 * downward-facing surfaces: the ground, roofs and treetops get ambient light alone.
 */
export function upwardSun(direction: readonly [number, number, number]): string | null {
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (!(length > 0)) return null;
  const y = direction[1] / length;
  if (y <= 0.02) return null;
  const below = (Math.asin(Math.min(1, y)) * 180) / Math.PI;
  return `it sits ${below.toFixed(1)}° below the horizon, so the ground, roofs and treetops get no sunlight (ambient only)`;
}
