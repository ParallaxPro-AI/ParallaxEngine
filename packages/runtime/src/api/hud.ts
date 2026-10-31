/**
 * `parallax.hud` (sdk/parallax/hud.pyi): the HUD kit's component handles, `ctx.hud`, the
 * built-in HUD panels and the `hud()` factory `parallax.plugins` re-exports.
 *
 * The panels are built-in `@ui` PlayerPanels (one copy per seat), each open exactly while it
 * has something to show (its `when=` asks the engine), so a game turns a widget on by
 * putting its component on the player prefab — no panel list, no toggles. To restyle one,
 * subclass it with your own markup: `@ui("my_map", html="ui/map.html") class MyMap(MinimapPanel)`
 * binds the same state keys, and the built-in steps aside while the game declares a subclass.
 */

import { Color, fail, Vec2, Vec3 } from '../core/index.js';
import type { EntityId } from '../core/index.js';
import type { Kernel, KernelPlugin } from '../function/kernel/index.js';
import {
  ABILITIES, AWARENESS, COMBO, COMPASS, CROSSHAIR, hud as hudPlugin, HUD_SCHEMAS, HURT_FEEDBACK, KEY_HINTS,
  MAP_FEATURE, MAP_ICON, MINIMAP, NAMEPLATE, PING_KINDS, STAT_BARS, DISTANCE_UNITS,
} from '../function/plugins/hud/index.js';
import type { Accessibility, DistanceUnits, HudEngine, HudPanel, PingKind } from '../function/plugins/hud/index.js';
import { ACTIONS_SERVICE } from '../function/services/index.js';
import type { ActionGlyph, ActionsService } from '../function/services/index.js';
import { record } from './declarations.js';
import { componentHandle } from './handles.js';
import { Handle } from './time.js';
import { bindArgs, kw } from './kwargs.js';
import { truthy } from './py.js';
import { PyDict } from './pyrt/collections.js';
import { builtinPanels, PlayerPanel, registeredPanels, ui } from './ui.js';
import { rt } from './types.js';
import { seatIndexes, seatViewer } from './viewers.js';

// ── Components ─────────────────────────────────────────────────────────────────

const handle = (id: string, name: string) => componentHandle({ id, schema: HUD_SCHEMAS[id]! }, name);

/** On the player: a minimap of the scene (range = zoom, rotate, shape, route). */
export const Minimap = handle(MINIMAP, 'Minimap');
/** On the player: a heading strip with markers. */
export const Compass = handle(COMPASS, 'Compass');
/** On the player: crosshair style, spread, reload progress, hit markers. */
export const Crosshair = handle(CROSSHAIR, 'Crosshair');
/** On the player: HUD bars bound to its component fields. */
export const StatBars = handle(STAT_BARS, 'StatBars');
/** On anything: slots with cooldowns and charges (`use`, `ready`, `remaining`); the player's show on the ability bar. */
export const Abilities = handle(ABILITIES, 'Abilities');
/** On anything: a combo counter (`hit`, `drop`); the player's is shown. */
export const Combo = handle(COMBO, 'Combo');
/** On the player: which actions' keys to show (device-aware). */
export const KeyHints = handle(KEY_HINTS, 'KeyHints');
/** On the player: hurt flash, shake, hit-stop, damage direction, low-health vignette. */
export const HurtFeedback = handle(HURT_FEEDBACK, 'HurtFeedback');
/** On anything: an icon on the minimap (and compass). */
export const MapIcon = handle(MAP_ICON, 'MapIcon');
/** On a placement: how it draws on the base map. */
export const MapFeature = handle(MAP_FEATURE, 'MapFeature');
/** On anything: a name (and health) over it. */
export const Nameplate = handle(NAMEPLATE, 'Nameplate');
/** On an NPC: a 0..1 awareness meter ("?" → "!"). */
export const Awareness = handle(AWARENESS, 'Awareness');

