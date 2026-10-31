/**
 * The visuals engine components as `parallax` names (sdk/parallax/__init__.pyi): Sprite,
 * Shape, Model, Animator, Light, Particles, TextMesh, AudioSource, Marker, WorldBar,
 * PlayerStart, EnvironmentZone, Outline, Camera and `ctx.camera`'s type (animation events and
 * RootMotion: `animation.ts`).
 * The behavior lives in the visuals plugin; this module names it for game code and wires
 * the core plugin to the rest of the runtime (`coreVisuals`): look input from the input
 * engine and the Settings resource, and api values (`Handle`, `ClipRef`).
 */

import type { EntityId } from '../core/index.js';
import { Vec2 } from '../core/index.js';
import {
  ANIMATOR, AUDIO_SOURCE, CAMERA, DECAL, DEPTH_OF_FIELD, ENVIRONMENT_ZONE, FOG_OVERLAY, HEAT_HAZE, LIGHT, LOD, LOD_LEVEL_RECORD, MARKER, MIRROR, MODEL, MONITOR, OUTLINE, TILEMAP,
  PARTICLES, PLAYER_START, RENDER_TEXTURE, SHAPE, SOCKET, SPRITE, STATIC_MESH, SURFACE_FX, TEXT_MESH, VISUAL_SCHEMAS, visuals, WORLD_BAR,
} from '../function/plugins/visuals/index.js';
import { record } from './declarations.js';
import { ModelRef, rt } from './types.js';
import type { CameraView, LookSource, Screen, VisualsPlugin } from '../function/plugins/visuals/index.js';
import type { Axis2Decl, InputEngine } from '../function/plugins/input/index.js';
import { presentRootMotion } from './animation.js';
import { componentHandle } from './handles.js';
import type { ComponentHandle } from './handles.js';
import { Handle } from './time.js';
import { ClipRef } from './types.js';

export { CameraApi } from '../function/plugins/visuals/index.js';

const handle = (id: string, name: string): ComponentHandle => componentHandle({ id, schema: VISUAL_SCHEMAS[id]! }, name);

export const Sprite = handle(SPRITE, 'Sprite');
export const Shape = handle(SHAPE, 'Shape');
export const Model = handle(MODEL, 'Model');
/** Keeps an entity on a socket of its parent's Model (`parent.attach(child, socket=...)`, model_sockets.ts). */
export const Socket = handle(SOCKET, 'Socket');
export const Animator = handle(ANIMATOR, 'Animator');
export const Light = handle(LIGHT, 'Light');
export const Particles = handle(PARTICLES, 'Particles');
export const TextMesh = handle(TEXT_MESH, 'TextMesh');
export const AudioSource = handle(AUDIO_SOURCE, 'AudioSource');
export const Marker = handle(MARKER, 'Marker');
export const WorldBar = handle(WORLD_BAR, 'WorldBar');
export const PlayerStart = handle(PLAYER_START, 'PlayerStart');
export const EnvironmentZone = handle(ENVIRONMENT_ZONE, 'EnvironmentZone');
export const Outline = handle(OUTLINE, 'Outline');
export const Tilemap = handle(TILEMAP, 'Tilemap');
export const Camera = handle(CAMERA, 'Camera');

// Render scale and render to texture (render3d draws them; render2d draws FogOverlay).
export const Lod = handle(LOD, 'Lod');
/** `Lod(levels=[LodLevel(distance=40, model=Assets.models.tree_low)])` (fields: visuals' `LOD_LEVEL_RECORD`). */
export const LodLevel = lodLevel();

function lodLevel(): unknown {
  const fields = class {};
  Object.defineProperty(fields, 'name', { value: 'LodLevel' });
  Object.defineProperty(fields, '__annotations__', { value: { distance: () => rt.float, model: () => rt.optional(ModelRef) } });
  (fields as unknown as Record<string, unknown>)['model'] = LOD_LEVEL_RECORD['model']!.default;
  return record(fields);
}
export const StaticMesh = handle(STATIC_MESH, 'StaticMesh');
export const Decal = handle(DECAL, 'Decal');
export const RenderTexture = handle(RENDER_TEXTURE, 'RenderTexture');
export const Monitor = handle(MONITOR, 'Monitor');
export const Mirror = handle(MIRROR, 'Mirror');
export const FogOverlay = handle(FOG_OVERLAY, 'FogOverlay');
export const SurfaceFx = handle(SURFACE_FX, 'SurfaceFx');
export const HeatHaze = handle(HEAT_HAZE, 'HeatHaze');
export const DepthOfField = handle(DEPTH_OF_FIELD, 'DepthOfField');

export { AnimationEvent, ClipFinished, RootMotion } from './animation.js';

/** Mouse and touch-drag look: degrees per pixel at mouse_sensitivity 1. */
export const MOUSE_DEGREES_PER_PIXEL = 0.15;
/** Stick look: degrees per second at full tilt and stick_sensitivity 1. */
export const STICK_DEGREES_PER_SECOND = 180;

/** The Settings fields look input honors. */
export interface LookSettings {
  readonly mouse_sensitivity: number;
  readonly stick_sensitivity: number;
  readonly invert_look: boolean;
}

/**
 * Look input for orbit / first_person rigs: the seat's live Axis2 action named `look`
 * (the convention the SDK's examples follow), in degrees this frame. A gamepad stick is a
 * rate (× STICK_DEGREES_PER_SECOND × dt); mouse and touch look are pixel deltas
 * (× MOUSE_DEGREES_PER_PIXEL). Sensitivities and `invert_look` come from Settings.
 */
export function lookFromInput(engine: InputEngine, settings: () => LookSettings): LookSource {
  return (seat, dt) => {
    const reader = { seat, owner: null };
    let reading = Vec2.ZERO;
    for (const set of engine.sets) {
      const action = set.actions.get('look');
      if (action?.kind !== 'axis2') continue;
      reading = engine.axis(action as Axis2Decl, reader);
      if (reading.length_squared() > 0) break;
    }
    if (reading.length_squared() === 0) return Vec2.ZERO;
    const s = settings();
    const scale = engine.device(reader) === 'gamepad'
      ? STICK_DEGREES_PER_SECOND * s.stick_sensitivity * dt
      : MOUSE_DEGREES_PER_PIXEL * s.mouse_sensitivity;
    return new Vec2(reading.x * scale, reading.y * scale * (s.invert_look ? -1 : 1));
  };
}

export interface CoreVisualsOptions {
  /** `Game(mode=...)`. */
  readonly mode: '2d' | '3d';
  readonly input: InputEngine;
  /** The live Settings resource. */
  readonly settings: () => LookSettings;
  /** The seat of the running behavior (`ctx.camera.main`). */
  readonly currentSeat: () => number;
  /** The entity a seat controls (players / net plugins), for `"follow": "local_player"`. */
  readonly seatEntity?: (seat: number) => EntityId | null;
  readonly screen?: Screen;
  readonly capture?: (view: CameraView) => unknown;
}

/** The core visuals plugin of a running game, wired to the runtime. */
export function coreVisuals(options: CoreVisualsOptions): VisualsPlugin {
  return visuals({
    dimension: options.mode,
    look: lookFromInput(options.input, options.settings),
    currentSeat: options.currentSeat,
    present: { handle: (inner) => new Handle(inner), clip: (name) => new ClipRef(name), rootMotion: presentRootMotion },
    ...(options.seatEntity !== undefined && { seatEntity: options.seatEntity }),
    ...(options.screen !== undefined && { screen: options.screen }),
    ...(options.capture !== undefined && { capture: options.capture }),
  });
}
