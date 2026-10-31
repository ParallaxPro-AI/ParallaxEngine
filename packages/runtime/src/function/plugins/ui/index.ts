/**
 * plugins/ui — panels bound to state, headless half: the panel
 * registry, derived opening (`when=` + `delay`, `toggle_with`, `while_held`, a scene's
 * `"ui"` list), scene scoping, the modal stack (freezes time without net, mutes gameplay
 * input), panel commands, function actions with typed arguments, per-seat panel state,
 * and presentation requests (toast, announce, float text, flash, labels) for a renderer.
 * `UiPresenter` drives a panel surface (core's UI port) from the engine; the HTML itself is
 * rendered by the platform's surface, and binding checks live in `check`.
 */

import type { KernelPlugin } from '../../kernel/index.js';
import { KERNEL_EVENTS } from '../../kernel/index.js';
import { UI_EVENTS, UiEngine } from './engine.js';
import type { UiEngineOptions, UiSnapshot } from './engine.js';
import type { Json } from '../../../resource/index.js';

export { COMMAND_KEY } from './declarations.js';
export type {
  PanelAction, PanelCommand, PanelDecl, PanelInstance, PanelKey, PanelLayer, ParamSpec,
} from './declarations.js';
export { commandOf, performAction, plain, requestSceneCommand, UI_EVENTS, UiEngine } from './engine.js';
export type { ActionRun, Label, OpenPanel, PanelView, UiEngineOptions, UiInputLink, UiRequest, UiSnapshot } from './engine.js';
export { UiDriver } from './headless.js';
export { projectToScreen, UiPresenter } from './presenter.js';
export type { UiPresenterOptions } from './presenter.js';

export interface UiOptions extends UiEngineOptions {
  /** Builds `ctx.ui` (the api layer's Python-facing facade over the engine). */
  readonly namespace?: (engine: UiEngine) => object;
}

export interface UiPlugin extends KernelPlugin {
  /** The engine behind `ctx.ui`, for wiring (input muting, renderer, test driver). */
  readonly engine: UiEngine;
}

export function ui(options: UiOptions = {}): UiPlugin {
  const engine = new UiEngine(options);
  const namespace = options.namespace;
  return {
    id: 'ui',
    engine,
    events: Object.values(UI_EVENTS),
    systems: [{
      // Engine-internal: closes panels and opens the scene's list on every scene load.
      id: 'engine_ui',
      scenes: [],
      runsWhileFrozen: false,
      handlers: [{ event: KERNEL_EVENTS.sceneLoaded, method: 'scene_loaded', always: true }],
      create: () => ({ scene_loaded: () => engine.sceneLoaded() }),
    }],
    install(kernel) {
      engine.bind(kernel);
      kernel.addHook('ui', () => engine.frame());
      kernel.addHook('ui', () => engine.computeViews(), { last: true });
    },
    snapshot: () => engine.snapshot() as unknown as Json,
    restore: (_kernel, state) => engine.restore(state as unknown as UiSnapshot),
    ...(namespace !== undefined && { namespace: { name: 'ui', create: () => namespace(engine) } }),
  };
}
