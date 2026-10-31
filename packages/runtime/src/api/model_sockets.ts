/**
 * `parent.attach(child, socket="grip_r")`: parent `child` to a socket of the parent's
 * Model. The child gets a `Socket(name=...)` component and sits on the socket from then
 * on — render3d moves it with the posed model every frame (code_model_draw.ts), and it is
 * placed on the socket at once, so the same frame reads it there.
 *
 * Checked here: the parent has a Model; the socket exists (a declared socket, or a part,
 * bone or node by name: PP2122); a declared socket's `accepts` (the child's model must
 * `provide` one of those tags: PP3824) and `limit` (PP3825). In a run without the parent
 * model's file (data-only) only the Model is checked.
 */

import { closestMatch, fail } from '../core/index.js';
import type { EntityRecord, Kernel } from '../function/kernel/index.js';
import { MODEL, SOCKET } from '../function/plugins/visuals/index.js';
import { MODEL_RIG_SERVICE } from '../function/services/index.js';

function nameOf(record: EntityRecord): string {
  return record.prefab === undefined ? `entity ${record.id}` : `prefab "${record.prefab}"`;
}

/** The stored form of a Model's `model` field (an id string, or a ref object's). */
function modelRef(fields: Readonly<Record<string, unknown>>): string {
  const value = fields['model'];
  if (typeof value === 'string') return value;
  const toJSON = (value as { toJSON?: unknown } | null)?.toJSON;
  return typeof toJSON === 'function' ? String((toJSON as () => unknown).call(value)) : String(value);
}

export function attachToSocket(kernel: Kernel, parent: EntityRecord, child: EntityRecord, socket: unknown, keepWorld: unknown): void {
  if (typeof socket !== 'string' || socket === '') fail('PP3004', `attach() socket must be a socket name (a string), got ${String(socket)}`);
  if (keepWorld === true) {
    fail('PP3004', 'attach(socket=..., keep_world=True) asks for two places: a socketed child sits on its socket', {
      fix: 'Leave out keep_world, or attach without a socket.',
    });
  }
  const model = parent.components.get(MODEL);
  if (model === undefined) {
    fail('PP3821', `attach(socket="${socket}"): ${nameOf(parent)} has no Model, so it has no sockets`, {
      fix: 'Attach to an entity with a Model, or attach without a socket.',
    });
  }
  const rigs = kernel.service(MODEL_RIG_SERVICE);
  const rig = rigs.rig(modelRef(model));
  if (rig !== null && rig !== undefined) {
    if (!rig.sockets.includes(socket)) {
      const guess = closestMatch(socket, rig.sockets);
      const declared = rig.document === null ? [] : [...rig.document.sockets.keys()];
      fail('PP2122', `attach(socket="${socket}"): ${rig.path} has no socket "${socket}"`, {
        fix: guess !== undefined ? `Did you mean "${guess}"?` : declared.length > 0 ? `Its sockets: ${declared.join(', ')}.` : 'Name a part, bone or node of the model.',
      });
    }
    const declared = rig.document?.sockets.get(socket);
    if (declared?.accepts !== null && declared?.accepts !== undefined) {
      const childModel = child.components.get(MODEL);
      const provides = childModel === undefined ? [] : rigs.rig(modelRef(childModel))?.document?.provides ?? null;
      // null: the child's model has no file in this run, so what it provides can't be known.
      if (provides !== null && !provides.some((tag) => declared.accepts!.includes(tag))) {
        fail('PP3824', `attach(socket="${socket}"): the socket takes ${declared.accepts.join(', ')}; ${nameOf(child)} ${provides.length === 0 ? 'provides nothing' : `provides ${provides.join(', ')}`}`, {
          fix: 'Attach something the socket accepts (a model whose document "provides" one of its tags), or use another socket.',
        });
      }
    }
    if (declared?.limit !== null && declared?.limit !== undefined) {
      const held = parent.children.filter((id) => id !== child.id && kernel.world.get(id)?.components.get(SOCKET)?.['name'] === socket).length;
      if (held >= declared.limit) {
        fail('PP3825', `attach(socket="${socket}"): the socket holds ${declared.limit} already`, {
          fix: `Detach what is on it first (child.detach()), or use another socket.`,
        });
      }
    }
  }
  kernel.world.attach(child, parent);
  kernel.addComponent(child.id, SOCKET, { name: socket });
  const frame = rigs.socket(parent.id, socket, 'local');
  if (frame !== null && frame !== undefined) {
    child.transform.position = frame.position;
    child.transform.rotation = frame.rotation;
  }
}

/** Leaving a socket (`detach()`, or `attach()` without one): the child is free again. */
export function leaveSocket(kernel: Kernel, child: EntityRecord): void {
  if (child.components.has(SOCKET)) kernel.removeComponent(child.id, SOCKET);
}
