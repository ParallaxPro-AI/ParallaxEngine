/**
 * UI, Python-facing (sdk/parallax/__init__.pyi "UI"): `@ui`, `Panel` / `PlayerPanel` /
 * `SettingsPanel` / `DialoguePanel`, the panel commands, `@action`, and `ctx.ui`. They
 * build the ui plugin's declarations; `interfacePlugins` builds the input and ui plugins
 * wired to each other (a modal mutes gameplay input; the UI reads its own toggle keys).
 *
 *     @ui("pause_menu", html="ui/pause.html", modal=True, toggle_with=Controls.pause)
 *     class PauseMenu(Panel):
 *         actions = {"resume": close_panel(), "quit": load_scene(Scenes.title, new_run=True)}
 *
 * `load_scene` / `reload_scene` are panel-action values only; function code loads scenes
 * with `ctx.scenes.load` / `ctx.scenes.reload`.
 */

import { fail } from '../core/index.js';
import { Color } from '../core/index.js';
import type { InputDevices, UiCursor, UiFloatStyle, UiPanelScale, Vec2, Vec3 } from '../core/index.js';
import type { Condition, Fields, Kernel } from '../function/kernel/index.js';
import { Handle } from './time.js';
import { actionDecl, bindingText, controlRows, input } from '../function/plugins/input/index.js';
import type { ControlRow, InputPlugin, InputScope, Seat } from '../function/plugins/input/index.js';
import { ui as uiPlugin } from '../function/plugins/ui/index.js';
import type {
  PanelAction, PanelCommand as Command, PanelDecl, PanelInstance, PanelLayer, ParamSpec, UiEngine, UiPlugin,
} from '../function/plugins/ui/index.js';
import { Settings } from './builtins.js';
import { Button, registerActions, registeredActionSets, sceneScopes } from './input.js';
import { bindArgs, kw } from './kwargs.js';
import { dictEntries } from './py.js';
import { PyDict } from './pyrt/collections.js';
// Types only: importing pyrt's values here would close an import cycle (pyrt imports the api).
import type { Sig } from './pyrt/objects.js';
import { truthy } from './py.js';
import { isRpc, rpcPanelAction } from './net.js';
import { AssetRef, coerce, resolveType, rt, schemaOf, SceneRef } from './types.js';
import type { AnyClass, CoerceEnv } from './types.js';
import { GIVEN } from './declarations.js';
import { newRunArg, SCENE_KEYWORDS } from './scenes.js';

// ── Commands ───────────────────────────────────────────────────────────────────

/** A built-in panel action, or a function action's return value. */
export class PanelCommand {
  readonly __command__: Command;
  constructor(command: Command) { this.__command__ = command; }
}

/** Close the panel the button is in. */
export function close_panel(...args: unknown[]): PanelCommand {
  bindArgs('close_panel', args, {});
  return new PanelCommand({ kind: 'close' });
}

export function open_panel(...args: unknown[]): PanelCommand {
  const { panel } = bindArgs('open_panel', args, { positional: ['panel'], required: ['panel'] }).args;
  return new PanelCommand({ kind: 'open', panel: panelClass(panel, 'open_panel()') });
}

/** `init=[Run(level=3)]` → resource id → the fields each instance was constructed with. */
function initOf(value: unknown, where: string): Record<string, Fields> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || !(Symbol.iterator in value)) fail('PP4424', `${where} init= takes a list of resource instances`);
  const init: Record<string, Fields> = {};
  for (const item of value as Iterable<unknown>) {
    const id = (item as { constructor?: { __resource_id__?: unknown } } | null)?.constructor?.__resource_id__;
    if (typeof id !== 'string') fail('PP4424', `${where} init= takes resource instances (Run(level=3)), got ${String(item)}`);
    const given = (item as { [GIVEN]?: ReadonlySet<string> })[GIVEN] ?? new Set<string>();
    init[id] = Object.fromEntries([...given].map((name) => [name, (item as Record<string, unknown>)[name]]));
  }
  return init;
}

function sceneCommand(scene: string | null, a: Record<string, unknown>, where: string): PanelCommand {
  const newRun = newRunArg(a, where, 'PP4424');
  const seed = a['seed'] ?? undefined;
  if (seed !== undefined && !Number.isInteger(seed)) fail('PP4424', `${where} seed= must be an int`);
  const init = initOf(a['init'], where);
  return new PanelCommand({
    kind: 'scene', scene,
    ...(newRun && { newRun: true as const }),
    ...(init !== undefined && { init }),
    ...(seed !== undefined && { seed: seed as number }),
  });
}

