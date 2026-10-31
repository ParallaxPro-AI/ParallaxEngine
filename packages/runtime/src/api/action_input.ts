/**
 * The `actions` service (function/services/actions.ts) over the input engine: seat-aware
 * press / hold reads for plugins (the interaction plugin's key), and the bindings of an
 * action as a player reads them on their current device — what key hints, interaction
 * prompts and ability slots print. Remaps (Settings.controls) apply to the primary key and
 * gamepad button, exactly as the input engine reads them.
 */

import { fail } from '../core/index.js';
import type { EntityId } from '../core/index.js';
import type { ActionDevice, ActionGlyph, ActionsService } from '../function/services/index.js';
import { actionDecl } from '../function/plugins/input/index.js';
import type { ActionDecl, BindingPart, InputEngine, RemapSlot } from '../function/plugins/input/index.js';
import { bindingText } from './ui.js';

/** Gamepad buttons as the default look prints them (standard layout, south = A). */
const PAD_TEXT: Readonly<Record<string, string>> = {
  south: 'A', east: 'B', west: 'X', north: 'Y', left_shoulder: 'LB', right_shoulder: 'RB', start: 'Menu', select: 'View',
  dpad_up: 'D-pad ↑', dpad_down: 'D-pad ↓', dpad_left: 'D-pad ←', dpad_right: 'D-pad →', left_stick: 'L3', right_stick: 'R3',
};
const MOUSE_TEXT: Readonly<Record<string, string>> = { left: 'LMB', right: 'RMB', middle: 'MMB' };

function nameOf(decl: ActionDecl): string | undefined {
  return decl.owner === undefined ? undefined : `${decl.owner.set.id}.${decl.owner.name}`;
}

function key(code: string): ActionGlyph {
  return { device: 'keyboard', code, text: bindingText(code, 'keyboard') };
}

function pad(button: string): ActionGlyph {
  return { device: 'gamepad', code: button, text: PAD_TEXT[button] ?? button };
}

function partsOf(decl: ActionDecl): readonly BindingPart[] {
  switch (decl.kind) {
    case 'button': case 'axis2': return decl.bindings;
    case 'axis1': return [...decl.gamepad, ...decl.other];
    case 'group': return decl.slots.flatMap((s) => s.bindings);
  }
}

/** `KeyW`+`KeyA`+`KeyS`+`KeyD` → "WASD"; arrows → "↑←↓→". */
function compositeText(codes: readonly string[]): string {
  return codes.map((c) => bindingText(c, 'keyboard')).join('');
}

export function glyphsOf(decl: ActionDecl, device: ActionDevice, slots: readonly RemapSlot[]): ActionGlyph[] {
  const name = nameOf(decl);
  const mine = slots.filter((s) => s.action === name);
  const slot = (dev: 'keyboard' | 'gamepad', part: string | null): string | undefined => mine.find((s) => s.device === dev && s.part === part)?.binding;
  const parts = partsOf(decl);
  const out: ActionGlyph[] = [];
  if (device === 'keyboard') {
    if (decl.kind === 'axis1') {
      const negative = slot('keyboard', 'negative') ?? decl.negative[0];
      const positive = slot('keyboard', 'positive') ?? decl.positive[0];
      if (negative !== undefined && positive !== undefined) out.push({ device, code: `${negative}+${positive}`, text: `${bindingText(negative, 'keyboard')}/${bindingText(positive, 'keyboard')}` });
    }
    let firstKeys = true;
    for (const part of parts) {
      if (part.kind === 'keys') {
        const codes = firstKeys ? [slot('keyboard', null) ?? part.codes[0]!, ...part.codes.slice(1)] : part.codes;
        firstKeys = false;
        for (const code of codes) out.push(key(code));
      } else if (part.kind === 'composite') {
        const codes = (['up', 'left', 'down', 'right'] as const).map((d) => slot('keyboard', d) ?? part[d][0]!);
        out.push({ device, code: codes.join('+'), text: compositeText(codes) });
      } else if (part.kind === 'key_axis') {
        const codes = [part.negative[0]!, part.positive[0]!];
        out.push({ device, code: codes.join('+'), text: compositeText(codes) });
      } else if (part.kind === 'mouse_button') {
        out.push({ device, code: `mouse:${part.button}`, text: MOUSE_TEXT[part.button] ?? part.button });
      } else if (part.kind === 'mouse_delta') {
        out.push({ device, code: 'mouse:move', text: 'Mouse' });
      } else if (part.kind === 'mouse_wheel') {
        out.push({ device, code: 'mouse:wheel', text: 'Wheel' });
      }
    }
  } else if (device === 'gamepad') {
    let firstButton = true;
    for (const part of parts) {
      if (part.kind === 'pad_button') {
        out.push(pad(firstButton ? slot('gamepad', null) ?? part.button : part.button));
        firstButton = false;
      } else if (part.kind === 'pad_stick') {
        out.push({ device, code: `stick:${part.stick}`, text: part.stick === 'left' ? 'L stick' : 'R stick' });
      } else if (part.kind === 'pad_trigger') {
        out.push({ device, code: `trigger:${part.trigger}`, text: part.trigger === 'left' ? 'LT' : 'RT' });
      } else if (part.kind === 'pad_dpad') {
        out.push({ device, code: 'dpad', text: 'D-pad' });
      } else if (part.kind === 'pad_axis') {
        out.push({ device, code: `axis:${part.axis}`, text: part.axis.startsWith('left') ? 'L stick' : 'R stick' });
      }
    }
  } else {
    for (const part of parts) {
      if (part.kind !== 'touch') continue;
      const control = part.control;
      out.push({ device, code: `touch:${control.id}`, text: control.label ?? control.icon ?? control.id });
    }
  }
  // One glyph per code: alternates the game declared twice (or a remap onto an alternate) print once.
  return out.filter((g, i) => out.findIndex((o) => o.code === g.code) === i);
}

/** The service the runtime provides (`kernel.provide(ACTIONS_SERVICE, actionsService(...))`). */
export function actionsService(engine: InputEngine, wrap: (id: EntityId) => unknown): ActionsService {
  const reader = (seat: number, owner: EntityId | null) => ({ seat, owner: owner === null ? null : wrap(owner) });
  const button = (action: unknown, what: string) => {
    const decl = actionDecl(action);
    if (decl.kind !== 'button') fail('PP3404', `${nameOf(decl) ?? 'This action'} is a ${decl.kind}; ${what} needs a button`);
    return decl;
  };
  const all = (): Map<string, ActionDecl> => {
    const found = new Map<string, ActionDecl>();
    for (const set of engine.sets) {
      for (const [attr, decl] of set.actions) {
        found.set(`${set.id}.${attr}`, decl);
        const own = nameOf(decl);
        if (own !== undefined && !found.has(own)) found.set(own, decl);
      }
    }
    return found;
  };
  return {
    pressed: (action, seat, owner) => engine.pressed(button(action, 'pressed'), reader(seat, owner)),
    held: (action, seat, owner) => engine.held(button(action, 'held'), reader(seat, owner)),
    live: (action, seat, owner) => {
      const decl = actionDecl(action);
      return decl.owner === undefined ? false : engine.live(decl.owner.set, reader(seat, owner));
    },
    device: (seat) => engine.device({ seat, owner: null }),
    find: (name) => all().get(name),
    names: () => [...all().keys()],
    glyphs: (action, device) => glyphsOf(actionDecl(action), device, engine.remapSlots()),
  };
}
