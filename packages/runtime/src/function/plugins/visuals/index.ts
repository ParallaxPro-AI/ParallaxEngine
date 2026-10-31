/**
 * visuals — the shared engine components every renderer reads:
 * Sprite, Shape, Model, Animator, Light, Particles, TextMesh, AudioSource, Marker,
 * WorldBar, PlayerStart, EnvironmentZone and Camera, with the SDK's field names verbatim.
 * Core: the runtime includes it in every game.
 *
 * It owns the logic that needs no GPU — camera rigs, shake/kick/zoom and the resolved
 * view, screen↔world math, sprite and clip timing, TextMesh markup, WorldBar bands,
 * EnvironmentZone blending — and records it on the components for renderers, which read
 * components by id and never import this plugin. The renderer contract (beyond the SDK
 * fields) is the engine-facing getters on component methods:
 *
 *   camera.__view__                 CameraView (view.ts): pose, projection, viewport, active
 *   sprite.__image__                the image to draw now (animation frame or `image`)
 *   sprite.animation, .animation_started   saved fields `play()` sets (name or None; game time)
 *   animator.__playback__           AnimatorPlayback (animation_player.ts): per layer the clips at their
 *                                   times and weights, masks, additive; root motion; IK goals
 *   animator.clip                   the current clip (SDK)
 *   text_mesh.__spans__             TextSpan[] (markup parsed)
 *   world_bar.__bands__             Band[] (checked, colours resolved)
 *   environment_zone.__weight__     0..1 blend of the zone's overrides around the camera
 *   every component .entity         its entity (SDK EngineComponent.entity)
 *
 * Plugin-level: `rig` (render2d's CameraRig2d: active camera + shake offset) and
 * `listener()` (audio's listener: the active camera entity).
 *
 * Animators read clip facts (lengths, markers, root tracks) from the `animation_clips`
 * service (the models plugin provides it), looked up when a clip first plays.
 *
 * Timing: animators advance in a plugin system's `update` (before the game's); sprite
 * frames follow from `ctx.time.now - animation_started`;
 * rigs and views resolve in the kernel's 'ui' hook, after every `late_update` and before
 * 'render'. A camera spawned mid-frame has a view at once (`added`).
 */

import { fail } from '../../../core/index.js';
import type { EntityId, Vec3 } from '../../../core/index.js';
import { componentEntity } from '../../kernel/index.js';
import type { ComponentDef, Fields, Handle, Kernel, KernelPlugin, SystemDef } from '../../kernel/index.js';
import type { Json } from '../../../resource/index.js';
import { CAMERAS_SERVICE } from '../../services/index.js';
import { Sprites } from './animation.js';
import { ANIMATION_EVENT, Animators, CLIP_FINISHED } from './animation_player.js';
import type { SavedAnimator } from './animation_player.js';
import { Cameras } from './camera.js';
import type { LookSource, SavedCameras } from './camera.js';
import { Bars, readBands, textSpans, Zones } from './derived.js';
import type { SavedZone } from './derived.js';
import { modelMethods } from './model.js';
import { HEAT_HAZE, SURFACE_FX } from './render_schemas.js';
import { heatHazeMethods, surfaceFxMethods } from './surface_fx.js';
import { CameraApi } from './namespace.js';
import {
  ANIMATOR, CAMERA, ENVIRONMENT_ZONE, MODEL, SPRITE, TEXT_MESH, VISUAL_SCHEMAS, WORLD_BAR,
} from './schemas.js';
import type { CameraView, Dimension, Screen } from './view.js';

