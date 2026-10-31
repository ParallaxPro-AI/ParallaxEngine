/**
 * Cameras: the rigs, shake / kick / zoom, the resolved view
 * every renderer draws with, and `ctx.camera`.
 *
 * Every frame, after `late_update` (the kernel's 'ui' hook), each camera in spawn order:
 *   1. advances its zoom tween (writes `fov` or `size`);
 *   2. runs its rig, writing the camera entity's transform (the rig's pose, without
 *      shake or kick — those live only in the view);
 *   3. resolves its view: pose + shake + kick, the orthographic size after `fit` and
 *      multi-target framing, `min_visible` (a width × height kept in view: orthographic
 *      widens `size`, perspective widens `fov` at `focus_distance`, default the rig's
 *      focus), the viewport in pixels and whether it is active.
 *
 * Rigs:
 *   fixed         stays where its transform is. With `fit` (2D), the view centers on and
 *                 frames the rectangle.
 *   follow        trails the focus — the follow target, or the `follow_weights`-weighted
 *                 centroid of several — at `offset` (in the first target's yaw frame, or
 *                 world axes with `world_offset`). `bounds` clamps the focus ((x, y) in
 *                 2D, ground (x, z) in 3D). `smoothing` is the time constant in seconds of
 *                 an exponential follow (frame-rate independent; 0 = locked). 3D: the
 *                 camera looks at the focus, or along the heading to it at a fixed `pitch`
 *                 when `pitch` is set. 2D: only x and y follow; z and rotation stay.
 *                 `look_ahead` leads the focus that many meters in the direction the
 *                 first target last moved horizontally (x in 2D, the ground plane in
 *                 3D), easing to a new direction over `look_ahead_smoothing` seconds; it
 *                 holds while the target stands still. The lead is added before `bounds`.
 *                 Several targets: the view pulls back (perspective) or widens
 *                 (orthographic) until each is within `fit_margin` of the frame.
 *   orbit (3D)    around a pivot `offset.y` above the focus at the horizontal arm
 *                 (offset.x, offset.z), turned by the seat's look input; starts behind the
 *                 target at `pitch` (or level). `smoothing` applies to the pivot.
 *   first_person  at the target's eye when it is a Character (else its position), plus
 *                 `offset` (turned with the view's yaw),
 *   (3D)          yaw/pitch from look input; the target's yaw follows the view.
 * A rig that needs a target and has none (unset, destroyed, or "local_player" with no
 * entity for the seat) holds the camera where it is. Look pitch is clamped to
 * `pitch_limits` (degrees, positive looks up).
 *
 * Pitch convention: every camera pitch — the `pitch` and `pitch_limits` fields, look input,
 * `kick(pitch=)` and the rig state below — is positive looking UP. (A Transform's Euler x
 * is the opposite, positive tipping forward down; the rigs negate it when they build the
 * rotation.)
 */

