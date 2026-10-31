/**
 * `ctx.input` and `ctx.input.pointer`: the SDK's `Input` and `Pointer`, with its Python
 * names. Actions arrive as the api layer's handles (`Controls.jump`), which carry their
 * declaration under `__action__`. Who is reading comes from the `InputScope` the api layer
 * supplies (the running behavior's owner and seat); without one, reads are a system's on
 * seat 0.
 */

import { bindArgs, Cell, fail } from '../../../core/index.js';
import type { Vec2, Vec3 } from '../../../core/index.js';
import type { ActionDecl, Axis1Decl, Axis2Decl, ButtonDecl, GroupDecl } from './declarations.js';
import { SYSTEM_READER } from './engine.js';
import type { Device, InputEngine, Reader } from './engine.js';
import type { ControlRow } from './labels.js';
import { actionName } from './remap.js';

/** The handle property under which an api action object carries its declaration. */
export const ACTION_KEY = '__action__';

export interface InputScope {
  /** The reader for code running right now. */
  current(): Reader;
}

/** At most this many pulses in one `rumble_pattern`. */
const MAX_PULSES = 32;
const SYSTEM_SCOPE: InputScope = { current: () => SYSTEM_READER };

/** The declaration behind an action handle (or a declaration passed directly). */
export function actionDecl(handle: unknown): ActionDecl {
  if (typeof handle === 'object' && handle !== null) {
    const inner = (handle as Record<string, unknown>)[ACTION_KEY];
    const decl = (inner ?? handle) as Partial<ActionDecl>;
    if (decl.kind === 'button' || decl.kind === 'axis1' || decl.kind === 'axis2' || decl.kind === 'group') return decl as ActionDecl;
  }
  return fail('PP3407', `Expected an action (Controls.jump), got ${String(handle)}`, {
    fix: 'Pass an action declared on an Actions subclass.',
  });
}

function expect<K extends ActionDecl['kind']>(handle: unknown, kind: K, what: string): Extract<ActionDecl, { kind: K }> {
  const decl = actionDecl(handle);
  if (decl.kind !== kind) {
    const owner = decl.owner === undefined ? 'This action' : `${decl.owner.set.id}.${decl.owner.name}`;
    fail('PP3404', `${owner} is a ${decl.kind === 'group' ? 'button_group' : decl.kind}; ${what} needs a ${kind === 'group' ? 'button_group' : kind}`);
  }
  return decl as Extract<ActionDecl, { kind: K }>;
}

export class PointerApi {
  readonly #engine: InputEngine;
  readonly #scope: InputScope;

  constructor(engine: InputEngine, scope: InputScope = SYSTEM_SCOPE) {
    this.#engine = engine;
    this.#scope = scope;
  }

