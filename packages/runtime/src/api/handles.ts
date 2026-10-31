/**
 * Python-facing handles for engine components (contract C3), for plugin api modules:
 * `export const Health = componentHandle(healthDef, 'Health')` gives game code
 * `entity.get(Health)`, `query(Health)` and `Health(current=3, max=3)`.
 */

import type { ComponentDef } from '../function/kernel/index.js';
import { GIVEN } from './declarations.js';
import { bindArgs } from './kwargs.js';

export interface ComponentHandle {
  new (...args: unknown[]): object;
  readonly __component_id__: string;
}

/** A constructible handle: arguments are the component's fields, by position or name. */
export function componentHandle(def: ComponentDef, name: string): ComponentHandle {
  const fields = Object.keys(def.schema);
  const handle = class {
    constructor(...args: unknown[]) {
      const { args: bound } = bindArgs(name, args, { positional: fields });
      Object.assign(this, bound);
      Object.defineProperty(this, GIVEN, { value: new Set(Object.keys(bound)), enumerable: false });
    }
  };
  Object.defineProperty(handle, 'name', { value: name });
  Object.defineProperty(handle, '__component_id__', { value: def.id });
  return handle as unknown as ComponentHandle;
}
