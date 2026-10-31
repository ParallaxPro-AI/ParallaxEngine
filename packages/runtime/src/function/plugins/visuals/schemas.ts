/**
 * The shared engine components every renderer reads (sdk/parallax/__init__.pyi, "Engine
 * components"): field names verbatim from the SDK, with the engine defaults the stubs
 * leave as `...`. Renderers find these by component id and read fields by these names.
 *
 * FieldType notes:
 *   - `camera.follow` is `Entity | list[Entity] | None` in the SDK: a kernel union, so a
 *     single placed id, "local_player", a list of targets and null all decode and snapshot.
 *   - `camera.fit` is a rectangle `[[x, y], [x, y]]` or the JSON string "grid": `json`,
 *     checked by the rig every frame (`readFit`).
 *   - Tuples (`pitch_limits`, `viewport`, `world_bar.bands`) are lists whose length the
 *     plugin checks when the entity arrives and whenever it reads them.
 *   - `ref` targets match the declarations extractor (`asset/images`, `clip`, …); the
 *     kernel keeps refs as their stored strings.
 */

import { Color, Vec2, Vec3 } from '../../../core/index.js';
import { t } from '../../kernel/index.js';
import type { FieldType, Schema } from '../../kernel/index.js';
import { ANIMATOR, ANIMATOR_SCHEMA } from './animator.js';
import { RENDER_SCHEMAS } from './render_schemas.js';

export { ANIMATOR } from './animator.js';

export const SPRITE = 'sprite';
export const SHAPE = 'shape';
export const MODEL = 'model';
export const SOCKET = 'socket';
export const LIGHT = 'light';
export const PARTICLES = 'particles';
export const TEXT_MESH = 'text_mesh';
export const AUDIO_SOURCE = 'audio_source';
export const MARKER = 'marker';
export const WORLD_BAR = 'world_bar';
export const PLAYER_START = 'player_start';
export const ENVIRONMENT_ZONE = 'environment_zone';
export const CAMERA = 'camera';
export const OUTLINE = 'outline';
export const TILEMAP = 'tilemap';

/** Components read from other plugins by id and SDK field names (never imported). */
export const COLLIDER = 'collider';
export const GRID = 'grid';

const optional = (of: FieldType): FieldType => ({ kind: 'optional', of });
const ref = (to: string): FieldType => ({ kind: 'ref', to });

/** One entry of a sprite's `animations`: {"frames": [...], "fps": 12, "loop": true}. */
export const SPRITE_ANIMATION: FieldType = {
  kind: 'record',
  fields: {
    frames: t.list(ref('asset/images')),
    fps: t.number({ default: 12, min: 0 }),
    loop: t.bool({ default: true }),
  },
};

export const SPRITE_SCHEMA: Schema = {
  image: { type: optional(ref('asset/images')), default: null },
  size: t.vec2({ default: Vec2.ONE }),
  color: t.color({ default: Color.WHITE }),
  offset: t.vec2({ default: Vec2.ZERO }),
  flip_x: t.bool({ default: false }),
  flip_y: t.bool({ default: false }),
  /** "additive": its colors add to what is under it (glows, lasers, magic); "normal" paints over. */
  blend: t.enum(['normal', 'additive'], { default: 'normal' }),
  /** Documented prefab data (SDK Sprite docstring): animation name → frames. */
  animations: { type: { kind: 'dict', of: SPRITE_ANIMATION }, default: {} },
  /** The playing animation (None: `image`). Set by `play()`; read-only by convention. */
  animation: { type: optional({ kind: 'string' }), default: null },
  /** Game time (`ctx.time.now`) the playing animation started. Set by `play()`. */
  animation_started: t.number({ default: 0 }),
};

export const SHAPE_KINDS = ['box', 'sphere', 'capsule', 'cylinder', 'cone', 'plane', 'circle', 'rect', 'polygon', 'ring'] as const;