  get screen(): Vec2 { return this.#engine.pointerScreen(this.#scope.current()); }
  get world(): Vec3 { return this.#engine.pointerWorld(this.#scope.current()); }
  get over(): unknown { return this.#engine.pointerOver(this.#scope.current()); }
  get pressed(): boolean { return this.#engine.pointerButton(this.#scope.current()).pressed; }
  get held(): boolean { return this.#engine.pointerButton(this.#scope.current()).held; }
  get released(): boolean { return this.#engine.pointerButton(this.#scope.current()).released; }
  get moved(): boolean {
    const d = this.#engine.pointerDelta(this.#scope.current());
    return d.x !== 0 || d.y !== 0;
  }

  get drag(): Vec2 {
    const reader = this.#scope.current();
    const d = this.#engine.pointerDelta(reader);
    return this.#engine.pointerButton(reader).held ? d : d.__mul__(0);
  }

  consume(): void {
    this.#engine.consumePointer(this.#scope.current());
  }
}

export class InputApi {
  readonly #engine: InputEngine;
  readonly #scope: InputScope;
  readonly #pointer: PointerApi;

  constructor(engine: InputEngine, scope: InputScope = SYSTEM_SCOPE) {
    this.#engine = engine;
    this.#scope = scope;
    this.#pointer = new PointerApi(engine, scope);
  }

  pressed(action: unknown): boolean {
    return this.#engine.pressed(expect(action, 'button', 'pressed()') as ButtonDecl, this.#scope.current());
  }

  released(action: unknown): boolean {
    return this.#engine.released(expect(action, 'button', 'released()') as ButtonDecl, this.#scope.current());
  }

  held(action: unknown): boolean {
    return this.#engine.held(expect(action, 'button', 'held()') as ButtonDecl, this.#scope.current());
  }

  value(action: unknown): number {
    return this.#engine.value(expect(action, 'axis1', 'value()') as Axis1Decl, this.#scope.current());
  }

  axis(action: unknown): Vec2 {
    return this.#engine.axis(expect(action, 'axis2', 'axis()') as Axis2Decl, this.#scope.current());
  }

  pressed_index(group: unknown): number | null {
    return this.#engine.pressedIndex(expect(group, 'group', 'pressed_index()') as GroupDecl, this.#scope.current());
  }

  pressed_direction(action: unknown): Vec2 | -1 | 1 | null {
    const decl = actionDecl(action);
    if (decl.kind === 'axis2') return this.#engine.pressedDirection(decl, this.#scope.current());
    if (decl.kind === 'axis1') return this.#engine.pressedDirection(decl, this.#scope.current());
    return fail('PP3404', 'pressed_direction() needs an axis1 or axis2 action');
  }

  /** `pressed_direction` as a grid step (`Cell.UP` is row - 1), or None. */
  pressed_step(action: unknown): Cell | null {
    const step = this.#engine.pressedStep(expect(action, 'axis2', 'pressed_step()') as Axis2Decl, this.#scope.current());
    return step === null ? null : new Cell(step.col, step.row);
  }

  get pointer(): PointerApi {
    return this.#pointer;
  }

  get text(): string {
    return this.#engine.text(this.#scope.current());
  }

  get device(): Device {
    return this.#engine.device(this.#scope.current());
  }

  rumble(strength: number, seconds: number): void {
    this.#engine.rumble(strength, seconds, this.#scope.current());
  }

  /** Pulses one after another: (strength 0..1, seconds) pairs, strength 0 a pause. */
  rumble_pattern(pattern: unknown): void {
    const items = typeof pattern === 'object' && pattern !== null && Symbol.iterator in pattern ? [...(pattern as Iterable<unknown>)] : null;
    const fix = 'e.g. ctx.input.rumble_pattern([(1, 0.04), (0, 0.06), (0.5, 0.1)]): a strong tap, a pause, a softer buzz.';
    if (items === null || items.length === 0 || items.length > MAX_PULSES) {
      fail('PP3411', `rumble_pattern() takes a list of 1..${MAX_PULSES} (strength, seconds) pulses, got ${String(pattern)}`, { fix });
    }
    const pulses = items.map((item, i): readonly [number, number] => {
      const pair = typeof item === 'object' && item !== null && Symbol.iterator in item ? [...(item as Iterable<unknown>)] : [];
      const [strength, seconds] = pair;
      if (pair.length !== 2 || typeof strength !== 'number' || !(strength >= 0 && strength <= 1) || typeof seconds !== 'number' || !(seconds > 0 && seconds <= 5)) {
        fail('PP3411', `rumble_pattern() pulse ${i} must be (strength 0..1, seconds 0..5), got ${String(item)}`, { fix });
      }
      return [strength, seconds];
    });
    const total = pulses.reduce((sum, [, s]) => sum + s, 0);
    const peak = Math.max(...pulses.map(([s]) => s));
    this.#engine.rumble(peak, total, this.#scope.current(), pulses);
  }

  // ── Remapping (a game's own controls menu; the built-in SettingsPanel uses the same) ──

  /** Every remappable binding as a menu shows it, or one action's (`controls(Controls.jump)`). */
  controls(...args: unknown[]): readonly ControlRow[] {
    const { action } = bindArgs('input.controls', args, { positional: ['action'] }).args;
    if (action === undefined || action === null) return this.#engine.controls();
    const name = actionName(actionDecl(action));
    if (name === undefined) fail('PP3407', 'input.controls() takes an action declared on a registered Actions subclass');
    return this.#engine.controls(name);
  }

  /** The next key (keyboard slot) or gamepad button (`:pad` slot) pressed becomes the slot's binding; Escape cancels. */
  rebind(slot: unknown): void {
    this.#engine.rebind(slotArg(slot, 'rebind'));
  }

  /** The slot waiting for its key, or None. */
  get rebinding(): string | null {
    return this.#engine.capturing;
  }

  cancel_rebind(): void {
    this.#engine.cancelCapture();
  }

  /** One slot, or every slot, back to the binding the game declared. */
  reset_controls(...args: unknown[]): void {
    const { slot } = bindArgs('input.reset_controls', args, { positional: ['slot'] }).args;
    this.#engine.resetControls(slot === undefined || slot === null ? undefined : slotArg(slot, 'reset_controls'));
  }
}

function slotArg(slot: unknown, where: string): string {
  if (typeof slot !== 'string') {
    fail('PP3408', `input.${where}() takes a slot name ("Controls.jump:key"), got ${String(slot)}`, { fix: 'Use a row\'s `slot` from ctx.input.controls().' });
  }
  return slot;
}
