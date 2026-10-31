/**
 * The shape of `build/declarations.json`, written by the transpiler's extract pass
 * (`parallax_transpiler/extract`, contract C2). Field types are the kernel's
 * `FieldType`; field specs are the kernel's `FieldSpec` plus authoring metadata.
 */

import type { FieldSpec, FieldType } from '@parallax/runtime/kernel';

export type { FieldType };

export interface DeclaredField extends Omit<FieldSpec, 'default'> {
  /** Authored-JSON form (what a data file would say). Absent = required in data. */
  readonly default?: unknown;
  /** SDK stubs only: the engine supplies a default (`= ...`). */
  readonly engine_default?: boolean;
  /** A live handle (Player, Handle, type[...]): never written in data files. */
  readonly runtime_only?: boolean;
  /** A default the extract pass couldn't read statically (reported as PP4002). */
  readonly default_expr?: string;
  readonly unit?: string;
  readonly doc?: string;
  readonly choices?: readonly unknown[];
  readonly replicate?: boolean | string;
  readonly annotation: string;
  readonly line: number;
}

export type DeclaredSchema = Readonly<Record<string, DeclaredField>>;

interface Located {
  readonly name: string;
  readonly module: string;
  readonly feature: string | null;
  readonly path: string;
  readonly line: number;
  readonly doc?: string;
}

export interface DataDecl extends Located {
  readonly fields: DeclaredSchema;
  /** Paths of `Localized` text inside a value: "name", "waves[].title", "steps{}.text". */
  readonly localized: readonly string[];
}

export interface ResourceDecl extends DataDecl {
  readonly keep: string;
}

export interface ContentDecl extends DataDecl {
  readonly kind: string;
  readonly order?: string;
  /** A built-in kind this class extends (`quest`). */
  readonly extends?: string;
}

export interface EventDecl extends Located {
  readonly fields: DeclaredSchema;
  readonly target?: string;
}

export interface HandlerDecl {
  readonly method: string;
  readonly line: number;
  readonly event?: string;
  readonly when?: boolean;
  readonly where?: boolean;
  readonly always?: boolean;
}

export type ScopeEntry = { readonly scene: string; readonly line: number } | { readonly tag: string; readonly line: number };

export interface BehaviorDecl extends Located {
  readonly params: DeclaredSchema;
  readonly state: DeclaredSchema;
  readonly requires: readonly string[];
  readonly tick: string | number;
  readonly when: boolean;
  readonly hooks: readonly string[];
  readonly handlers: readonly HandlerDecl[];
}

export interface SystemDecl extends Located {
  readonly scenes: readonly ScopeEntry[];
  readonly after: readonly string[];
  readonly when: boolean;
  readonly runs_while_frozen: boolean;
  readonly runs_on: string;
  readonly hooks: readonly string[];
  readonly handlers: readonly HandlerDecl[];
}

export type Shape =
  | { readonly kind: 'object'; readonly keys: Readonly<Record<string, Shape>>; readonly open: boolean }
  | { readonly kind: 'list'; readonly item: Shape }
  | { readonly kind: 'value' }
  | { readonly kind: 'any' };

export type PanelAction =
  | { readonly kind: 'command'; readonly command: string; readonly line: number; readonly panel?: string;
    readonly builtin?: string; readonly scene?: string; readonly new_run?: boolean }
  | { readonly kind: 'event'; readonly event: string; readonly line: number }
  | { readonly kind: 'function' | 'rpc'; readonly name: string; readonly line: number; readonly params: readonly string[];
    readonly required?: readonly string[]; readonly param_types: Readonly<Record<string, FieldType>>; readonly when?: boolean }
  | { readonly kind: 'unknown'; readonly line: number; readonly source: string };

export interface ActionRef {
  readonly action_set: string;
  readonly action: string;
}

export interface PanelDecl extends Located {
  readonly html?: string;
  readonly modal: boolean;
  readonly layer: string;
  readonly scenes: readonly ScopeEntry[];
  readonly when: boolean;
  readonly delay: number | 'dynamic';
  readonly per_player: boolean;
  readonly toggle_with?: ActionRef;
  readonly while_held?: ActionRef;
  readonly actions: Readonly<Record<string, PanelAction>>;
  readonly actions_dynamic?: boolean;
  /** What `state()` returns; null when it can't be known statically. */
  readonly state: Shape | null;
}

export interface ActionSetDecl extends Located {
  readonly actions: Readonly<Record<string, { readonly kind: string; readonly bindings: Readonly<Record<string, unknown>>; readonly line: number }>>;
  readonly priority: number;
  readonly scenes: readonly ScopeEntry[];
  readonly active_when: boolean;
}

