/**
 * plugins/input — actions: action sets with priority, scenes and
 * `active_when`; keyboard / gamepad / mouse / touch bindings; per-frame action state with
 * dead zones, repeat, button groups and direction presses; per-seat reading; the pointer
 * with click consumption; `ctx.input`. Devices come in through core's `InputDevices` port.
 */

import type { InputDevices } from '../../../core/index.js';
import type { Kernel, KernelPlugin } from '../../kernel/index.js';
import type { ActionSetDecl } from './declarations.js';
import type { DeadZones } from './devices.js';
import { InputEngine } from './engine.js';
import type { Seat } from './engine.js';
import { InputApi } from './namespace.js';
import type { InputScope } from './namespace.js';

export { claimActions, partsOf, sourcesOf, TOUCH_PRESETS, touchIsDelta } from './declarations.js';
export type {
  ActionDecl, ActionOwner, ActionSetDecl, Axis1Decl, Axis2Decl, Binding, BindingPart, ButtonDecl, Direction,
  GroupDecl, GroupSlot, PadAxis, StickSide, TouchControl, TouchControlState, TouchPreset, TouchShape, TouchSkin, TouchZone,
} from './declarations.js';
export { PRESET_RULES, presetActions } from './touch_presets.js';
export { DEFAULT_DEAD_ZONES } from './devices.js';
export type { DeadZones, SeatDevices } from './devices.js';
export { InputEngine, SYSTEM_READER } from './engine.js';
export type {
  Device, InputEngineOptions, PointerResolver, PointerSample, Reader, ReadOptions, Seat, Step, TouchLayoutEntry,
} from './engine.js';
export type { RemapSlot } from './remap.js';
export { bindingText, controlRows } from './labels.js';
export type { ControlRow } from './labels.js';
export { HeadlessInput } from './headless.js';
export { ACTION_KEY, actionDecl, InputApi, PointerApi } from './namespace.js';
export type { InputScope } from './namespace.js';

export interface InputOptions {
  readonly devices: InputDevices;
  readonly sets?: readonly ActionSetDecl[];
  readonly seats?: readonly Seat[];
  /** True while gameplay input is muted; wire to the UI plugin's `modalOpen`. */
  readonly muted?: () => boolean;
  /** Who is reading (behavior owner + seat); supplied by the api layer. */
  readonly scope?: InputScope;
  readonly deadZones?: Partial<DeadZones>;
  /** A touch button's label as the player reads it (locale key → text). */
  readonly touchLabel?: (label: string) => string;
  /** The player's control remaps (`Settings.controls`). */
  readonly overrides?: () => Readonly<Record<string, string>>;
  /** Store them (`ctx.input.rebind` / `reset_controls`); `kernel` is the bound kernel. */
  readonly setOverrides?: (next: Readonly<Record<string, string>>, kernel: Kernel | undefined) => void;
}

export interface InputPlugin extends KernelPlugin {
  /** The engine behind `ctx.input`, for wiring (UI, harness, platform). */
  readonly engine: InputEngine;
}

export function input(options: InputOptions): InputPlugin {
  const engine = new InputEngine(options);
  return {
    id: 'input',
    engine,
    install(kernel) {
      engine.bind(kernel);
      kernel.addHook('input', (dt) => engine.frame(dt));
    },
    namespace: { name: 'input', create: () => new InputApi(engine, options.scope) },
  };
}