export function reload_scene(...args: unknown[]): PanelCommand {
  return sceneCommand(null, bindArgs('reload_scene', args, { keyword: SCENE_KEYWORDS }).args, 'reload_scene()');
}

export function load_scene(...args: unknown[]): PanelCommand {
  const a = bindArgs('load_scene', args, { positional: ['scene'], keyword: SCENE_KEYWORDS, required: ['scene'] }).args;
  if (!(a['scene'] instanceof SceneRef)) fail('PP4424', `load_scene() takes a scene (Scenes.<id>), got ${String(a['scene'])}`);
  return sceneCommand(a['scene'].id, a, 'load_scene()');
}

// ── Function actions ───────────────────────────────────────────────────────────

const ACTION_WHEN = Symbol('parallax.action.when');

/** `@action(when=...)`: the function action is disabled while `when` is false. */
export function action(...args: unknown[]): <F>(fn: F) => F {
  const { when } = bindArgs('action', args, { keyword: ['when'] }).args;
  if (when !== undefined && when !== null && typeof when !== 'function') fail('PP4425', '@action when= takes a function of ctx');
  return (fn) => {
    if (typeof fn !== 'function') fail('PP4425', '@action must decorate a function');
    if (typeof when === 'function') Object.defineProperty(fn, ACTION_WHEN, { value: when });
    return fn;
  };
}

// ── Cursor ─────────────────────────────────────────────────────────────────────

const CURSOR_VISUALS: readonly UiCursor['visual'][] = ['ring', 'dot', 'crosshair', 'image', 'system'];

/**
 * How the cursor the engine draws looks: `Game(cursor=...)` for the whole game, `@ui(cursor=...)`
 * while that panel is open. The engine draws it over a modal menu in a mouse-look game (the
 * virtual cursor, which keeps the pointer locked), and with `show_in_menus=True` in place of
 * the OS cursor whenever the cursor is free. Visibility and position are derived; this is
 * only the look.
 */
export class Cursor {
  readonly __cursor__: UiCursor;

  constructor(...args: unknown[]) {
    const a = bindArgs('Cursor', args, {
      positional: ['visual'], keyword: ['size', 'color', 'image', 'hotspot', 'show_in_menus'],
    }).args;
    const visual = (a['visual'] ?? (a['image'] !== undefined && a['image'] !== null ? 'image' : 'ring')) as UiCursor['visual'];
    if (!CURSOR_VISUALS.includes(visual)) {
      fail('PP4429', `Cursor visual must be one of ${CURSOR_VISUALS.map((v) => `"${v}"`).join(', ')}, got ${JSON.stringify(visual)}`);
    }
    const size = a['size'] ?? 24;
    if (typeof size !== 'number' || !(size >= 4 && size <= 256)) fail('PP4429', `Cursor size= must be 4..256 pixels, got ${String(size)}`);
    const color = a['color'] ?? null;
    if (color !== null && !(color instanceof Color)) fail('PP4429', `Cursor color= takes a Color, got ${String(color)}`, { fix: 'Color.hex("#ffd95a") or Color(1, 0.85, 0.35).' });
    const rawImage = a['image'] ?? null;
    const image = rawImage instanceof AssetRef ? rawImage.path : rawImage;
    if (image !== null && (typeof image !== 'string' || image === '')) fail('PP4429', `Cursor image= takes a project path ("assets/ui/cursor.png"), got ${String(rawImage)}`);
    if (visual === 'image' && image === null) fail('PP4429', 'Cursor("image") needs image="<project path>"', { fix: 'Cursor(image="assets/ui/cursor.png").' });
    const rawHotspot = a['hotspot'] ?? [0.5, 0.5];
    const hotspot = typeof rawHotspot === 'object' && rawHotspot !== null && Symbol.iterator in rawHotspot ? [...(rawHotspot as Iterable<unknown>)] : [];
    if (hotspot.length !== 2 || !hotspot.every((v) => typeof v === 'number' && v >= 0 && v <= 1)) {
      fail('PP4429', `Cursor hotspot= is (x, y) as fractions 0..1 of the cursor from its top-left, got ${String(rawHotspot)}`, { fix: 'hotspot=(0, 0) for an arrow, (0.5, 0.5) for a centred ring.' });
    }
    this.__cursor__ = {
      visual, size, color: color === null ? null : [color.r, color.g, color.b, color.a], image,
      hotspot: [hotspot[0] as number, hotspot[1] as number], showInMenus: truthy(a['show_in_menus'] ?? false),
    };
  }

  get visual(): string { return this.__cursor__.visual; }
  get size(): number { return this.__cursor__.size; }
  get show_in_menus(): boolean { return this.__cursor__.showInMenus; }
}

