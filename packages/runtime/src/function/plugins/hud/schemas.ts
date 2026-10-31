/**
 * The HUD kit's components (sdk/parallax/hud.pyi), with the SDK's field names verbatim.
 *
 * Two kinds:
 *   - viewer components sit on the entity a seat plays (minimap, compass, crosshair,
 *     stat_bars, abilities, combo, key_hints, hurt_feedback): they say what that seat's HUD
 *     shows. Which entity a seat plays is the `viewer` rule (viewer.ts).
 *   - world components sit on anything (map_icon, map_feature, nameplate, awareness): they
 *     put that entity on every seat's map, compass or screen.
 *
 * Other plugins' components the HUD draws, read by id: core `marker` (objective markers),
 * combat `health` (stat bars, nameplates) and `health_bar` (world health bars).
 */

import { Color, Vec3 } from '../../../core/index.js';
import { t } from '../../kernel/index.js';
import type { FieldType, Schema } from '../../kernel/index.js';

export const MINIMAP = 'minimap';
export const COMPASS = 'compass';
export const CROSSHAIR = 'crosshair';
export const STAT_BARS = 'stat_bars';
export const ABILITIES = 'abilities';
export const COMBO = 'combo';
export const KEY_HINTS = 'key_hints';
export const HURT_FEEDBACK = 'hurt_feedback';
export const MAP_ICON = 'map_icon';
export const MAP_FEATURE = 'map_feature';
export const NAMEPLATE = 'nameplate';
export const AWARENESS = 'awareness';

/** Read by id from other plugins. */
export const MARKER = 'marker';
export const HEALTH = 'health';
export const HEALTH_BAR = 'health_bar';
export const CAMERA = 'camera';
export const SHAPE = 'shape';
export const COLLIDER = 'collider';
export const RIGIDBODY = 'rigidbody';
/** Things that move by themselves: never part of the static base map. */
export const MOVERS = ['rigidbody', 'character', 'vehicle', 'nav_agent'] as const;

/** Minimap / compass icon glyphs. Restyled panels draw them however they like (the state carries the name). */
export const ICONS = ['dot', 'arrow', 'square', 'diamond', 'triangle', 'star', 'cross', 'skull', 'flag', 'pin', 'ring'] as const;
export type IconName = (typeof ICONS)[number];

export const MAP_FEATURE_KINDS = ['solid', 'floor', 'road', 'water', 'path', 'hidden'] as const;
export type MapFeatureKind = (typeof MAP_FEATURE_KINDS)[number];

export const CROSSHAIR_STYLES = ['none', 'dot', 'cross', 'circle', 'scope'] as const;

const optional = (of: FieldType): FieldType => ({ kind: 'optional', of });
const optionalColor = { type: optional({ kind: 'color' }), default: null } as const;
const optionalString = { type: optional({ kind: 'string' }), default: null } as const;

const STAT_BAR_RECORD: Schema = {
  /** Shown text (source language). */
  label: t.string({ default: '' }),
  /** `"<component>.<field>"` on the viewer entity: `"health.current"`, `"stamina.value"`. */
  value: t.string(),
  /** Another field path holding the maximum (`"health.max"`); None: `value` is already 0..1. */
  max: optionalString,
  color: t.color({ default: Color.hex('#e04848') }),
  /** Show "value / max" next to the bar. */
  numbers: t.bool({ default: true }),
  /** Below this fraction the bar is "low" (pulses in the default look). */
  low: t.number({ default: 0.25, min: 0, max: 1 }),
};

const ABILITY_SLOT_RECORD: Schema = {
  /** The slot's name in `use("dash")`. */
  id: t.string(),
  label: t.string({ default: '' }),
  /** A short glyph or letter shown in the slot ("⚡", "Q"). */
  icon: t.string({ default: '' }),
  /** An image file shown in the slot instead of `icon` (a project path: "assets/ui/dash.png"); None: the glyph. */
  image: optionalString,
  /** Seconds to regain one charge. */
  cooldown: t.number({ min: 0 }),
  charges: t.int({ default: 1, min: 1 }),
  /** `"<ActionSet>.<action>"` whose key the slot shows (`"Controls.dash"`); None: no key. */
  action: optionalString,
};