export const SHAPE_SCHEMA: Schema = {
  kind: t.enum(SHAPE_KINDS, { default: 'box' }),
  size: t.vec3({ default: Vec3.ONE }),
  offset: t.vec3({ default: Vec3.ZERO }),
  color: t.color({ default: Color.WHITE }),
  emissive: t.color({ default: Color.BLACK }),
  /** Multiplies `emissive` (linear light, no upper bound): above 1 glows past white and blooms. */
  emissive_strength: t.number({ default: 1, min: 0 }),
  /** Material defaults shared with model documents (resource/models/format.ts MATERIAL_DEFAULTS). */
  metallic: t.number({ default: 0, min: 0, max: 1 }),
  roughness: t.number({ default: 0.8, min: 0, max: 1 }),
  texture: { type: optional(ref('asset/images')), default: null },
  /** Texture repeats along u and v (tiling; applies to `texture` and `normal_map`). */
  uv_scale: t.vec2({ default: Vec2.ONE }),
  /** Tangent-space normal map (linear data, glTF convention), and how strongly it bends the surface. */
  normal_map: { type: optional(ref('asset/images')), default: null },
  normal_strength: t.number({ default: 1, min: 0 }),
  cast_shadows: t.bool({ default: true }),
  /** `polygon`: corners in order, local meters × size (render2d checks there are ≥ 3). */
  points: { type: { kind: 'list', of: { kind: 'vec2' } }, default: [] },
  /** `ring`: band width in meters. */
  thickness: t.number({ default: 0.1, min: 0 }),
  /** `rect`: rounded-corner radius in meters. */
  corner_radius: t.number({ default: 0, min: 0 }),
  /** 2D outline: width in meters (0 = none) and color. */
  stroke_width: t.number({ default: 0, min: 0 }),
  stroke_color: t.color({ default: Color.BLACK }),
};

/** One entry of `model.joint_motion`: a timed move to the joint's `joints` value (resource/models/rig.ts). */
export const JOINT_MOTION: FieldType = {
  kind: 'record',
  fields: {
    start_value: t.number({ default: 0 }),
    start_time: t.number({ default: 0 }),
    seconds: t.number({ default: 0, min: 0 }),
    /** The move's ease (core EASE_KINDS). */
    ease: t.string({ default: 'in_out_quad' }),
  },
};

/**
 * Model: the asset, placement and tint, plus the look and pose of a model document
 * (`assets/models/<name>.model.json`): joint values in the joint's own units, option
 * choices, shown/hidden parts and recolored materials — each keyed by the names the
 * document declares (`parallax check` and the renderer check them). `joint_motion` is
 * written by `pose(..., seconds=)`/`open`/`close`; read-only by convention.
 */
export const MODEL_SCHEMA: Schema = {
  /** Required: a model entity names its asset. */
  model: t.ref('asset/models'),
  offset: t.vec3({ default: Vec3.ZERO }),
  /** Euler degrees turning the model about its origin before `offset` (a GLB authored facing another axis). */
  rotation_offset: t.vec3({ default: Vec3.ZERO }),
  /** Uniform size multiplier about the model's origin, before `rotation_offset` and `offset` (above 0). */
  scale: t.number({ default: 1, min: 0 }),
  tint: t.color({ default: Color.WHITE }),
  cast_shadows: t.bool({ default: true }),
  joints: { type: { kind: 'dict', of: { kind: 'number' } }, default: {} },
  joint_motion: { type: { kind: 'dict', of: JOINT_MOTION }, default: {} },
  options: { type: { kind: 'dict', of: { kind: 'string' } }, default: {} },
  parts: { type: { kind: 'dict', of: { kind: 'bool' } }, default: {} },
  colors: { type: { kind: 'dict', of: { kind: 'color' } }, default: {} },
};

/** Socket: keeps an entity on a socket of its parent's Model (`parent.attach(child, socket=...)`). */
export const SOCKET_SCHEMA: Schema = {
  /** Required: the socket (a declared socket, or a part, bone or node name). */
  name: t.string(),
};

export const LIGHT_SCHEMA: Schema = {
  kind: t.enum(['point', 'spot', 'directional'], { default: 'point' }),
  color: t.color({ default: Color.WHITE }),
  intensity: t.number({ default: 1, min: 0 }),
  range: t.number({ default: 10, min: 0 }),
  /** Spot cone angle in degrees (the outer edge, where the light reaches zero). */
  angle: t.number({ default: 45, min: 0, max: 180 }),
  /** Spot: full angle in degrees of the fully lit core; between it and `angle` the light fades. None: a soft edge (the outer 20%). */
  inner_angle: { type: { kind: 'optional', of: { kind: 'number' } }, default: null, min: 0, max: 180 },
  shadows: t.bool({ default: false }),
  /** When it shines: "night" lights fade in over dusk and out over dawn (the environment's time_of_day); "day" the reverse. */
  when: t.enum(['always', 'night', 'day'], { default: 'always' }),
};

