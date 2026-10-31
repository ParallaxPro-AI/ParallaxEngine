/**
 * Declarations: the engine form of a game's `@ui` panels and their actions. The api layer
 * builds these from decorated `Panel` subclasses; the ui plugin never sees Python types.
 */

import type { UiCursor, UiPanelScale } from '../../../core/index.js';
import type { Condition, FieldType, Fields, SceneScope } from '../../kernel/index.js';

export type PanelLayer = 'hud' | 'menu' | 'overlay';

/** A panel by id, or by its handle (the game's Panel class). */
export type PanelKey = string | object;

/** A built-in action: `close_panel()`, `open_panel(P)`, `reload_scene(...)`, `load_scene(...)`. */
export type PanelCommand =
  | { readonly kind: 'close' }
  | { readonly kind: 'open'; readonly panel: PanelKey }
  | {
    readonly kind: 'scene';
    /** null: reload the current scene. */
    readonly scene: string | null;
    /** Start a new run (`new_run=True`). */
    readonly newRun?: true;
    /** Resource id → fields (runtime values), applied after the reset. */
    readonly init?: Readonly<Record<string, Fields>>;
    readonly seed?: number;
  };

/** The handle property under which an api command object carries its `PanelCommand`. */
export const COMMAND_KEY = '__command__';

/** One typed parameter of a function action, filled from the clicked element's data. */
export interface ParamSpec {
  readonly name: string;
  /** Stored type: the payload value is decoded against it (strings from `data-*` are parsed first). */
  readonly type: FieldType;
  /** Decoded value → what the function receives (a ContentRef, an Enum member…). */
  readonly present?: (decoded: unknown, ctx: unknown) => unknown;
  /** It has a default: a click may leave it out, and `run` then gets `undefined` for it. */
  readonly optional?: boolean;
}

export type PanelAction =
  | { readonly kind: 'command'; readonly command: PanelCommand }
  /**
   * A function action (or an event class: `run` emits it). Arguments arrive in `params`
   * order. It may return a command (or a handle carrying one under `__command__`).
   */
  | {
    readonly kind: 'call';
    readonly params: readonly ParamSpec[];
    /** Disabled (and its buttons greyed) while false. */
    readonly when?: Condition;
    run(ctx: unknown, args: readonly unknown[], panel: PanelInstance, seat: number): unknown;
  };

/** The game's panel instance (a `Panel` subclass). The plugin sets `subject`. */
export interface PanelInstance {
  subject?: unknown;
  state?(ctx: unknown, player?: unknown): unknown;
}

export interface PanelDecl {
  readonly id: string;
  readonly html: string;
  readonly modal: boolean;
  readonly layer: PanelLayer;
  /** Empty: every scene. */
  readonly scenes: readonly SceneScope[];
  /** Open exactly while true. */
  readonly when?: Condition;
  /** With `when`: seconds (or `delay(ctx)`) the condition must hold before opening. */
  readonly delay?: number | ((ctx: unknown) => number);
  /** An action handle: opens the panel, and closes it while it's on top. */
  readonly toggleWith?: unknown;
  /** An action handle: open while held. */
  readonly whileHeld?: unknown;
  /** The cursor's look while this is the top open panel with one (`@ui(cursor=Cursor(...))`). */
  readonly cursor?: UiCursor;
  /** How its CSS pixels map onto the screen (`@ui(scale=...)`); absent: 'viewport'. */
  readonly scale?: UiPanelScale;
  /** One state per seat (`PlayerPanel`): `state(ctx, player)`. */
  readonly perPlayer: boolean;
  readonly actions: ReadonlyMap<string, PanelAction>;
  /** The game-facing handle (the Panel class): `PanelOpened.panel`, lookups by class. */
  readonly handle: object | undefined;
  create(): PanelInstance;
}