export const HUD_SCHEMAS: Readonly<Record<string, Schema>> = {
  [MINIMAP]: {
    /** Meters from the map's center to its rim. Change it to zoom. */
    range: t.number({ default: 40, min: 1 }),
    /** Turn the map with the viewer's heading (player-up); False: north-up. */
    rotate: t.bool({ default: true }),
    shape: t.enum(['circle', 'square'], { default: 'circle' }),
    /** A route line (world points, e.g. from `ctx.nav.path`); empty: none. */
    route: t.list({ kind: 'vec3' }, { default: [] }),
    shown: t.bool({ default: true }),
  },
  [COMPASS]: {
    /** Degrees of heading the strip spans. */
    fov: t.number({ default: 180, min: 30, max: 360 }),
    /** Show markers (Marker components and MapIcon(compass=True)) on the strip. */
    markers: t.bool({ default: true }),
    shown: t.bool({ default: true }),
  },
  [CROSSHAIR]: {
    style: t.enum(CROSSHAIR_STYLES, { default: 'cross' }),
    /** Half-angle in degrees of the current aim cone: widens the cross's gap. */
    spread: t.number({ default: 0, min: 0, max: 45 }),
    /** 0..1 while reloading (shown under the crosshair); None otherwise. */
    reload: { type: optional({ kind: 'number' }), default: null },
    color: t.color({ default: Color.WHITE }),
    /** Flash a hit marker when this entity damages something (combat's Damaged), a kill marker on Died. */
    hit_markers: t.bool({ default: true }),
  },
  [STAT_BARS]: {
    bars: t.list({ kind: 'record', fields: STAT_BAR_RECORD }, { default: [] }),
  },
  [ABILITIES]: {
    slots: t.list({ kind: 'record', fields: ABILITY_SLOT_RECORD }, { default: [] }),
    /** Per slot: charges ready now. Kept by the engine (`use`, the cooldown tick). */
    charges: { type: { kind: 'dict', of: { kind: 'int' } }, default: {} },
    /** Per slot: seconds until the next charge returns (0 when full). */
    left: { type: { kind: 'dict', of: { kind: 'number' } }, default: {} },
  },
  [COMBO]: {
    /** Seconds a combo survives without a hit. */
    window: t.number({ default: 2, min: 0.05 }),
    count: t.int({ default: 0, min: 0 }),
    best: t.int({ default: 0, min: 0 }),
    /** Seconds until the combo breaks. */
    left: t.number({ default: 0, min: 0 }),
    /** Every Damaged this entity is the source of counts as a hit. */
    from_damage: t.bool({ default: true }),
  },
  [KEY_HINTS]: {
    /** `"<ActionSet>.<action>"` names, in order (`"Controls.jump"`). Hints of sets that aren't live are hidden. */
    actions: t.list({ kind: 'string' }, { default: [] }),
    shown: t.bool({ default: true }),
  },
  [HURT_FEEDBACK]: {
    /** Peak opacity of the hurt flash; a hit of a quarter of max health or more flashes fully. */
    flash: t.number({ default: 0.6, min: 0, max: 1 }),
    /** Camera shake intensity at a full-strength hit (0: none). */
    shake: t.number({ default: 0.3, min: 0 }),
    /** Seconds of hit-stop on every hit (0: none). */
    hitstop: t.number({ default: 0, min: 0, max: 0.5 }),
    /** Show an arc pointing at whoever hit this entity. */
    direction: t.bool({ default: true }),
    /** Below this health fraction the screen edge pulses (0: never). */
    low_health: t.number({ default: 0.3, min: 0, max: 1 }),
    color: t.color({ default: Color.hex('#d01818') }),
    /** Show where noises this entity could hear came from (ai's perception: gunshots, footsteps). */
    noise_cues: t.bool({ default: false }),
  },
  [MAP_ICON]: {
    icon: t.enum(ICONS, { default: 'dot' }),
    color: t.color({ default: Color.WHITE }),
    size: t.number({ default: 1, min: 0.1, max: 8 }),
    /** Turn with the entity's heading (vehicles, other players). */
    rotate: t.bool({ default: false }),
    /** Stay on the map's rim when out of range (objectives). */
    edge: t.bool({ default: false }),
    /** Also show on the compass strip. */
    compass: t.bool({ default: false }),
    label: optionalString,
    shown: t.bool({ default: true }),
  },
  [MAP_FEATURE]: {
    kind: t.enum(MAP_FEATURE_KINDS, { default: 'solid' }),
    /** None: the kind's colour (or the entity's Shape colour for solid / floor). */
    color: optionalColor,
    /** path: the order nodes are joined in. */
    order: t.int({ default: 0 }),
    /** path / road: stroke width in meters. */
    width: t.number({ default: 4, min: 0.1 }),
    /** path: join the last node back to the first. */
    loop: t.bool({ default: false }),
  },
  [NAMEPLATE]: {
    /** None: the entity's name. */
    text: optionalString,
    offset: t.vec3({ default: new Vec3(0, 2.2, 0) }),
    /** Meters from the viewer's camera beyond which it is hidden. */
    range: t.number({ default: 30, min: 0 }),
    /** Show the entity's Health under the name. */
    health: t.bool({ default: true }),
    color: optionalColor,
    shown: t.bool({ default: true }),
  },
  [AWARENESS]: {
    /** 0 unaware … 1 alerted. Set it from the NPC's perception. */
    level: t.number({ default: 0, min: 0, max: 1 }),
    offset: t.vec3({ default: new Vec3(0, 2.4, 0) }),
    shown: t.bool({ default: true }),
  },
};

/** Components that describe one seat's HUD (read off the seat's viewer entity). */
export const VIEWER_COMPONENTS = [MINIMAP, COMPASS, CROSSHAIR, STAT_BARS, ABILITIES, COMBO, KEY_HINTS, HURT_FEEDBACK] as const;