export interface FunctionDecl {
  readonly kind: 'rpc' | 'quest_verb' | 'dialogue_command' | 'migration' | 'action';
  readonly name: string;
  readonly module: string;
  readonly path: string;
  readonly line: number;
  readonly id?: string;
  readonly from_version?: number;
  readonly to_version?: number;
  readonly target?: FieldType;
  readonly args?: Readonly<Record<string, { readonly type: FieldType }>>;
}

export interface FeatureDecl {
  readonly variable: string;
  readonly folder: string | null;
  readonly path: string;
  readonly line: number;
  readonly requires: readonly string[];
  readonly systems: readonly string[];
  readonly scenes: readonly ScopeEntry[];
  readonly doc?: string;
}

export interface PluginUse {
  readonly id: string;
  readonly options: Readonly<Record<string, unknown>>;
  readonly line: number;
}

export interface GameDecl {
  readonly path: string;
  readonly line: number;
  readonly id?: string;
  readonly title?: string;
  readonly sdk?: string;
  readonly mode?: '2d' | '3d';
  readonly start_scene?: string;
  readonly plugins: readonly PluginUse[];
  readonly features: readonly string[];
  readonly systems: readonly string[];
  readonly languages: readonly string[];
  readonly save_version: number;
  /** `pointer_lock=False`: no host pointer lock for play (absent: True). */
  readonly pointer_lock?: boolean;
}

export interface EngineDecl {
  readonly name: string;
  readonly module: string;
  /** Plugins that provide it; "core" means always present. */
  readonly plugins: readonly string[];
  readonly fields: DeclaredSchema;
  readonly target?: string;
  readonly localized?: readonly string[];
}

export interface ModuleImports {
  readonly path: string;
  readonly feature: string | null;
  readonly imports: readonly { readonly module: string; readonly line: number }[];
}

export interface ProjectRefUse {
  /** ["Prefabs", "ball"], ["Assets", "sfx", "hit"], ["Content", "enemy", "slime", "data"]… */
  readonly ref: readonly string[];
  readonly path: string;
  readonly line: number;
  readonly column: number;
}

export interface SpawnSite {
  /** The prefab id, or null when the prefab is chosen at runtime (from content, a param…). */
  readonly prefab: string | null;
  readonly path: string;
  readonly line: number;
  /** Component ids passed in `components=`; null when they can't be read statically. */
  readonly components: readonly string[] | null;
  /** Behavior ids given `params=`; null when not static. */
  readonly params: readonly string[] | null;
}

export interface ExtractDiagnostic {
  readonly code: `PP${number}`;
  readonly severity: 'error' | 'warning';
  readonly message: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly fix: string | null;
}

export interface Declarations {
  readonly version: number;
  readonly game: GameDecl | null;
  readonly components: Readonly<Record<string, DataDecl>>;
  readonly tags: Readonly<Record<string, Located>>;
  readonly resources: Readonly<Record<string, ResourceDecl>>;
  readonly configs: Readonly<Record<string, DataDecl>>;
  readonly content: Readonly<Record<string, ContentDecl>>;
  readonly records: Readonly<Record<string, DataDecl>>;
  readonly enums: Readonly<Record<string, Located & { readonly values: readonly string[] }>>;
  readonly events: Readonly<Record<string, EventDecl>>;
  readonly behaviors: Readonly<Record<string, BehaviorDecl>>;
  readonly systems: Readonly<Record<string, SystemDecl>>;
  readonly panels: Readonly<Record<string, PanelDecl>>;
  readonly action_sets: Readonly<Record<string, ActionSetDecl>>;
  readonly functions: Readonly<Record<string, FunctionDecl>>;
  readonly facts: Readonly<Record<string, { readonly name: string; readonly module: string; readonly default: unknown }>>;
  readonly features: Readonly<Record<string, FeatureDecl>>;
  readonly engine: {
    readonly components: Readonly<Record<string, EngineDecl>>;
    readonly events: Readonly<Record<string, EngineDecl>>;
    readonly content: Readonly<Record<string, EngineDecl>>;
    readonly resources: Readonly<Record<string, EngineDecl>>;
    readonly records: Readonly<Record<string, EngineDecl>>;
  };
  readonly modules: Readonly<Record<string, ModuleImports>>;
  readonly project_refs: readonly ProjectRefUse[];
  readonly spawns: readonly SpawnSite[];
  readonly approximations: readonly { readonly path: string; readonly line: number; readonly field: string; readonly note: string }[];
  readonly diagnostics: readonly ExtractDiagnostic[];
}