/** `cursor=` of `@ui` / `Game`: a Cursor, or None. */
export function cursorOf(value: unknown, where: string): UiCursor | undefined {
  if (value === undefined || value === null) return undefined;
  if (!(value instanceof Cursor)) fail('PP4429', `${where} cursor= takes a Cursor(...), got ${String(value)}`);
  return value.__cursor__;
}

// ── Floating text ──────────────────────────────────────────────────────────────

const rgbaOf = (c: Color): [number, number, number, number] => [c.r, c.g, c.b, c.a];

/**
 * How `ctx.ui.float_text` looks and moves: damage numbers, score pops, "+50 XP". Keyword-only;
 * keep one per kind of pop as a module constant and pass it as `style=`.
 */
export class FloatStyle {
  readonly __float_style__: UiFloatStyle;

  constructor(...args: unknown[]) {
    const a = bindArgs('FloatStyle', args, {
      keyword: ['size', 'font', 'color', 'outline', 'outline_width', 'bold', 'pop', 'end_scale', 'rise', 'seconds'],
    }).args;
    const num = (key: string, fallback: number, lo: number, hi: number, unit: string): number => {
      const v = a[key] ?? fallback;
      if (typeof v !== 'number' || !(v >= lo && v <= hi)) fail('PP3030', `FloatStyle ${key}= must be ${lo}..${hi} ${unit}, got ${String(v)}`);
      return v;
    };
    const color = (key: string): Color | null => {
      const v = a[key] ?? null;
      if (v !== null && !(v instanceof Color)) fail('PP3030', `FloatStyle ${key}= takes a Color, got ${String(v)}`, { fix: 'Color.hex("#ffd95a") or Color(1, 0.2, 0.2).' });
      return v;
    };
    const font = a['font'] ?? null;
    if (font !== null && (typeof font !== 'string' || font.trim() === '')) fail('PP3030', `FloatStyle font= takes a CSS font-family name, got ${String(font)}`);
    const fill = color('color');
    const outline = color('outline');
    this.__float_style__ = {
      size: num('size', 20, 6, 200, 'pixels'), font, bold: truthy(a['bold'] ?? true),
      color: fill === null ? null : rgbaOf(fill), outline: outline === null ? null : rgbaOf(outline),
      outlineWidth: num('outline_width', 2, 0, 12, 'pixels'), pop: num('pop', 1, 0.1, 4, '(scale at the start)'),
      endScale: num('end_scale', 1, 0, 4, '(scale at the end)'), rise: num('rise', 40, -1000, 1000, 'pixels'),
      seconds: num('seconds', 1, 0.05, 10, 'seconds'),
    };
  }

  get size(): number { return this.__float_style__.size; }
  get rise(): number { return this.__float_style__.rise; }
  get seconds(): number { return this.__float_style__.seconds; }
}

// ── Panels ─────────────────────────────────────────────────────────────────────

/** An HTML panel bound to game state. Subclass it and decorate with `@ui`. */
export class Panel {
  static actions: unknown = {};
  /** The entity the panel is about (`ctx.ui.open(P, subject=e)`), else None. */
  subject: unknown = null;

  state(_ctx: unknown, _player?: unknown): unknown {
    return {};
  }
}

/** One instance per seat: `state(self, ctx, player)`. */
export class PlayerPanel extends Panel {}

/** A panel class's `@ui` options. */
interface PanelOptions {
  readonly id: string;
  readonly html: string;
  readonly modal: boolean;
  readonly layer: PanelLayer;
  readonly scenes: unknown;
  readonly when: unknown;
  readonly delay: unknown;
  readonly toggleWith: unknown;
  readonly whileHeld: unknown;
  readonly cursor: UiCursor | undefined;
  readonly scale: UiPanelScale;
}

const PANEL = Symbol('parallax.panel');
let panels: Function[] = [];
let builtIns: Function[] = [];

function panelOptions(cls: unknown): PanelOptions | undefined {
  return typeof cls === 'function' ? (cls as unknown as { [PANEL]?: PanelOptions })[PANEL] : undefined;
}

function panelClass(value: unknown, where: string): Function {
  if (typeof value !== 'function' || !(value.prototype instanceof Panel)) {
    fail('PP4426', `${where} takes a Panel class, got ${String(value)}`);
  }
  return value;
}

const LAYERS: readonly PanelLayer[] = ['hud', 'menu', 'overlay'];
const SCALES: readonly UiPanelScale[] = ['viewport', 'design', 'none'];

