/**
 * `parallax.touch` and the touch side of `Actions` (touch_preset, touch_skin), called the
 * way compiled game code calls them: keyword arguments as a trailing `kw({...})`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Color, ParallaxError } from '../core/index.js';
import { Actions, actionSetOf, axis1, axis2, button, button_group, keys, mouse, resetActionSets, touch, TouchSkin } from './input.js';
import { kw } from './kwargs.js';
import { HeadlessInput, InputEngine } from '../function/plugins/input/index.js';

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return undefined;
}

afterEach(() => resetActionSets());

const controlOf = (b: { parts: readonly unknown[] }): Record<string, unknown> => (b.parts[0] as { control: Record<string, unknown> }).control;

describe('touch bindings', () => {
  it('builds the new controls', () => {
    expect(controlOf(touch.joystick('right', kw({ fixed: true })))).toEqual({ id: 'joystick:right', shape: 'joystick', analog: true, side: 'right', fixed: true });
    expect(controlOf(touch.stepper())).toEqual({ id: 'stepper:−|+', shape: 'stepper', analog: true, labels: ['−', '+'] });
    expect(controlOf(touch.stepper('Lower', 'Raise', kw({ zone: 'hotbar' })))).toMatchObject({ labels: ['Lower', 'Raise'], zone: 'hotbar' });
    expect(controlOf(touch.pedals())).toEqual({ id: 'pedals:Brake|Gas', shape: 'stepper', analog: true, zone: 'pedals', labels: ['Brake', 'Gas'] });
    expect(controlOf(touch.steer())).toEqual({ id: 'steer', shape: 'steer', analog: true });
    expect(controlOf(touch.stick_edge('left'))).toEqual({ id: 'joystick:left:edge', shape: 'stick_edge', analog: false, side: 'left' });
    expect([touch.DOUBLE_TAP, touch.LONG_PRESS, touch.PINCH, touch.SCROLL].map((b) => controlOf(b)['shape'])).toEqual(['double_tap', 'long_press', 'pinch', 'scroll']);
  });

  it('buttons take a zone, toggle or hold (seconds), and per-frame state functions', () => {
    const state = { ammo: 0, ready: false, cool: 0.25 };
    const c = controlOf(touch.button('Fire', kw({
      icon: 'target', zone: 'primary', hold: 0.6,
      visible_when: () => 1, enabled_when: (ctx: typeof state) => ctx.ready,
      relabel: (ctx: typeof state) => (ctx.ammo === 0 ? ['Empty', 'x'] : null), cooldown: (ctx: typeof state) => ctx.cool,
    }))) as { state: Record<string, (ctx: unknown) => unknown> };
    expect(c).toMatchObject({ id: 'button:Fire', zone: 'primary', holdMs: 600, icon: 'target' });
    expect([c.state['visible']!(state), c.state['enabled']!(state), c.state['relabel']!(state), c.state['cooldown']!(state)])
      .toEqual([true, false, { label: 'Empty', icon: 'x' }, 0.25]);
    expect(controlOf(touch.button('Crouch', kw({ toggle: true })))).toMatchObject({ toggle: true });
    expect(code(() => touch.button('X', kw({ zone: 'corner' })))).toBe('PP4402');
    expect(code(() => touch.button('X', kw({ toggle: true, hold: 0.1 })))).toBe('PP4402');
    expect(code(() => touch.button('X', kw({ hold_ms: 100 })))).toBe('PP3030');
    expect(code(() => touch.button('X', kw({ visible_when: true })))).toBe('PP4402');
    expect(code(() => touch.button('X', kw({ relabel: () => 3 })).parts.map((p) => (p as { control: { state: { relabel(c: unknown): unknown } } }).control.state.relabel({})))).toBe('PP4402');
  });

  it('button_group takes a hotbar or a toggle group, whose selection comes from the game', () => {
    const slots = button_group(kw({ keyboard: ['Digit1', 'Digit2', 'Digit3'], touch: touch.hotbar('Sword', null, 'Bow') }));
    const parts = slots.__action__.slots.map((s) => s.bindings.filter((p) => p.kind === 'touch').map((p) => p.kind === 'touch' && p.control.id));
    expect(parts).toEqual([['hotbar:Sword||Bow:0'], [], ['hotbar:Sword||Bow:2']]);
    expect(slots.__action__.touchLabels).toEqual(['Sword', null, 'Bow']);
    const mode = { m: 1 };
    const modes = button_group(kw({ keyboard: ['KeyB', 'KeyF'], touch: touch.toggle_group('Build', 'Fight', kw({ selected_when: (ctx: typeof mode) => ctx.m })) }));
    const controls = modes.__action__.slots.map((s) => (s.bindings[1] as { control: { group: string; state: { selected(c: unknown): boolean } } }).control);
    expect(controls.map((c) => [c.group, c.state.selected(mode)])).toEqual([['toggle:Build|Fight', false], ['toggle:Build|Fight', true]]);
    expect(code(() => button_group(kw({ keyboard: ['Digit1'], touch: touch.hotbar('A'), touch_labels: ['A'] })))).toBe('PP4402');
    expect(code(() => button_group(kw({ keyboard: ['Digit1'], touch: touch.hotbar('A', 'B') })))).toBe('PP4402');
    expect(code(() => button_group(kw({ keyboard: ['Digit1'], touch: touch.TAP })))).toBe('PP4402');
  });

  it('touch.NONE opts an action out of presets; axis1 takes one control or a pair of buttons', () => {
    expect(button(kw({ keyboard: 'KeyV', touch: touch.NONE })).__action__).toMatchObject({ noTouch: true, bindings: [{ kind: 'keys', codes: ['KeyV'] }] });
    expect(axis2(kw({ mouse: mouse.DELTA, touch: touch.NONE })).__action__.noTouch).toBe(true);
    expect(button_group(kw({ keyboard: ['Digit1'], touch: touch.NONE })).__action__.noTouch).toBe(true);
    expect(code(() => button(kw({ touch: touch.NONE })))).toBe('PP4404');
    expect(code(() => axis1(kw({ touch: touch.button('A').__or__(touch.button('B')).__or__(touch.button('C')) })))).toBe('PP4402');
    expect(code(() => axis1(kw({ touch: touch.stepper().__or__(touch.button('B')) })))).toBe('PP4402');
    expect(axis1(kw({ touch: touch.button('Brake').__or__(touch.button('Gas')) })).__action__.other).toHaveLength(2);
  });
});

describe('Actions touch_preset and touch_skin', () => {
  it('records the preset and skin, inherited by subclasses', () => {
    class Controls extends Actions {
      static move = axis2(kw({ keyboard: keys.WASD }));
      static override touch_preset: unknown = 'fps';
      static override touch_skin: unknown = new TouchSkin(kw({ accent: new Color(1, 0.5, 0, 0.8), shape: 'rounded', scale: 1.2, font: 'Inter, sans-serif' }));
    }
    class Player2 extends Controls {}
    expect(actionSetOf(Controls)).toMatchObject({
      touchPreset: 'fps', touchSkin: { accent: 'rgba(255, 128, 0, 0.8)', shape: 'rounded', scale: 1.2, font: 'Inter, sans-serif' },
    });
    expect(actionSetOf(Player2).touchPreset).toBe('fps');
    class Plain extends Actions { static jump = button(kw({ keyboard: 'Space' })); }
    expect(actionSetOf(Plain).touchPreset).toBeUndefined();
  });

  it('touch_keyboard = False marks the set (inherited); a non-bool is PP4405', () => {
    class Typing extends Actions { static override touch_keyboard: unknown = false; }
    class More extends Typing {}
    expect(actionSetOf(Typing).touchKeyboard).toBe(false);
    expect(actionSetOf(More).touchKeyboard).toBe(false);
    class Plain2 extends Actions {}
    expect(actionSetOf(Plain2).touchKeyboard).toBeUndefined();
    class Bad extends Actions { static override touch_keyboard: unknown = 'no'; }
    expect(code(() => actionSetOf(Bad))).toBe('PP4405');
  });

  it('buttons take a size, a pinned position and a ring colour; skins take stroke width, blur, press scale and stick colours', () => {
    expect(controlOf(touch.button('Dash', kw({ size: 1.4, at: [0.8, 0.3], ring: new Color(1, 0, 0) }))))
      .toMatchObject({ size: 1.4, at: [0.8, 0.3], ring: 'rgba(255, 0, 0, 1)' });
    expect(code(() => touch.button('X', kw({ size: 3 })))).toBe('PP4402');
    expect(code(() => touch.button('X', kw({ at: [1.2, 0.5] })))).toBe('PP4402');
    expect(code(() => touch.button('X', kw({ at: 0.5 })))).toBe('PP4402');
    expect(code(() => touch.button('X', kw({ ring: '#f00' })))).toBe('PP4402');
    expect(new TouchSkin(kw({
      stroke_width: 3, blur: 8, press_scale: 0.92, joystick_base: new Color(0, 0, 0, 0.5), joystick_knob: new Color(1, 1, 1),
    })).__touch_skin__).toEqual({
      strokeWidth: 3, blur: 8, pressScale: 0.92, joystickBase: 'rgba(0, 0, 0, 0.5)', joystickKnob: 'rgba(255, 255, 255, 1)',
    });
    expect(code(() => new TouchSkin(kw({ stroke_width: 9 })))).toBe('PP4405');
    expect(code(() => new TouchSkin(kw({ press_scale: 2 })))).toBe('PP4405');
    expect(code(() => new TouchSkin(kw({ blur: -1 })))).toBe('PP4405');
  });

  it('rejects unknown presets and bad skins', () => {
    class Typo extends Actions { static override touch_preset: unknown = 'fsp'; }
    expect(code(() => actionSetOf(Typo))).toBe('PP4405');
    class NotSkin extends Actions { static override touch_skin: unknown = 'dark'; }
    expect(code(() => actionSetOf(NotSkin))).toBe('PP4405');
    expect(code(() => new TouchSkin(kw({ opacity: 0 })))).toBe('PP4405');
    expect(code(() => new TouchSkin(kw({ fill: '#fff' })))).toBe('PP4405');
    expect(code(() => new TouchSkin(kw({ shape: 'hexagon' })))).toBe('PP4405');
    expect(code(() => new TouchSkin(kw({ font: 'x; background: url(evil)' })))).toBe('PP4405');
  });
});

describe('Actions with a preset, through the input engine', () => {
  it('a one-line preset draws the whole scheme, with the declared controls and their per-frame state', () => {
    let ammo = 0;
    class Controls extends Actions {
      static override touch_preset: unknown = 'tps';
      static move = axis2(kw({ keyboard: keys.WASD }));
      static look = axis2(kw({ mouse: mouse.DELTA }));
      static fire = button(kw({ mouse: mouse.LEFT, touch: touch.button('Shoot', kw({ relabel: () => (ammo === 0 ? 'Reload' : null) })) }));
      static sprint = button(kw({ keyboard: 'ShiftLeft' }));
      static debug = button(kw({ keyboard: 'KeyV', touch: touch.NONE }));
      static pause = button(kw({ keyboard: 'Escape' }));
    }
    const devices = new HeadlessInput();
    const engine = new InputEngine({ devices, sets: [actionSetOf(Controls)] });
    engine.frame(1 / 60);
    expect(devices.output!.touch.map((s) => [s.id, s.zone ?? s.shape, s.label])).toEqual([
      ['joystick:left', 'joystick', undefined],
      ['look', 'look', undefined],
      ['button:Shoot', 'primary', 'Reload'],
      ['joystick:left:edge', 'stick_edge', undefined],
      ['button:Pause', 'system', 'Pause'],
    ]);
    ammo = 3;
    engine.frame(1 / 60);
    expect(devices.output!.touch.find((s) => s.id === 'button:Shoot')!.label).toBe('Shoot');
    devices.touchHold('joystick:left:edge');
    engine.frame(1 / 60);
    expect(engine.held(Controls.sprint.__action__)).toBe(true);
  });
});