import { Color, fail, Quat, Vec2, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import { componentEntity } from '../../kernel/index.js';
import type { Fields, Handle, Kernel } from '../../kernel/index.js';
import type { EntityRecord } from '../../kernel/index.js';
import { bind, bool, describe, finite, nonNegative, vec2, vec3 } from './args.js';
import { RENDER_TEXTURE } from './render_schemas.js';
import { CAMERA, CAMERA_RIGS, GRID } from './schemas.js';
import type { CameraRig } from './schemas.js';
import type { Json } from '../../../resource/index.js';
import { CHARACTERS_SERVICE, RENDER_POSE_SERVICE } from '../../services/index.js';
import type { Pose } from '../../services/index.js';
import {
  axes, FAR, fitSize, lookRotation, NEAR, pixelRect, relative, requireViewport, screenRay, screenToWorld, viewCenter,
  worldToScreen, yawOf,
} from './view.js';
import type { CameraView, Dimension, Screen } from './view.js';

/** Degrees per frame (x: yaw to the right, y: pitch up) of a seat's look input. */
export type LookSource = (seat: number, dt: number) => Vec2;

export interface CameraOptions {
  readonly dimension: Dimension;
  readonly screen: () => Screen;
  readonly look?: LookSource;
  readonly seatEntity?: (seat: number) => EntityId | null;
  readonly currentSeat?: () => number;
  readonly capture?: (view: CameraView) => unknown;
  readonly presentHandle?: (handle: Handle) => unknown;
}

interface Shake { readonly intensity: number; readonly seconds: number; left: number }
interface Kick { readonly pitch: number; readonly yaw: number; readonly recover: number; t: number }
interface Zoom {
  readonly field: 'fov' | 'size';
  readonly from: number;
  readonly to: number;
  readonly seconds: number;
  t: number;
  active: boolean;
}

interface CameraState {
  /** The rig the state below was set up for; a change re-aims. */
  rig: CameraRig | undefined;
  yaw: number;
  /** Degrees, positive looking up (the `pitch` field's convention). */
  pitch: number;
  /** Smoothed rig position (follow) and focus/pivot (follow, orbit); null = snap next frame. */
  position: Vec3 | null;
  focus: Vec3 | null;
  /** look_ahead: the eased lead, the last horizontal direction of travel, the target's last position. */
  lead: Vec3;
  heading: Vec3;
  last: Vec3 | null;
  shakes: Shake[];
  kicks: Kick[];
  zoom: Zoom | null;
  view: CameraView | undefined;
  /** This frame's shake, in world meters (part of `view.position`). */
  shake: Vec3;
}

interface SavedCamera {
  readonly id: number;
  readonly rig: string | null;
  readonly yaw: number;
  readonly pitch: number;
  readonly position: number[] | null;
  readonly focus: number[] | null;
  readonly lead?: number[];
  readonly heading?: number[];
  readonly last?: number[] | null;
  readonly shakes: Array<[number, number, number]>;
  readonly kicks: Array<[number, number, number, number]>;
  readonly zoom: [string, number, number, number, number] | null;
}

export interface SavedCameras {
  readonly cameras: SavedCamera[];
  /** seat → used camera id. */
  readonly used: Array<[number, number]>;
}

const xyz = (v: Vec3): number[] => [v.x, v.y, v.z];
const vec = (a: readonly number[]): Vec3 => new Vec3(a[0], a[1], a[2]);

/** Shake: a deterministic wobble of time (no random draws), two incommensurate sines per axis. */
function wobble(t: number): Vec2 {
  return new Vec2(
    Math.sin(t * 47.3) * 0.6 + Math.sin(t * 83.9 + 1.3) * 0.4,
    Math.sin(t * 53.1 + 2.1) * 0.6 + Math.sin(t * 91.7 + 0.4) * 0.4,
  );
}

function smoothstep(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

/** m/s of horizontal travel below which `look_ahead` keeps its last direction. */
const LOOK_AHEAD_MIN_SPEED = 0.5;

function approach(current: Vec3 | null, target: Vec3, alpha: number): Vec3 {
  return current === null || alpha >= 1 ? target : current.lerp(target, alpha);
}

type Fit = { readonly min: Vec2; readonly max: Vec2 } | 'grid' | null;

function corner(value: unknown): Vec2 | undefined {
  if (value instanceof Vec2) return value;
  if (Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
    return new Vec2(value[0] as number, value[1] as number);
  }
  return undefined;
}

/** `camera.fit`: None, "grid", or (min corner, max corner). */
export function readFit(value: unknown, where: string): Fit {
  if (value === null || value === undefined) return null;
  if (value === 'grid') return 'grid';
  if (Array.isArray(value) && value.length === 2) {
    const min = corner(value[0]);
    const max = corner(value[1]);
    if (min !== undefined && max !== undefined) return { min, max };
  }
  return fail('PP3711', `${where} must be (min corner, max corner) or "grid", got ${JSON.stringify(value) ?? describe(value)}`, {
    fix: 'Write [[min_x, min_y], [max_x, max_y]] in JSON, (vec2(...), vec2(...)) in code, or "grid".',
  });
}

function readLimits(value: unknown, where: string): [number, number] {
  if (Array.isArray(value) && value.length === 2 && value.every((n) => typeof n === 'number' && Number.isFinite(n))
    && (value[0] as number) <= (value[1] as number)) {
    return [value[0] as number, value[1] as number];
  }
  return fail('PP3712', `${where} must be (low, high) degrees with low ≤ high, got ${JSON.stringify(value) ?? describe(value)}`, {
    fix: 'Write e.g. [-80, 80] (positive looks up).',
  });
}

function readBounds(value: unknown, where: string): { min: Vec2; max: Vec2 } | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) && value.length === 2 && value[0] instanceof Vec2 && value[1] instanceof Vec2) {
    return { min: value[0], max: value[1] };
  }
  return fail('PP3711', `${where} must be (min corner, max corner), got ${describe(value)}`, {
    fix: 'Write [[min_x, min_y], [max_x, max_y]] in JSON or (vec2(...), vec2(...)) in code.',
  });
}

export class Cameras {
  readonly #kernelOf: () => Kernel;
  #kernel(): Kernel { return this.#kernelOf(); }
  readonly #options: CameraOptions;
  readonly #states = new Map<EntityId, CameraState>();
  /** seat → the camera `use()` made active. */
  readonly #used = new Map<number, EntityId>();

  constructor(kernel: () => Kernel, options: CameraOptions) {
    this.#kernelOf = kernel;
    this.#options = options;
  }

