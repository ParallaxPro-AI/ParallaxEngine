/**
 * The rendering components of scale and render-to-texture (sdk/parallax/__init__.pyi),
 * defined here with the other shared visuals and read by render3d by id with these field
 * names:
 *
 *   lod            distance bands for an entity's Model (DESIGN §6.7): other models farther
 *                  away, a baked impostor beyond `impostor`, nothing beyond `cull`
 *   static_mesh    the entity and everything under it never move: their meshes are merged
 *                  into world chunks (fewer draws), re-merged if one does move
 *   decal          an image projected onto whatever surfaces lie inside its box
 *   render_texture on a camera: it draws into a named texture instead of the screen
 *   monitor        shows a render texture on the entity's Shape or Model (screens, TVs)
 *   mirror         a planar mirror: the entity's flat Shape (or Model) reflects the scene
 *   fog_overlay    on a camera: one team's fog of war over the ground in its view
 *   surface_fx     stylized effects on the entity's Shape or Model materials: rim light,
 *                  hit flash, dissolve, hologram, uv scrolling, triplanar mapping
 *   heat_haze      the image around the entity shimmers (hot air) or a shockwave ring bends it
 *   depth_of_field on a camera: what is nearer or farther than `focus_distance` blurs (3D;
 *                  cinematic focus tracks pull it)
 */

import { Color, Vec2, Vec3 } from '../../../core/index.js';
import { t } from '../../kernel/index.js';
import type { FieldType, Schema } from '../../kernel/index.js';

export const LOD = 'lod';
export const STATIC_MESH = 'static_mesh';
export const DECAL = 'decal';
export const RENDER_TEXTURE = 'render_texture';
export const MONITOR = 'monitor';
export const MIRROR = 'mirror';
export const FOG_OVERLAY = 'fog_overlay';
export const SURFACE_FX = 'surface_fx';
export const HEAT_HAZE = 'heat_haze';
export const DEPTH_OF_FIELD = 'depth_of_field';

const optional = (of: FieldType): FieldType => ({ kind: 'optional', of });

/** One level of detail: from `distance` meters on, draw `model` (None: draw nothing). */
export const LOD_LEVEL_RECORD: Schema = {
  distance: t.number({ min: 0 }),
  model: { type: optional({ kind: 'ref', to: 'asset/models' }), default: null },
};

export const LOD_SCHEMA: Schema = {
  levels: t.list({ kind: 'record', fields: LOD_LEVEL_RECORD }, { default: [] }),
  /** Meters past which a baked impostor of the last model level is drawn (None: never). */
  impostor: { type: optional({ kind: 'number' }), default: null },
  /** Meters past which nothing is drawn (None: the quality's view distance). */
  cull: { type: optional({ kind: 'number' }), default: null },
  /** Fraction of each switch distance over which two levels cross-fade (dithered). */
  fade: t.number({ default: 0.1, min: 0, max: 1 }),
};

export const STATIC_MESH_SCHEMA: Schema = {
  /** Meters per side of the world chunks static meshes are merged into. */
  chunk: t.number({ default: 32, min: 1 }),
};

export const DECAL_SCHEMA: Schema = {
  image: t.ref('asset/images'),
  /** The box the image is projected through: x wide, y deep (along the entity's down axis), z tall. */
  size: t.vec3({ default: new Vec3(1, 0.5, 1) }),
  color: t.color({ default: Color.WHITE }),
  /** Degrees from facing the projection where the decal starts fading (gone at 90°). */
  angle_fade: t.number({ default: 60, min: 0, max: 90 }),
  /** Later orders draw over earlier ones. */
  order: t.int({ default: 0 }),
};

export const RENDER_TEXTURE_SCHEMA: Schema = {
  /** What monitors name it by. */
  name: t.string(),
  width: t.int({ default: 512, min: 16, max: 4096 }),
  height: t.int({ default: 288, min: 16, max: 4096 }),
  /** Redraws per second (0: every frame). */
  fps: t.number({ default: 30, min: 0 }),
};

export const MONITOR_SCHEMA: Schema = {
  /** The render texture shown. */
  feed: t.string(),
  /** How brightly the screen glows (its image is emissive). */
  brightness: t.number({ default: 1, min: 0 }),
  /** The Model material the feed replaces (None: the Shape, or every material of the Model). */
  material: { type: optional({ kind: 'string' }), default: null },
};

export const MIRROR_SCHEMA: Schema = {
  /** The reflection's pixels per screen pixel (per axis). */
  resolution: t.number({ default: 0.5, min: 0.1, max: 1 }),
  tint: t.color({ default: Color.WHITE }),
};

export const FOG_OVERLAY_SCHEMA: Schema = {
  /** The team (tag id) whose fog of war this view shows. */
  team: t.string(),
  unexplored: t.color({ default: new Color(0, 0, 0, 0.85) }),
  explored: t.color({ default: new Color(0, 0, 0, 0.45) }),
};

/**
 * Surface effects. The animated ones keep their state as fields (snapshot-safe): `flash()`
 * stamps `flash_at`, `dissolve_to()` the `dissolve_from` / `dissolve_at` / `dissolve_seconds`
 * of a transition toward `dissolve`; renderers work out the current amounts from game time.
 */
