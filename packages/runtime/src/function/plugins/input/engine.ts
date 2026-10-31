/**
 * The input engine: samples devices once per frame (hook point `input`), keeps per-seat
 * action trackers, and answers reads. A read is from a `Reader` — a seat and the entity
 * whose behavior is reading (null for systems) — because an action set is live per owner
 * (`active_when(ctx, owner)`) and per-seat controls override actions by name.
 *
 * An action reads as idle unless its set is live: in scope for the current scene, its
 * `active_when` true for the reader, and gameplay input not muted (a modal panel is open).
 * When several live sets bind the same physical input, the strictly higher priority set
 * keeps it; equal priorities share it.
 */

import { closestMatch, fail, ParallaxError, Vec2 } from '../../../core/index.js';
import type { InputDevices, InputOutput, TouchControlSpec, TouchSkin, Vec3 } from '../../../core/index.js';
import type { Kernel, SceneScope } from '../../kernel/index.js';
import { claimActions, partsOf, sourcesOf } from './declarations.js';
import type { ActionDecl, ActionSetDecl, Axis1Decl, Axis2Decl, ButtonDecl, GroupDecl, TouchControl } from './declarations.js';
import { ALLOW_ALL, DEFAULT_DEAD_ZONES, DeviceState } from './devices.js';
import type { Allowed, DeadZones, SeatDevices } from './devices.js';
import {
  advance, axis1Now, axis2Now, beginFrame, buttonNow, latched, newTracker, newVirtual, slotNow,
} from './evaluate.js';
import type { Source, Tracker, VirtualInput } from './evaluate.js';
import { PAD_BUTTONS, remapped, remappedParts, remapSlots, slotDevice } from './remap.js';
import { presetActions } from './touch_presets.js';
import { controlRows } from './labels.js';
import type { ControlRow } from './labels.js';
import type { Overrides, RemapSlot } from './remap.js';

export interface Seat extends SeatDevices {
  /** 0-based seat number. */
  readonly index: number;
  /** Per-seat controls: a subclass whose actions replace its ancestors' by name. */
  readonly controls?: ActionSetDecl;
}

/** Who is reading: a seat, and the owning entity's handle for behaviors (null for systems). */
export interface Reader {
  readonly seat: number;
  readonly owner: unknown;
}

export const SYSTEM_READER: Reader = { seat: 0, owner: null };

export interface ReadOptions {
  /** Read through a modal's mute (the UI's own `toggle_with` key). */
  readonly ignoreMute?: boolean;
}

/** Maps the pointer into the world; supplied by whichever plugin renders the scene. */
export interface PointerResolver {
  world(screen: Vec2): Vec3;
  /** The topmost entity (handle) with a collider under the pointer. */
  over(screen: Vec2): unknown;
}

export type Device = 'keyboard' | 'gamepad' | 'touch';

/** A step on a grid: col/row deltas, UP is row - 1. */
export interface Step {
  readonly col: number;
  readonly row: number;
}

export interface TouchLayoutEntry {
  readonly control: TouchControl;
  /** "Set.action" names bound to it. */
  readonly actions: readonly string[];
}

/**
 * A pointer read on another machine (a networked client's), fed to a remote seat: where
 * the pointer was, what it was over (an entity handle), and the left button.
 */
export interface PointerSample {
  readonly x: number;
  readonly y: number;
  /** The point under the pointer in the world, or null (no renderer, off the play plane). */
  readonly world: Vec3 | null;
  /** The entity handle under the pointer, or null. */
  readonly over: unknown;
  readonly held: boolean;
  /** Went down since the last sample. */
  readonly pressed: boolean;
}

interface RemotePointer {
  pending: PointerSample | null;
  /** Presses folded in since the last frame (a press shorter than a frame still counts). */
  pendingPress: boolean;
  now: PointerSample;
  before: PointerSample;
  pressedNow: boolean;
}

const IDLE_POINTER: PointerSample = { x: 0, y: 0, world: null, over: null, held: false, pressed: false };

interface Capture {
  readonly slot: string;
  readonly done: (binding: string | null) => void;
}

export interface InputEngineOptions {
  readonly sets?: readonly ActionSetDecl[];
  readonly devices: InputDevices;
  /** Default: one seat reading every device. */
  readonly seats?: readonly Seat[];
  /** True while gameplay input is muted (the UI's modal stack). */
  readonly muted?: () => boolean;
  readonly deadZones?: Partial<DeadZones>;
  /** A touch button's label as the player reads it (a locale key → its text); default: as written. */
  readonly touchLabel?: (label: string) => string;
  /** The player's remaps (`Settings.controls`); default none. */
  readonly overrides?: () => Overrides;
  /** Store the player's remaps (`Settings.controls` = next): what `rebind` / `resetControls` write. */
  readonly setOverrides?: (next: Overrides, kernel: Kernel | undefined) => void;
}