  get dimension(): Dimension {
    return this.#options.dimension;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /** New camera entities: check their data, set up state and resolve a first view (no smoothing). */
  added(records: readonly EntityRecord[]): void {
    const fresh = records.filter((r) => r.components.has(CAMERA) && !this.#states.has(r.id));
    for (const record of fresh) {
      this.#check(record);
      this.#states.set(record.id, this.#freshState());
    }
    if (fresh.length > 0) this.#resolveAll(0, false);
  }

  removed(records: readonly EntityRecord[]): void {
    for (const record of records) this.#states.delete(record.id);
  }

  changed(record: EntityRecord): void {
    if (!record.components.has(CAMERA)) { this.#states.delete(record.id); return; }
    if (!this.#states.has(record.id)) this.added([record]);
  }

  sceneLoading(): void {
    this.#used.clear();
    this.#states.clear();
  }

  #freshState(): CameraState {
    return { rig: undefined, yaw: 0, pitch: 0, position: null, focus: null, lead: Vec3.ZERO, heading: Vec3.ZERO, last: null, shakes: [], kicks: [], zoom: null, view: undefined, shake: Vec3.ZERO };
  }

  #check(record: EntityRecord): void {
    const fields = record.components.get(CAMERA)!;
    const where = this.#where(record);
    requireViewport(fields['viewport'], `${where}.viewport`);
    readLimits(fields['pitch_limits'], `${where}.pitch_limits`);
    readFit(fields['fit'], `${where}.fit`);
    readBounds(fields['bounds'], `${where}.bounds`);
    if (this.dimension === '2d' && fields['mode'] !== 'orthographic') {
      fail('PP3713', `${where}: 2D games draw through orthographic cameras, but this one is "${String(fields['mode'])}"`, {
        fix: 'Set "mode": "orthographic" (and "size", or "fit") on the camera.',
      });
    }
  }

  #where(record: EntityRecord): string {
    const name = record.placedId ?? record.prefab ?? `entity ${record.id}`;
    return `camera of "${name}"`;
  }

  // ── Frame ────────────────────────────────────────────────────────────────────

  /** Run every rig and resolve every view; `dt` is game time (0 while frozen). */
  frame(dt: number): void {
    this.#resolveAll(dt, true);
  }

  #cameraRecords(): EntityRecord[] {
    const out: EntityRecord[] = [];
    for (const record of this.#kernel().world.live()) if (record.components.has(CAMERA)) out.push(record);
    return out;
  }

  /**
   * `turn`: apply this frame's look input (once per frame; resolves between frames, after
   * a spawn, `use()` or a restore, re-run the rigs without it and without advancing time).
   */
  #resolveAll(dt: number, turn: boolean): void {
    const records = this.#cameraRecords();
    const screen = this.#options.screen();
    const active = this.#activeBySeat(records);
    for (const record of records) {
      let state = this.#states.get(record.id);
      if (state === undefined) {
        // Restored or re-added without an `added` notice: set up now.
        this.#check(record);
        state = this.#freshState();
        this.#states.set(record.id, state);
      }
      const fields = record.components.get(CAMERA)!;
      this.#advanceEffects(state, fields, dt);
      this.#runRig(record, fields, state, dt, turn);
      const servesSeat = [...active].find(([, id]) => id === record.id)?.[0];
      state.view = this.#resolveView(record, fields, state, screen, servesSeat);
    }
  }

  /**
   * seat → active camera: the one `use()` chose while it lives, else the seat's first camera.
   * A camera with a `render_texture` draws into a texture (a feed), never a seat's screen.
   */
  #activeBySeat(records: readonly EntityRecord[]): Map<number, EntityId> {
    const active = new Map<number, EntityId>();
    for (const record of records) {
      if (record.components.has(RENDER_TEXTURE)) continue;
      const seat = record.owner ?? 0;
      if (!active.has(seat)) active.set(seat, record.id);
    }
    for (const [seat, id] of this.#used) {
      if (this.#kernel().world.get(id)?.components.has(CAMERA) === true) active.set(seat, id);
      else this.#used.delete(seat);
    }
    return active;
  }