export const SURFACE_FX_SCHEMA: Schema = {
  /** Fresnel rim light at grazing angles: strength 0..4, color, falloff power (higher: thinner). */
  rim: t.number({ default: 0, min: 0, max: 4 }),
  rim_color: t.color({ default: Color.WHITE }),
  rim_power: t.number({ default: 3, min: 0.1, max: 16 }),
  /** 0 whole .. 1 gone: the surface burns away through world noise, a glowing band at the cut. */
  dissolve: t.number({ default: 0, min: 0, max: 1 }),
  dissolve_color: t.color({ default: new Color(1, 0.55, 0.15) }),
  /** Brightness of the cut's band (above 1 blooms). */
  dissolve_glow: t.number({ default: 3, min: 0 }),
  /** Width of the glowing band, 0..0.5 of the noise range. */
  dissolve_edge: t.number({ default: 0.06, min: 0, max: 0.5 }),
  /** Noise cells per meter (bigger: finer holes). */
  dissolve_scale: t.number({ default: 4, min: 0.05 }),
  /** A `dissolve_to` transition: the amount it started from, when (game time) and how long. */
  dissolve_from: t.number({ default: 0, min: 0, max: 1 }),
  dissolve_at: t.number({ default: 0 }),
  dissolve_seconds: t.number({ default: 0, min: 0 }),
  /** 0..1 of the surface drawn as a see-through projection: fresnel glow, scanlines, flicker. */
  hologram: t.number({ default: 0, min: 0, max: 1 }),
  hologram_color: t.color({ default: new Color(0.4, 0.85, 1) }),
  /** Scanlines per meter of world height. */
  hologram_lines: t.number({ default: 40, min: 0 }),
  hologram_flicker: t.number({ default: 0.3, min: 0, max: 1 }),
  /** Texture repeats per second along u and v (conveyor belts, lava, waterfalls, screens). */
  scroll: t.vec2({ default: new Vec2(0, 0) }),
  /** Project the base texture along the world axes every this many meters (0: the mesh's uvs). */
  triplanar: t.number({ default: 0, min: 0 }),
  /** The last `flash()`: color, peak strength 0..1, seconds it fades over, and when (game time; None: never). */
  flash_color: t.color({ default: Color.WHITE }),
  flash_strength: t.number({ default: 0.8, min: 0, max: 1 }),
  flash_seconds: t.number({ default: 0.12, min: 0.01 }),
  flash_at: { type: optional({ kind: 'number' }), default: null },
  /** The Model material the effects apply to (None: the Shape, or every material of the Model). */
  material: { type: optional({ kind: 'string' }), default: null },
};

export const HEAT_HAZE_SCHEMA: Schema = {
  /** Meters around the entity that shimmer (0: only pulses). */
  radius: t.number({ default: 1.5, min: 0 }),
  /** 0..1: how far the image bends. */
  strength: t.number({ default: 0.4, min: 0, max: 1 }),
  /** Meters above the entity's origin the shimmer is centered (heat rises off a fire). */
  height: t.number({ default: 1 }),
  /** The last `pulse()`: a shockwave ring growing to `pulse_radius` over `pulse_seconds` from `pulse_at` (None: none). */
  pulse_radius: t.number({ default: 8, min: 0 }),
  pulse_seconds: t.number({ default: 0.6, min: 0.01 }),
  pulse_strength: t.number({ default: 1, min: 0, max: 1 }),
  pulse_at: { type: optional({ kind: 'number' }), default: null },
};

/**
 * Depth of field on a camera (3D). Blur grows with the distance from `focus_distance`,
 * reaching `max_blur` `focus_range` meters in front of or behind it.
 */
export const DEPTH_OF_FIELD_SCHEMA: Schema = {
  /** Meters from the camera that are in sharp focus. */
  focus_distance: t.number({ default: 10, min: 0 }),
  /** Meters from the focus distance at which the blur is greatest. */
  focus_range: t.number({ default: 4, min: 0.01 }),
  /** The greatest blur: radius in pixels at 1080p (scaled to the view's height; 0: off). */
  max_blur: t.number({ default: 6, min: 0, max: 64 }),
};

export const RENDER_SCHEMAS: Readonly<Record<string, Schema>> = {
  [LOD]: LOD_SCHEMA,
  [STATIC_MESH]: STATIC_MESH_SCHEMA,
  [DECAL]: DECAL_SCHEMA,
  [RENDER_TEXTURE]: RENDER_TEXTURE_SCHEMA,
  [MONITOR]: MONITOR_SCHEMA,
  [MIRROR]: MIRROR_SCHEMA,
  [FOG_OVERLAY]: FOG_OVERLAY_SCHEMA,
  [SURFACE_FX]: SURFACE_FX_SCHEMA,
  [HEAT_HAZE]: HEAT_HAZE_SCHEMA,
  [DEPTH_OF_FIELD]: DEPTH_OF_FIELD_SCHEMA,
};
