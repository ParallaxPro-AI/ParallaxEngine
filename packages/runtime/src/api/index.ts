/**
 * api — the SDK surface compiled game code calls: the names in `sdk/parallax/*.pyi`,
 * implemented. The only layer game code touches; everything below may change freely as
 * long as this contract holds. Imports `core`, `resource` and `function`.
 *
 * Python-facing names are verbatim (`move_to`, `try_get`); engine-facing ones (boot,
 * pyrt, plugin api modules) are camelCase: `createRuntime`, `kw`, `componentHandle`…
 */

// Values, types and schemas.
export {
  AssetRef, ClipRef, Color, Effect, EffectRef, Enum, enum_class, EntityRef, field, ImageRef, Localized, ModelRef, MusicRef,
  param, PrefabRef, Quat, rt, SceneRef, SoundRef, state, Tag, TextRef, toFieldType, Vec2, Vec3, WorldLayerRef,
} from './types.js';
export type { ApiType, TypeMarker } from './types.js';

// Declarations.
export {
  Behavior, behavior, component, config, content, declarations, event, on, record, resource, System, system, tag,
} from './declarations.js';
export { resetDeclarations } from './reset.js';
export { Settings, Timer } from './builtins.js';
export { migration, SaveData } from './save.js';
export { ContentList, ContentRef } from './content.js';

// The world and logic.
export { Context, Player } from './context.js';
export { Entity, Transform } from './entity.js';
export {
  Collided, CollisionEnded, Destroyed, eventHandle, PanelAction, PanelClosed, PanelOpened, SceneLoaded, Spawned, TriggerEntered,
  TriggerExited,
} from './events.js';
export type { EventHandle } from './events.js';
export { Feature, Game } from './game.js';
export { Query } from './query.js';
export { ScenesApi } from './scenes.js';
export { Handle, Task, Time } from './time.js';
export { Placement, World } from './world.js';

// Audio (core): listener and reverb zones as data; ctx.audio.
export { AudioApi, AudioListener, Beat, MusicLayer, ReverbZone, Synth } from './audio.js';

// Engine components (visuals plugin).
export {
  AnimationEvent, Animator, AudioSource, Camera, CameraApi, ClipFinished, coreVisuals, Decal, DepthOfField, EnvironmentZone, FogOverlay, HeatHaze, Light, Lod, LodLevel,
  Marker, Mirror, Model, Monitor, Outline, Particles, PlayerStart, RenderTexture, RootMotion, Shape, Socket, Sprite, StaticMesh, SurfaceFx, TextMesh,
  Tilemap, WorldBar,
} from './visuals.js';

// Input and UI.
export {
  Actions, Axis1, axis1, Axis2, axis2, Binding, Button, button, button_group, ButtonGroup, gamepad, Input, keys, mouse,
  Pointer, touch, TouchGroup, TouchSkin,
} from './input.js';
export {
  action, close_panel, Cursor, FloatStyle, load_scene, open_panel, Panel, PanelCommand, PlayerPanel, reload_scene,
  SettingsPanel, ui, UiApi,
} from './ui.js';

// Math.
export {
  angle_between, angle_to, approach, clamp, deg, ease, Ease, heading_to, inverse_lerp, lerp, move_toward, noise2d, rad, remap,
  rotate_toward, scatter, vec2, vec3, wrap_angle,
} from './math.js';

// Engine-facing: boot, pyrt and plugin api modules.
export { componentHandle } from './handles.js';
export type { ComponentHandle } from './handles.js';
export { bindArgs, kw, Kwargs } from './kwargs.js';
export { activeRandom, setActiveRandom } from './random.js';
export { createRuntime, GameRuntime } from './runtime.js';
export type { RuntimeOptions, RuntimeSnapshot } from './runtime.js';

// Environment (a core plugin: day/night, weather, sky).
export { DayChanged, EnvironmentApi } from './environment.js';

// Networking (hosts: boot and the test harness).
export { attachNet, LOCAL_SESSION, netPluginOf, prepareNet } from './net.js';
export type { NetSession } from './net.js';

// Device hookups for plugins with a platform side (boot).
export { connectPayments } from './payments.js';
export { connectScreens } from './screens.js';
export { connectVoice } from './voice.js';
