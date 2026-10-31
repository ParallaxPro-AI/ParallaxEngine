/**
 * The UI engine (headless half): which panels are open, derived from declarations and
 * never toggled by hand.
 *
 * Each frame, in the kernel's `ui` hook:
 *   1. queued panel clicks run (commands, function actions with typed arguments)
 *   2. panels whose subject was destroyed close
 *   3. `toggle_with`, `while_held` and `when=` (+ `delay`) panels follow their inputs/state
 *   4. modal state is applied: time freezes (without net) and gameplay input is muted
 *   5. every open panel's `state()` is evaluated for the renderer
 *
 * A scene load closes every panel and opens the scene's `"ui"` list. Modals stack; a
 * `toggle_with` key closes its panel only while that panel is the top modal.
 */

import { closestMatch, fail } from '../../../core/index.js';
import type { EntityId, Vec2, Vec3, Color, UiFloatStyle } from '../../../core/index.js';
import { decode, encode } from '../../kernel/index.js';
import type { EventDef, FieldType, Handle, Kernel, SceneScope } from '../../kernel/index.js';
import type { Json } from '../../../resource/index.js';
import { COMMAND_KEY } from './declarations.js';
import type { PanelAction, PanelCommand, PanelDecl, PanelInstance, PanelKey } from './declarations.js';

export const UI_EVENTS = {
  opened: { id: 'panel_opened' },
  closed: { id: 'panel_closed' },
  /** Every panel action that ran (not a disabled one): `{panel, action, seat}`, after its command applied. */
  acted: { id: 'panel_action' },
} as const satisfies Record<string, EventDef>;

/** How the UI reads its own keys (toggle_with / while_held) through the input plugin. */
export interface UiInputLink {
  pressed(action: unknown, ignoreMute: boolean): boolean;
  held(action: unknown, ignoreMute: boolean): boolean;
}

export interface UiEngineOptions {
  readonly panels?: readonly PanelDecl[];
  /** Freeze simulation time while a modal is open (default true; the net plugin turns it off). */
  readonly freezeTime?: boolean;
  /** Needed when any panel declares `toggle_with` or `while_held`. */
  readonly input?: UiInputLink;
  /** The seats' player handles, for `PlayerPanel.state(ctx, player)`. Default: one seat, null. */
  readonly players?: () => readonly unknown[];
}

export interface OpenPanel {
  readonly decl: PanelDecl;
  readonly instance: PanelInstance;
  readonly subject: EntityId | undefined;
}

export interface PanelView {
  readonly id: string;
  readonly layer: PanelDecl['layer'];
  readonly modal: boolean;
  /** One entry per seat for a PlayerPanel, else one. */
  readonly states: readonly Readonly<Record<string, unknown>>[];
  /** Function actions with `when=`: false while disabled. */
  readonly enabled: Readonly<Record<string, boolean>>;
}

/** Presentation requests for the renderer (wave 2 draws them). */
export type UiRequest =
  | { readonly kind: 'toast'; readonly text: unknown; readonly seconds: number; readonly to: unknown }
  | { readonly kind: 'announce'; readonly title: unknown; readonly subtitle: unknown; readonly seconds: number; readonly to: unknown }
  | {
    readonly kind: 'float_text'; readonly text: string; readonly at: Vec2 | Vec3; readonly color: Color | null; readonly to: unknown;
    readonly style: UiFloatStyle | null;
  }
  | { readonly kind: 'flash'; readonly entity: EntityId; readonly color: Color | null; readonly seconds: number };

export interface Label {
  readonly entity: EntityId;
  readonly text: unknown;
  readonly offset: Vec3 | null;
  /** A style name: the label's CSS class beside `label` (`ui/feedback.html` styles `.label.you`). */
  readonly kind?: string;
}