export {
  ANIMATOR, AUDIO_SOURCE, CAMERA, CAMERA_RIGS, CAMERA_SCHEMA, COLLIDER, ENVIRONMENT_ZONE, GRID, LIGHT, MARKER, MODEL, OUTLINE,
  PARTICLES, PLAYER_START, SHAPE, SHAPE_KINDS, SOCKET, SPRITE, TEXT_MESH, TILEMAP, VISUAL_SCHEMAS, WORLD_BAR,
} from './schemas.js';
export type { CameraRig } from './schemas.js';
export {
  DECAL, DECAL_SCHEMA, DEPTH_OF_FIELD, DEPTH_OF_FIELD_SCHEMA, FOG_OVERLAY, FOG_OVERLAY_SCHEMA, HEAT_HAZE, HEAT_HAZE_SCHEMA, LOD, LOD_LEVEL_RECORD, LOD_SCHEMA, MIRROR, MIRROR_SCHEMA, MONITOR,
  MONITOR_SCHEMA, RENDER_SCHEMAS, RENDER_TEXTURE, RENDER_TEXTURE_SCHEMA, STATIC_MESH, STATIC_MESH_SCHEMA, SURFACE_FX, SURFACE_FX_SCHEMA,
} from './render_schemas.js';
export { dissolveNow } from './surface_fx.js';
export { spriteFrame } from './animation.js';
export { ANIMATION_EVENT, CLIP_FINISHED } from './animation_player.js';
export type { AnimatorPlayback, PlaybackGoal, PlaybackIk, PlaybackLayer, PlaybackLimb, PlaybackSample } from './animation_player.js';
export { ANIMATOR_GRAPH_FIELDS, ANIMATOR_SCHEMA, ROOT_MOTION_MODES } from './animator.js';
export type { RootMotionMode } from './animator.js';
export { BASE_LAYER, blendWeights, BUILT_IN_LIMBS, graphBones, graphClips, parseCondition, readAnimatorGraph } from './animation_graph.js';
export type { AnimatorGraph, AnimatorData, GraphProblem, LayerDef, LimbDef, StateDef } from './animation_graph.js';
export { angleDelta, crossedMarkers, rootTravel } from './animation_timeline.js';
export { readFit } from './camera.js';
export type { LookSource } from './camera.js';
export { insideCollider, readBands, textSpans } from './derived.js';
export type { Band, TextSpan } from './derived.js';
export { CameraApi } from './namespace.js';
export {
  axes, FAR, fitSize, lookRotation, NEAR, relative, screenRay, screenToWorld, worldToScreen,
} from './view.js';
export type { Axes, CameraView, Dimension, PixelRect, Screen } from './view.js';

/** The screen a headless game is laid out for until the platform reports its own. */
export const HEADLESS_SCREEN: Screen = { width: 1280, height: 720 };

export interface VisualsOptions {
  /** The game's `Game(mode=...)`: 2D draws the x/y plane through orthographic cameras. */
  readonly dimension: Dimension;
  /** Pixels. Default `HEADLESS_SCREEN`; the platform calls `resize` with the real one. */
  readonly screen?: Screen;
  /** Look input for orbit / first_person rigs (degrees this frame); none: rigs don't turn. */
  readonly look?: LookSource;
  /** The entity a seat controls, for `"follow": "local_player"` (players / net plugins). */
  readonly seatEntity?: (seat: number) => EntityId | null;
  /** The seat `ctx.camera.main` serves now (the running behavior's); default 0. */
  readonly currentSeat?: () => number;
  /** Renders a view to an image (`Camera.capture`), supplied by the renderer. */
  readonly capture?: (view: CameraView) => unknown;
  /** Engine values as game code sees them (the api's `Handle` and `ClipRef`). */
  readonly present?: {
    readonly handle?: (handle: Handle) => unknown;
    readonly clip?: (clip: string) => unknown;
    readonly rootMotion?: (offset: Vec3, turn: number) => unknown;
  };
}

/**
 * What a renderer needs from the rigs each frame (render2d's `CameraRig2d`, structurally):
 * the active camera entity of the current seat and its transient offset (shake) in world
 * x, y. The rig itself has already moved the camera entity (follow, smoothing, bounds).
 */
export interface CameraRigView {
  active(): EntityId | undefined;
  offset(camera: EntityId): readonly [number, number];
}

export interface VisualsPlugin extends KernelPlugin {
  /** For render2d's `rig` option. */
  readonly rig: CameraRigView;
  /** The audio listener: the active camera entity of the current seat (audio's `listener`). */
  listener(): EntityId | null;
  /** The screen size in pixels (the platform, on resize). Views re-resolve next frame. */
  resize(width: number, height: number): void;
  readonly screen: Screen;
}

interface SavedVisuals {
  readonly cameras: SavedCameras;
  readonly animators: SavedAnimator[];
  readonly zones: SavedZone[];
}

/** Methods every visuals component has: `.entity` (SDK `EngineComponent`). */
function withEntity(kernel: () => Kernel, methods: object = {}): object {
  const base = {
    get entity(): unknown {
      return kernel().handles.wrap(componentEntity(this as unknown as Fields));
    },
  };
  return Object.defineProperties(base, Object.getOwnPropertyDescriptors(methods));
}

function checkScreen(width: number, height: number): Screen {
  if (!(Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0)) {
    fail('PP3745', `The screen must have a positive size, got ${width}×${height}`);
  }
  return { width, height };
}