/** `@ui("hud", html="ui/hud.html", modal=False, layer="hud", scenes=(), when=None, delay=0, toggle_with=None, while_held=None, cursor=None, scale="viewport")`. */
export function ui(...args: unknown[]): <T extends AnyClass>(cls: T) => T {
  const a = bindArgs('ui', args, {
    positional: ['id'], keyword: ['html', 'modal', 'layer', 'scenes', 'when', 'delay', 'toggle_with', 'while_held', 'cursor', 'scale'], required: ['id', 'html'],
  }).args;
  const id = a['id'];
  if (typeof id !== 'string' || !/^[a-z][a-z0-9_]*$/.test(id)) fail('PP4427', `@ui id ${JSON.stringify(id)} must be snake_case`);
  if (typeof a['html'] !== 'string' || a['html'] === '') fail('PP4427', `@ui("${id}") needs html="ui/<file>.html"`);
  const layer = a['layer'] ?? 'hud';
  if (!LAYERS.includes(layer as PanelLayer)) fail('PP4427', `@ui("${id}") layer must be "hud", "menu" or "overlay", got ${String(layer)}`);
  const scale = a['scale'] ?? 'viewport';
  if (!SCALES.includes(scale as UiPanelScale)) fail('PP4427', `@ui("${id}") scale must be "viewport", "design" or "none", got ${String(scale)}`);
  for (const key of ['toggle_with', 'while_held'] as const) {
    const v = a[key];
    if (v !== undefined && v !== null && !(v instanceof Button)) fail('PP4427', `@ui("${id}") ${key}= takes a button action (Controls.pause)`);
  }
  if (a['when'] !== undefined && a['when'] !== null && typeof a['when'] !== 'function') fail('PP4427', `@ui("${id}") when= takes a function of ctx`);
  const delay = a['delay'] ?? 0;
  if (typeof delay !== 'number' && typeof delay !== 'function') fail('PP4427', `@ui("${id}") delay= takes seconds or a function of ctx`);
  const options: PanelOptions = {
    id, html: a['html'], modal: truthy(a['modal'] ?? false), layer: layer as PanelLayer, scenes: a['scenes'] ?? [],
    when: a['when'] ?? undefined, delay, toggleWith: a['toggle_with'] ?? undefined, whileHeld: a['while_held'] ?? undefined,
    cursor: cursorOf(a['cursor'], `@ui("${id}")`), scale: scale as UiPanelScale,
  };
  return (cls) => {
    panelClass(cls, `@ui("${id}")`);
    Object.defineProperty(cls, PANEL, { value: options });
    if (!panels.includes(cls)) panels.push(cls);
    return cls;
  };
}

// ── SettingsPanel ──────────────────────────────────────────────────────────────

/** What the SettingsPanel reaches beyond `ctx.get(Settings)`: the game's languages and `ctx.input`'s remapping. */
interface SettingsHost {
  __languages__(): readonly string[];
  readonly input: {
    controls(): readonly ControlRow[];
    rebind(slot: unknown): void;
    readonly rebinding: string | null;
    cancel_rebind(): void;
    reset_controls(): void;
  };
}

/** Numeric settings the menu steps, with the range it keeps them in. */
const STEPPED: Readonly<Record<string, readonly [min: number, max: number]>> = {
  master_volume: [0, 1],
  music_volume: [0, 1],
  sfx_volume: [0, 1],
  mouse_sensitivity: [0.1, 5],
  stick_sensitivity: [0.1, 5],
  text_scale: [0.75, 2],
};
const QUALITIES = ['low', 'medium', 'high'] as const;
const VISION_MODES = ['none', 'protanopia', 'deuteranopia', 'tritanopia'] as const;
/** True/False settings the menu toggles. */
const TOGGLED = ['invert_look', 'reduced_motion', 'high_contrast'] as const;

function settingsOf(ctx: unknown): Record<string, unknown> {
  return (ctx as { get(kind: unknown): Record<string, unknown> }).get(Settings);
}

function hostOf(ctx: unknown): SettingsHost {
  return ctx as SettingsHost;
}

function settingName(setting: unknown, allowed: readonly string[], where: string): string {
  if (typeof setting !== 'string' || !allowed.includes(setting)) {
    fail('PP4440', `SettingsPanel ${where} has no setting ${JSON.stringify(setting)}`, {
      fix: `Use one of: ${allowed.join(', ')} (data-setting="..." on the button).`,
    });
  }
  return setting;
}

/** `adjust(setting, step)`: a volume or sensitivity, stepped and kept in range. */
function settingsAdjust(ctx: unknown, setting: unknown, step: unknown): null {
  const name = settingName(setting, Object.keys(STEPPED), 'adjust');
  const [min, max] = STEPPED[name]!;
  const settings = settingsOf(ctx);
  const next = Math.round(((settings[name] as number) + (step as number)) * 100) / 100;
  settings[name] = Math.max(min, Math.min(max, next));
  return null;
}
Object.defineProperty(settingsAdjust, '__annotations__', { value: { setting: () => rt.str, step: () => rt.float } });