class StatBarFields {
  static readonly __annotations__ = {
    label: () => rt.str, value: () => rt.str, max: () => rt.optional(rt.str), color: () => Color, numbers: () => rt.bool, low: () => rt.float,
  };
  static readonly label = '';
  static readonly max = null;
  static readonly color = Color.hex('#e04848');
  static readonly numbers = true;
  static readonly low = 0.25;
}
/** One bar of StatBars: `StatBar(label="HP", value="health.current", max="health.max")`. */
export const StatBar = record(StatBarFields);

class AbilitySlotFields {
  static readonly __annotations__ = {
    id: () => rt.str, label: () => rt.str, icon: () => rt.str, cooldown: () => rt.float, charges: () => rt.int, action: () => rt.optional(rt.str),
  };
  static readonly label = '';
  static readonly icon = '';
  static readonly charges = 1;
  static readonly action = null;
}
/** One slot of Abilities: `AbilitySlot(id="dash", cooldown=4, action="Controls.dash")`. */
export const AbilitySlot = record(AbilitySlotFields);

// ── ctx.hud ────────────────────────────────────────────────────────────────────

function seatArg(to: unknown, where: string): number | null {
  if (to === undefined || to === null) return null;
  const index = (to as { index?: unknown }).index;
  if (typeof index !== 'number') fail('PP3558', `${where} to= takes a Player (ctx.players[i]), got ${String(to)}`);
  return index;
}

function number(value: unknown, fallback: number, where: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('PP3558', `${where} must be a number, got ${String(value)}`);
  return value;
}