interface Rival {
  readonly set: ActionSetDecl;
  readonly sources: ReadonlySet<string>;
}

const DEFAULT_SEAT: Seat = { index: 0, keyboard: true, mouse: true, touch: true, gamepad: 'any' };

function inScope(scopes: readonly SceneScope[], scene: { readonly id: string; readonly tags: readonly string[] } | undefined): boolean {
  if (scopes.length === 0) return true;
  if (scene === undefined) return false;
  return scopes.some((s) => ('scene' in s ? s.scene === scene.id : scene.tags.includes(s.tag)));
}

function ancestors(set: ActionSetDecl): ActionSetDecl[] {
  const chain: ActionSetDecl[] = [];
  for (let s: ActionSetDecl | undefined = set; s !== undefined; s = s.parent) chain.push(s);
  return chain;
}

function rootOf(set: ActionSetDecl): ActionSetDecl {
  const chain = ancestors(set);
  return chain[chain.length - 1]!;
}

function nameOf(action: ActionDecl): string {
  return action.owner === undefined ? '(unregistered action)' : `${action.owner.set.id}.${action.owner.name}`;
}

export class InputEngine {
  readonly #devices: InputDevices;
  readonly #state: DeviceState;
  readonly #muted: () => boolean;
  #kernel: Kernel | undefined;
  #sets: ActionSetDecl[] = [];
  #seats: Seat[];
  #actions: ActionDecl[] = [];
  #rivals = new Map<ActionDecl, Rival[]>();
  readonly #trackers = new Map<number, Map<ActionDecl, Tracker>>();
  readonly #virtual = new Map<number, Map<ActionDecl, VirtualInput>>();
  readonly #lastDevice = new Map<number, Device>();
  #rumble: { pad: number | null; strength: number; seconds: number; pattern?: readonly (readonly [number, number])[] }[] = [];
  #textRead = false;
  #realNow = 0;
  #resolver: PointerResolver | undefined;
  readonly #touchLabel: (label: string) => string;
  readonly #overrides: () => Overrides;
  readonly #setOverrides: (next: Overrides, kernel: Kernel | undefined) => void;
  #overrideKey = '';
  #overrideMap: Overrides = {};
  #bound = new Map<ActionDecl, ActionDecl>();
  /** Actions as their set's touch preset fills them in (only the ones it changes). */
  readonly #presetted = new Map<ActionDecl, ActionDecl>();
  /** Sources (`touch:<id>`) of the touch controls the game hid or disabled last frame: they read as idle. */
  #touchBlocked: ReadonlySet<string> = new Set();
  #capture: Capture | undefined;
  readonly #remotePointers = new Map<number, RemotePointer>();

  constructor(options: InputEngineOptions) {
    this.#devices = options.devices;
    this.#state = new DeviceState({ ...DEFAULT_DEAD_ZONES, ...options.deadZones });
    this.#muted = options.muted ?? (() => false);
    this.#touchLabel = options.touchLabel ?? ((label) => label);
    // Without a store (bare engine, tests): remaps live on the engine.
    let own: Overrides = {};
    this.#overrides = options.overrides ?? (() => own);
    this.#setOverrides = options.setOverrides ?? ((next) => { own = next; });
    this.#seats = [...(options.seats ?? [DEFAULT_SEAT])];
    for (const set of options.sets ?? []) this.addSet(set);
  }

  bind(kernel: Kernel): void {
    this.#kernel = kernel;
  }

  // ── Declarations and seats ──────────────────────────────────────────────────