/** `toggle(setting)`: a True/False setting (invert_look, reduced_motion, high_contrast). */
function settingsToggle(ctx: unknown, setting: unknown): null {
  const name = settingName(setting, TOGGLED, 'toggle');
  const settings = settingsOf(ctx);
  settings[name] = !(settings[name] as boolean);
  return null;
}
Object.defineProperty(settingsToggle, '__annotations__', { value: { setting: () => rt.str } });

/** `cycle(setting, step)`: graphics quality, colour-vision mode, or the language among the game's `languages=`. */
function settingsCycle(ctx: unknown, setting: unknown, step: unknown): null {
  const name = settingName(setting, ['quality', 'language', 'colorblind'], 'cycle');
  const options: readonly string[] = name === 'quality' ? QUALITIES : name === 'colorblind' ? VISION_MODES : hostOf(ctx).__languages__();
  const settings = settingsOf(ctx);
  const at = Math.max(0, options.indexOf(settings[name] as string));
  const n = options.length;
  settings[name] = options[(((at + (step as number)) % n) + n) % n]!;
  return null;
}
Object.defineProperty(settingsCycle, '__annotations__', { value: { setting: () => rt.str, step: () => rt.int } });

/** `rebind(slot)`: the next key (or gamepad button, for a gamepad row) becomes the binding; Escape cancels. */
function settingsRebind(ctx: unknown, slot: unknown): null {
  hostOf(ctx).input.rebind(slot);
  return null;
}
Object.defineProperty(settingsRebind, '__annotations__', { value: { slot: () => rt.str } });

/** `reset_controls()`: every action back to the bindings the game declared. */
function settingsResetControls(ctx: unknown): null {
  hostOf(ctx).input.reset_controls();
  return null;
}

/** `back`: close the menu (a rebind in progress is cancelled). */
function settingsBack(ctx: unknown): PanelCommand {
  hostOf(ctx).input.cancel_rebind();
  return close_panel();
}

/** Key codes / gamepad buttons in words and the menu's rows live with the input plugin (`ctx.input.controls()`). */
export { bindingText, controlRows };

/**
 * Built-in options menu (`open_panel(SettingsPanel)`): volumes, quality, language, look
 * sensitivity and invert, and remapping of every action's keyboard key and gamepad
 * button. Its actions write the `Settings` resource, which is keep="profile" (the save
 * plugin persists it); the engine reads it every frame (audio buses, look, language,
 * `controls` remaps).
 */
export class SettingsPanel extends Panel {
  static override actions: unknown = {
    adjust: settingsAdjust,
    toggle: settingsToggle,
    cycle: settingsCycle,
    rebind: settingsRebind,
    reset_controls: settingsResetControls,
    back: settingsBack,
  };

  override state(ctx: unknown): unknown {
    const settings = settingsOf(ctx);
    const host = hostOf(ctx);
    const capturing = host.input.rebinding;
    const controls = host.input.controls();
    const view: Record<string, unknown> = {};
    for (const name of Object.keys(STEPPED)) view[name] = settings[name];
    return {
      ...view,
      quality: settings['quality'],
      language: settings['language'],
      languages_many: host.__languages__().length > 1,
      invert_look: settings['invert_look'],
      reduced_motion: settings['reduced_motion'],
      high_contrast: settings['high_contrast'],
      colorblind: settings['colorblind'],
      controls,
      capturing: capturing !== null,
      remapped: controls.some((c) => c.changed),
    };
  }
}

/** What the DialoguePanel drives: `ctx.story`'s engine-facing methods (api/story.ts). */
interface DialogueDriver {
  __dialogue_view__(): unknown;
  __next__(): void;
  __choose__(option: unknown): void;
}

function storyOf(ctx: unknown): DialogueDriver {
  const story = (ctx as { story?: DialogueDriver }).story;
  if (story === undefined) {
    fail('PP3904', 'The DialoguePanel shows conversations of the story plugin, which this game doesn\'t have', {
      fix: 'Add story() to Game(plugins=[...]) (from parallax import plugins) and start conversations with ctx.story.say(...).',
    });
  }
  return story;
}

/** The DialoguePanel's `next` action: advance the line. */
function dialogueNext(ctx: unknown): null {
  storyOf(ctx).__next__();
  return null;
}