export const PARTICLES_SCHEMA: Schema = {
  /** Required: the emitter's definition (assets/vfx/*.vfx.json). */
  effect: t.ref('asset/vfx'),
  emitting: t.bool({ default: true }),
  rate_scale: t.number({ default: 1, min: 0 }),
};

export const TEXT_MESH_SCHEMA: Schema = {
  text: t.string({ default: '' }),
  /** Height of a line of text in meters. */
  size: t.number({ default: 0.5, min: 0 }),
  color: t.color({ default: Color.WHITE }),
  face_camera: t.bool({ default: false }),
};

export const AUDIO_SOURCE_SCHEMA: Schema = {
  /** Required: the looping sound. */
  sound: t.ref('asset/sfx'),
  playing: t.bool({ default: true }),
  loop: t.bool({ default: true }),
  volume: t.number({ default: 1, min: 0 }),
  pitch: t.number({ default: 1, min: 0 }),
  spatial: t.bool({ default: true }),
};

export const MARKER_SCHEMA: Schema = {
  icon: t.string({ default: 'waypoint' }),
  /** `Localized | None`: inline source-language text. */
  label: { type: optional({ kind: 'string' }), default: null },
  shown: t.bool({ default: true }),
  color: t.color({ default: Color.WHITE }),
};

export const WORLD_BAR_SCHEMA: Schema = {
  value: t.number({ default: 0, min: 0, max: 1 }),
  offset: t.vec3({ default: new Vec3(0, 1.5, 0) }),
  color: t.color({ default: Color.WHITE }),
  /** `list[tuple[float, float, Color]]`: [from, to, color] ranges on the bar. */
  bands: t.list({ kind: 'tuple', of: [{ kind: 'number' }, { kind: 'number' }, { kind: 'color' }] }, { default: [] }),
  shown: t.bool({ default: true }),
};

export const PLAYER_START_SCHEMA: Schema = {
  /** -1: any seat. */
  seat: t.int({ default: -1, min: -1 }),
};

export const ENVIRONMENT_ZONE_SCHEMA: Schema = {
  fog_density: { type: optional({ kind: 'number' }), default: null, min: 0 },
  fog_color: { type: optional({ kind: 'color' }), default: null },
  ambient: { type: optional({ kind: 'color' }), default: null },
  sky_tint: { type: optional({ kind: 'color' }), default: null },
  /** Seconds to blend in (entering) and out (leaving). */
  blend: t.number({ default: 1, min: 0 }),
};

export const CAMERA_RIGS = ['fixed', 'follow', 'orbit', 'first_person'] as const;
export type CameraRig = (typeof CAMERA_RIGS)[number];

export const CAMERA_SCHEMA: Schema = {
  rig: t.enum(CAMERA_RIGS, { default: 'fixed' }),
  mode: t.enum(['perspective', 'orthographic'], { default: 'perspective' }),
  /** Vertical field of view in degrees (perspective). */
  fov: t.number({ default: 60, min: 1, max: 179 }),
  /** Half-height in meters of the visible area (orthographic). */
  size: t.number({ default: 5, min: 0 }),
  follow: { type: optional({ kind: 'union', of: [{ kind: 'entity' }, { kind: 'list', of: { kind: 'entity' } }] }), default: null },
  follow_weights: t.list({ kind: 'number' }, { default: [] }),
  /**
   * Degrees, positive looking UP (negative looks down on the target). `None` (the
   * default): a follow rig looks at its target; orbit and first_person start level.
   */
  pitch: { type: optional({ kind: 'number' }), default: null },
  /** (low, high) degrees the look pitch of orbit / first_person stays within; positive looks up. */
  pitch_limits: t.list({ kind: 'number' }, { default: [-80, 80] }),
  offset: t.vec3({ default: Vec3.ZERO }),
  world_offset: t.bool({ default: false }),
  /** Seconds: the time constant of the follow (0 = locked to the target). */
  smoothing: t.number({ default: 0, min: 0 }),
  /** Meters a follow rig leads its focus in the first target's direction of travel (x in 2D, ground plane in 3D). */
  look_ahead: t.number({ default: 0, min: 0 }),
  /** Seconds: the time constant of the lead swinging to a new direction. */
  look_ahead_smoothing: t.number({ default: 0.6, min: 0 }),
  fit: { type: { kind: 'json' }, default: null },
  fit_margin: t.number({ default: 0, min: 0 }),
  /** (width, height) in meters always visible: orthographic widens `size`, perspective widens `fov` at `focus_distance`. */
  min_visible: { type: optional({ kind: 'vec2' }), default: null },
  /** Meters from the camera where `min_visible` is measured (None: the follow/orbit focus). */
  focus_distance: { type: optional({ kind: 'number' }), default: null },
  bounds: { type: optional({ kind: 'list', of: { kind: 'vec2' } }), default: null },
  background: { type: optional({ kind: 'color' }), default: null },
  /** [x, y, width, height] as fractions of the screen; y measured from the top. */
  viewport: t.list({ kind: 'number' }, { default: [0, 0, 1, 1] }),
};