export function visuals(options: VisualsOptions): VisualsPlugin {
  let installed: Kernel | undefined;
  const kernel = (): Kernel => {
    if (installed === undefined) fail('PP9701', 'visuals is used before its kernel was built');
    return installed;
  };
  let screen = checkScreen(options.screen?.width ?? HEADLESS_SCREEN.width, options.screen?.height ?? HEADLESS_SCREEN.height);
  const cameras = new Cameras(kernel, {
    dimension: options.dimension,
    screen: () => screen,
    ...(options.look !== undefined && { look: options.look }),
    ...(options.seatEntity !== undefined && { seatEntity: options.seatEntity }),
    ...(options.currentSeat !== undefined && { currentSeat: options.currentSeat }),
    ...(options.capture !== undefined && { capture: options.capture }),
    ...(options.present?.handle !== undefined && { presentHandle: options.present.handle }),
  });
  const sprites = new Sprites(kernel);
  const animators = new Animators(kernel, {
    ...(options.present?.clip !== undefined && { presentClip: options.present.clip }),
    ...(options.present?.rootMotion !== undefined && { presentRootMotion: options.present.rootMotion }),
  });
  const zones = new Zones(kernel, options.dimension);
  const bars = new Bars(kernel);
  const reference = (): Vec3 | null => cameras.activeView(0)?.position ?? null;

  const methods: Record<string, object> = {
    [SPRITE]: sprites.methods(),
    [MODEL]: modelMethods(kernel),
    [ANIMATOR]: animators.methods(),
    [CAMERA]: cameras.methods(),
    [SURFACE_FX]: surfaceFxMethods(kernel),
    [HEAT_HAZE]: heatHazeMethods(kernel),
    [TEXT_MESH]: {
      get __spans__() {
        return textSpans((this as unknown as Fields)['text'] as string);
      },
    },
    [WORLD_BAR]: {
      get __bands__() {
        return readBands((this as unknown as Fields)['bands']);
      },
    },
    [ENVIRONMENT_ZONE]: {
      get __weight__() {
        return zones.weight(this as unknown as Fields);
      },
    },
  };
  const components: ComponentDef[] = Object.entries(VISUAL_SCHEMAS).map(([id, schema]) => ({
    id, schema, methods: withEntity(kernel, methods[id]),
  }));

  const animation: SystemDef = {
    id: 'visuals.animation',
    scenes: [],
    handlers: [],
    create: () => ({
      update: (_ctx: unknown, dt: number) => {
        animators.advance(dt);
      },
    }),
  };

  return {
    id: 'visuals',
    components,
    events: [CLIP_FINISHED, ANIMATION_EVENT],
    systems: [animation],
    get screen() {
      return screen;
    },
    rig: {
      active: () => cameras.activeEntity(options.currentSeat?.() ?? 0) ?? undefined,
      offset: (camera) => {
        const shake = cameras.shakeOffset(camera);
        return [shake.x, shake.y];
      },
    },
    listener: () => cameras.activeEntity(options.currentSeat?.() ?? 0),
    resize(width, height) {
      screen = checkScreen(width, height);
    },
    install(k) {
      if (installed !== undefined) {
        fail('PP9702', 'This visuals plugin is already installed in another kernel', { fix: 'Call visuals(...) once per kernel.' });
      }
      installed = k;
      k.provide(CAMERAS_SERVICE, { active: (seat) => cameras.activeEntity(seat), live: () => cameras.live() });
      k.observeScenes({ loading: () => cameras.sceneLoading() });
      k.observeEntities({
        added: (records) => {
          cameras.added(records);
          sprites.added(records);
          animators.added(records);
          zones.added(records, reference);
          bars.added(records);
        },
        removed: (records) => {
          cameras.removed(records);
          animators.removed(records);
          zones.removed(records);
        },
        changed: (record) => {
          cameras.changed(record);
          sprites.added([record]);
          animators.changed(record);
          zones.changed(record, reference);
          bars.added([record]);
        },
      });
      k.addHook('ui', () => {
        bars.frame();
        cameras.frame(k.time.dt);
        zones.frame(k.time.dt, reference());
      });
    },
    snapshot: (): Json => ({
      cameras: cameras.snapshot(),
      animators: animators.snapshot(),
      zones: zones.snapshot(),
    }) as unknown as Json,
    restore: (k, state) => {
      const saved = state as unknown as SavedVisuals;
      cameras.restore(saved.cameras);
      animators.restore(saved.animators);
      zones.restore(saved.zones);
    },
    namespace: {
      name: 'camera',
      create: () => new CameraApi(kernel(), cameras, options.currentSeat ?? (() => 0)),
    },
  };
}