/** The DialoguePanel's `choose` action: pick an option by its index. */
function dialogueChoose(ctx: unknown, option: unknown): null {
  storyOf(ctx).__choose__(option);
  return null;
}
Object.defineProperty(dialogueChoose, '__annotations__', { value: { option: () => rt.int } });

/**
 * Built-in dialogue panel of the story plugin (restylable; Python: `parallax.story.DialoguePanel`,
 * re-exported by api/story.ts and defined here beside the other built-in panels). Modal: gameplay input
 * is muted while a conversation runs (any button still advances it: `dialogue_input`).
 * State: {dialogue, node, speaker, text, tags, options: [{index, speaker, text, enabled}]};
 * actions `next` and `choose(option: int)`.
 */
export class DialoguePanel extends Panel {
  static override actions: unknown = { next: dialogueNext, choose: dialogueChoose };

  override state(ctx: unknown): unknown {
    return storyOf(ctx).__dialogue_view__();
  }
}

ui('settings', kw({ html: 'builtin:settings.html', modal: true, layer: 'menu' }))(SettingsPanel);
ui('dialogue', kw({ html: 'builtin:dialogue.html', modal: true, layer: 'overlay' }))(DialoguePanel);
builtIns = panels;
panels = [];

/**
 * Panels another engine module provides (the HUD kit, the interaction prompt), decorated
 * with `@ui` at that module's load: built-ins every game has, like SettingsPanel.
 */
export function builtinPanels(...classes: Function[]): void {
  for (const cls of classes) {
    panels = panels.filter((c) => c !== cls);
    if (!builtIns.includes(cls)) builtIns.push(cls);
  }
}

/** Every declared panel class: the engine's built-ins, then the game's. */
export function registeredPanels(): Function[] {
  return [...builtIns, ...panels];
}

/** Forget the game's panels (a fresh module realm; tests). */
export function resetPanels(): void {
  panels = [];
}

type Annotated = { __annotations__?: Record<string, () => unknown> };

/** Parameters of a compiled `def` that have defaults (from its `__sig__`). */
function defaulted(fn: Function): Set<string> {
  const sig = (fn as { __sig__?: Sig }).__sig__;
  if (sig === undefined) return new Set();
  const positional = sig.params.slice(sig.params.length - sig.defaults.length);
  // A keyword-only parameter without a default holds pyrt's NO_DEFAULT symbol; no Python value is a symbol.
  const keyword = sig.kwonly.filter((_, i) => typeof sig.kwdefaults[i] !== 'symbol');
  return new Set([...positional, ...keyword]);
}

/**
 * Typed parameters of a function action, from its `__annotations__` thunks (ctx is
 * unannotated). A parameter with a default may be left out of a click.
 */
function paramsOf(fn: Function, where: string, env: CoerceEnv): ParamSpec[] {
  const annotations = (fn as Annotated).__annotations__ ?? {};
  const optional = defaulted(fn);
  return Object.entries(annotations)
    .filter(([name]) => name !== 'return' && name !== 'ctx')
    .map(([name, thunk]) => {
      const type = resolveType(thunk(), `${where} parameter "${name}"`);
      return {
        name, type: type.field, optional: optional.has(name), present: (v: unknown) => coerce(type, v, env, `${where}.${name}`),
      };
    });
}

function entries(value: unknown, where: string): [string, unknown][] {
  if (value instanceof Map) return [...value].map(([k, v]) => [String(k), v]);
  if (value instanceof PyDict || (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype)) {
    return dictEntries(value, `${where} actions`);
  }
  return fail('PP4428', `${where} actions must be a dict of name → action`);
}

function panelAction(value: unknown, where: string, env: CoerceEnv): PanelAction {
  if (isRpc(value)) return rpcPanelAction(value) as PanelAction;
  if (value instanceof PanelCommand) return { kind: 'command', command: value.__command__ };
  const eventDef = typeof value === 'function' ? (value as { __event_def__?: unknown }).__event_def__ : undefined;
  if (eventDef !== undefined) {
    const cls = value as AnyClass;
    const fields = schemaOf(cls, `event ${cls.name}`).fields;
    return {
      kind: 'call',
      params: fields.map((f) => ({ name: f.name, type: f.type.field, present: (v: unknown) => coerce(f.type, v, env, `${where}.${f.name}`) })),
      run: (ctx, args) => {
        const values = Object.fromEntries(fields.map((f, i) => [f.name, args[i]]));
        (ctx as { emit(event: unknown): void }).emit(new (cls as unknown as new (k: unknown) => object)(kw(values)));
        return null;
      },
    };
  }
  if (typeof value === 'function') {
    const fn = value as (...a: unknown[]) => unknown;
    const when = (fn as unknown as { [ACTION_WHEN]?: (ctx: unknown) => unknown })[ACTION_WHEN];
    const params = paramsOf(fn, where, env);
    return {
      kind: 'call',
      params,
      ...(when !== undefined && { when: ((ctx: unknown) => truthy(when(ctx))) as Condition }),
      // A compiled def is called by keyword, leaving out what the click left out, so its defaults apply.
      run: (ctx, args) => ('__sig__' in fn
        ? fn(ctx, kw(Object.fromEntries(params.flatMap((p, i) => (args[i] === undefined ? [] : [[p.name, args[i]]])))))
        : fn(ctx, ...args)),
    };
  }
  return fail('PP4428', `${where} is ${String(value)}; a panel action is close_panel()/open_panel()/reload_scene()/load_scene(), a function, or an event class`);
}