/**
 * A selection outline around the entity's 3D meshes (render3d draws it; render2d ignores
 * it). `fill` tints the silhouette too; `through_walls` keeps it visible behind other
 * surfaces (x-ray).
 */
export const OUTLINE_SCHEMA: Schema = {
  color: t.color({ default: new Color(1, 0.85, 0.2) }),
  /** Pixels (0: fill only). */
  width: t.number({ default: 2, min: 0, max: 16 }),
  through_walls: t.bool({ default: false }),
  fill: t.number({ default: 0, min: 0, max: 1 }),
};

/** One `tiles` entry of a tilemap: how its character draws and whether it is solid. */
export const TILE_RECORD: FieldType = {
  kind: 'record',
  fields: {
    image: { type: optional(ref('asset/images')), default: null },
    color: t.color({ default: Color.WHITE }),
    solid: t.bool({ default: true }),
  },
};

/**
 * A 2D grid of tiles (core/values/tilemap.ts reads the grid): render2d draws every cell,
 * physics2d gives the solid ones static colliders when `collide` is on. The entity's
 * position is the map's bottom-left corner.
 */
export const TILEMAP_SCHEMA: Schema = {
  tile_size: t.vec2({ default: Vec2.ONE }),
  /** The bottom-left corner relative to the entity. */
  offset: t.vec2({ default: Vec2.ZERO }),
  /** Top row first, one character per cell; " " and "." are empty. */
  rows: t.list({ kind: 'string' }, { default: [] }),
  tiles: { type: { kind: 'dict', of: TILE_RECORD }, default: {} },
  collide: t.bool({ default: false }),
  /** Collision layer of the tile colliders (physics2d layers). */
  layer: t.string({ default: 'default' }),
  friction: t.number({ default: 0.5, min: 0 }),
};

/** Every visuals component id → its schema, in SDK order. */
export const VISUAL_SCHEMAS: Readonly<Record<string, Schema>> = {
  [SPRITE]: SPRITE_SCHEMA,
  [SHAPE]: SHAPE_SCHEMA,
  [MODEL]: MODEL_SCHEMA,
  [SOCKET]: SOCKET_SCHEMA,
  [ANIMATOR]: ANIMATOR_SCHEMA,
  [LIGHT]: LIGHT_SCHEMA,
  [PARTICLES]: PARTICLES_SCHEMA,
  [TEXT_MESH]: TEXT_MESH_SCHEMA,
  [AUDIO_SOURCE]: AUDIO_SOURCE_SCHEMA,
  [MARKER]: MARKER_SCHEMA,
  [WORLD_BAR]: WORLD_BAR_SCHEMA,
  [PLAYER_START]: PLAYER_START_SCHEMA,
  [ENVIRONMENT_ZONE]: ENVIRONMENT_ZONE_SCHEMA,
  [OUTLINE]: OUTLINE_SCHEMA,
  [TILEMAP]: TILEMAP_SCHEMA,
  [CAMERA]: CAMERA_SCHEMA,
  ...RENDER_SCHEMAS,
};