  #advanceEffects(state: CameraState, fields: Fields, dt: number): void {
    const zoom = state.zoom;
    if (zoom !== null) {
      zoom.t += dt;
      const done = zoom.t >= zoom.seconds;
      fields[zoom.field] = done ? zoom.to : zoom.from + (zoom.to - zoom.from) * smoothstep(zoom.t / zoom.seconds);
      if (done) { zoom.active = false; state.zoom = null; }
    }
    for (const shake of state.shakes) shake.left -= dt;
    state.shakes = state.shakes.filter((s) => s.left > 0);
    for (const kick of state.kicks) kick.t += dt;
    state.kicks = state.kicks.filter((k) => k.t < k.recover);
  }

  // ── Rigs ─────────────────────────────────────────────────────────────────────

  #targets(record: EntityRecord, fields: Fields): EntityId[] {
    const seat = record.owner ?? 0;
    const one = (value: unknown, where: string): EntityId | undefined => {
      if (value === null || value === undefined) return undefined;
      if (value === 'local_player') {
        const id = this.#options.seatEntity?.(seat) ?? null;
        return id === null || this.#kernel().world.get(id) === undefined ? undefined : id;
      }
      const id = this.#kernel().handles.unwrap(value);
      if (id === undefined) {
        fail('PP3714', `${where} must be an entity, a list of entities, "local_player" or None, got ${describe(value)}`);
      }
      return this.#kernel().world.get(id) === undefined ? undefined : id;
    };
    const where = `${this.#where(record)}.follow`;
    const follow = fields['follow'];
    if (Array.isArray(follow)) return follow.map((v, i) => one(v, `${where}[${i}]`)).filter((id): id is EntityId => id !== undefined);
    const id = one(follow, where);
    return id === undefined ? [] : [id];
  }

  /** Weighted focus of the follow targets (weights by position in `follow`). */
  #focus(record: EntityRecord, fields: Fields, targets: readonly EntityId[]): Vec3 {
    const follow = fields['follow'];
    const weights = fields['follow_weights'] as number[];
    const listed = Array.isArray(follow) ? follow.length : 1;
    if (weights.length > 0 && weights.length !== listed) {
      fail('PP3715', `${this.#where(record)}.follow_weights has ${weights.length} weights for ${listed} follow target${listed === 1 ? '' : 's'}`, {
        fix: 'Give one weight per target, or none for equal weights.',
      });
    }
    let sum = Vec3.ZERO;
    let total = 0;
    const ids = Array.isArray(follow) ? follow.map((v) => this.#kernel().handles.unwrap(v)) : [targets[0]];
    ids.forEach((id, i) => {
      if (id === undefined || !targets.includes(id)) return;
      const w = weights.length > 0 ? finite(weights[i], `${this.#where(record)}.follow_weights[${i}]`) : 1;
      sum = sum.__add__(this.#drawn(id).position.__mul__(w));
      total += w;
    });
    if (total <= 0) {
      fail('PP3715', `${this.#where(record)}.follow_weights of the live targets add up to ${total}`, { fix: 'Use positive weights.' });
    }
    return sum.__truediv__(total);
  }

  #clampFocus(focus: Vec3, bounds: { min: Vec2; max: Vec2 } | null): Vec3 {
    if (bounds === null) return focus;
    const clamp = (v: number, a: number, b: number): number => Math.max(Math.min(a, b), Math.min(Math.max(a, b), v));
    if (this.dimension === '2d') {
      return new Vec3(clamp(focus.x, bounds.min.x, bounds.max.x), clamp(focus.y, bounds.min.y, bounds.max.y), focus.z);
    }
    return new Vec3(clamp(focus.x, bounds.min.x, bounds.max.x), focus.y, clamp(focus.z, bounds.min.y, bounds.max.y));
  }

  #runRig(record: EntityRecord, fields: Fields, state: CameraState, dt: number, turn: boolean): void {
    const rig = fields['rig'] as CameraRig;
    if (!CAMERA_RIGS.includes(rig)) fail('PP3716', `${this.#where(record)}.rig is "${String(rig)}"`, { fix: `Use one of: ${CAMERA_RIGS.join(', ')}.` });
    if (this.dimension === '2d' && (rig === 'orbit' || rig === 'first_person')) {
      fail('PP3717', `${this.#where(record)}: the ${rig} rig turns a 3D camera; this game is 2D`, { fix: 'Use "fixed" or "follow".' });
    }
    const targets = rig === 'fixed' ? [] : this.#targets(record, fields);
    if (state.rig !== rig) {
      state.rig = rig;
      state.position = null;
      state.focus = null;
      state.lead = Vec3.ZERO;
      state.heading = Vec3.ZERO;
      state.last = null;
      state.yaw = yawOf(targets[0] === undefined ? record.transform.worldRotation() : this.#drawn(targets[0]).rotation);
      state.pitch = (fields['pitch'] as number | null) ?? 0;
    }
    if (rig === 'fixed' || targets.length === 0) return;
    const alpha = (smoothing: number): number => (smoothing > 0 ? 1 - Math.exp(-dt / smoothing) : 1);
    const smoothing = nonNegative(fields['smoothing'], `${this.#where(record)}.smoothing`);
    const where = this.#where(record);
    const offset = fields['offset'] as Vec3;
    const lead = this.#drawn(targets[0]!);
    let raw = this.#focus(record, fields, targets);
    if (rig === 'follow') raw = raw.__add__(this.#lookAhead(record, fields, state, lead.position, dt));
    const focus = this.#clampFocus(raw, readBounds(fields['bounds'], `${where}.bounds`));

    if (rig === 'follow') {
      if (this.dimension === '2d') {
        state.position = approach(state.position, new Vec3(focus.x + offset.x, focus.y + offset.y, 0), alpha(smoothing));
        const z = record.transform.worldPosition().z;
        record.transform.setWorldPosition(new Vec3(state.position.x, state.position.y, z));
        return;
      }
      let arm = fields['world_offset'] === true ? offset : Quat.from_euler(new Vec3(0, yawOf(lead.rotation), 0)).rotate(offset);
      if (targets.length > 1) arm = this.#framedArm(fields, targets, focus, arm);
      state.position = approach(state.position, focus.__add__(arm), alpha(smoothing));
      state.focus = approach(state.focus, focus, alpha(smoothing));
      record.transform.setWorldPosition(state.position);
      const toFocus = state.focus.__sub__(state.position);
      const pitch = fields['pitch'] as number | null;
      if (pitch === null) {
        if (toFocus.length_squared() > 1e-12) this.#setWorldRotation(record, lookRotation(toFocus));
      } else {
        const flat = toFocus.flat();
        if (flat.length_squared() > 1e-12) state.yaw = Math.atan2(flat.x, flat.z) * 180 / Math.PI;
        this.#setWorldRotation(record, Quat.from_euler(new Vec3(-pitch, state.yaw, 0)));
      }
      return;
    }

    // orbit / first_person: turned by look input.
    if (turn && !this.#kernel().time.frozen) {
      const look = this.#options.look?.(record.owner ?? 0, dt) ?? Vec2.ZERO;
      state.yaw += look.x;
      state.pitch += look.y;
    }
    const [low, high] = readLimits(fields['pitch_limits'], `${where}.pitch_limits`);
    state.pitch = Math.max(low, Math.min(high, state.pitch));
    // Euler x tips forward down: a camera pitched up is a negative Euler x.
    const view = Quat.from_euler(new Vec3(-state.pitch, state.yaw, 0));
    if (rig === 'orbit') {
      state.focus = approach(state.focus, focus.__add__(new Vec3(0, offset.y, 0)), alpha(smoothing));
      record.transform.setWorldPosition(state.focus.__add__(view.rotate(new Vec3(offset.x, 0, offset.z))));
      this.#setWorldRotation(record, view);
      return;
    }
    const yawOnly = Quat.from_euler(new Vec3(0, state.yaw, 0));
    // A Character target: the eye (eased across stances); `offset` is then relative to it.
    const eye = this.#kernel().tryService(CHARACTERS_SERVICE)?.view(targets[0]!)?.eye ?? Vec3.ZERO;
    record.transform.setWorldPosition(focus.__add__(eye).__add__(yawOnly.rotate(offset)));
    this.#setWorldRotation(record, view);
    // First person turns the body itself (its transform, not the drawn pose).
    this.#setWorldRotation(this.#kernel().world.require(targets[0]!), yawOnly);
  }

  /** The follow rig's `look_ahead` lead this frame (zero when unset). */
  #lookAhead(record: EntityRecord, fields: Fields, state: CameraState, at: Vec3, dt: number): Vec3 {
    const where = this.#where(record);
    const meters = nonNegative(fields['look_ahead'], `${where}.look_ahead`);
    const smoothing = nonNegative(fields['look_ahead_smoothing'], `${where}.look_ahead_smoothing`);
    if (state.last !== null && dt > 0) {
      const moved = at.__sub__(state.last);
      const flat = this.dimension === '2d' ? new Vec3(moved.x, 0, 0) : moved.flat();
      // Walking pace and up (0.5 m/s): a nudge or a settle doesn't swing the view.
      if (flat.length() > LOOK_AHEAD_MIN_SPEED * dt) state.heading = flat.normalized();
    }
    state.last = at;
    if (meters === 0) {
      state.lead = Vec3.ZERO;
      return Vec3.ZERO;
    }
    const alpha = smoothing > 0 ? 1 - Math.exp(-dt / smoothing) : 1;
    state.lead = state.position === null ? state.heading.__mul__(meters) : state.lead.lerp(state.heading.__mul__(meters), alpha);
    return state.lead;
  }

  /** A follow arm lengthened until every target fits the frame (perspective; orthographic widens instead). */
  #framedArm(fields: Fields, targets: readonly EntityId[], focus: Vec3, arm: Vec3): Vec3 {
    if (fields['mode'] !== 'perspective') return arm;
    const radius = this.#spread(targets, focus) + (fields['fit_margin'] as number);
    const aspect = this.#aspect(fields);
    const half = Math.atan(Math.tan((fields['fov'] as number) * Math.PI / 360) * Math.min(1, aspect));
    const needed = radius / Math.tan(half);
    const length = arm.length();
    if (length < 1e-9 || needed <= length) return arm;
    return arm.__mul__(needed / length);
  }

  /**
   * Where a followed entity is drawn this frame: its interpolated pose when physics moves it
   * (render_pose service), so the camera and its target stay in step; else its transform.
   */
  #drawn(id: EntityId): Pose {
    const kernel = this.#kernel();
    const pose = kernel.tryService(RENDER_POSE_SERVICE)?.world(id);
    if (pose !== undefined) return pose;
    const transform = kernel.world.require(id).transform;
    return { position: transform.worldPosition(), rotation: transform.worldRotation() };
  }

  #spread(targets: readonly EntityId[], focus: Vec3): number {
    let radius = 0;
    for (const id of targets) {
      const p = this.#drawn(id).position;
      const d = this.dimension === '2d' ? Math.hypot(p.x - focus.x, p.y - focus.y) : p.distance_to(focus);
      radius = Math.max(radius, d);
    }
    return radius;
  }

  #setWorldRotation(record: EntityRecord, world: Quat): void {
    const parent = record.transform.parent;
    record.transform.rotation = parent === null ? world : parent.worldRotation().inverse().__mul__(world);
  }

  #aspect(fields: Fields): number {
    const rect = pixelRect(fields['viewport'] as number[], this.#options.screen());
    return rect.width / rect.height;
  }

  // ── Views ────────────────────────────────────────────────────────────────────

  #gridRect(): { min: Vec2; max: Vec2 } | null {
    for (const record of this.#kernel().world.live()) {
      const grid = record.components.get(GRID);
      if (grid === undefined) continue;
      const cols = grid['cols'] as number;
      const rows = grid['rows'] as number;
      const cell = grid['cell_size'] as Vec2;
      const p = record.transform.worldPosition();
      const width = cols * cell.x;
      const height = rows * cell.y;
      if (grid['origin'] === 'center') {
        return { min: new Vec2(p.x - width / 2, p.y - height / 2), max: new Vec2(p.x + width / 2, p.y + height / 2) };
      }
      // "corner": the outer corner of cell (0, 0) — the top-left when row 0 is the top row.
      const bottom = grid['row_order'] === 'down' ? p.y - height : p.y;
      return { min: new Vec2(p.x, bottom), max: new Vec2(p.x + width, bottom + height) };
    }
    return null;
  }

  #resolveView(record: EntityRecord, fields: Fields, state: CameraState, screen: Screen, servesSeat: number | undefined): CameraView {
    const where = this.#where(record);
    const viewport = pixelRect(requireViewport(fields['viewport'], `${where}.viewport`), screen);
    const aspect = viewport.width / viewport.height;
    const mode = fields['mode'] as 'perspective' | 'orthographic';
    let position = record.transform.worldPosition();
    let rotation = record.transform.worldRotation();
    let size = fields['size'] as number;

    const fit = readFit(fields['fit'], `${where}.fit`);
    if (fit !== null) {
      if (this.dimension === '3d') {
        fail('PP3718', `${where}.fit frames a 2D board; in a 3D game place the camera instead`, {
          fix: 'Remove "fit"; to promise a visible area in 3D, set "min_visible": [width, height] (meters at "focus_distance").',
        });
      }
      const rect = fit === 'grid' ? this.#gridRect() : fit;
      if (rect !== null) {
        size = fitSize(rect.min, rect.max, fields['fit_margin'] as number, aspect);
        if (fields['rig'] === 'fixed') {
          position = new Vec3((rect.min.x + rect.max.x) / 2, (rect.min.y + rect.max.y) / 2, position.z);
        }
      }
    }
    if (fields['rig'] === 'follow' && mode === 'orthographic') {
      const targets = this.#targets(record, fields);
      if (targets.length > 1) {
        const radius = this.#spread(targets, state.position ?? position) + (fields['fit_margin'] as number);
        size = Math.max(size, radius, radius / aspect);
      }
    }

    let fov = fields['fov'] as number;
    const minVisible = fields['min_visible'];
    if (minVisible !== null && minVisible !== undefined) {
      const v = vec2(minVisible, `${where}.min_visible`);
      const w = Math.max(0, v.x);
      const h = Math.max(0, v.y);
      if (mode === 'orthographic') {
        size = Math.max(size, h / 2, w / 2 / aspect);
      } else {
        const d = this.#focusDistance(fields, state, position, where);
        // Widen the vertical fov until the half-extents fit at distance d (capped below 180°).
        const need = 2 * Math.atan(Math.max(h / 2, w / 2 / aspect) / d) * (180 / Math.PI);
        fov = Math.min(179, Math.max(fov, need));
      }
    }

    if (state.kicks.length > 0) {
      if (this.dimension === '2d') fail('PP3719', `${where}: kick() turns a 3D view`, { fix: 'Use shake() in 2D.' });
      let pitch = 0;
      let yaw = 0;
      for (const kick of state.kicks) {
        const left = (1 - kick.t / kick.recover) ** 2;
        pitch += kick.pitch * left;
        yaw += kick.yaw * left;
      }
      rotation = rotation.__mul__(Quat.from_euler(new Vec3(-pitch, yaw, 0)));
    }
    state.shake = Vec3.ZERO;
    if (state.shakes.length > 0) {
      const amplitude = Math.max(...state.shakes.map((s) => s.intensity * (s.left / s.seconds)));
      const w = wobble(this.#kernel().time.now).__mul__(amplitude);
      const a = axes({ rotation, dimension: this.dimension });
      state.shake = a.right.__mul__(w.x).__add__(a.up.__mul__(w.y));
      position = position.__add__(state.shake);
    }

    const background = fields['background'];
    return {
      entity: record.id,
      seat: servesSeat ?? record.owner ?? 0,
      active: servesSeat !== undefined,
      dimension: this.dimension,
      mode,
      position,
      rotation,
      fov,
      size,
      near: NEAR,
      far: FAR,
      viewport,
      aspect,
      background: background instanceof Color ? background : null,
    };
  }

  /** `focus_distance`, else the distance to the rig's focus (follow, orbit). */
  #focusDistance(fields: Fields, state: CameraState, position: Vec3, where: string): number {
    const given = fields['focus_distance'];
    if (typeof given === 'number') {
      if (!(given > 0)) fail('PP3726', `${where}.focus_distance is ${given}; it must be above 0`, { fix: 'Give the distance in meters from the camera to what must stay in view.' });
      return given;
    }
    const focus = state.focus;
    const d = focus === null ? 0 : Math.hypot(focus.x - position.x, focus.y - position.y, focus.z - position.z);
    if (!(d > 1e-6)) {
      fail('PP3726', `${where}.min_visible needs a distance to measure at: the camera has no follow focus`, {
        fix: 'Set "focus_distance" (meters from the camera to the play area), or follow a target.',
      });
    }
    return d;
  }

  // ── Game-facing ──────────────────────────────────────────────────────────────

  view(id: EntityId): CameraView {
    const view = this.#states.get(id)?.view;
    if (view === undefined) fail('PP9700', `Camera ${id} has no resolved view`);
    return view;
  }

  /** A camera's shake this frame in world meters (zero at rest). */
  shakeOffset(id: EntityId): Vec3 {
    return this.#states.get(id)?.shake ?? Vec3.ZERO;
  }

  /** The active camera entity of a seat, or null when the seat has no camera. */
  activeEntity(seat: number): EntityId | null {
    return this.#activeBySeat(this.#cameraRecords()).get(seat) ?? null;
  }

  /** Every seat's active camera with its resolved pose, by seat. */
  live(): { seat: number; entity: EntityId; position: Vec3; rotation: Quat }[] {
    const out: { seat: number; entity: EntityId; position: Vec3; rotation: Quat }[] = [];
    for (const [seat, entity] of [...this.#activeBySeat(this.#cameraRecords())].sort((a, b) => a[0] - b[0])) {
      const view = this.#states.get(entity)?.view;
      const t = this.#kernel().world.require(entity).transform;
      out.push({ seat, entity, position: view?.position ?? t.worldPosition(), rotation: view?.rotation ?? t.worldRotation() });
    }
    return out;
  }

  /** The active view of a seat, or null when the seat has no camera. */
  activeView(seat: number): CameraView | null {
    const id = this.#activeBySeat(this.#cameraRecords()).get(seat);
    return id === undefined ? null : this.#states.get(id)?.view ?? null;
  }

  /** The active camera's entity for a seat (default: the reading behavior's seat). */
  main(seat = this.#options.currentSeat?.() ?? 0): EntityId {
    const active = this.#activeBySeat(this.#cameraRecords());
    const id = active.get(seat);
    if (id === undefined) {
      fail('PP3720', seat === 0 ? 'There is no camera in this scene' : `Seat ${seat} has no camera`, {
        fix: 'Place an entity with a "camera" component in the scene (or give the seat a camera prefab).',
      });
    }
    return id;
  }

  use(id: EntityId): void {
    const record = this.#kernel().world.require(id);
    if (!record.components.has(CAMERA)) {
      fail('PP3721', 'camera.use() takes an entity with a Camera', { fix: 'Pass the camera entity (camera.entity).' });
    }
    this.#used.set(this.#options.currentSeat?.() ?? 0, id);
    this.#resolveAll(0, false);
  }

  methods(): object {
    const cameras = this;
    const own = (fields: Fields): EntityId => componentEntity(fields);
    const stateOf = (fields: Fields): CameraState => {
      const state = cameras.#states.get(own(fields));
      if (state === undefined) fail('PP3722', 'This camera is not in the world', { fix: 'Use cameras of live entities.' });
      return state;
    };
    return {
      /** The resolved view (renderers; see view.ts). */
      get __view__(): CameraView {
        return cameras.view(own(this as unknown as Fields));
      },
      shake(this: Fields, ...args: unknown[]): void {
        const a = bind('shake', args, ['intensity', 'seconds']);
        const intensity = nonNegative(a['intensity'] ?? 0.3, 'shake intensity');
        const seconds = nonNegative(a['seconds'] ?? 0.25, 'shake seconds');
        if (seconds > 0 && intensity > 0) stateOf(this).shakes.push({ intensity, seconds, left: seconds });
      },
      kick(this: Fields, ...args: unknown[]): void {
        const a = bind('kick', args, ['pitch', 'yaw'], ['recover', 'accumulate'], ['pitch']);
        const pitch = finite(a['pitch'], 'kick pitch');
        const yaw = finite(a['yaw'] ?? 0, 'kick yaw');
        const recover = nonNegative(a['recover'] ?? 0.15, 'kick recover');
        const state = stateOf(this);
        if (cameras.dimension === '2d') fail('PP3719', 'kick() turns a 3D view', { fix: 'Use shake() in 2D.' });
        if (bool(a['accumulate'] ?? false, 'kick accumulate')) {
          if (this['rig'] !== 'orbit' && this['rig'] !== 'first_person') {
            fail('PP3723', `kick(accumulate=True) turns an orbit or first_person rig; this camera is "${String(this['rig'])}"`, {
              fix: 'Drop accumulate=True (the kick then recovers by itself), or use an orbit/first_person rig.',
            });
          }
          state.yaw += yaw;
          state.pitch += pitch;
          return;
        }
        if (recover > 0) state.kicks.push({ pitch, yaw, recover, t: 0 });
      },
      zoom_to(this: Fields, ...args: unknown[]): unknown {
        const a = bind('zoom_to', args, ['size_or_fov', 'seconds'], [], ['size_or_fov']);
        const field = this['mode'] === 'orthographic' ? 'size' : 'fov';
        const to = finite(a['size_or_fov'], 'zoom_to size_or_fov');
        if (field === 'fov' ? !(to >= 1 && to <= 179) : !(to > 0)) {
          fail('PP3724', `zoom_to(${to}) is not a valid ${field === 'fov' ? 'field of view (1–179 degrees)' : 'orthographic size (> 0)'}`);
        }
        const seconds = nonNegative(a['seconds'] ?? 0.3, 'zoom_to seconds');
        const state = stateOf(this);
        if (state.zoom !== null) state.zoom.active = false;
        const zoom: Zoom = { field, from: this[field] as number, to, seconds, t: 0, active: true };
        if (seconds === 0) { this[field] = to; zoom.active = false; state.zoom = null; }
        else state.zoom = zoom;
        const handle: Handle = {
          cancel: () => {
            if (state.zoom === zoom) state.zoom = null;
            zoom.active = false;
          },
          get active() { return zoom.active; },
        };
        return cameras.#options.presentHandle?.(handle) ?? handle;
      },
      screen_to_world(this: Fields, ...args: unknown[]): Vec3 {
        const a = bind('screen_to_world', args, ['screen'], [], ['screen']);
        return screenToWorld(cameras.view(own(this)), vec2(a['screen'], 'screen_to_world screen'));
      },
      world_to_screen(this: Fields, ...args: unknown[]): Vec2 | null {
        const a = bind('world_to_screen', args, ['point'], [], ['point']);
        return worldToScreen(cameras.view(own(this)), vec3(a['point'], 'world_to_screen point'));
      },
      ray(this: Fields, ...args: unknown[]): readonly [Vec3, Vec3] {
        const a = bind('ray', args, ['screen']);
        const view = cameras.view(own(this));
        const at = a['screen'] === undefined || a['screen'] === null ? viewCenter(view) : vec2(a['screen'], 'ray screen');
        return Object.freeze(screenRay(view, at));
      },
      relative(this: Fields, ...args: unknown[]): Vec3 {
        const a = bind('relative', args, ['stick'], [], ['stick']);
        return relative(cameras.view(own(this)), vec2(a['stick'], 'relative stick'));
      },
      capture(this: Fields, ...args: unknown[]): unknown {
        bind('capture', args, []);
        const capture = cameras.#options.capture;
        if (capture === undefined) {
          fail('PP3725', 'camera.capture() needs a renderer', { fix: 'Add a render plugin (render2d / render3d) to the game.' });
        }
        return capture(cameras.view(own(this)));
      },
    };
  }

  // ── Snapshots ────────────────────────────────────────────────────────────────

  snapshot(): SavedCameras {
    return {
      cameras: [...this.#states].map(([id, s]) => ({
        id,
        rig: s.rig ?? null,
        yaw: s.yaw,
        pitch: s.pitch,
        position: s.position === null ? null : xyz(s.position),
        focus: s.focus === null ? null : xyz(s.focus),
        lead: xyz(s.lead),
        heading: xyz(s.heading),
        last: s.last === null ? null : xyz(s.last),
        shakes: s.shakes.map((x) => [x.intensity, x.seconds, x.left]),
        kicks: s.kicks.map((k) => [k.pitch, k.yaw, k.recover, k.t]),
        zoom: s.zoom === null ? null : [s.zoom.field, s.zoom.from, s.zoom.to, s.zoom.seconds, s.zoom.t],
      })),
      used: [...this.#used],
    };
  }

  /** After a kernel restore: states of live cameras come back; handles to old zooms go inactive. */
  restore(saved: SavedCameras): void {
    for (const state of this.#states.values()) if (state.zoom !== null) state.zoom.active = false;
    this.#states.clear();
    this.#used.clear();
    for (const s of saved.cameras) {
      const id = s.id as EntityId;
      if (this.#kernel().world.get(id)?.components.has(CAMERA) !== true) continue;
      this.#states.set(id, {
        rig: s.rig === null ? undefined : (s.rig as CameraRig),
        yaw: s.yaw,
        pitch: s.pitch,
        position: s.position === null ? null : vec(s.position),
        focus: s.focus === null ? null : vec(s.focus),
        lead: s.lead === undefined ? Vec3.ZERO : vec(s.lead),
        heading: s.heading === undefined ? Vec3.ZERO : vec(s.heading),
        last: s.last === undefined || s.last === null ? null : vec(s.last),
        shakes: s.shakes.map(([intensity, seconds, left]) => ({ intensity, seconds, left })),
        kicks: s.kicks.map(([pitch, yaw, recover, t]) => ({ pitch, yaw, recover, t })),
        zoom: s.zoom === null ? null : {
          field: s.zoom[0] as 'fov' | 'size', from: s.zoom[1], to: s.zoom[2], seconds: s.zoom[3], t: s.zoom[4], active: true,
        },
        view: undefined,
        shake: Vec3.ZERO,
      });
    }
    for (const [seat, id] of saved.used) this.#used.set(seat, id as EntityId);
    this.#resolveAll(0, false);
  }
}

export function savedCameras(json: Json): SavedCameras {
  return json as unknown as SavedCameras;
}