/** The ui plugin's declaration of a `@ui` Panel class. */
export function panelDecl(cls: unknown, env: CoerceEnv): PanelDecl {
  const options = panelOptions(cls);
  if (options === undefined) fail('PP4426', `${String(cls)} is a Panel without @ui`, { fix: 'Decorate it with @ui("id", html=...).' });
  const Cls = cls as new () => Panel;
  const where = `panel "${options.id}"`;
  const actions = new Map(entries((Cls as unknown as typeof Panel).actions, where)
    .map(([name, value]) => [name, panelAction(value, `${where} action "${name}"`, env)]));
  const when = options.when as ((ctx: unknown) => unknown) | undefined;
  const delay = options.delay as number | ((ctx: unknown) => unknown);
  return {
    id: options.id,
    html: options.html,
    modal: options.modal,
    layer: options.layer,
    scenes: sceneScopes(options.scenes, `@ui("${options.id}")`),
    ...(when !== undefined && { when: (ctx: unknown) => truthy(when(ctx)) }),
    ...(when !== undefined && delay !== 0 && { delay: typeof delay === 'number' ? delay : (ctx: unknown) => delay(ctx) as number }),
    ...(options.toggleWith !== undefined && { toggleWith: options.toggleWith }),
    ...(options.whileHeld !== undefined && { whileHeld: options.whileHeld }),
    ...(options.cursor !== undefined && { cursor: options.cursor }),
    ...(options.scale !== 'viewport' && { scale: options.scale }),
    perPlayer: Cls.prototype instanceof PlayerPanel,
    actions,
    handle: Cls,
    create: () => new Cls() as unknown as PanelInstance,
  };
}

// ── ctx.ui ─────────────────────────────────────────────────────────────────────

export class UiApi {
  readonly #engine: UiEngine;

  constructor(engine: UiEngine) {
    this.#engine = engine;
  }

  /** For panels opened by game events (a shop when touching a shopkeeper). */
  open(...args: unknown[]): void {
    const a = bindArgs('ui.open', args, { positional: ['panel'], keyword: ['subject'], required: ['panel'] }).args;
    this.#engine.open(panelClass(a['panel'], 'ui.open()'), a['subject'] ?? undefined);
  }

  close(...args: unknown[]): void {
    const a = bindArgs('ui.close', args, { positional: ['panel'], required: ['panel'] }).args;
    this.#engine.close(panelClass(a['panel'], 'ui.close()'));
  }

  is_open(...args: unknown[]): boolean {
    const a = bindArgs('ui.is_open', args, { positional: ['panel'], required: ['panel'] }).args;
    return this.#engine.isOpen(panelClass(a['panel'], 'ui.is_open()'));
  }

  toast(...args: unknown[]): void {
    const a = bindArgs('ui.toast', args, { positional: ['text'], keyword: ['seconds', 'to'], required: ['text'] }).args;
    this.#engine.toast(a['text'], seconds(a['seconds'], 2), a['to'] ?? null);
  }

  announce(...args: unknown[]): void {
    const a = bindArgs('ui.announce', args, { positional: ['title', 'subtitle'], keyword: ['seconds', 'to'], required: ['title'] }).args;
    this.#engine.announce(a['title'], a['subtitle'] ?? null, seconds(a['seconds'], 2), a['to'] ?? null);
  }

  float_text(...args: unknown[]): void {
    const a = bindArgs('ui.float_text', args, { positional: ['text', 'at'], keyword: ['color', 'style', 'to'], required: ['text', 'at'] }).args;
    if (typeof a['text'] !== 'string') fail('PP3030', 'ui.float_text() text must be a str', { fix: 'Format it first: ctx.ui.float_text(f"-{amount}", at).' });
    const style = a['style'] ?? null;
    if (style !== null && !(style instanceof FloatStyle)) fail('PP3030', `ui.float_text() style= takes a FloatStyle(...), got ${String(style)}`);
    this.#engine.floatText(a['text'], a['at'] as Vec2 | Vec3, (a['color'] ?? null) as Color | null, a['to'] ?? null, style?.__float_style__ ?? null);
  }

