/**
 * Engine events — ordinary events, the same mechanism games use — and the helper plugin
 * api modules use to expose theirs (`Collided` from physics, `Died` from combat…).
 */

import { fail } from '../core/index.js';
import { KERNEL_EVENTS } from '../function/kernel/index.js';
import type { EventDef, Fields } from '../function/kernel/index.js';
import { UI_EVENTS } from '../function/plugins/ui/index.js';
import { SceneRef } from './types.js';

/** An event handle for `@on(...)`, `task.until(...)`: carries its kernel EventDef. */
export interface EventHandle {
  readonly __event_id__: string;
  readonly __event_def__: EventDef;
  readonly name: string;
}

/**
 * The handle for an engine or plugin event. Engine events are emitted by the engine,
 * so the handle is not constructible from game code.
 */
export function eventHandle(def: EventDef, name: string): EventHandle {
  const handle = class {
    constructor() {
      fail('PP3038', `${name} is emitted by the engine; game code can't construct it`, { fix: 'Declare your own @event.' });
    }
  };
  Object.defineProperty(handle, 'name', { value: name });
  Object.defineProperty(handle, '__event_id__', { value: def.id });
  Object.defineProperty(handle, '__event_def__', { value: def });
  return handle as unknown as EventHandle;
}

export const Spawned = eventHandle(KERNEL_EVENTS.spawned, 'Spawned');
export const Destroyed = eventHandle(KERNEL_EVENTS.destroyed, 'Destroyed');
export const SceneLoaded = eventHandle(KERNEL_EVENTS.sceneLoaded, 'SceneLoaded');
// Physics events are kernel events shared by every physics plugin.
export const Collided = eventHandle(KERNEL_EVENTS.collided, 'Collided');
export const CollisionEnded = eventHandle(KERNEL_EVENTS.collisionEnded, 'CollisionEnded');
export const TriggerEntered = eventHandle(KERNEL_EVENTS.triggerEntered, 'TriggerEntered');
export const TriggerExited = eventHandle(KERNEL_EVENTS.triggerExited, 'TriggerExited');
// Registered by the ui plugin; the payload's `panel` is the Panel class.
export const PanelOpened = eventHandle(UI_EVENTS.opened, 'PanelOpened');
export const PanelClosed = eventHandle(UI_EVENTS.closed, 'PanelClosed');
export const PanelAction = eventHandle(UI_EVENTS.acted, 'PanelAction');

/**
 * Payloads the kernel emits in its own form, converted to what game code sees. Each
 * payload is converted once (handlers and tasks share the converted object).
 */
const PAYLOADS = new Map<EventDef, (payload: Fields) => Fields>([
  [KERNEL_EVENTS.sceneLoaded, (p) => sceneLoadedPayload(p)],
]);

/** `SceneLoaded(scene, new_run)`; the old `event.reset` fails naming its replacement. */
function sceneLoadedPayload(p: Fields): Fields {
  const payload: Fields = { scene: new SceneRef(p['scene'] as string), new_run: p['new_run'] === true };
  Object.defineProperty(payload, 'reset', {
    enumerable: false,
    get: () => fail('PP3039', 'SceneLoaded.reset was renamed', { fix: 'Use event.new_run (True when the load started a new run).' }),
  });
  return payload;
}

const converted = new WeakMap<Fields, Fields>();

export function presentPayload(def: EventDef, payload: Fields): Fields {
  const convert = PAYLOADS.get(def);
  if (convert === undefined) return payload;
  let result = converted.get(payload);
  if (result === undefined) {
    result = convert(payload);
    converted.set(payload, result);
  }
  return result;
}
