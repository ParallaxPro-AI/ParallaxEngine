/**
 * `ctx.scenes`: which scene is loaded, and changing it at the end of the frame — with a
 * run reset, resource `init` values and the seed for `random` / `ctx.seed`.
 */

import { fail } from '../core/index.js';
import type { DiagnosticCode } from '../core/index.js';
import type { Fields, SceneRequest } from '../function/kernel/index.js';
import { GIVEN } from './declarations.js';
import { bindArgs } from './kwargs.js';
import { SceneRef, Tag } from './types.js';
import type { GameRuntime } from './runtime.js';

export class ScenesApi {
  readonly #rt: GameRuntime;

  constructor(rt: GameRuntime) {
    this.#rt = rt;
  }

  /** Removed: one way to ask which scene is loaded. */
  get current(): never {
    return fail('PP3039', 'ctx.scenes.current was removed', {
      fix: 'Use ctx.scenes.current_is(Scenes.<id>) (or a scene Tag); to match content, '
        + 'first(lambda d: ctx.scenes.current_is(d.scene)).',
    });
  }

  current_is(scene_or_tag: unknown): boolean {
    const scene = this.#rt.kernel.scene;
    if (scene === undefined) return false;
    if (scene_or_tag instanceof SceneRef) return scene.id === scene_or_tag.id;
    if (scene_or_tag instanceof Tag) return scene.tags.includes(scene_or_tag.id);
    return fail('PP3039', `current_is() takes a scene (Scenes.<id>) or a scene Tag, got ${String(scene_or_tag)}`);
  }

  load(...args: unknown[]): void {
    const a = bindArgs('load', args, { positional: ['scene'], keyword: SCENE_KEYWORDS, required: ['scene'] }).args;
    const scene = a['scene'];
    if (!(scene instanceof SceneRef)) fail('PP3039', `load() takes a scene (Scenes.<id>), got ${String(scene)}`);
    this.#request(scene.id, a, 'ctx.scenes.load()');
  }

  reload(...args: unknown[]): void {
    const a = bindArgs('reload', args, { keyword: SCENE_KEYWORDS }).args;
    const scene = this.#rt.kernel.scene;
    if (scene === undefined) fail('PP3039', 'ctx.scenes.reload() before any scene loaded');
    this.#request(scene.id, a, 'ctx.scenes.reload()');
  }

  #request(sceneId: string, a: Record<string, unknown>, where: string): void {
    const newRun = newRunArg(a, where, 'PP3039');
    const seed = a['seed'] ?? null;
    if (seed !== null && !Number.isInteger(seed)) fail('PP3039', `seed= must be an int, got ${String(seed)}`);
    const request: { -readonly [K in keyof SceneRequest]: SceneRequest[K] } = {};
    if (newRun) request.newRun = true;
    const init = initValues(a['init']);
    if (init !== undefined) request.init = init;
    this.#rt.requestScene(sceneId, request, seed as number | null);
  }
}

/** Keywords of every scene load (`reset` only to name its replacement). */
export const SCENE_KEYWORDS = ['new_run', 'init', 'seed', 'reset'];

/**
 * `new_run=True`: start a new run. The old `reset="run"` fails naming it. `code` is the
 * caller's own (ctx.scenes here, the panel commands in ui.ts).
 */
export function newRunArg(a: Record<string, unknown>, where: string, code: DiagnosticCode): boolean {
  if (a['reset'] !== undefined) {
    fail(code, `${where}: reset= was renamed`, { fix: 'Write new_run=True instead of reset="run".' });
  }
  const newRun = a['new_run'] ?? false;
  if (typeof newRun !== 'boolean') fail(code, `${where} new_run= must be True or False, got ${String(newRun)}`);
  return newRun;
}

/** `init=[Run(level=3)]` → resource id → the fields each instance was constructed with. */
function initValues(value: unknown): Record<string, Fields> | undefined {
  if (value === undefined || value === null) return undefined;
  const init: Record<string, Fields> = {};
  for (const instance of value as Iterable<unknown>) {
    const id = (instance as { constructor?: { __resource_id__?: unknown } } | null)?.constructor?.__resource_id__;
    if (typeof id !== 'string') fail('PP3039', `init= takes resource instances (Run(level=3)), got ${String(instance)}`);
    const given = (instance as Record<symbol, Set<string>>)[GIVEN] ?? new Set<string>();
    init[id] = Object.fromEntries([...given].map((name) => [name, (instance as Fields)[name]]));
  }
  return init;
}