  flash(...args: unknown[]): void {
    const a = bindArgs('ui.flash', args, { positional: ['entity'], keyword: ['color', 'seconds'], required: ['entity'] }).args;
    this.#engine.flash(a['entity'], (a['color'] ?? null) as Color | null, seconds(a['seconds'], 0.1));
  }

  /** A world-space label following an entity (name tags, prompts). */
  label(...args: unknown[]): Handle {
    const a = bindArgs('ui.label', args, { positional: ['entity', 'text'], keyword: ['offset', 'kind'], required: ['entity', 'text'] }).args;
    const kind = a['kind'] ?? undefined;
    if (kind !== undefined && (typeof kind !== 'string' || !/^[a-z][a-z0-9_-]*$/.test(kind))) {
      fail('PP3030', `ui.label() kind= is a style name (a CSS class: "you", "pass"), got ${String(kind)}`);
    }
    // An api Handle, so game code can keep it in a `Handle | None` field.
    return new Handle(this.#engine.label(a['entity'], a['text'], (a['offset'] ?? null) as Vec3 | null, kind as string | undefined));
  }
}

function seconds(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !(value >= 0)) fail('PP3030', `seconds= must be 0 or more, got ${String(value)}`);
  return value;
}

// ── Building both plugins ──────────────────────────────────────────────────────

export interface InterfaceOptions {
  readonly devices: InputDevices;
  /** Default: every registered Actions subclass / @ui panel. */
  readonly actionSets?: readonly unknown[];
  readonly panels?: readonly unknown[];
  readonly seats?: readonly Seat[];
  /** Who is reading input now (the running behavior's owner and its seat). */
  readonly scope?: InputScope;
  /** Seat player handles for PlayerPanel.state(ctx, player). */
  readonly players?: () => readonly unknown[];
  /** Content lookups for typed action arguments (`ContentRef[LevelDef]`). */
  readonly content: CoerceEnv;
  /** Freeze time under a modal (default true; false with the net plugin). */
  readonly freezeTime?: boolean;
  /** A touch button's label as the player reads it (locale key → text). */
  readonly touchLabel?: (label: string) => string;
  /** The player's control remaps (`Settings.controls`). */
  readonly overrides?: () => Readonly<Record<string, string>>;
  /** Store them; default: `Settings.controls` on the kernel. */
  readonly setOverrides?: (next: Readonly<Record<string, string>>, kernel: Kernel | undefined) => void;
}

/** The input and ui plugins, wired: modals mute gameplay input; toggle/while-held keys read through the input plugin. */
export function interfacePlugins(options: InterfaceOptions): { readonly input: InputPlugin; readonly ui: UiPlugin } {
  let uiEngine: UiEngine | undefined;
  const inputPlugin = input({
    devices: options.devices,
    sets: options.actionSets === undefined ? registeredActionSets() : options.actionSets.map((cls) => registerActions(cls)),
    ...(options.seats !== undefined && { seats: options.seats }),
    ...(options.scope !== undefined && { scope: options.scope }),
    muted: () => uiEngine?.modalOpen() ?? false,
    ...(options.touchLabel !== undefined && { touchLabel: options.touchLabel }),
    ...(options.overrides !== undefined && { overrides: options.overrides }),
    // `ctx.input.rebind` / `reset_controls` store into Settings.controls (keep="profile": saved with the profile).
    setOverrides: options.setOverrides ?? ((next, kernel) => {
      if (kernel !== undefined) kernel.resource('settings')['controls'] = PyDict.from(Object.entries(next));
    }),
  });
  const engine = inputPlugin.engine;
  const anySeat = (read: (seat: number) => boolean): boolean => engine.seats.some((s) => read(s.index));
  const plugin = uiPlugin({
    panels: (options.panels ?? registeredPanels()).map((cls) => panelDecl(cls, options.content)),
    input: {
      pressed: (a, ignoreMute) => anySeat((seat) => engine.pressed(actionDecl(a) as never, { seat, owner: null }, { ignoreMute })),
      held: (a, ignoreMute) => anySeat((seat) => engine.held(actionDecl(a) as never, { seat, owner: null }, { ignoreMute })),
    },
    ...(options.players !== undefined && { players: options.players }),
    ...(options.freezeTime !== undefined && { freezeTime: options.freezeTime }),
    namespace: (e) => new UiApi(e),
  });
  uiEngine = plugin.engine;
  return { input: inputPlugin, ui: plugin };
}