  addSet(set: ActionSetDecl): void {
    if (this.#sets.includes(set)) return;
    if (this.#sets.some((s) => s.id === set.id)) {
      fail('PP4400', `Two action sets are named "${set.id}"`, { fix: 'Rename one of the Actions subclasses.' });
    }
    claimActions(set);
    for (const [declared, planned] of presetActions(set)) this.#presetted.set(declared, planned);
    this.#sets.push(set);
    for (const action of set.actions.values()) if (!this.#actions.includes(action)) this.#actions.push(action);
    this.#rivals = new Map(this.#actions.map((a) => [a, this.#rivalsOf(a)]));
  }

  get sets(): readonly ActionSetDecl[] {
    return this.#sets;
  }

  setSeats(seats: readonly Seat[]): void {
    if (seats.length === 0) fail('PP3401', 'A game needs at least one seat');
    seats.forEach((seat, i) => {
      if (seat.index !== i) fail('PP3401', `Seat ${i} is numbered ${seat.index}`, { fix: 'Number seats 0, 1, 2… in order.' });
      if (seat.controls !== undefined && !this.#sets.includes(seat.controls)) {
        fail('PP3402', `Seat ${i}'s controls "${seat.controls.id}" are not a registered Actions class`);
      }
    });
    this.#seats = [...seats];
  }

  get seats(): readonly Seat[] {
    return this.#seats;
  }

  setPointerResolver(resolver: PointerResolver | undefined): void {
    this.#resolver = resolver;
  }

  #rivalsOf(action: ActionDecl): Rival[] {
    const overrides = this.#overrideMap;
    const mine = new Set(remappedParts(this.#preset(action), overrides).flatMap(sourcesOf));
    const set = action.owner!.set;
    const rivals: Rival[] = [];
    for (const other of this.#sets) {
      if (other.priority <= set.priority) continue;
      const shared = new Set<string>();
      for (const a of other.actions.values()) {
        for (const src of remappedParts(this.#preset(a), overrides).flatMap(sourcesOf)) if (mine.has(src)) shared.add(src);
      }
      if (shared.size > 0) rivals.push({ set: other, sources: shared });
    }
    return rivals;
  }

  // ── Frame ───────────────────────────────────────────────────────────────────

  /** Hook point `input`: sample devices, advance trackers, publish cursor/rumble/text requests. */
  frame(realDt: number): void {
    this.#realNow += realDt;
    this.#state.update(this.#devices.poll());
    this.#refreshOverrides();
    this.#runCapture();
    for (const remote of this.#remotePointers.values()) this.#advancePointer(remote);
    for (const seat of this.#seats) {
      const virtuals = this.#virtual.get(seat.index);
      if (virtuals !== undefined) for (const v of virtuals.values()) beginFrame(v, this.#realNow);
      let trackers = this.#trackers.get(seat.index);
      if (trackers === undefined) this.#trackers.set(seat.index, (trackers = new Map()));
      for (const action of this.#actions) {
        let tracker = trackers.get(action);
        if (tracker === undefined) trackers.set(action, (tracker = newTracker(action)));
        advance(this.#boundOf(action), tracker, this.#source(seat, action, ALLOW_ALL), realDt);
      }
      const used = this.#state.activity(seat);
      if (used !== undefined) this.#lastDevice.set(seat.index, used);
    }
    const cursor = this.cursor();
    const touchSkin = this.#touchSkin();
    const output: InputOutput = {
      cursor, virtualCursor: cursor === 'free' && this.#looks(), textEntry: this.#textRead && this.#touchKeyboard(), rumble: this.#rumble, touch: this.#touchSpecs(),
      ...(touchSkin !== undefined && { touchSkin }),
    };
    this.#rumble = [];
    this.#textRead = false;
    this.#devices.present(output);
  }

  // ── Resolution ──────────────────────────────────────────────────────────────

  #seat(index: number): Seat {
    const seat = this.#seats[index];
    if (seat === undefined) fail('PP3403', `There is no seat ${index} (seats: ${this.#seats.length})`);
    return seat;
  }

  /** The action a seat actually reads: its per-seat controls override by name. */
  resolve<A extends ActionDecl>(action: A, seatIndex: number): A {
    if (action.owner === undefined) {
      fail('PP3400', 'This action belongs to no registered Actions class', {
        fix: 'Declare actions as class attributes of an Actions subclass the game imports.',
      });
    }
    const controls = this.#seat(seatIndex).controls;
    if (controls === undefined || controls === action.owner.set) return action;
    if (!ancestors(controls).includes(action.owner.set)) return action;
    return (controls.actions.get(action.owner.name) as A | undefined) ?? action;
  }

  #source(seat: Seat, action: ActionDecl, allowed: Allowed): Source {
    return { devices: this.#state, seat, allowed, virtual: this.#virtual.get(seat.index)?.get(action) };
  }

  /** Whether a set is live for this reader. */
  live(set: ActionSetDecl, reader: Reader, options: ReadOptions = {}): boolean {
    if (options.ignoreMute !== true && this.#muted()) return false;
    if (!inScope(set.scenes, this.#kernel?.scene)) return false;
    if (set.activeWhen !== undefined && !set.activeWhen(this.#kernel?.context, reader.owner)) return false;
    return this.#seatReads(set, this.#seat(reader.seat));
  }

  /** Another seat's per-seat controls are not this seat's. */
  #seatReads(set: ActionSetDecl, seat: Seat): boolean {
    const controls = seat.controls;
    return controls === undefined || set === controls || rootOf(set) !== rootOf(controls) || ancestors(controls).includes(set);
  }

  /** Sources a higher-priority live set has claimed from this action. */
  #allowed(action: ActionDecl, reader: Reader, options: ReadOptions): Allowed {
    const rivals = this.#rivals.get(action) ?? [];
    let masked: Set<string> | undefined;
    for (const rival of rivals) {
      if (!this.live(rival.set, reader, options)) continue;
      masked ??= new Set(this.#touchBlocked);
      for (const s of rival.sources) masked.add(s);
    }
    if (masked === undefined && this.#touchBlocked.size > 0) {
      const blocked = this.#touchBlocked;
      return (src) => !blocked.has(src);
    }
    return masked === undefined ? ALLOW_ALL : (src) => !masked.has(src);
  }

  /** The resolved action, its tracker and a masked source — or undefined when its set isn't live. */
  #read<A extends ActionDecl>(action: A, kind: A['kind'], reader: Reader, options: ReadOptions):
    { readonly action: A; readonly tracker: Tracker; readonly source: Source } | undefined {
    const resolved = this.resolve(action, reader.seat);
    if (resolved.kind !== kind) {
      fail('PP3404', `${nameOf(resolved)} is a ${resolved.kind}, not a ${kind}`, {
        fix: { button: 'Read buttons with pressed/held/released.', axis1: 'Read axis1 with value().', axis2: 'Read axis2 with axis().', group: 'Read button groups with pressed_index().' }[resolved.kind],
      });
    }
    if (!this.live(resolved.owner!.set, reader, options)) return undefined;
    const tracker = this.#trackers.get(reader.seat)?.get(resolved);
    if (tracker === undefined) return undefined; // before the first input frame
    const source = this.#source(this.#seat(reader.seat), resolved, this.#allowed(resolved, reader, options));
    return { action: this.#boundOf(resolved) as A, tracker, source };
  }

  // ── Reads ───────────────────────────────────────────────────────────────────

  /**
   * Whether the seat pressed any button (or button-group slot) this frame, whatever its
   * set's liveness (scenes, `active_when`) and a modal's mute: what advances a conversation
   * in the modal DialoguePanel. Another seat's per-seat controls don't count.
   */
  anyButtonPressed(seatIndex: number): boolean {
    const seat = this.#seat(seatIndex);
    const trackers = this.#trackers.get(seatIndex);
    if (trackers === undefined) return false;
    for (const [action, tracker] of trackers) {
      if (action.owner === undefined || !this.#seatReads(action.owner.set, seat)) continue;
      if (tracker.kind === 'button' && tracker.pressed) return true;
      if (tracker.kind === 'group' && tracker.slots.some((slot) => slot.pressed)) return true;
    }
    return false;
  }

  pressed(action: ButtonDecl, reader: Reader = SYSTEM_READER, options: ReadOptions = {}): boolean {
    const r = this.#read(action, 'button', reader, options);
    if (r === undefined || r.tracker.kind !== 'button') return false;
    const now = buttonNow(r.action, r.source);
    return (r.tracker.pressed && (now.pressed || now.held)) || (r.tracker.repeated && now.held);
  }

  held(action: ButtonDecl, reader: Reader = SYSTEM_READER, options: ReadOptions = {}): boolean {
    const r = this.#read(action, 'button', reader, options);
    return r !== undefined && buttonNow(r.action, r.source).held;
  }

  released(action: ButtonDecl, reader: Reader = SYSTEM_READER, options: ReadOptions = {}): boolean {
    const r = this.#read(action, 'button', reader, options);
    if (r === undefined || r.tracker.kind !== 'button') return false;
    return r.tracker.released && !buttonNow(r.action, r.source).held;
  }

  value(action: Axis1Decl, reader: Reader = SYSTEM_READER): number {
    const r = this.#read(action, 'axis1', reader, {});
    return r === undefined ? 0 : axis1Now(r.action, r.source);
  }

  axis(action: Axis2Decl, reader: Reader = SYSTEM_READER): Vec2 {
    const r = this.#read(action, 'axis2', reader, {});
    return r === undefined ? Vec2.ZERO : axis2Now(r.action, r.source);
  }

  pressedIndex(group: GroupDecl, reader: Reader = SYSTEM_READER): number | null {
    const r = this.#read(group, 'group', reader, {});
    if (r === undefined || r.tracker.kind !== 'group') return null;
    for (let i = 0; i < r.action.slots.length; i++) {
      if (!r.tracker.slots[i]!.pressed) continue;
      const now = slotNow(r.action, i, r.source);
      if (now.pressed || now.held) return i;
    }
    return null;
  }

  /** Axis2: a unit Vec2 on the frame a direction is entered (and on repeats). */
  pressedDirection(action: Axis2Decl, reader?: Reader): Vec2 | null;
  /** Axis1: -1 or +1 on the frame the axis crosses into that direction. */
  pressedDirection(action: Axis1Decl, reader?: Reader): -1 | 1 | null;
  pressedDirection(action: Axis1Decl | Axis2Decl, reader: Reader = SYSTEM_READER): Vec2 | -1 | 1 | null {
    if (action.kind === 'axis1') {
      const r = this.#read(action, 'axis1', reader, {});
      if (r === undefined || r.tracker.kind !== 'axis1' || r.tracker.dirPressed === null) return null;
      return axis1Now(r.action, latched(r.source)) * r.tracker.dirPressed > 0 ? r.tracker.dirPressed : null;
    }
    const r = this.#read(action, 'axis2', reader, {});
    if (r === undefined || r.tracker.kind !== 'axis2' || r.tracker.dirPressed === null) return null;
    return axis2Now(r.action, latched(r.source)).dot(r.tracker.dirPressed) > 0.3 ? r.tracker.dirPressed : null;
  }

  /** `pressedDirection` as a grid step: up is row - 1. */
  pressedStep(action: Axis2Decl, reader: Reader = SYSTEM_READER): Step | null {
    const dir = this.pressedDirection(action, reader);
    return dir === null ? null : { col: Math.round(dir.x), row: -Math.round(dir.y) || 0 };
  }

  text(reader: Reader = SYSTEM_READER): string {
    this.#textRead = true;
    return this.#seat(reader.seat).keyboard ? this.#state.snapshot.text : '';
  }

  device(reader: Reader = SYSTEM_READER): Device {
    return this.#lastDevice.get(reader.seat) ?? (this.#seat(reader.seat).gamepad !== null && !this.#seat(reader.seat).keyboard ? 'gamepad' : 'keyboard');
  }

  rumble(strength: number, seconds: number, reader: Reader = SYSTEM_READER, pattern?: readonly (readonly [number, number])[]): void {
    const pad = this.#seat(reader.seat).gamepad;
    this.#rumble.push({ pad: typeof pad === 'number' ? pad : null, strength, seconds, ...(pattern !== undefined && { pattern }) });
  }

  /** Pointer lock while gameplay input is live and an in-scope set reads mouse delta. */
  cursor(): 'locked' | 'free' {
    if (this.#muted()) return 'free';
    return this.#looks() ? 'locked' : 'free';
  }

  /**
   * The cursor is free over a mouse-look scene (a modal is open): a locked pointer stays
   * locked and the platform draws the virtual cursor, so look resumes with no click after.
   */
  virtualCursor(): boolean {
    return this.cursor() === 'free' && this.#looks();
  }

  /** An in-scope set reads mouse delta (the scene is played with mouse-look). */
  #looks(): boolean {
    const scene = this.#kernel?.scene;
    return this.#sets.some((set) => inScope(set.scenes, scene)
      && [...set.actions.values()].some((a) => a.kind === 'axis2' && a.bindings.some((p) => p.kind === 'mouse_delta')));
  }

  /**
   * Touch controls the platform should draw now: every live set's (in scope, and `active_when`
   * asked with no owner, as for a system's read), unless input is muted.
   */
  touchLayout(): TouchLayoutEntry[] {
    if (this.#muted()) return [];
    const scene = this.#kernel?.scene;
    const byId = new Map<string, { control: TouchControl; actions: string[] }>();
    for (const set of this.#sets) {
      if (!inScope(set.scenes, scene)) continue;
      if (set.activeWhen !== undefined && !set.activeWhen(this.#kernel?.context, null)) continue;
      for (const [name, action] of set.actions) {
        for (const part of partsOf(this.#preset(action))) {
          if (part.kind !== 'touch') continue;
          const entry = byId.get(part.control.id) ?? { control: part.control, actions: [] };
          entry.actions.push(`${set.id}.${name}`);
          byId.set(part.control.id, entry);
        }
      }
    }
    return [...byId.values()];
  }

  // ── Remapping ───────────────────────────────────────────────────────────────

  /** Re-read the player's remaps; rebuild the remapped actions and priority masks when they changed. */
  #refreshOverrides(): void {
    const overrides = this.#overrides();
    const key = JSON.stringify(Object.entries(overrides).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    if (key === this.#overrideKey) return;
    this.#overrideKey = key;
    this.#overrideMap = { ...overrides };
    this.#bound = new Map(this.#actions.map((a) => [a, remapped(this.#preset(a), this.#overrideMap)]));
    this.#rivals = new Map(this.#actions.map((a) => [a, this.#rivalsOf(a)]));
  }

  /** The action with the player's remaps applied (trackers stay keyed by the declared action). */
  #boundOf<A extends ActionDecl>(action: A): A {
    return (this.#bound.get(action) ?? this.#preset(action)) as A;
  }

  /** The action with its set's touch preset applied. */
  #preset<A extends ActionDecl>(action: A): A {
    return (this.#presetted.get(action) ?? action) as A;
  }

  /** Every remappable binding, with what is in effect now (the settings menu's rows). */
  remapSlots(): RemapSlot[] {
    return remapSlots(this.#sets, this.#overrides());
  }

  /**
   * Rebind `slot`: the next key (a keyboard slot) or gamepad button (a `:pad` slot) that
   * goes down in a later input frame is reported to `done`, whatever is muted; Escape reports null (cancelled).
   * A new capture replaces one in progress (which is cancelled).
   */
  beginCapture(slot: string, done: (binding: string | null) => void): void {
    this.#knownSlot(slot);
    this.#capture?.done(null);
    this.#capture = { slot, done };
  }

  /** The remap slots as a controls menu shows them; `action` ("<Set>.<action>") keeps one action's. */
  controls(action?: string): ControlRow[] {
    const slots = this.remapSlots();
    return controlRows(action === undefined ? slots : slots.filter((s) => s.action === action), this.capturing);
  }

  /**
   * Rebind `slot` to the next key (a keyboard slot) or gamepad button (a `:pad` slot) the
   * player presses: it is stored in the player's remaps. Escape cancels; a new rebind
   * replaces one in progress.
   */
  rebind(slot: string): void {
    this.beginCapture(slot, (binding) => {
      if (binding === null) return;
      this.#setOverrides({ ...this.#overrides(), [slot]: binding }, this.#kernel);
    });
  }

  /** Back to the declared binding: one slot, or every slot (and a rebind in progress is cancelled). */
  resetControls(slot?: string): void {
    if (slot === undefined) {
      this.cancelCapture();
      this.#setOverrides({}, this.#kernel);
      return;
    }
    this.#knownSlot(slot);
    if (this.capturing === slot) this.cancelCapture();
    const { [slot]: _gone, ...rest } = this.#overrides();
    this.#setOverrides(rest, this.#kernel);
  }

  #knownSlot(slot: string): void {
    if (!this.remapSlots().some((s) => s.slot === slot)) {
      const near = closestMatch(slot, this.remapSlots().map((s) => s.slot));
      fail('PP3408', `"${slot}" is not a remappable control`, {
        fix: near !== undefined ? `Did you mean "${near}"? (slots: ctx.input.controls())`
          : 'Rebind a slot ctx.input.controls() lists: an action\'s keyboard key or gamepad button (sticks, mouse and touch are not remappable).',
      });
    }
  }

  /** The slot being rebound, if any. */
  get capturing(): string | null {
    return this.#capture?.slot ?? null;
  }

  cancelCapture(): void {
    const capture = this.#capture;
    this.#capture = undefined;
    capture?.done(null);
  }

  #runCapture(): void {
    const capture = this.#capture;
    if (capture === undefined) return;
    const snapshot = this.#state.snapshot;
    let found: string | null | undefined;
    if (snapshot.keysPressed.includes('Escape')) {
      found = null;
    } else if (slotDevice(capture.slot) === 'keyboard') {
      found = snapshot.keysPressed[0];
    } else {
      for (const pad of snapshot.gamepads) {
        const button = pad?.pressed.find((b) => PAD_BUTTONS.includes(b));
        if (button !== undefined) {
          found = button;
          break;
        }
      }
    }
    if (found === undefined) return;
    this.#capture = undefined;
    capture.done(found);
  }

  // ── Touch ───────────────────────────────────────────────────────────────────

  /**
   * The layout as the platform draws it this frame: the game's per-control state asked (a
   * hidden control is left out, a disabled one greyed), labels localized. Hidden and disabled
   * controls read as idle until the next frame's layout.
   */
  #touchSpecs(): TouchControlSpec[] {
    const ctx = this.#kernel?.context;
    const blocked = new Set<string>();
    const out: TouchControlSpec[] = [];
    for (const { control } of this.touchLayout()) {
      const { state, ...spec } = control;
      if (state?.visible !== undefined && !state.visible(ctx)) {
        blocked.add(`touch:${control.id}`);
        continue;
      }
      const relabel = state?.relabel?.(ctx);
      const label = relabel?.label ?? spec.label;
      const icon = relabel?.icon ?? spec.icon;
      const disabled = state?.enabled !== undefined && !state.enabled(ctx);
      if (disabled) blocked.add(`touch:${control.id}`);
      const cooldown = state?.cooldown?.(ctx);
      out.push({
        ...spec,
        ...(label !== undefined && { label: this.#touchLabel(label) }),
        ...(icon !== undefined && { icon }),
        ...(spec.labels !== undefined && { labels: [this.#touchLabel(spec.labels[0]), this.#touchLabel(spec.labels[1])] as const }),
        ...(disabled && { disabled }),
        ...(state?.selected !== undefined && { selected: state.selected(ctx) }),
        ...(cooldown !== undefined && Number.isFinite(cooldown) && cooldown > 0 && { cooldown: Math.min(1, cooldown) }),
      });
    }
    this.#touchBlocked = blocked;
    return out;
  }

  /** Whether the phone's keyboard may open for typed text: no live, in-scope set says `touch_keyboard = False`. */
  #touchKeyboard(): boolean {
    const scene = this.#kernel?.scene;
    for (const set of this.#sets) {
      if (set.touchKeyboard !== false || !inScope(set.scenes, scene)) continue;
      if (set.activeWhen !== undefined && !set.activeWhen(this.#kernel?.context, null)) continue;
      return false;
    }
    return true;
  }

  /** The highest-priority live set's (in scope, `active_when` as for a system) `touch_skin`. */
  #touchSkin(): TouchSkin | undefined {
    const scene = this.#kernel?.scene;
    let best: ActionSetDecl | undefined;
    for (const set of this.#sets) {
      if (set.touchSkin === undefined || !inScope(set.scenes, scene)) continue;
      if (set.activeWhen !== undefined && !set.activeWhen(this.#kernel?.context, null)) continue;
      if (best === undefined || set.priority > best.priority) best = set;
    }
    return best?.touchSkin;
  }

  // ── Pointer ─────────────────────────────────────────────────────────────────

  /** A remote seat reads the pointer its client sent; every other seat reads this machine's. */
  #remote(reader: Reader): RemotePointer | undefined {
    return this.#remotePointers.get(reader.seat);
  }

  pointerScreen(reader: Reader = SYSTEM_READER): Vec2 {
    const remote = this.#remote(reader);
    if (remote !== undefined) return new Vec2(remote.now.x, remote.now.y);
    const p = this.#state.snapshot.pointer;
    return new Vec2(p.x, p.y);
  }

  pointerButton(reader: Reader = SYSTEM_READER): { held: boolean; pressed: boolean; released: boolean } {
    const remote = this.#remote(reader);
    if (remote !== undefined) {
      const held = remote.now.held;
      const pressed = remote.pressedNow;
      return { held, pressed, released: (remote.before.held && !held) || (pressed && !held) };
    }
    if (this.#state.claimOf('left') === 'ui') return { held: false, pressed: false, released: false };
    return this.#state.mouseButton('left');
  }

  pointerDelta(reader: Reader = SYSTEM_READER): Vec2 {
    const remote = this.#remote(reader);
    if (remote !== undefined) return new Vec2(remote.now.x - remote.before.x, remote.now.y - remote.before.y);
    const p = this.#state.snapshot.pointer;
    return new Vec2(p.dx, p.dy);
  }

  pointerWorld(reader: Reader = SYSTEM_READER): Vec3 {
    const remote = this.#remote(reader);
    if (remote !== undefined) {
      if (remote.now.world === null) {
        fail('PP3409', 'pointer.world: this player\'s client had no world point under its pointer (no camera, or the pointer off the play plane)', {
          fix: 'Read pointer.world when the player clicks (pointer.pressed, or a mouse/tap action), when the client has a point.',
        });
      }
      return remote.now.world;
    }
    if (this.#resolver === undefined) {
      fail('PP3405', 'pointer.world needs a scene renderer', { fix: 'Add a render plugin (render2d / render3d) to the game.' });
    }
    return this.#resolver.world(this.pointerScreen());
  }

  /** The entity under the pointer; reading it on a pressed frame consumes the click. */
  pointerOver(reader: Reader = SYSTEM_READER): unknown {
    const remote = this.#remote(reader);
    if (remote !== undefined) return remote.now.over ?? null;
    if (this.#resolver === undefined) {
      fail('PP3405', 'pointer.over needs a scene renderer', { fix: 'Add a render plugin (render2d / render3d) to the game.' });
    }
    const over = this.#resolver.over(this.pointerScreen());
    if (over !== null && over !== undefined && this.pointerButton().pressed) this.consumePointer();
    return over ?? null;
  }

  consumePointer(reader: Reader = SYSTEM_READER): void {
    if (this.#remote(reader) !== undefined) return; // a remote click has no mouse-bound action here to suppress
    this.#state.claimPresses('world');
  }

  /**
   * This machine's pointer as a networked client sends it: screen position, the world point
   * and entity under it (null without a renderer), and the left button. Reading it consumes
   * nothing.
   */
  pointerSample(): PointerSample {
    const screen = this.pointerScreen();
    const button = this.pointerButton();
    const resolver = this.#resolver;
    // What this machine can't resolve (no camera yet, no physics for `over`) travels as null;
    // the server raises PP3409 only if game code reads it.
    const attempt = <T>(read: () => T): T | null => {
      try {
        return read();
      } catch (error) {
        if (error instanceof ParallaxError) return null;
        throw error;
      }
    };
    return {
      x: screen.x, y: screen.y,
      world: resolver === undefined ? null : attempt(() => resolver.world(screen)),
      over: resolver === undefined ? null : attempt(() => resolver.over(screen)) ?? null,
      held: button.held, pressed: button.pressed,
    };
  }

  /** Feed a remote seat its client's pointer; it reads it from the next frame (like injected actions). */
  injectPointer(seat: number, sample: PointerSample): void {
    this.#seat(seat);
    let remote = this.#remotePointers.get(seat);
    if (remote === undefined) {
      remote = { pending: null, pendingPress: false, now: IDLE_POINTER, before: IDLE_POINTER, pressedNow: false };
      this.#remotePointers.set(seat, remote);
    }
    remote.pending = sample;
    remote.pendingPress ||= sample.pressed;
  }

  /** The seat left: it reads this machine's pointer again (nothing, for a seat without devices). */
  forgetPointer(seat: number): void {
    this.#remotePointers.delete(seat);
  }

  #advancePointer(remote: RemotePointer): void {
    remote.before = remote.now;
    if (remote.pending !== null) remote.now = remote.pending;
    remote.pressedNow = remote.pendingPress;
    remote.pending = null;
    remote.pendingPress = false;
  }

  // ── Injection (test harness) ────────────────────────────────────────────────

  #virtualFor(action: ActionDecl, seat: number): VirtualInput {
    const resolved = this.resolve(action, seat);
    let map = this.#virtual.get(seat);
    if (map === undefined) this.#virtual.set(seat, (map = new Map()));
    let v = map.get(resolved);
    if (v === undefined) map.set(resolved, (v = newVirtual()));
    return v;
  }

  /** Press and release within the next frame. */
  inject(action: ButtonDecl, seat = 0): void {
    const v = this.#virtualFor(action, seat);
    v.slot = null;
    v.wentDown = true;
  }

  /** Hold for `seconds` of real time (null: until `release`). */
  injectHold(action: ButtonDecl, seconds: number | null, seat = 0): void {
    const v = this.#virtualFor(action, seat);
    v.slot = null;
    v.held = true;
    v.until = seconds === null ? null : this.#realNow + seconds;
  }

  injectRelease(action: ActionDecl, seat = 0): void {
    const v = this.#virtualFor(action, seat);
    v.held = false;
    v.until = null;
    v.value = 0;
    v.vec = Vec2.ZERO;
  }

  injectIndex(group: GroupDecl, index: number, seat = 0): void {
    if (!Number.isInteger(index) || index < 0 || index >= group.slots.length) {
      fail('PP3406', `${nameOf(group)} has ${group.slots.length} buttons; index ${index} is out of range`);
    }
    const v = this.#virtualFor(group, seat);
    v.slot = index;
    v.wentDown = true;
  }

  injectValue(action: Axis1Decl, value: number, seconds: number | null, seat = 0): void {
    const v = this.#virtualFor(action, seat);
    v.value = value;
    v.until = seconds === null ? null : this.#realNow + seconds;
  }

  injectVector(action: Axis2Decl, vec: Vec2, seconds: number | null, seat = 0): void {
    const v = this.#virtualFor(action, seat);
    v.vec = vec;
    v.until = seconds === null ? null : this.#realNow + seconds;
  }
}