/** Words of an action name: `Controls.open_map` → "Open map". */
function actionLabel(name: string): string {
  const words = name.slice(name.lastIndexOf('.') + 1).replace(/_/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

interface KeyView { readonly text: string; readonly code: string; readonly device: string; readonly pad: boolean; readonly touch: boolean }

function keyViews(glyphs: readonly ActionGlyph[]): KeyView[] {
  return glyphs.map((g) => ({ text: g.text, code: g.code, device: g.device, pad: g.device === 'gamepad', touch: g.device === 'touch' }));
}

export class HudApi {
  readonly #engine: HudEngine;

  constructor(engine: HudEngine) {
    this.#engine = engine;
  }

  /** `ping(at, *, kind="look", seconds=6, label="", to=None)`: a marker at a point or entity, on screen and minimap. */
  ping(...args: unknown[]): void {
    const a = bindArgs('hud.ping', args, { positional: ['at'], keyword: ['kind', 'seconds', 'label', 'to'], required: ['at'] }).args;
    const kind = (a['kind'] ?? 'look') as PingKind;
    if (!(PING_KINDS as readonly string[]).includes(kind)) fail('PP3558', `hud.ping() kind must be one of ${PING_KINDS.join(', ')}, got ${String(kind)}`);
    const seconds = number(a['seconds'], 6, 'hud.ping() seconds');
    const label = a['label'] ?? '';
    if (typeof label !== 'string') fail('PP3558', 'hud.ping() label must be a str');
    let at: Vec3 | EntityId;
    const raw = a['at'];
    if (raw instanceof Vec3) at = raw;
    else if (raw instanceof Vec2) at = new Vec3(raw.x, raw.y, 0);
    else {
      const id = this.#engine.kernel.handles.unwrap(raw);
      if (id === undefined) fail('PP3558', `hud.ping() at= takes a Vec3, Vec2 or Entity, got ${String(raw)}`);
      at = id;
    }
    this.#engine.ping(at, kind, seconds, label, seatArg(a['to'], 'hud.ping()'));
  }

  /** `hit_marker(*, kill=False, to=None)`: flash the crosshair's hit (or kill) marker. Damage from a Crosshair entity does this by itself. */
  hit_marker(...args: unknown[]): void {
    const a = bindArgs('hud.hit_marker', args, { keyword: ['kill', 'to'] }).args;
    this.#engine.hitMarker(truthy(a['kill'] ?? false), seatArg(a['to'], 'hud.hit_marker()'));
  }

  /** `screen_flash(color=None, *, strength=0.5, seconds=0.3, ease="out_quad", to=None)`: a full-screen flash (pickups, explosions). */
  screen_flash(...args: unknown[]): void {
    const a = bindArgs('hud.screen_flash', args, { positional: ['color'], keyword: ['strength', 'seconds', 'ease', 'to'] }).args;
    const color = a['color'] ?? Color.WHITE;
    if (!(color instanceof Color)) fail('PP3558', 'hud.screen_flash() color must be a Color');
    const strength = number(a['strength'], 0.5, 'hud.screen_flash() strength');
    const seconds = number(a['seconds'], 0.3, 'hud.screen_flash() seconds');
    if (!(strength >= 0 && strength <= 1) || !(seconds > 0)) fail('PP3558', 'hud.screen_flash() needs 0 <= strength <= 1 and seconds > 0');
    const ease = a['ease'] ?? 'out_quad';
    if (typeof ease !== 'string') fail('PP3558', 'hud.screen_flash() ease= takes an Ease name ("out_quad", "linear", "in_out_cubic"…)');
    this.#engine.screenFlash(color, strength, seconds, seatArg(a['to'], 'hud.screen_flash()'), ease);
  }

  /** `slow_motion(scale, seconds, *, ease_in=0.15, ease_out=0.3) -> Handle`: ease time.scale down, hold, ease back. */
  slow_motion(...args: unknown[]): Handle {
    const a = bindArgs('hud.slow_motion', args, { positional: ['scale', 'seconds'], keyword: ['ease_in', 'ease_out'], required: ['scale', 'seconds'] }).args;
    return new Handle(this.#engine.slowMotion(
      number(a['scale'], 1, 'hud.slow_motion() scale'), number(a['seconds'], 0, 'hud.slow_motion() seconds'),
      number(a['ease_in'], 0.15, 'hud.slow_motion() ease_in'), number(a['ease_out'], 0.3, 'hud.slow_motion() ease_out'),
    ));
  }

  // Engine-facing (the built-in panels); not part of the SDK.

  __has__(panel: HudPanel): boolean {
    return this.#engine.has(panel);
  }

  __state__(panel: HudPanel, seat: number): Record<string, unknown> {
    const e = this.#engine;
    switch (panel) {
      case 'minimap': return { ...e.minimap(seat) };
      case 'compass': return { ...e.compass(seat) };
      case 'crosshair': return { ...e.crosshair(seat) };
      case 'nameplates': return { ...e.nameplates(seat) };
      case 'markers': return { ...e.markers(seat) };
      case 'stats': return { ...e.stats(seat) };
      case 'combo': return { ...e.combo(seat) };
      case 'awareness': return { ...e.awareness(seat) };
      case 'screen': return { ...e.screen(seat) };
      case 'abilities': {
        const model = e.abilities(seat);
        const actions = this.#actions();
        const device = actions?.device(seat) ?? 'keyboard';
        return {
          ...model,
          slots: model.slots.map((slot) => ({ ...slot, keys: slot.action === null ? [] : keyViews(actions === undefined ? [] : actions.glyphs(this.#action(actions, slot.action, 'AbilitySlot.action'), device)) })),
        };
      }
      case 'key_hints': {
        const model = e.keyHints(seat);
        const actions = this.#actions();
        if (actions === undefined || !model.shown) return { shown: false, device: 'keyboard', hints: [], a11y: model.a11y };
        const device = actions.device(seat);
        const owner = e.viewer(seat, KEY_HINTS);
        const hints = model.actions.flatMap((name) => {
          const action = this.#action(actions, name, 'KeyHints.actions');
          if (!actions.live(action, seat, owner)) return [];
          const keys = keyViews(actions.glyphs(action, device));
          return keys.length === 0 ? [] : [{ label: actionLabel(name), action: name, keys }];
        });
        return { shown: hints.length > 0, device, hints, a11y: model.a11y };
      }
    }
  }

  #actions(): ActionsService | undefined {
    return this.#engine.kernel.tryService(ACTIONS_SERVICE);
  }

  #action(actions: ActionsService, name: string, where: string): unknown {
    const found = actions.find(name);
    if (found === undefined) {
      fail('PP3559', `${where} names "${name}", which no Actions class declares`, {
        fix: `Write "<ActionSet>.<action>". Declared: ${actions.names().slice(0, 12).join(', ') || '(none)'}.`,
      });
    }
    return found;
  }
}

// ── The plugin ─────────────────────────────────────────────────────────────────

/** The player's accessibility settings, from the Settings resource. */
export function accessibilityOf(kernel: Kernel): Accessibility {
  const s = kernel.resource('settings');
  return {
    reducedMotion: s['reduced_motion'] === true,
    highContrast: s['high_contrast'] === true,
    textScale: s['text_scale'] as number,
    colorblind: s['colorblind'] as Accessibility['colorblind'],
  };
}

/** `parallax.plugins.hud()`. */
export function hud(...args: unknown[]): KernelPlugin {
  const units = bindArgs('hud', args, { keyword: ['units'] }).args['units'] ?? 'metric';
  if (!DISTANCE_UNITS.includes(units as DistanceUnits)) {
    fail('PP3561', `hud(units=) must be ${DISTANCE_UNITS.map((u) => `"${u}"`).join(' or ')}, got ${String(units)}`, {
      fix: 'units="metric" (m, then km past 1000 m) or units="imperial" (ft, then mi past 1000 ft).',
    });
  }
  return hudPlugin({
    units: units as DistanceUnits,
    viewer: seatViewer,
    seats: seatIndexes,
    accessibility: accessibilityOf,
    hitstop: (kernel, seconds) => (kernel.context as { time: { hitstop(s: number): void } }).time.hitstop(seconds),
    seatOf: (to) => seatArg(to, 'to='),
    namespace: (engine) => new HudApi(engine),
  });
}

// ── Built-in panels ────────────────────────────────────────────────────────────

function hudOf(ctx: unknown): HudApi {
  const api = (ctx as { hud?: HudApi }).hud;
  if (api === undefined) {
    fail('PP3560', 'HUD panels show the hud plugin\'s state, and this game doesn\'t have it', {
      fix: 'Add hud() to Game(plugins=[...]) (from parallax import plugins).',
    });
  }
  return api;
}

/** A built-in panel steps aside while the game declares a subclass of it (its restyled copy). */
function overridden(cls: Function): boolean {
  return registeredPanels().some((c) => c !== cls && c.prototype instanceof cls);
}

function seatOfPlayer(player: unknown): number {
  return typeof (player as { index?: unknown } | null)?.index === 'number' ? (player as { index: number }).index : 0;
}

/** HUD state as Python sees it: dicts (`state["icons"][0]["x"]`, `.get`, `|`), new lists — never the engine's own. */
function pythonState(value: unknown): unknown {
  if (Array.isArray(value)) {
    const items = value.map(pythonState);
    return Object.isFrozen(value) ? Object.freeze(items) : items;
  }
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return PyDict.from(Object.entries(value).map(([k, v]) => [k, pythonState(v)]));
  }
  return value;
}

abstract class HudPanelBase extends PlayerPanel {
  static readonly panel: HudPanel;

  /**
   * The panel's state. A game's subclass gets it as a dict it may change or extend
   * (`s = super().state(ctx, player); s["zoom"] = 2; return s`); the built-in panels
   * hand the engine's view to the UI as is.
   */
  override state(ctx: unknown, player?: unknown): unknown {
    const cls = this.constructor as typeof HudPanelBase;
    const state = hudOf(ctx).__state__(cls.panel, seatOfPlayer(player));
    return BUILT_IN.some(([builtIn]) => builtIn === cls) ? state : pythonState(state);
  }
}

/** Minimap: state {shown, round, base, base_left/top/width/height, turn, player_turn, icons, has_route, route, range, a11y}. */
export class MinimapPanel extends HudPanelBase { static override readonly panel: HudPanel = 'minimap'; }
/** Compass strip: {shown, heading, ticks: [{label, x, major}], marks: [{glyph, color, x, distance, label}], a11y}. */
export class CompassPanel extends HudPanelBase { static override readonly panel: HudPanel = 'compass'; }
/** Crosshair / scope / hit markers / reload: {shown, dot, cross, circle, scope, gap, color, hit, kill, reloading, reload, a11y}. */
export class CrosshairPanel extends HudPanelBase { static override readonly panel: HudPanel = 'crosshair'; }
/** Nameplates and world health bars: {shown, plates: [{x, y, text, named, health, fill, color, low}], a11y}. */
export class NameplatesPanel extends HudPanelBase { static override readonly panel: HudPanel = 'nameplates'; }
/** Objective markers and pings, pinned to the edge off screen: {shown, markers: [{x, y, on_screen, turn, icon, glyph, label, distance, color, ping}], a11y}. */
export class MarkersPanel extends HudPanelBase { static override readonly panel: HudPanel = 'markers'; }
/** Stat bars: {shown, bars: [{label, text, fill, color, low, numbers}], a11y}. */
export class StatBarsPanel extends HudPanelBase { static override readonly panel: HudPanel = 'stats'; }
/** Ability bar: {shown, slots: [{id, label, icon, keys, ready, charges, max_charges, show_charges, fill, seconds}], a11y}. */
export class AbilityBarPanel extends HudPanelBase { static override readonly panel: HudPanel = 'abilities'; }
/** Combo counter: {shown, count, best, fill, a11y}. */
export class ComboPanel extends HudPanelBase { static override readonly panel: HudPanel = 'combo'; }
/** Key hints: {shown, device, hints: [{label, action, keys: [{text, code, device, pad, touch}]}], a11y}. */
export class KeyHintsPanel extends HudPanelBase { static override readonly panel: HudPanel = 'key_hints'; }
/** Awareness meters, damage-direction arcs and noise cues: {shown, meters: [{x, y, fill, alerted, on_screen, turn}], hits: [{turn, opacity}], sounds: [{turn, opacity, kind}], a11y}. */
export class AwarenessPanel extends HudPanelBase { static override readonly panel: HudPanel = 'awareness'; }
/** Screen juice: {shown, flash, flash_color, vignette, vignette_color, a11y}. */
export class ScreenEffectsPanel extends HudPanelBase { static override readonly panel: HudPanel = 'screen'; }

const BUILT_IN: readonly [typeof HudPanelBase, string][] = [
  [ScreenEffectsPanel, 'screen'],
  [NameplatesPanel, 'nameplates'],
  [AwarenessPanel, 'awareness'],
  [MarkersPanel, 'markers'],
  [CrosshairPanel, 'crosshair'],
  [MinimapPanel, 'minimap'],
  [CompassPanel, 'compass'],
  [StatBarsPanel, 'stat_bars'],
  [AbilityBarPanel, 'ability_bar'],
  [ComboPanel, 'combo'],
  [KeyHintsPanel, 'key_hints'],
];

for (const [cls, file] of BUILT_IN) {
  const when = (ctx: unknown): boolean => {
    const api = (ctx as { hud?: HudApi }).hud;
    return api !== undefined && !overridden(cls) && api.__has__(cls.panel);
  };
  ui(`hud_${file}`, kw({ html: `builtin:hud/${file}.html`, layer: 'hud', when }))(cls);
}
builtinPanels(...BUILT_IN.map(([cls]) => cls));
