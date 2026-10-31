/**
 * cinematics — data-authored sequences (sdk/parallax/cinematics.pyi): the `cinematic`
 * content kind (timeline.ts documents the format), the `cinematic_trigger` component, the
 * `cinematic_started` / `cinematic_marker` / `cinematic_ended` events and `ctx.cinematics`
 * (built by the api from the engine). engine.ts documents timing, skipping and snapshots.
 *
 * Imports core, resource, the kernel and services only: the camera is driven through the
 * `camera` component's SDK fields (`rig`, `fov`), its `shake` method and its transform; depth
 * of field through the visuals plugin's `depth_of_field` component; clips through the
 * `animator` / `sprite` components' `play`; sounds and music through the audio service; the
 * grade through the environment service; effects through the host (the api's `ctx.vfx`).
 *
 * One `cinematics(...)` value serves one kernel.
 */

import { fail } from '../../../core/index.js';
import type { Json } from '../../../resource/index.js';
import { KERNEL_EVENTS, t } from '../../kernel/index.js';
import type { ComponentDef, Fields, Kernel, KernelPlugin, Schema, SystemDef } from '../../kernel/index.js';
import { CINEMATIC_EVENTS, CINEMATIC_TRIGGER, CinematicsEngine } from './engine.js';
import type { CinematicsHost, SavedRun } from './engine.js';
import { CINEMATIC } from './timeline.js';

export { ANIMATABLE_KINDS, CAMERA_GROUND_CLEARANCE, CINEMATIC_EVENTS, CINEMATIC_TRIGGER, CinematicsEngine, DEPTH_OF_FIELD } from './engine.js';
export type { CinematicsHost, Presentation, SavedRun, VfxOptions } from './engine.js';
export { DEFAULT_EASE, ease, EASES, EASE_NAMES } from './easing.js';
export {
  CINEMATIC, dialogueAt, DUE, holdTimes, parseCinematic, sample, SINGLE_TRACKS, slerp, subtitleAt, targetNames, TRACK_TYPES,
} from './timeline.js';
export type { Cinematic, ParseResult, Track, TrackType } from './timeline.js';

export const CINEMATIC_TRIGGER_SCHEMA: Schema = {
  cinematic: t.ref(`content/${CINEMATIC}`),
  /** Meters from the trigger's position. */
  radius: t.number({ default: 3, min: 0 }),
  /** Entities with this tag set it off. */
  activator: { type: { kind: 'tag' } },
  /** Fire the first time only. */
  once: t.bool({ default: true }),
  /** Kept by the engine: it has fired. */
  fired: t.bool({ default: false }),
  /** Kept by the engine: an activator is inside (it fires on entering). */
  occupied: t.bool({ default: false }),
};

export interface CinematicsOptions {
  /** The button that skips a skippable cinematic (`Controls.skip`); undefined: only code skips. */
  readonly skip?: unknown;
  /** The button that advances a waiting dialogue line (`Controls.advance`); undefined: the panel's Continue or code. */
  readonly advance?: unknown;
  readonly host: CinematicsHost;
  /** `ctx.cinematics`, built by the api over the engine. */
  readonly namespace?: (engine: CinematicsEngine) => object;
}

export interface CinematicsPlugin extends KernelPlugin {
  /** The engine of the kernel it is installed in (tests and the api). */
  engine(): CinematicsEngine;
}

export function cinematics(options: CinematicsOptions): CinematicsPlugin {
  let engine: CinematicsEngine | undefined;
  let installedOn: Kernel | undefined;
  const current = (): CinematicsEngine => {
    if (engine === undefined) fail('PP7290', 'The cinematics plugin is used before its kernel was built');
    return engine;
  };
  const system: SystemDef = {
    id: 'cinematics.player',
    scenes: [],
    handlers: [{ event: KERNEL_EVENTS.sceneLoaded, method: 'loaded', always: true }],
    create: () => ({
      update: (_ctx: unknown, dt: number) => current().update(dt),
      loaded: (_ctx: unknown, payload: Fields) => current().sceneLoaded(payload['scene'] as string),
    }),
  };
  const components: ComponentDef[] = [{ id: CINEMATIC_TRIGGER, schema: CINEMATIC_TRIGGER_SCHEMA }];
  return {
    id: 'cinematics',
    components,
    events: Object.values(CINEMATIC_EVENTS),
    systems: [system],
    install(kernel) {
      if (installedOn !== undefined) {
        fail('PP7291', 'This cinematics plugin is already installed in another kernel', { fix: 'Call cinematics(...) once per kernel.' });
      }
      installedOn = kernel;
      const created = new CinematicsEngine(kernel, options.host, options.skip, options.advance);
      engine = created;
      kernel.observeScenes({ loading: () => created.sceneLoading() });
    },
    snapshot: () => current().snapshot() as unknown as Json,
    restore: (_kernel, saved) => current().restore(saved as unknown as { run: SavedRun | null }),
    ...(options.namespace !== undefined && { namespace: { name: 'cinematics', create: () => options.namespace!(current()) } }),
    engine: current,
  };
}