/** What `UiEngine.snapshot()` saves: the open panels in order, and `when=` delays under way. */
export interface UiSnapshot {
  readonly open: readonly { readonly id: string; readonly subject: number | null }[];
  readonly pending: readonly { readonly id: string; readonly elapsed: number; readonly delay: number }[];
}

interface Click {
  readonly decl: PanelDecl;
  readonly action: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly seat: number;
}

function inScope(scopes: readonly SceneScope[], scene: { readonly id: string; readonly tags: readonly string[] } | undefined): boolean {
  if (scopes.length === 0) return true;
  if (scene === undefined) return false;
  return scopes.some((s) => ('scene' in s ? s.scene === scene.id : scene.tags.includes(s.tag)));
}

/** A value from `state()` as plain data: Maps and dict-likes become objects, iterables arrays. */
export function plain(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value ?? null;
  if (Array.isArray(value)) return value.map(plain);
  if (value instanceof Map) return Object.fromEntries([...value].map(([k, v]) => [String(k), plain(v)]));
  if (Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
  }
  return value;
}

function unwrapScalar(type: FieldType): FieldType {
  return type.kind === 'optional' ? unwrapScalar(type.of) : type;
}

/** `data-*` attributes arrive as strings; parse them toward the declared type before decoding. */
function parseData(type: FieldType, raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  if (type.kind === 'optional' && raw === '') return null;
  const inner = unwrapScalar(type);
  if ((inner.kind === 'number' || inner.kind === 'int') && raw.trim() !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  if (inner.kind === 'bool' && (raw === 'true' || raw === 'false')) return raw === 'true';
  if (inner.kind === 'list' || inner.kind === 'dict' || inner.kind === 'record' || inner.kind === 'vec2' || inner.kind === 'vec3') {
    try { return JSON.parse(raw) as unknown; } catch { return raw; }
  }
  return raw;
}

function isJsonForm(value: unknown): boolean {
  if (typeof value === 'function') return false;
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.every(isJsonForm);
  return Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(isJsonForm);
}

/**
 * A click's value for a typed argument, in data form: `data-*` strings are parsed toward
 * the type; a runtime value (what a test's `click(..., level=Content.level.x)` or a
 * `data-each` item holds: a ContentRef, an enum member, a Vec3, …) is encoded by the type,
 * exactly as a save would write it.
 */
function dataForm(type: FieldType, raw: unknown, where: string): Json {
  if (typeof raw === 'string') return parseData(type, raw) as Json;
  if (isJsonForm(raw)) return raw as Json;
  return encode(type, raw, where);
}

export class UiEngine {
  readonly #decls: PanelDecl[] = [];
  readonly #freezeTime: boolean;
  readonly #input: UiInputLink | undefined;
  readonly #players: () => readonly unknown[];
  #kernel: Kernel | undefined;
  #open: OpenPanel[] = [];
  readonly #pending = new Map<PanelDecl, { elapsed: number; delay: number }>();
  #clicks: Click[] = [];
  #views = new Map<PanelDecl, PanelView>();
  #requests: UiRequest[] = [];
  readonly #labels = new Map<Handle, Label>();
  #frozen = false;

  constructor(options: UiEngineOptions) {
    this.#freezeTime = options.freezeTime ?? true;
    this.#input = options.input;
    this.#players = options.players ?? (() => [null]);
    for (const decl of options.panels ?? []) this.addPanel(decl);
  }

  bind(kernel: Kernel): void {
    this.#kernel = kernel;
  }

  // ── Declarations ────────────────────────────────────────────────────────────

  addPanel(decl: PanelDecl): void {
    const where = `panel "${decl.id}"`;
    if (this.#decls.some((d) => d.id === decl.id)) fail('PP4420', `Two panels are named "${decl.id}"`, { fix: 'Give each @ui panel its own id.' });
    const openings = [decl.when !== undefined, decl.toggleWith !== undefined, decl.whileHeld !== undefined].filter(Boolean).length;
    if (openings > 1) {
      fail('PP4421', `${where} declares more than one of when=, toggle_with= and while_held=`, { fix: 'Pick one way the panel opens.' });
    }
    if (decl.delay !== undefined && decl.when === undefined) fail('PP4422', `${where}: delay= only applies with when=`, { fix: 'Add when=, or remove delay=.' });
    if (typeof decl.delay === 'number' && !(decl.delay >= 0)) fail('PP4422', `${where}: delay must be 0 or more seconds, got ${decl.delay}`);
    if ((decl.toggleWith !== undefined || decl.whileHeld !== undefined) && this.#input === undefined) {
      fail('PP9420', `${where} reads a key, but the UI was built without an input link`);
    }
    for (const [name, action] of decl.actions) {
      if (decl.when !== undefined && action.kind === 'command' && action.command.kind === 'close') {
        fail('PP4423', `${where}: action "${name}" is close_panel(), but the panel follows its when= condition`, {
          fix: 'Change the state its when= reads instead (a function action), and the panel closes by itself.',
        });
      }
    }
    this.#decls.push(decl);
  }

  get panels(): readonly PanelDecl[] {
    return this.#decls;
  }

  /** A panel by id or handle. */
  panel(key: PanelKey): PanelDecl {
    const found = this.#decls.find((d) => (typeof key === 'string' ? d.id === key : d === key || d.handle === key));
    if (found !== undefined) return found;
    const name = typeof key === 'string' ? key : ((key as { name?: string }).name ?? String(key));
    const guess = typeof key === 'string' ? closestMatch(key, this.#decls.map((d) => d.id)) : undefined;
    return fail('PP2080', `Unknown panel "${name}"`, {
      fix: guess !== undefined ? `Did you mean "${guess}"?` : 'Declare it with @ui and import its module from the game.',
    });
  }

  #kernelOrFail(): Kernel {
    if (this.#kernel === undefined) fail('PP9421', 'The UI is used before its kernel was built');
    return this.#kernel;
  }

  // ── Open / close ────────────────────────────────────────────────────────────

  isOpen(key: PanelKey): boolean {
    const decl = this.panel(key);
    return this.#open.some((p) => p.decl === decl);
  }

  /** Open panels, oldest first. */
  get openPanels(): readonly OpenPanel[] {
    return this.#open;
  }

  /** True while any modal panel is open: gameplay input is muted. */
  modalOpen(): boolean {
    return this.#open.some((p) => p.decl.modal);
  }

  /** The most recently opened modal. */
  topModal(): PanelDecl | undefined {
    for (let i = this.#open.length - 1; i >= 0; i--) if (this.#open[i]!.decl.modal) return this.#open[i]!.decl;
    return undefined;
  }

  /** `ctx.ui.open(P, subject=e)`. */
  open(key: PanelKey, subject?: unknown): void {
    const decl = this.panel(key);
    const scene = this.#kernelOrFail().scene;
    if (!inScope(decl.scenes, scene)) {
      fail('PP3420', `Panel "${decl.id}" doesn't exist in scene "${scene?.id ?? '(none)'}"`, {
        fix: 'Open it in a scene its scenes= lists, or widen its scenes=.',
      });
    }
    let subjectId: EntityId | undefined;
    if (subject !== undefined && subject !== null) {
      subjectId = this.#kernelOrFail().handles.unwrap(subject);
      if (subjectId === undefined) fail('PP3421', `subject= takes an entity, got ${String(subject)}`);
    }
    if (this.isOpen(decl)) return;
    const instance = decl.create();
    instance.subject = subject ?? null;
    this.#open.push({ decl, instance, subject: subjectId });
    this.#kernelOrFail().emit(UI_EVENTS.opened, { panel: decl.handle ?? decl.id });
    this.#applyModal();
  }

  /** `ctx.ui.close(P)`. A `when=` panel follows its condition and can't be closed by hand. */
  close(key: PanelKey): void {
    const decl = this.panel(key);
    if (decl.when !== undefined) {
      fail('PP3422', `Panel "${decl.id}" follows its when= condition; it can't be closed directly`, {
        fix: 'Change the state its when= reads instead.',
      });
    }
    this.#close(decl);
  }

  #close(decl: PanelDecl): void {
    const index = this.#open.findIndex((p) => p.decl === decl);
    if (index < 0) return;
    this.#open.splice(index, 1);
    this.#views.delete(decl);
    this.#kernelOrFail().emit(UI_EVENTS.closed, { panel: decl.handle ?? decl.id });
    this.#applyModal();
  }

  #applyModal(): void {
    const modal = this.modalOpen();
    if (modal === this.#frozen) return;
    this.#frozen = modal;
    if (this.#freezeTime) this.#kernelOrFail().setFrozen(modal);
  }

  /**
   * Scene loaded: every panel closes, the scene's `"ui"` list opens, and `when=` panels
   * follow their condition right away ("open exactly while the condition holds"), so a
   * title screen with `when=` is open when the scene starts, not a frame later.
   */
  sceneLoaded(): void {
    const kernel = this.#kernelOrFail();
    for (const open of [...this.#open].reverse()) this.#close(open.decl);
    this.#pending.clear();
    this.#clicks = [];
    const scene = kernel.scene!;
    for (const id of scene.ui) {
      const decl = this.panel(id);
      if (decl.when !== undefined || decl.toggleWith !== undefined || decl.whileHeld !== undefined) {
        fail('PP2081', `Scene "${scene.id}" lists panel "${id}" in "ui", but it opens by itself (when= / toggle_with= / while_held=)`, {
          path: scene.path, fix: `Remove "${id}" from the scene's "ui" list.`,
        });
      }
      this.open(decl);
    }
    for (const decl of this.#decls) if (decl.when !== undefined) this.#derive(decl, kernel);
    this.#applyModal();
  }

  // ── Frame ───────────────────────────────────────────────────────────────────

  /** Kernel hook `ui`. */
  frame(): void {
    const kernel = this.#kernelOrFail();
    const clicks = this.#clicks;
    this.#clicks = [];
    for (const click of clicks) this.#runClick(click);

    for (const open of [...this.#open]) {
      if (open.subject !== undefined && !kernel.world.isAlive(open.subject)) this.#close(open.decl);
    }
    for (const [handle, label] of [...this.#labels]) {
      if (!kernel.world.isAlive(label.entity)) {
        this.#labels.delete(handle);
      }
    }

    for (const decl of this.#decls) this.#derive(decl, kernel);
    this.#applyModal();
  }

  /**
   * The open panels' views, computed after every other 'ui' hook (the plugin adds this one
   * `last`): camera rigs settle in that hook, so world-anchored items (nameplates, markers,
   * prompts) project through this frame's camera, not last frame's.
   */
  computeViews(): void {
    const kernel = this.#kernelOrFail();
    this.#views = new Map();
    for (const open of this.#open) this.#views.set(open.decl, this.#view(open, kernel));
  }

  #derive(decl: PanelDecl, kernel: Kernel): void {
    const ctx = kernel.context;
    const open = this.isOpen(decl);
    if (!inScope(decl.scenes, kernel.scene)) return;
    if (decl.toggleWith !== undefined) {
      const top = open && (!decl.modal || this.topModal() === decl);
      if (open && !top) return;
      if (this.#input!.pressed(decl.toggleWith, top)) {
        if (open) this.#close(decl);
        else this.open(decl);
      }
    } else if (decl.whileHeld !== undefined) {
      const held = this.#input!.held(decl.whileHeld, open);
      if (held && !open) this.open(decl);
      else if (!held && open) this.#close(decl);
    } else if (decl.when !== undefined) {
      // Logic off (an editor's edit mode): when= is game code, so it isn't asked; the panel stays as it is.
      if (!kernel.logic) return;
      if (decl.when(ctx) !== true) {
        this.#pending.delete(decl);
        if (open) this.#close(decl);
        return;
      }
      if (open) return;
      let pending = this.#pending.get(decl);
      if (pending === undefined) {
        const delay = typeof decl.delay === 'function' ? decl.delay(ctx) : (decl.delay ?? 0);
        if (typeof delay !== 'number' || !(delay >= 0)) fail('PP3423', `Panel "${decl.id}": delay() returned ${String(delay)}`, { fix: 'Return 0 or more seconds.' });
        pending = { elapsed: 0, delay };
        this.#pending.set(decl, pending);
      } else {
        pending.elapsed += kernel.time.dt;
      }
      if (pending.elapsed + 1e-9 >= pending.delay) {
        this.#pending.delete(decl);
        this.open(decl);
      }
    }
  }

  #view(open: OpenPanel, kernel: Kernel): PanelView {
    const ctx = kernel.context;
    const decl = open.decl;
    const stateOf = (player?: unknown): Readonly<Record<string, unknown>> => {
      if (typeof open.instance.state !== 'function') return {};
      const value = plain(decl.perPlayer ? open.instance.state(ctx, player) : open.instance.state(ctx));
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        fail('PP3424', `Panel "${decl.id}": state() must return a dict, got ${JSON.stringify(value)}`);
      }
      return value as Record<string, unknown>;
    };
    const states = decl.perPlayer ? this.#players().map((p) => stateOf(p)) : [stateOf()];
    const enabled: Record<string, boolean> = {};
    for (const [name, action] of decl.actions) {
      if (action.kind === 'call' && action.when !== undefined) enabled[name] = action.when(ctx) === true;
    }
    return { id: decl.id, layer: decl.layer, modal: decl.modal, states, enabled };
  }

  /** The last evaluated view of an open panel (after a frame), or undefined while closed. */
  view(key: PanelKey): PanelView | undefined {
    return this.#views.get(this.panel(key));
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  /** Queue a click on a panel action (the renderer, data-key shortcuts, the test driver). Runs in the next `ui` hook. */
  click(key: PanelKey, action: string, data: Readonly<Record<string, unknown>> = {}, seat = 0): void {
    const decl = this.panel(key);
    if (!decl.actions.has(action)) {
      const guess = closestMatch(action, [...decl.actions.keys()]);
      fail('PP2082', `Panel "${decl.id}" has no action "${action}"`, {
        fix: guess !== undefined ? `Did you mean "${guess}"?` : `Actions: ${[...decl.actions.keys()].join(', ') || '(none)'}.`,
      });
    }
    this.#clicks.push({ decl, action, data, seat });
  }

  #runClick(click: Click): void {
    const open = this.#open.find((p) => p.decl === click.decl);
    if (open === undefined) return; // closed since the click
    const action = click.decl.actions.get(click.action)!;
    const kernel = this.#kernelOrFail();
    if (action.kind === 'call' && action.when !== undefined && action.when(kernel.context) !== true) return; // disabled
    const command = this.#perform(action, open, click);
    if (command !== undefined) this.apply(command, open.decl);
    // Games route library panels' buttons through this (`@on(PanelAction)`), without editing the piece.
    kernel.emit(UI_EVENTS.acted, { panel: open.decl.handle ?? open.decl.id, action: click.action, seat: click.seat });
  }

  #perform(action: PanelAction, open: OpenPanel, click: Click): PanelCommand | undefined {
    return performAction(action, {
      ctx: this.#kernelOrFail().context, instance: open.instance, data: click.data, seat: click.seat,
      where: `panel "${open.decl.id}" action "${click.action}"`,
      fix: (name) => `Add data-${name.replace(/_/g, '-')} to the button, or a "${name}" key to the data-each item.`,
    });
  }

  /** Apply a command issued from `from` (a panel button or a function action's return). */
  apply(command: PanelCommand, from: PanelDecl | undefined): void {
    const kernel = this.#kernelOrFail();
    switch (command.kind) {
      case 'close':
        if (from === undefined) fail('PP3426', 'close_panel() only works from a panel action');
        if (from.when !== undefined) {
          fail('PP4423', `close_panel() on panel "${from.id}", which follows its when= condition`, {
            fix: 'Change the state its when= reads instead.',
          });
        }
        this.#close(from);
        return;
      case 'open':
        this.open(command.panel);
        return;
      case 'scene':
        requestSceneCommand(kernel, command);
    }
  }

  // ── Snapshots ───────────────────────────────────────────────────────────────

  /**
   * Which panels are open (oldest first, with their subjects) and the `when=` delays under
   * way. Like behaviors' plain attributes, a panel instance's own attributes are not saved:
   * restore makes new instances. Queued clicks, presentation requests and labels are
   * transient (labels are handles, like timers): a restore drops them.
   */
  snapshot(): UiSnapshot {
    return {
      open: this.#open.map((p) => ({ id: p.decl.id, subject: p.subject ?? null })),
      pending: [...this.#pending].map(([decl, p]) => ({ id: decl.id, elapsed: p.elapsed, delay: p.delay })),
    };
  }

  /** Put the panels back as `snapshot` found them, after the kernel restored the world; no open/close events. */
  restore(saved: UiSnapshot): void {
    const kernel = this.#kernelOrFail();
    const open = saved.open.map(({ id, subject }) => {
      const decl = this.panel(id);
      if (subject !== null && !kernel.world.isAlive(subject as EntityId)) {
        fail('PP9002', `The snapshot's panel "${id}" is about entity ${subject}, which the restored world doesn't have`);
      }
      return { decl, subject: subject === null ? undefined : subject as EntityId };
    });
    const pending = saved.pending.map((p) => ({ decl: this.panel(p.id), elapsed: p.elapsed, delay: p.delay }));
    this.#open = open.map(({ decl, subject }) => {
      const instance = decl.create();
      instance.subject = subject === undefined ? null : kernel.handles.wrap(subject);
      return { decl, instance, subject };
    });
    this.#pending.clear();
    for (const p of pending) this.#pending.set(p.decl, { elapsed: p.elapsed, delay: p.delay });
    this.#clicks = [];
    this.#requests = [];
    this.#labels.clear();
    // The kernel restored time.frozen with the world; follow it rather than re-apply.
    this.#frozen = this.modalOpen();
    this.#views = new Map();
    for (const p of this.#open) this.#views.set(p.decl, this.#view(p, kernel));
  }

  // ── Presentation requests ───────────────────────────────────────────────────

  #entity(handle: unknown, what: string): EntityId {
    const id = this.#kernelOrFail().handles.unwrap(handle);
    if (id === undefined) fail('PP3421', `${what} takes an entity, got ${String(handle)}`);
    return id;
  }

  toast(text: unknown, seconds: number, to: unknown): void {
    this.#requests.push({ kind: 'toast', text, seconds, to });
  }

  announce(title: unknown, subtitle: unknown, seconds: number, to: unknown): void {
    this.#requests.push({ kind: 'announce', title, subtitle, seconds, to });
  }

  floatText(text: string, at: Vec2 | Vec3, color: Color | null, to: unknown, style: UiFloatStyle | null = null): void {
    this.#requests.push({ kind: 'float_text', text, at, color, to, style });
  }

  flash(entity: unknown, color: Color | null, seconds: number): void {
    this.#requests.push({ kind: 'flash', entity: this.#entity(entity, 'flash()'), color, seconds });
  }

  label(entity: unknown, text: unknown, offset: Vec3 | null, kind?: string): Handle {
    const labels = this.#labels;
    const handle: Handle = {
      cancel: () => { labels.delete(handle); },
      get active() { return labels.has(handle); },
    };
    labels.set(handle, { entity: this.#entity(entity, 'label()'), text, offset, ...(kind !== undefined && { kind }) });
    return handle;
  }

  /** Requests since the last take (the renderer drains these each frame). */
  takeRequests(): UiRequest[] {
    const out = this.#requests;
    this.#requests = [];
    return out;
  }

  get requests(): readonly UiRequest[] {
    return this.#requests;
  }

  get labels(): readonly Label[] {
    return [...this.#labels.values()];
  }
}

/** One run of a panel action: what was pressed, by whom, and how to explain a missing parameter. */
export interface ActionRun {
  readonly ctx: unknown;
  readonly instance: PanelInstance;
  /** The pressed element's `data-*` values (strings) or a driver's runtime values. */
  readonly data: Readonly<Record<string, unknown>>;
  readonly seat: number;
  /** Names the action in diagnostics, e.g. `panel "shop" action "buy"`. */
  readonly where: string;
  /** Parameters filled when the data lacks them (in-world screens: `screen`, the screen pressed). */
  readonly implicit?: Readonly<Record<string, unknown>>;
  /** The fix for a parameter the data lacks (PP3425). */
  readonly fix: (name: string) => string;
}

/**
 * Perform a panel action as the engine does for every panel (HUD panels and in-world
 * screens alike): a built-in command as it is; a function action, unless its `when=` is
 * false, with each parameter decoded from the data (`data-*` strings parsed toward the
 * type), its result read as a command. Undefined: nothing to apply.
 */
export function performAction(action: PanelAction, run: ActionRun): PanelCommand | undefined {
  if (action.kind === 'command') return action.command;
  const { ctx, data, where } = run;
  if (action.when !== undefined && action.when(ctx) !== true) return undefined; // disabled
  const args = action.params.map((param) => {
    if (!(param.name in data)) {
      if (run.implicit !== undefined && param.name in run.implicit) return run.implicit[param.name];
      if (param.optional === true) return undefined;
      fail('PP3425', `${where} needs "${param.name}", but the data carried ${JSON.stringify(Object.keys(data))}`, { fix: run.fix(param.name) });
    }
    const decoded = decode(param.type, dataForm(param.type, data[param.name], `${where} argument "${param.name}"`), `${where} argument "${param.name}"`);
    return param.present === undefined ? decoded : param.present(decoded, ctx);
  });
  return commandOf(action.run(ctx, args, run.instance, run.seat), where);
}

/** `reload_scene(...)` / `load_scene(...)`: request the load (null scene: the current one). */
export function requestSceneCommand(kernel: Kernel, command: Extract<PanelCommand, { kind: 'scene' }>): void {
  const scene = command.scene ?? kernel.scene?.id;
  if (scene === undefined) fail('PP9422', 'reload_scene() before any scene loaded');
  kernel.requestScene(scene, {
    ...(command.newRun === true && { newRun: true }),
    ...(command.init !== undefined && { init: command.init }),
    ...(command.seed !== undefined && { seed: command.seed }),
  });
}

/** A function action's return value as a command (null / None: no command). */
export function commandOf(value: unknown, where: string): PanelCommand | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') {
    const inner = (value as Record<string, unknown>)[COMMAND_KEY] ?? value;
    const kind = (inner as { kind?: unknown }).kind;
    if (kind === 'close' || kind === 'open') return inner as PanelCommand;
    if (kind === 'scene') {
      // load_scene/reload_scene are panel-action values only: one way to load from code.
      return fail('PP3427', `${where} returned a scene command; a function loads scenes with ctx.scenes`, {
        fix: 'Call ctx.scenes.load(Scenes.<id>, ...) or ctx.scenes.reload(...) in the function instead of returning load_scene(...) / reload_scene(...).',
      });
    }
  }
  return fail('PP3427', `${where} returned ${String(value)}; a function action returns a panel command or None`, {
    fix: 'Return close_panel() or open_panel(P), or nothing (load scenes with ctx.scenes.load / reload).',
  });
}
