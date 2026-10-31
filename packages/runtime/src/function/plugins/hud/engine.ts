/**
 * The HUD engine: keeps an index of the entities the HUD draws (filed as they come and go),
 * builds each built-in panel's model per seat on demand, and owns HUD feedback — hit
 * markers, hurt flashes and damage arcs, pings, eased slow motion — plus the gameplay half
 * of two components (ability cooldowns, combo windows), which tick in game time.
 *
 * Presentation decays (flashes, markers, pings) run on real time, so hit-stop and slow
 * motion don't stretch them.
 *
 * Net games. Feedback is made where the game logic runs (the server). With `forwardTo` set
 * (the net feedback bridge, on the authority) every piece of seat feedback — pings, hit
 * and kill markers, screen flashes, damage arcs, camera shakes — is also handed over as
 * JSON (entity references as this kernel's ids); a client `replay`s it on its own copy. Models are computed when a panel asks (its `state()`), from
 * the cameras' resolved views (`camera.__view__`).
 */

import { Color, easing, fail, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { EntityRecord, Fields, Handle, Kernel } from '../../kernel/index.js';
import { CITY_SERVICE, engineText, PERCEPTION_SERVICE, PLAYERS_SERVICE } from '../../services/index.js';
import type { Json, JsonObject } from '../../../resource/index.js';
import { BaseMapBuilder, headingOf, planeOf } from './base_map.js';
import type { BaseMap } from './base_map.js';
import type {
  A11yState, AbilitiesModel, Accessibility, AwarenessModel, ComboModel, CompassModel, CrosshairModel, KeyHintsModel,
  MapIconModel, MarkerModel, MarkersModel, MinimapModel, NameplatesModel, PlateModel, ScreenModel, StatBarModel, StatsModel,
} from './models.js';
import { css, pct, place, seatViews, viewHeading } from './project.js';
import type { ViewLike } from './project.js';
import {
  ABILITIES, AWARENESS, CAMERA, COMBO, COMPASS, CROSSHAIR, HEALTH, HEALTH_BAR, HURT_FEEDBACK, KEY_HINTS, MAP_ICON,
  MARKER, MINIMAP, NAMEPLATE, STAT_BARS,
} from './schemas.js';

export const ICON_GLYPHS: Readonly<Record<string, string>> = {
  dot: '●', arrow: '▲', square: '■', diamond: '◆', triangle: '△', star: '★', cross: '✚', skull: '☠', flag: '⚑',
  pin: '⌖', ring: '○', waypoint: '◆',
};

export const PING_KINDS = ['look', 'go', 'enemy', 'loot', 'help'] as const;
export type PingKind = (typeof PING_KINDS)[number];
const PING_STYLE: Readonly<Record<PingKind, { glyph: string; color: Color }>> = {
  look: { glyph: '◉', color: Color.hex('#ffd95a') },
  go: { glyph: '➜', color: Color.hex('#5ad1ff') },
  enemy: { glyph: '✖', color: Color.hex('#ff5a5a') },
  loot: { glyph: '★', color: Color.hex('#c78bff') },
  help: { glyph: '✚', color: Color.hex('#6dff8a') },
};

/** HUD defaults per colour-vision mode: ally, enemy, neutral health. */
const SIDE_COLORS = {
  normal: { ally: Color.hex('#4cc35a'), enemy: Color.hex('#e04848'), neutral: Color.hex('#e0c048') },
  safe: { ally: Color.hex('#3d8bff'), enemy: Color.hex('#ff8c1a'), neutral: Color.hex('#f0f0f0') },
} as const;

const HIT_SECONDS = 0.25;
const KILL_SECONDS = 0.5;
const ARC_SECONDS = 1.2;
const FLASH_SECONDS = 0.35;
/** A screen flash's fade by default: fast off the peak, a soft tail. */
const FLASH_EASE = 'out_quad';
const MAP_RIM = 0.46;

/** Panels the HUD kit draws (their `when=` asks `has(panel)`). */
export const HUD_PANELS = [
  'minimap', 'compass', 'crosshair', 'nameplates', 'markers', 'stats', 'abilities', 'combo', 'key_hints', 'awareness', 'screen',
] as const;
export type HudPanel = (typeof HUD_PANELS)[number];

export interface HudOptions {
  /**
   * The entity seat `seat` plays among `candidates` (live entities carrying the viewer
   * component `what`), or null: the api's viewer rule (players service, camera follow).
   */
  readonly viewer: (kernel: Kernel, seat: number, candidates: readonly EntityId[], what: string) => EntityId | null;
  /** Seats in play (seat indexes). */
  readonly seats: (kernel: Kernel) => readonly number[];
  /** The player's accessibility settings (the Settings resource). */
  readonly accessibility: (kernel: Kernel) => Accessibility;
  /** `ctx.time.hitstop(seconds)`. */
  readonly hitstop: (kernel: Kernel, seconds: number) => void;
  /** A `to=` argument (a Player) → its seat, or null for every seat. */
  readonly seatOf: (to: unknown) => number | null;
  /** How marker, compass and ping distances read (`hud(units=)`); default metric. */
  readonly units?: DistanceUnits;
}

export type DistanceUnits = 'metric' | 'imperial';
export const DISTANCE_UNITS: readonly DistanceUnits[] = ['metric', 'imperial'];

/**
 * A distance in metres as a HUD prints it. metric: "640 m", then "1.2 km" from 1000 m
 * ("12 km" from 10 km); imperial: "850 ft", then "0.2 mi" from 1000 ft ("12 mi" from 10 mi).
 */
export function formatDistance(metres: number, units: DistanceUnits = 'metric'): string {
  const [small, smallUnit, big, bigUnit] = units === 'imperial'
    ? [metres * 3.28084, 'ft', metres / 1609.344, 'mi'] as const
    : [metres, 'm', metres / 1000, 'km'] as const;
  if (Math.round(small) < 1000) return `${Math.round(small)} ${smallUnit}`;
  return big < 9.95 ? `${big.toFixed(1)} ${bigUnit}` : `${Math.round(big)} ${bigUnit}`;
}

interface Ping {
  readonly at: Vec3 | EntityId;
  readonly kind: PingKind;
  readonly start: number;
  readonly until: number;
  readonly seat: number | null;
  readonly label: string;
}

interface Flash {
  readonly color: Color;
  readonly strength: number;
  readonly start: number;
  readonly seconds: number;
  /** How it fades: the opacity is strength × (1 − ease(t)). Default out_quad. */
  readonly ease: string;
}

interface SeatFeedback {
  hitAt: number;
  killAt: number;
  flashes: Flash[];
  arcs: { readonly from: Vec3; readonly start: number }[];
}

interface SlowMotion {
  readonly scale: number;
  readonly seconds: number;
  readonly easeIn: number;
  readonly easeOut: number;
  readonly base: number;
  start: number;
  readonly handle: Handle;
}

export interface HudSnapshot {
  /** A slow motion under way: its profile and how far in (real seconds). */
  readonly slow: { scale: number; seconds: number; ease_in: number; ease_out: number; base: number; elapsed: number } | null;
}

function ramp(t: number): number {
  return t * t * (3 - 2 * t);
}

function finiteNumber(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail('PP3551', `${where} must be a number, got ${String(value)}`);
  return value;
}

export class HudEngine {
  readonly #options: HudOptions;
  #kernel: Kernel | undefined;
  /** Live entities by the HUD-relevant component they carry. */
  readonly #index = new Map<string, Set<EntityId>>();
  /** Entities that can change the base map. */
  readonly #static = new Set<EntityId>();
  #base: BaseMap | null = null;
  #baseDirty = true;
  #pings: Ping[] = [];
  readonly #feedback = new Map<number, SeatFeedback>();
  #slow: SlowMotion | null = null;
  #forward: ((item: Json) => void) | null = null;
  #dimension: '2d' | '3d' | undefined;

  constructor(options: HudOptions) {
    this.#options = options;
    for (const id of [MINIMAP, COMPASS, CROSSHAIR, STAT_BARS, ABILITIES, COMBO, KEY_HINTS, HURT_FEEDBACK, MAP_ICON, NAMEPLATE,
      AWARENESS, MARKER, HEALTH_BAR, CAMERA]) {
      this.#index.set(id, new Set());
    }
  }

  get kernel(): Kernel {
    if (this.#kernel === undefined) fail('PP9550', 'The hud plugin is used before its kernel was built');
    return this.#kernel;
  }

  /**
   * 2D or 3D, as the cameras see it (a plugin factory runs before `Game(mode=...)` is known;
   * every game that draws has a camera, and its resolved view names the dimension).
   */
  get dimension(): '2d' | '3d' {
    if (this.#dimension !== undefined) return this.#dimension;
    const view = this.#views().values().next().value;
    if (view === undefined) {
      fail('PP3557', 'The HUD places things through a camera, and this scene has no active one', {
        fix: 'Place an entity with a camera component in the scene.',
      });
    }
    this.#dimension = view.dimension;
    return this.#dimension;
  }

  bind(kernel: Kernel): void {
    if (this.#kernel !== undefined) fail('PP9551', 'This hud plugin is already installed in another kernel', { fix: 'Call hud() once per game.' });
    this.#kernel = kernel;
  }

  // ── Index ───────────────────────────────────────────────────────────────────

  file(record: EntityRecord): void {
    for (const [id, set] of this.#index) {
      if (record.components.has(id)) set.add(record.id);
      else set.delete(record.id);
    }
    const contributes = BaseMapBuilder.contributes(record);
    if (contributes !== this.#static.has(record.id)) this.#baseDirty = true;
    if (contributes) {
      this.#static.add(record.id);
      // A changed contributor (a moved wall, a new MapFeature) redraws the map.
      this.#baseDirty = true;
    } else {
      this.#static.delete(record.id);
    }
  }

  unfile(id: EntityId): void {
    for (const set of this.#index.values()) set.delete(id);
    if (this.#static.delete(id)) this.#baseDirty = true;
  }

  sceneLoading(): void {
    this.#pings = [];
    this.#feedback.clear();
    this.#baseDirty = true;
  }

  #ids(component: string): EntityId[] {
    return [...this.#index.get(component)!];
  }

  #record(id: EntityId): EntityRecord | undefined {
    return this.kernel.world.get(id);
  }

  /** The entity seat `seat` plays, among those carrying `component`. */
  viewer(seat: number, component: string): EntityId | null {
    const candidates = this.#ids(component);
    if (candidates.length === 0) return null;
    return this.#options.viewer(this.kernel, seat, candidates, component);
  }

  /** Whether the panel has anything to show for some seat (its `when=`). */
  has(panel: HudPanel): boolean {
    const any = (id: string): boolean => this.#index.get(id)!.size > 0;
    const now = this.kernel.time.realNow;
    switch (panel) {
      case 'minimap': return any(MINIMAP);
      case 'compass': return any(COMPASS);
      case 'crosshair': return any(CROSSHAIR);
      case 'nameplates': return any(NAMEPLATE) || any(HEALTH_BAR);
      case 'markers': return any(MARKER) || this.#pings.some((p) => p.until > now);
      case 'stats': return any(STAT_BARS);
      case 'abilities': return any(ABILITIES);
      case 'combo': return any(COMBO);
      case 'key_hints': return any(KEY_HINTS);
      case 'awareness': return any(AWARENESS) || any(HURT_FEEDBACK);
      case 'screen': return any(HURT_FEEDBACK) || [...this.#feedback.values()].some((f) => f.flashes.length > 0);
    }
  }

  // ── Shared reads ────────────────────────────────────────────────────────────

  #a11y(): Accessibility {
    return this.#options.accessibility(this.kernel);
  }

  #a11yState(a: Accessibility): A11yState {
    return { contrast: a.highContrast, calm: a.reducedMotion, font: `${Math.round(a.textScale * 100)}%` };
  }

  #views(): Map<number, ViewLike> {
    return seatViews(this.kernel, this.#index.get(CAMERA)!);
  }

  #anchor(id: EntityId | Vec3, offset?: Vec3): Vec3 | undefined {
    if (id instanceof Vec3) return id;
    const record = this.#record(id);
    if (record === undefined) return undefined;
    const p = record.transform.worldPosition();
    return offset === undefined ? p : p.__add__(offset);
  }

  /** Engine-component text in the player's language (a locale key's text, else as written). */
  #text(text: string): string {
    return engineText(this.kernel, text);
  }

  #nameOf(record: EntityRecord): string {
    return record.name ?? record.childName ?? record.placedId ?? record.prefab ?? 'entity';
  }

  #feedbackOf(seat: number): SeatFeedback {
    let f = this.#feedback.get(seat);
    if (f === undefined) {
      f = { hitAt: -Infinity, killAt: -Infinity, flashes: [], arcs: [] };
      this.#feedback.set(seat, f);
    }
    return f;
  }

  /** Seats whose viewer (for `component`) is `entity`. */
  #seatsViewing(entity: EntityId, component: string): number[] {
    return this.#feedbackSeats().filter((seat) => this.viewer(seat, component) === entity);
  }

  // ── Minimap ─────────────────────────────────────────────────────────────────

  /** The base map, rebuilt when a contributing entity came, went or changed. */
  baseMap(): BaseMap | null {
    // The city plan is generated on first use and replaced on a rebuild: redraw on change.
    const city = this.dimension === '3d' ? this.kernel.tryService(CITY_SERVICE)?.map() ?? null : null;
    if (this.#baseDirty || (this.#base?.city ?? null) !== city) {
      this.#base = new BaseMapBuilder(this.kernel, this.dimension).build(this.#static);
      this.#baseDirty = false;
    }
    return this.#base;
  }

  minimap(seat: number): MinimapModel {
    const a = this.#a11y();
    const empty: MinimapModel = {
      shown: false, round: true, base: null, base_left: '0%', base_top: '0%', base_width: '0%', base_height: '0%', turn: 'none',
      player_turn: 'none', icons: [], has_route: false, route: '', range: 0, a11y: this.#a11yState(a),
    };
    const id = this.viewer(seat, MINIMAP);
    const record = id === null ? undefined : this.#record(id);
    if (record === undefined) return empty;
    const map = record.components.get(MINIMAP)!;
    if (map['shown'] !== true) return empty;
    const range = map['range'] as number;
    const round = map['shape'] === 'circle';
    const heading = headingOf(this.dimension, record);
    const turnDeg = map['rotate'] === true ? heading : 0;
    const [vu, vv] = planeOf(this.dimension, record.transform.worldPosition());
    const span = 2 * range;
    const cos = Math.cos((turnDeg * Math.PI) / 180);
    const sin = Math.sin((turnDeg * Math.PI) / 180);
    /** A map-plane point as box fractions, turned with the map. */
    const box = (u: number, v: number): [number, number] => {
      const du = (u - vu) / span;
      const dv = (v - vv) / span;
      return [0.5 + du * cos - dv * sin, 0.5 - (du * sin + dv * cos)];
    };
    const inside = (x: number, y: number): boolean => (round ? Math.hypot(x - 0.5, y - 0.5) <= 0.5 : Math.max(Math.abs(x - 0.5), Math.abs(y - 0.5)) <= 0.5);
    const rim = (x: number, y: number): [number, number] => {
      const dx = x - 0.5;
      const dy = y - 0.5;
      const k = round ? MAP_RIM / Math.max(1e-9, Math.hypot(dx, dy)) : MAP_RIM / Math.max(1e-9, Math.abs(dx), Math.abs(dy));
      return [0.5 + dx * k, 0.5 + dy * k];
    };
    const icons: MapIconModel[] = [];
    for (const other of this.#ids(MAP_ICON)) {
      if (other === id) continue;
      const r = this.#record(other);
      const icon = r?.components.get(MAP_ICON);
      if (r === undefined || icon === undefined || icon['shown'] !== true) continue;
      const [u, v] = planeOf(this.dimension, r.transform.worldPosition());
      let [x, y] = box(u, v);
      const within = inside(x, y);
      if (!within && icon['edge'] !== true) continue;
      if (!within) [x, y] = rim(x, y);
      const name = icon['icon'] as string;
      icons.push({
        icon: name, glyph: ICON_GLYPHS[name] ?? '●', x: pct(x), y: pct(y), color: css(icon['color'] as Color),
        size: `${Math.round((icon['size'] as number) * 100)}%`,
        turn: icon['rotate'] === true ? `rotate(${Math.round(headingOf(this.dimension, r) - turnDeg)}deg)` : 'none',
        label: this.#text((icon['label'] as string | null) ?? ''), edge: !within,
      });
    }
    const now = this.kernel.time.realNow;
    for (const ping of this.#pings) {
      if (ping.until <= now || (ping.seat !== null && ping.seat !== seat)) continue;
      const at = this.#anchor(ping.at);
      if (at === undefined) continue;
      const [u, v] = planeOf(this.dimension, at);
      let [x, y] = box(u, v);
      const within = inside(x, y);
      if (!within) [x, y] = rim(x, y);
      const style = PING_STYLE[ping.kind];
      icons.push({ icon: `ping_${ping.kind}`, glyph: style.glyph, x: pct(x), y: pct(y), color: css(style.color), size: '120%', turn: 'none', label: this.#text(ping.label), edge: !within });
    }
    const base = this.baseMap();
    const route = (map['route'] as Vec3[]).map((p) => {
      const [u, v] = planeOf(this.dimension, p);
      return `${Math.round((50 + ((u - vu) / span) * 100) * 100) / 100},${Math.round((50 - ((v - vv) / span) * 100) * 100) / 100}`;
    });
    return {
      shown: true, round,
      base: base?.uri ?? null,
      base_left: base === null ? '0%' : pct(0.5 + (base.minU - vu) / span),
      base_top: base === null ? '0%' : pct(0.5 - (base.maxV - vv) / span),
      base_width: base === null ? '0%' : pct((base.maxU - base.minU) / span),
      base_height: base === null ? '0%' : pct((base.maxV - base.minV) / span),
      turn: turnDeg === 0 ? 'none' : `rotate(${Math.round(-turnDeg * 10) / 10}deg)`,
      player_turn: turnDeg === 0 ? `rotate(${Math.round(heading)}deg)` : 'none',
      icons, has_route: route.length >= 2, route: route.join(' '), range, a11y: this.#a11yState(a),
    };
  }

  // ── Compass ─────────────────────────────────────────────────────────────────

  compass(seat: number): CompassModel {
    const a = this.#a11y();
    const id = this.viewer(seat, COMPASS);
    const record = id === null ? undefined : this.#record(id);
    const fields = record?.components.get(COMPASS);
    if (record === undefined || fields === undefined || fields['shown'] !== true) {
      return { shown: false, heading: 0, ticks: [], marks: [], a11y: this.#a11yState(a) };
    }
    const view = this.#views().get(seat);
    const heading = view !== undefined && view.dimension === '3d' ? viewHeading(view) : headingOf(this.dimension, record);
    const fov = fields['fov'] as number;
    const offset = (bearing: number): number | null => {
      const delta = ((((bearing - heading) % 360) + 540) % 360) - 180;
      return Math.abs(delta) <= fov / 2 ? 0.5 + delta / fov : null;
    };
    const LETTERS: Readonly<Record<number, string>> = { 0: 'N', 45: 'NE', 90: 'E', 135: 'SE', 180: 'S', 225: 'SW', 270: 'W', 315: 'NW' };
    const ticks: CompassModel['ticks'][number][] = [];
    for (let b = 0; b < 360; b += 15) {
      const x = offset(b);
      if (x !== null) ticks.push({ label: LETTERS[b] ?? '', x: pct(x), major: b % 90 === 0 });
    }
    const marks: CompassModel['marks'][number][] = [];
    if (fields['markers'] === true) {
      const [vu, vv] = planeOf(this.dimension, record.transform.worldPosition());
      const add = (r: EntityRecord, glyph: string, color: Color, label: string): void => {
        const [u, v] = planeOf(this.dimension, r.transform.worldPosition());
        const bearing = (Math.atan2(u - vu, v - vv) * 180) / Math.PI;
        const x = offset(bearing);
        if (x !== null) marks.push({ glyph, color: css(color), x: pct(x), distance: formatDistance(Math.hypot(u - vu, v - vv), this.#options.units), label });
      };
      for (const other of this.#ids(MARKER)) {
        const r = this.#record(other);
        const m = r?.components.get(MARKER);
        if (r === undefined || m === undefined || m['shown'] !== true || other === id) continue;
        add(r, ICON_GLYPHS[m['icon'] as string] ?? '◆', m['color'] as Color, this.#text((m['label'] as string | null) ?? ''));
      }
      for (const other of this.#ids(MAP_ICON)) {
        const r = this.#record(other);
        const icon = r?.components.get(MAP_ICON);
        if (r === undefined || icon === undefined || icon['shown'] !== true || icon['compass'] !== true || other === id) continue;
        add(r, ICON_GLYPHS[icon['icon'] as string] ?? '●', icon['color'] as Color, this.#text((icon['label'] as string | null) ?? ''));
      }
    }
    return { shown: true, heading: Math.round(((heading % 360) + 360) % 360), ticks, marks, a11y: this.#a11yState(a) };
  }

  // ── Crosshair ───────────────────────────────────────────────────────────────

  crosshair(seat: number): CrosshairModel {
    const a = this.#a11y();
    const id = this.viewer(seat, CROSSHAIR);
    const fields = id === null ? undefined : this.#record(id)?.components.get(CROSSHAIR);
    const style = (fields?.['style'] ?? 'none') as string;
    const off: CrosshairModel = {
      shown: false, dot: false, cross: false, circle: false, scope: false, gap: '0px', color: '', hit: 0, kill: false,
      reloading: false, reload: '0%', a11y: this.#a11yState(a),
    };
    if (fields === undefined || style === 'none') return off;
    const view = this.#views().get(seat);
    const spread = fields['spread'] as number;
    const half = view !== undefined && view.mode === 'perspective' ? view.viewport.height / 2 : 0;
    const gap = half > 0
      ? 4 + (Math.tan((spread * Math.PI) / 180) / Math.tan((view!.fov * Math.PI) / 360)) * half
      : 4 + spread * 6;
    const now = this.kernel.time.realNow;
    const feedback = this.#feedback.get(seat);
    const sinceHit = feedback === undefined ? Infinity : now - feedback.hitAt;
    const sinceKill = feedback === undefined ? Infinity : now - feedback.killAt;
    const reload = fields['reload'] as number | null;
    return {
      shown: true, dot: style === 'dot' || style === 'cross', cross: style === 'cross', circle: style === 'circle', scope: style === 'scope',
      gap: `${Math.round(gap * 10) / 10}px`, color: css(fields['color'] as Color),
      hit: fields['hit_markers'] === true && sinceHit < HIT_SECONDS ? Math.round((1 - sinceHit / HIT_SECONDS) * 100) / 100 : 0,
      kill: fields['hit_markers'] === true && sinceKill < KILL_SECONDS,
      reloading: reload !== null, reload: reload === null ? '0%' : pct(Math.max(0, Math.min(1, reload))), a11y: this.#a11yState(a),
    };
  }

  // ── World-anchored: nameplates, markers, awareness ──────────────────────────

  #side(record: EntityRecord | undefined): unknown {
    const side = record?.components.get('side');
    return side === undefined ? undefined : side['side'];
  }

  nameplates(seat: number): NameplatesModel {
    const a = this.#a11y();
    const view = this.#views().get(seat);
    if (view === undefined) return { shown: false, plates: [], a11y: this.#a11yState(a) };
    const viewerId = this.#options.seats(this.kernel).includes(seat) ? this.#seatEntity(seat) : null;
    const viewerSide = this.#side(viewerId === null ? undefined : this.#record(viewerId));
    const sides = a.colorblind === 'none' ? SIDE_COLORS.normal : SIDE_COLORS.safe;
    const ids = new Set([...this.#ids(NAMEPLATE), ...this.#ids(HEALTH_BAR)]);
    const plates: (PlateModel & { distance: number })[] = [];
    for (const id of ids) {
      if (id === viewerId) continue;
      const record = this.#record(id);
      if (record === undefined || !record.visible) continue;
      const plate = record.components.get(NAMEPLATE);
      const bar = record.components.get(HEALTH_BAR);
      if (plate !== undefined && plate['shown'] !== true) continue;
      const health = record.components.get(HEALTH);
      const showHealth = health !== undefined && (plate === undefined ? bar !== undefined : plate['health'] === true);
      const ratio = health === undefined ? 1 : Math.max(0, Math.min(1, (health['current'] as number) / (health['max'] as number)));
      if (plate === undefined && bar !== undefined && (health === undefined || (bar['hide_when_full'] === true && ratio >= 1))) continue;
      const offset = (plate?.['offset'] ?? bar?.['offset']) as Vec3;
      const at = place(view, record.transform.worldPosition().__add__(offset));
      if (!at.onScreen) continue;
      if (plate !== undefined && at.distance > (plate['range'] as number)) continue;
      const side = this.#side(record);
      const relation = side === undefined || viewerSide === undefined ? 'neutral' : side === viewerSide ? 'ally' : 'enemy';
      const chosen = (plate?.['color'] as Color | null | undefined)
        ?? (relation === 'ally' ? bar?.['ally_color'] as Color | null : relation === 'enemy' ? bar?.['enemy_color'] as Color | null : null)
        ?? (bar?.['color'] as Color | null | undefined)
        ?? sides[relation];
      plates.push({
        x: pct(at.x), y: pct(at.y), text: plate === undefined ? '' : this.#text((plate['text'] as string | null) ?? this.#nameOf(record)),
        named: plate !== undefined, health: showHealth, fill: pct(ratio), color: css(chosen), low: ratio < 0.25, distance: at.distance,
        ...barLook(bar),
      });
    }
    plates.sort((p, q) => q.distance - p.distance);
    return { shown: plates.length > 0, plates: plates.map(({ distance: _d, ...p }) => p), a11y: this.#a11yState(a) };
  }

  /** The entity a seat plays, whatever it carries (for "don't label yourself"). */
  #seatEntity(seat: number): EntityId | null {
    for (const component of [HURT_FEEDBACK, CROSSHAIR, MINIMAP, STAT_BARS, COMPASS]) {
      const id = this.viewer(seat, component);
      if (id !== null) return id;
    }
    return null;
  }

  markers(seat: number): MarkersModel {
    const a = this.#a11y();
    const view = this.#views().get(seat);
    if (view === undefined) return { shown: false, markers: [], a11y: this.#a11yState(a) };
    const out: MarkerModel[] = [];
    const add = (point: Vec3, icon: string, glyph: string, label: string, color: Color, ping: boolean): void => {
      const at = place(view, point);
      out.push({
        x: pct(at.x), y: pct(at.y), on_screen: at.onScreen, turn: `rotate(${Math.round(at.angle)}deg)`, icon, glyph, label,
        distance: formatDistance(at.distance, this.#options.units), color: css(color), ping,
      });
    };
    for (const id of this.#ids(MARKER)) {
      const record = this.#record(id);
      const m = record?.components.get(MARKER);
      if (record === undefined || m === undefined || m['shown'] !== true) continue;
      const icon = m['icon'] as string;
      add(record.transform.worldPosition().__add__(new Vec3(0, this.dimension === '3d' ? 1.5 : 0.5, 0)), icon, ICON_GLYPHS[icon] ?? '◆',
        this.#text((m['label'] as string | null) ?? ''), m['color'] as Color, false);
    }
    const now = this.kernel.time.realNow;
    this.#pings = this.#pings.filter((p) => p.until > now && (typeof p.at !== 'number' || this.kernel.world.isAlive(p.at)));
    for (const ping of this.#pings) {
      if (ping.seat !== null && ping.seat !== seat) continue;
      const at = this.#anchor(ping.at, typeof ping.at === 'number' ? new Vec3(0, this.dimension === '3d' ? 1.5 : 0.5, 0) : undefined);
      if (at === undefined) continue;
      const style = PING_STYLE[ping.kind];
      add(at, `ping_${ping.kind}`, style.glyph, this.#text(ping.label), style.color, true);
    }
    return { shown: out.length > 0, markers: out, a11y: this.#a11yState(a) };
  }

  awareness(seat: number): AwarenessModel {
    const a = this.#a11y();
    const view = this.#views().get(seat);
    const meters: AwarenessModel['meters'][number][] = [];
    if (view !== undefined) {
      for (const id of this.#ids(AWARENESS)) {
        const record = this.#record(id);
        const f = record?.components.get(AWARENESS);
        if (record === undefined || f === undefined || f['shown'] !== true || (f['level'] as number) <= 0) continue;
        const at = place(view, record.transform.worldPosition().__add__(f['offset'] as Vec3));
        meters.push({
          x: pct(at.x), y: pct(at.y), fill: pct(f['level'] as number), alerted: (f['level'] as number) >= 1, on_screen: at.onScreen,
          turn: `rotate(${Math.round(at.angle)}deg)`,
        });
      }
    }
    const hits: AwarenessModel['hits'][number][] = [];
    const sounds: AwarenessModel['sounds'][number][] = [];
    const feedback = this.#feedback.get(seat);
    const now = this.kernel.time.realNow;
    const viewer = this.viewer(seat, HURT_FEEDBACK);
    const record = viewer === null ? undefined : this.#record(viewer);
    if (record !== undefined) {
      const heading = view !== undefined && view.dimension === '3d' ? viewHeading(view) : this.dimension === '3d' ? headingOf('3d', record) : 0;
      const [vu, vv] = planeOf(this.dimension, record.transform.worldPosition());
      const turn = (at: Vec3): string => {
        const [u, v] = planeOf(this.dimension, at);
        return `rotate(${Math.round((Math.atan2(u - vu, v - vv) * 180) / Math.PI - heading)}deg)`;
      };
      if (feedback !== undefined) {
        feedback.arcs = feedback.arcs.filter((arc) => now - arc.start < ARC_SECONDS);
        for (const arc of feedback.arcs) hits.push({ turn: turn(arc.from), opacity: Math.round((1 - (now - arc.start) / ARC_SECONDS) * 100) / 100 });
      }
      const perception = record.components.get(HURT_FEEDBACK)?.['noise_cues'] === true ? this.kernel.tryService(PERCEPTION_SERVICE) : undefined;
      if (perception !== undefined) {
        const here = record.transform.worldPosition();
        for (const noise of perception.recentNoises()) {
          if (noise.source === viewer) continue;
          const d = here.distance_to(noise.at);
          if (!(d < noise.loudness) || d < 1e-6) continue;
          sounds.push({ turn: turn(noise.at), opacity: Math.round((1 - d / noise.loudness) * 100) / 100, kind: noise.kind ?? '' });
        }
      }
    }
    const shown = meters.length > 0 || hits.length > 0 || sounds.length > 0;
    return { shown, meters, hits, sounds, a11y: this.#a11yState(a) };
  }

  // ── Viewer bars: stats, abilities, combo, key hints, screen ─────────────────

  #path(record: EntityRecord, path: string, where: string): number {
    const dot = path.indexOf('.');
    const component = dot < 0 ? '' : path.slice(0, dot);
    const field = path.slice(dot + 1);
    const fields = record.components.get(component);
    if (dot < 0 || fields === undefined) {
      fail('PP3552', `${where} reads "${path}", but ${this.#nameOf(record)} has no "${component || path}" component`, {
        fix: 'Write "<component>.<field>" naming a component on the same entity ("health.current").',
      });
    }
    if (!(field in fields)) fail('PP3552', `${where} reads "${path}", but "${component}" has no field "${field}"`);
    return finiteNumber(fields[field], `${where} "${path}"`);
  }

  stats(seat: number): StatsModel {
    const a = this.#a11y();
    const id = this.viewer(seat, STAT_BARS);
    const record = id === null ? undefined : this.#record(id);
    if (record === undefined) return { shown: false, bars: [], a11y: this.#a11yState(a) };
    const bars: StatBarModel[] = (record.components.get(STAT_BARS)!['bars'] as Fields[]).map((bar, i) => {
      const where = `StatBars.bars[${i}]`;
      const value = this.#path(record, bar['value'] as string, where);
      const max = bar['max'] === null ? 1 : this.#path(record, bar['max'] as string, where);
      const ratio = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
      return {
        label: this.#text(bar['label'] as string), text: bar['max'] === null ? `${Math.round(ratio * 100)}%` : `${Math.ceil(value)} / ${Math.round(max)}`,
        fill: pct(ratio), color: css(bar['color'] as Color), low: ratio < (bar['low'] as number), numbers: bar['numbers'] === true,
      };
    });
    return { shown: bars.length > 0, bars, a11y: this.#a11yState(a) };
  }

  abilities(seat: number): AbilitiesModel {
    const a = this.#a11y();
    const id = this.viewer(seat, ABILITIES);
    const fields = id === null ? undefined : this.#record(id)?.components.get(ABILITIES);
    if (fields === undefined) return { shown: false, slots: [], a11y: this.#a11yState(a) };
    const charges = fields['charges'] as Record<string, number>;
    const left = fields['left'] as Record<string, number>;
    const slots = (fields['slots'] as Fields[]).map((slot) => {
      const name = slot['id'] as string;
      const max = slot['charges'] as number;
      const have = charges[name] ?? max;
      const remaining = left[name] ?? 0;
      const cooldown = slot['cooldown'] as number;
      return {
        id: name, label: this.#text(slot['label'] as string), icon: slot['icon'] as string, image: slot['image'] as string | null,
        action: slot['action'] as string | null,
        ready: have > 0, charges: have, max_charges: max, show_charges: max > 1,
        fill: have > 0 || cooldown <= 0 ? '0%' : pct(remaining / cooldown),
        seconds: have > 0 || remaining <= 0 ? '' : remaining >= 10 ? String(Math.ceil(remaining)) : remaining.toFixed(1),
      };
    });
    return { shown: slots.length > 0, slots, a11y: this.#a11yState(a) };
  }

  combo(seat: number): ComboModel {
    const a = this.#a11y();
    const id = this.viewer(seat, COMBO);
    const fields = id === null ? undefined : this.#record(id)?.components.get(COMBO);
    if (fields === undefined) return { shown: false, count: 0, best: 0, fill: '0%', a11y: this.#a11yState(a) };
    const count = fields['count'] as number;
    return {
      shown: count >= 2, count, best: fields['best'] as number, fill: pct((fields['left'] as number) / (fields['window'] as number)),
      a11y: this.#a11yState(a),
    };
  }

  keyHints(seat: number): KeyHintsModel {
    const a = this.#a11y();
    const id = this.viewer(seat, KEY_HINTS);
    const fields = id === null ? undefined : this.#record(id)?.components.get(KEY_HINTS);
    if (fields === undefined || fields['shown'] !== true) return { shown: false, actions: [], a11y: this.#a11yState(a) };
    const actions = [...(fields['actions'] as string[])];
    return { shown: actions.length > 0, actions, a11y: this.#a11yState(a) };
  }

  screen(seat: number): ScreenModel {
    const a = this.#a11y();
    const now = this.kernel.time.realNow;
    const feedback = this.#feedback.get(seat);
    let flash = 0;
    let flashColor = Color.hex('#d01818');
    if (feedback !== undefined) {
      feedback.flashes = feedback.flashes.filter((f) => now - f.start < f.seconds);
      for (const f of feedback.flashes) {
        const k = 1 - easing(f.ease)((now - f.start) / f.seconds);
        const value = Math.min(1, Math.max(0, f.strength * k * (a.reducedMotion ? 0.35 : 1)));
        if (value > flash) { flash = value; flashColor = f.color; }
      }
    }
    let vignette = 0;
    let vignetteColor = Color.hex('#d01818');
    const id = this.viewer(seat, HURT_FEEDBACK);
    const record = id === null ? undefined : this.#record(id);
    const hurt = record?.components.get(HURT_FEEDBACK);
    const health = record?.components.get(HEALTH);
    if (hurt !== undefined && health !== undefined) {
      const low = hurt['low_health'] as number;
      const ratio = (health['current'] as number) / (health['max'] as number);
      if (low > 0 && ratio < low && (health['current'] as number) > 0) {
        const strength = 0.25 + 0.5 * (1 - ratio / low);
        vignette = a.reducedMotion ? strength : strength * (0.8 + 0.2 * Math.sin(now * 6));
        vignetteColor = hurt['color'] as Color;
      }
    }
    return {
      shown: flash > 0.005 || vignette > 0.005, flash: Math.round(flash * 1000) / 1000, flash_color: css(flashColor),
      vignette: Math.round(vignette * 1000) / 1000, vignette_color: css(vignetteColor), a11y: this.#a11yState(a),
    };
  }

  // ── Feedback requests ───────────────────────────────────────────────────────

  /** Net games, on the authority: hand every piece of seat feedback to `listener` too (null: stop). */
  forwardTo(listener: ((item: Json) => void) | null): void {
    this.#forward = listener;
  }

  /** Net games, on a client: show feedback the authority forwarded (`entity` maps its ids to ours; null: not here). */
  replay(item: Json, entity: (id: number) => EntityId | null): void {
    const o = item as JsonObject;
    const seat = o['seat'] as number | null;
    const v3 = (j: Json | undefined): Vec3 => {
      const a = j as number[];
      return new Vec3(a[0]!, a[1]!, a[2]!);
    };
    const rgba = (j: Json | undefined): Color => {
      const a = j as number[];
      return new Color(a[0]!, a[1]!, a[2]!, a[3]!);
    };
    switch (o['kind']) {
      case 'ping': {
        const at = typeof o['entity'] === 'number' ? entity(o['entity']) : v3(o['at']);
        if (at === null) return;
        this.#addPing(at, o['ping'] as PingKind, o['seconds'] as number, o['label'] as string, seat);
        return;
      }
      case 'hit':
        for (const s of seat === null ? this.#options.seats(this.kernel) : [seat]) this.#addHit(s, o['kill'] === true);
        return;
      case 'flash':
        for (const s of seat === null ? this.#options.seats(this.kernel) : [seat]) {
          this.#addFlash(s, rgba(o['color']), o['strength'] as number, o['seconds'] as number, true, typeof o['ease'] === 'string' ? o['ease'] : FLASH_EASE);
        }
        return;
      case 'arc': this.#addArc(seat!, v3(o['from'])); return;
      case 'shake': this.#shake(seat!, o['intensity'] as number); return;
      default: fail('PP9355', `The server forwarded an unknown HUD feedback kind ${JSON.stringify(o['kind'])}`);
    }
  }

  #send(item: JsonObject): void {
    this.#forward?.(item);
  }

  #addPing(at: Vec3 | EntityId, kind: PingKind, seconds: number, label: string, seat: number | null): void {
    const now = this.kernel.time.realNow;
    this.#pings.push({ at, kind, start: now, until: now + seconds, seat, label });
    this.#send({
      kind: 'ping', ...(at instanceof Vec3 ? { at: [at.x, at.y, at.z] } : { entity: at }), ping: kind, seconds, label, seat,
    });
  }

  #addHit(seat: number, kill: boolean, send = true): void {
    const now = this.kernel.time.realNow;
    const f = this.#feedbackOf(seat);
    f.hitAt = now;
    if (kill) f.killAt = now;
    if (send) this.#send({ kind: 'hit', seat, kill });
  }

  #addFlash(seat: number, color: Color, strength: number, seconds: number, send = true, ease = FLASH_EASE): void {
    this.#feedbackOf(seat).flashes.push({ color, strength, start: this.kernel.time.realNow, seconds, ease });
    if (send) this.#send({ kind: 'flash', seat, color: [color.r, color.g, color.b, color.a], strength, seconds, ...(ease !== FLASH_EASE && { ease }) });
  }

  /** Seats feedback is computed for: this machine's, and on a forwarding authority every player's. */
  #feedbackSeats(): readonly number[] {
    if (this.#forward === null) return this.#options.seats(this.kernel);
    return this.kernel.tryService(PLAYERS_SERVICE)?.seats().map((s) => s.index) ?? this.#options.seats(this.kernel);
  }

  #addArc(seat: number, from: Vec3): void {
    this.#feedbackOf(seat).arcs.push({ from, start: this.kernel.time.realNow });
    this.#send({ kind: 'arc', seat, from: [from.x, from.y, from.z] });
  }

  /** `ctx.hud.ping(at, kind=, seconds=, label=, to=)`. */
  ping(at: Vec3 | EntityId, kind: PingKind, seconds: number, label: string, seat: number | null): void {
    this.#addPing(at, kind, seconds, label, seat);
  }

  /** `ctx.hud.hit_marker(kill=, to=)`. */
  hitMarker(kill: boolean, seat: number | null): void {
    if (seat !== null) return this.#addHit(seat, kill);
    // Everyone: this machine's seats now, and one forwarded request each client applies to its own.
    for (const s of this.#options.seats(this.kernel)) this.#addHit(s, kill, false);
    this.#send({ kind: 'hit', seat: null, kill });
  }

  /** `ctx.hud.screen_flash(color, strength=, seconds=, ease=, to=)`. */
  screenFlash(color: Color, strength: number, seconds: number, seat: number | null, ease = FLASH_EASE): void {
    easing(ease);
    if (seat !== null) return this.#addFlash(seat, color, strength, seconds, true, ease);
    for (const s of this.#options.seats(this.kernel)) this.#addFlash(s, color, strength, seconds, false, ease);
    this.#send({ kind: 'flash', seat: null, color: [color.r, color.g, color.b, color.a], strength, seconds, ...(ease !== FLASH_EASE && { ease }) });
  }

  /** combat's Damaged: hurt feedback for the hit seat(s), hit markers and combo for the attacker's. */
  damaged(payload: Fields): void {
    const kernel = this.kernel;
    const target = kernel.handles.unwrap(payload['entity']);
    const source = payload['source'] === null || payload['source'] === undefined ? undefined : kernel.handles.unwrap(payload['source']);
    const amount = payload['amount'] as number;
    if (target === undefined || !(amount > 0)) return;
    const record = this.#record(target);
    const hurt = record?.components.get(HURT_FEEDBACK);
    if (record !== undefined && hurt !== undefined) {
      const health = record.components.get(HEALTH);
      const max = health === undefined ? 100 : (health['max'] as number);
      const strength = Math.min(1, (amount / max) * 4);
      const a = this.#a11y();
      for (const seat of this.#seatsViewing(target, HURT_FEEDBACK)) {
        const flash = hurt['flash'] as number;
        if (flash > 0) this.#addFlash(seat, hurt['color'] as Color, flash * strength, FLASH_SECONDS);
        if (hurt['direction'] === true) {
          const from = source !== undefined ? this.#record(source)?.transform.worldPosition() : (payload['point'] as Vec3 | null) ?? undefined;
          if (from !== undefined) this.#addArc(seat, from);
        }
        const shake = hurt['shake'] as number;
        if (shake > 0 && !a.reducedMotion) this.#shake(seat, shake * (0.4 + 0.6 * strength));
      }
      const stop = hurt['hitstop'] as number;
      if (stop > 0) this.#options.hitstop(kernel, stop);
    }
    if (source !== undefined) {
      const attacker = this.#record(source);
      const cross = attacker?.components.get(CROSSHAIR);
      if (cross !== undefined && cross['hit_markers'] === true) {
        for (const seat of this.#seatsViewing(source, CROSSHAIR)) this.#addHit(seat, false);
      }
      const combo = attacker?.components.get(COMBO);
      if (combo !== undefined && combo['from_damage'] === true) comboHit(combo, 1);
    }
  }

  /** combat's Died: a kill marker for the killer's (`source`'s) seat(s). */
  died(payload: Fields): void {
    const killer = payload['source'] === null || payload['source'] === undefined ? undefined : this.kernel.handles.unwrap(payload['source']);
    if (killer === undefined) return;
    const cross = this.#record(killer)?.components.get(CROSSHAIR);
    if (cross === undefined || cross['hit_markers'] !== true) return;
    for (const seat of this.#seatsViewing(killer, CROSSHAIR)) this.#addHit(seat, true);
  }

  #shake(seat: number, intensity: number): void {
    this.#send({ kind: 'shake', seat, intensity });
    const view = this.#views().get(seat);
    if (view === undefined) return;
    const camera = this.#record(view.entity as EntityId)?.components.get(CAMERA) as { shake?: (...a: unknown[]) => void } | undefined;
    camera?.shake?.(intensity, 0.25);
  }

  // ── Slow motion ─────────────────────────────────────────────────────────────

  /** `ctx.hud.slow_motion(scale, seconds, ease_in=, ease_out=)`: eases time.scale down, holds, eases back. */
  slowMotion(scale: number, seconds: number, easeIn: number, easeOut: number): Handle {
    if (!(scale >= 0 && scale <= 1)) fail('PP3553', `slow_motion() scale must be 0..1, got ${scale}`, { fix: 'Use time.scale directly to speed time up.' });
    if (!(seconds > 0)) fail('PP3553', `slow_motion() needs seconds > 0, got ${seconds}`);
    if (!(easeIn >= 0 && easeOut >= 0) || easeIn + easeOut > seconds + 1e-9) {
      fail('PP3553', `slow_motion() eases (${easeIn} + ${easeOut} s) must fit in its ${seconds} s`, { fix: 'Shorten ease_in/ease_out or lengthen seconds.' });
    }
    const base = this.#slow?.base ?? this.kernel.time.scale;
    this.#slow?.handle.cancel();
    const engine = this;
    let active = true;
    const handle: Handle = {
      cancel(): void {
        if (!active) return;
        active = false;
        if (engine.#slow?.handle === handle) {
          engine.kernel.time.scale = engine.#slow.base;
          engine.#slow = null;
        }
      },
      get active() { return active; },
    };
    this.#slow = { scale, seconds, easeIn, easeOut, base, start: this.kernel.time.realNow, handle };
    this.#applySlow();
    return handle;
  }

  /** Kernel 'input' hook: time.scale follows the slow-motion profile (it takes effect from the next frame's dt). */
  #applySlow(): void {
    const slow = this.#slow;
    if (slow === null) return;
    const t = this.kernel.time.realNow - slow.start;
    if (t >= slow.seconds) {
      this.kernel.time.scale = slow.base;
      this.#slow = null;
      slow.handle.cancel();
      return;
    }
    let k = 1;
    if (slow.easeIn > 0 && t < slow.easeIn) k = ramp(t / slow.easeIn);
    else if (slow.easeOut > 0 && t > slow.seconds - slow.easeOut) k = ramp((slow.seconds - t) / slow.easeOut);
    this.kernel.time.scale = slow.base * (1 + (slow.scale - 1) * k);
  }

  inputHook(): void {
    this.#applySlow();
  }

  // ── Gameplay ticks (game time) ──────────────────────────────────────────────

  tick(dt: number): void {
    for (const id of this.#ids(ABILITIES)) {
      const fields = this.#record(id)?.components.get(ABILITIES);
      if (fields !== undefined) abilitiesTick(fields, dt);
    }
    for (const id of this.#ids(COMBO)) {
      const fields = this.#record(id)?.components.get(COMBO);
      if (fields === undefined || (fields['count'] as number) === 0) continue;
      const left = Math.max(0, (fields['left'] as number) - dt);
      fields['left'] = left;
      if (left === 0) fields['count'] = 0;
    }
  }

  // ── Snapshots ───────────────────────────────────────────────────────────────

  /**
   * A slow motion under way is gameplay (it sets time.scale), so it is saved; hit markers,
   * flashes, arcs and pings are presentation and, like toasts, are dropped by a restore.
   */
  snapshot(): HudSnapshot {
    const slow = this.#slow;
    return {
      slow: slow === null ? null : {
        scale: slow.scale, seconds: slow.seconds, ease_in: slow.easeIn, ease_out: slow.easeOut, base: slow.base,
        elapsed: this.kernel.time.realNow - slow.start,
      },
    };
  }

  restore(saved: HudSnapshot): void {
    this.#slow?.handle.cancel();
    this.#slow = null;
    this.#pings = [];
    this.#feedback.clear();
    this.#baseDirty = true;
    if (saved.slow !== null) {
      const s = saved.slow;
      const handle = this.slowMotion(s.scale, s.seconds, s.ease_in, s.ease_out);
      // The kernel restored time.scale mid-ramp: keep the saved base and timing, not the restored scale.
      this.#slow = { scale: s.scale, seconds: s.seconds, easeIn: s.ease_in, easeOut: s.ease_out, base: s.base, start: this.kernel.time.realNow - s.elapsed, handle };
      this.#applySlow();
    }
  }
}

// ── Component methods' logic (fields-level, shared by the methods and the engine) ──

function slotOf(fields: Fields, slot: unknown, where: string): Fields {
  const found = (fields['slots'] as Fields[]).find((s) => s['id'] === slot);
  if (found === undefined) {
    const known = (fields['slots'] as Fields[]).map((s) => String(s['id']));
    fail('PP3554', `Abilities.${where}(): no slot ${JSON.stringify(slot)}`, { fix: `Slots: ${known.join(', ') || '(none)'}.` });
  }
  return found;
}

/** Charges ready now for a slot (full until first used). */
export function abilityCharges(fields: Fields, slot: unknown, where = 'charges'): number {
  const s = slotOf(fields, slot, where);
  return (fields['charges'] as Record<string, number>)[s['id'] as string] ?? (s['charges'] as number);
}

/** Spend a charge and start the cooldown; false when none is ready. */
export function abilityUse(fields: Fields, slot: unknown): boolean {
  const s = slotOf(fields, slot, 'use');
  const id = s['id'] as string;
  const have = abilityCharges(fields, id, 'use');
  if (have <= 0) return false;
  const charges = { ...(fields['charges'] as Record<string, number>), [id]: have - 1 };
  const left = { ...(fields['left'] as Record<string, number>) };
  if ((left[id] ?? 0) <= 0) left[id] = s['cooldown'] as number;
  fields['charges'] = charges;
  fields['left'] = left;
  if ((s['cooldown'] as number) <= 0) abilitiesTick(fields, 0);
  return true;
}

export function abilityRemaining(fields: Fields, slot: unknown): number {
  const s = slotOf(fields, slot, 'remaining');
  const id = s['id'] as string;
  return abilityCharges(fields, id, 'remaining') > 0 ? 0 : (fields['left'] as Record<string, number>)[id] ?? 0;
}

export function abilityRefill(fields: Fields, slot: unknown): void {
  const ids = slot === null || slot === undefined ? (fields['slots'] as Fields[]).map((s) => s['id'] as string) : [slotOf(fields, slot, 'refill')['id'] as string];
  const charges = { ...(fields['charges'] as Record<string, number>) };
  const left = { ...(fields['left'] as Record<string, number>) };
  for (const id of ids) {
    delete charges[id];
    delete left[id];
  }
  fields['charges'] = charges;
  fields['left'] = left;
}

/** Cooldowns run down; each that finishes returns one charge and starts the next if still short. */
export function abilitiesTick(fields: Fields, dt: number): void {
  const left = fields['left'] as Record<string, number>;
  if (Object.keys(left).length === 0) return;
  const charges = { ...(fields['charges'] as Record<string, number>) };
  const next = { ...left };
  for (const slot of fields['slots'] as Fields[]) {
    const id = slot['id'] as string;
    if (!(id in next)) continue;
    const max = slot['charges'] as number;
    const cooldown = slot['cooldown'] as number;
    let t = next[id]! - dt;
    let have = charges[id] ?? max;
    if (cooldown <= 0) {
      have = max;
    } else {
      while (t <= 0 && have < max) {
        have += 1;
        t = have < max ? t + cooldown : 0;
      }
    }
    if (have >= max) {
      delete charges[id];
      delete next[id];
    } else {
      charges[id] = have;
      next[id] = t;
    }
  }
  fields['charges'] = charges;
  fields['left'] = next;
}

export function comboHit(fields: Fields, n: number): void {
  const count = (fields['count'] as number) + n;
  fields['count'] = count;
  fields['left'] = fields['window'];
  if (count > (fields['best'] as number)) fields['best'] = count;
}

export function comboDrop(fields: Fields): void {
  fields['count'] = 0;
  fields['left'] = 0;
}

/** A HealthBar's own look (width, height, track, border) as the nameplates panel binds it. */
function barLook(bar: Fields | undefined): Pick<PlateModel, 'bar_width' | 'bar_height' | 'bar_background' | 'bar_border'> {
  const px = (v: unknown): string | null => (typeof v === 'number' ? `${v}px` : null);
  const color = (v: unknown): string | null => (v instanceof Color ? css(v) : null);
  return {
    bar_width: px(bar?.['width']), bar_height: px(bar?.['height']),
    bar_background: color(bar?.['background']), bar_border: color(bar?.['border']),
  };
}
