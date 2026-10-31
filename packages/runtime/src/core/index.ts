/**
 * core — the bottom of the engine: value types, diagnostics, ids, deterministic random,
 * the event queue, and the ports the platform implements. Imports nothing outside core.
 */

export { Cell } from './values/cell.js';
export { Cell3 } from './values/cell3.js';
export { Color, COLOR_FORMS, parseColor } from './values/color.js';
export { deg, rad, wrapAngle } from './values/angles.js';
export { Quat } from './values/quat.js';
export { Vec2 } from './values/vec2.js';
export { Vec3 } from './values/vec3.js';
export { cellCenter, EMPTY_TILES, solidRuns, tileGrid } from './values/tilemap.js';
export type { TileCell, TileGrid } from './values/tilemap.js';
export { NotImplemented } from './values/not_implemented.js';
export * from './values/ground_math.js';
export { FOOTPRINT_KEYS, footprintAnchor, footprintHits, readFootprint } from './values/footprint_json.js';
export type { FootprintFail } from './values/footprint_json.js';
export { ease, EASE_KINDS, EASES, easing } from './values/ease.js';

export {
  DOCS_BASE,
  ParallaxError,
  diagnostic,
  docsUrl,
  fail,
  formatDiagnostic,
} from './diagnostics.js';
export type { Diagnostic, DiagnosticCode, DiagnosticInit, Severity } from './diagnostics.js';

export { EntityIdAllocator, generationOf, indexOf } from './entity_ids.js';
export type { EntityId } from './entity_ids.js';

export { EventQueue } from './event_queue.js';
export { hashNumbers } from './hash.js';
export { SeededRandom } from './random.js';
export { closestMatch } from './suggest.js';
export { RTL_LANGUAGES, textDirectionOf, type TextDirection } from './text_direction.js';
export { UI_ICON_NAMES, UI_ICONS } from './ui_icons.js';
export { bindArgs, kw, Kwargs, splitArgs } from './kwargs.js';
export type { Bound, Signature } from './kwargs.js';
export type { RandomState } from './random.js';

export type {
  Clock, GamepadButton, GamepadSnapshot, InputDevices, InputOutput, InputSnapshot, KeyValueStore, MouseButton,
  PointerSnapshot, ProjectFiles, TouchControlSnapshot, TouchControlSpec, TouchShape, TouchSkin, TouchZone,
} from './ports.js';
export type * from './ports/audio.js';
export {
  biquad, MAX_SYNTH_LAYERS, MAX_SYNTH_SECONDS, MIN_SYNTH_SECONDS, renderSynth, SYNTH_FILTERS, SYNTH_KEYS, SYNTH_SAMPLE_RATE, SYNTH_WAVES,
  synthProblems, synthSeconds, synthStats,
} from './synth.js';
export type { Biquad, SynthFilter, SynthFilterType, SynthLayer, SynthSpec, SynthStats, SynthSweep, SynthWave } from './synth.js';
export * from './ports/render.js';
export * from './ports/render3d.js';
export * from './ports/nature3d.js';
export type { Display, DisplayChange, ViewportSize } from './ports/display.js';
export { HOST_PEER, type NetChannel, type NetIdentity, type NetLink, type NetLinkState, type NetListener, type NetMessage, type SignalMessage, type Signaling, type LobbyConnection, type RoomConfig, type RoomInfo, type RoomMember, type RoomState } from './ports/net.js';
export { drawRoomCode, LobbyRooms, LobbyView, roomConfigOf } from './lobby_rooms.js';
export type { LobbyMember, LobbyRoom, RelayMessage } from './lobby_rooms.js';
export type * from './ports/ui.js';
export * from './ports/jobs.js';
export type * from './ports/bundles.js';
export type * from './ports/saves.js';
export type * from './ports/payments.js';
export type * from './ports/voice.js';
export type * from './ports/screens.js';
export {
  fetchRemoteAsset, isAssetUrl, isRemoteAsset, REMOTE_ASSET_BASE, REMOTE_EXTENSIONS, remoteAssetProblem, remoteAssetUrl,
} from './remote_assets.js';
