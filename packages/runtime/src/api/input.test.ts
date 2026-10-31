/**
 * `parallax` input declarations, called the way compiled game code calls them: keyword
 * arguments as a trailing `kw({...})`, `a | b` as `__or__`, and `__init_subclass__` run
 * after each `Actions` subclass body.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ParallaxError } from '../core/index.js';
import {
  Actions, actionSetOf, axis1, axis2, Button, button, button_group, gamepad, keys, mouse, registeredActionSets,
  resetActionSets, touch,
} from './input.js';
import { kw } from './kwargs.js';
import { SceneRef, Tag } from './types.js';

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return undefined;
}

afterEach(() => resetActionSets());

describe('bindings', () => {
  it('builds buttons from key codes, tuples and device bindings', () => {
    const jump = button(kw({ keyboard: ['ArrowUp', 'KeyW'], gamepad: gamepad.SOUTH, touch: touch.button('Jump', kw({ icon: 'chevrons_up' })) }));
    expect(jump.__action__.bindings).toEqual([
      { kind: 'keys', codes: ['ArrowUp', 'KeyW'] },
      { kind: 'pad_button', button: 'south' },
      { kind: 'touch', control: { id: 'button:Jump', shape: 'button', analog: false, label: 'Jump', icon: 'chevrons_up' } },
    ]);
    expect(button(kw({ keyboard: 'Space', repeat: [0.25, 0.08] })).__action__.repeat).toEqual([0.25, 0.08]);
  });

  it('combines bindings with | and builds composites', () => {
    const move = axis2(kw({ keyboard: keys.WASD.__or__(keys.ARROWS), gamepad: gamepad.DPAD.__or__(gamepad.LEFT_STICK) }));
    expect(move.__action__.bindings.map((p) => p.kind)).toEqual(['composite', 'composite', 'pad_dpad', 'pad_stick']);
    const ijkl = keys.composite(kw({ up: 'KeyI', left: 'KeyJ', down: 'KeyK', right: 'KeyL' }));
    expect(ijkl.parts).toEqual([{ kind: 'composite', up: ['KeyI'], left: ['KeyJ'], down: ['KeyK'], right: ['KeyL'] }]);
  });

  it('axis1 takes key pairs, a stick axis, a trigger or d-pad pair, the wheel and touch', () => {
    const steer = axis1(kw({ negative: ['KeyA', 'ArrowLeft'], positive: ['KeyD', 'ArrowRight'], gamepad: gamepad.LEFT_STICK_X, touch: touch.joystick('left') }));
    expect(steer.__action__.negative).toEqual(['KeyA', 'ArrowLeft']);
    expect(axis1(kw({ gamepad: gamepad.LEFT_TRIGGER.__or__(gamepad.RIGHT_TRIGGER) })).__action__.gamepad).toHaveLength(2);
    expect(axis1(kw({ mouse: mouse.WHEEL, gamepad: gamepad.DPAD_DOWN.__or__(gamepad.DPAD_UP) })).__action__.other).toEqual([{ kind: 'mouse_wheel' }]);
  });

  it('touch helpers name their controls', () => {
    expect(touch.swipe('up').parts[0]).toEqual({ kind: 'touch', control: { id: 'swipe:up', shape: 'swipe', analog: false, direction: 'up' } });
    expect(touch.swipe().parts[0]).toEqual({ kind: 'touch', control: { id: 'swipe', shape: 'swipe', analog: true } });
    expect(touch.dpad('left').parts[0]).toMatchObject({ kind: 'touch', control: { id: 'dpad:left', analog: false } });
    expect(code(() => touch.joystick('middle'))).toBe('PP4402');
  });

  it('checks key names and which bindings fit which action', () => {
    expect(code(() => button(kw({ keyboard: 'Spcae' })))).toBe('PP4401');
    expect(code(() => button(kw({ gamepad: gamepad.LEFT_STICK })))).toBe('PP4402');
    expect(code(() => axis2(kw({ keyboard: keys.WASD, mouse: mouse.LEFT })))).toBe('PP4402');
    expect(code(() => axis2(kw({ touch: touch.button('Go') })))).toBe('PP4402');
    expect(code(() => axis1(kw({ negative: 'KeyA' })))).toBe('PP4402');
    expect(code(() => button())).toBe('PP4404');
    expect(code(() => button(kw({ keyboard: 'Space', repeat: [0.2] })))).toBe('PP4403');
    expect(code(() => button(kw({ keybaord: 'Space' })))).toBe('PP3030');
  });

  it('button_group: one slot per key, None leaves a slot unbound', () => {
    const hotbar = button_group(kw({ keyboard: ['Digit1', null, 'Digit3'], gamepad: [gamepad.DPAD_LEFT] }));
    expect(hotbar.__len__()).toBe(3);
    expect(hotbar.__action__.slots.map((s) => s.bindings.length)).toEqual([2, 0, 1]);
    expect(code(() => button_group(kw({ keyboard: [] })))).toBe('PP4402');
  });

  it('button_group touch_labels: a label or None per slot', () => {
    const weapons = button_group(kw({ keyboard: ['Digit1', 'Digit2', 'Digit3'], touch_labels: [null, null, 'Grenade'] }));
    expect(weapons.__action__.touchLabels).toEqual([null, null, 'Grenade']);
    expect(code(() => button_group(kw({ keyboard: ['Digit1'], touch_labels: [3] })))).toBe('PP4402');
    expect(code(() => button_group(kw({ keyboard: ['Digit1'], touch_labels: ['a', 'b'] })))).toBe('PP4402');
  });
});

describe('Actions', () => {
  it('registers subclasses with their actions, priority, scenes and active_when', () => {
    const Level = new Tag('level');
    class Controls extends Actions {
      static jump = button(kw({ keyboard: 'Space' }));
      static move = axis2(kw({ keyboard: keys.WASD }));
      static override priority = 2;
      static override scenes = [Level, new SceneRef('arena')];
      static override active_when(_ctx: unknown, owner: unknown): unknown { return owner === 'me' ? 1 : 0; }
    }
    Controls.__init_subclass__();
    const set = registeredActionSets()[0]!;
    expect(set.id).toBe('Controls');
    expect([...set.actions.keys()]).toEqual(['jump', 'move']);
    expect(set.priority).toBe(2);
    expect(set.scenes).toEqual([{ tag: 'level' }, { scene: 'arena' }]);
    expect([set.activeWhen?.({}, 'me'), set.activeWhen?.({}, 'you')]).toEqual([true, false]);
    expect(set.actions.get('jump')).toBe(Controls.jump.__action__);
  });

  it('a subclass inherits actions and overrides them by name (per-seat controls)', () => {
    class Controls extends Actions {
      static jump = button(kw({ keyboard: 'Space' }));
      static move = axis2(kw({ keyboard: keys.WASD }));
    }
    class Player2Controls extends Controls {
      static override move = axis2(kw({ keyboard: keys.ARROWS }));
    }
    Controls.__init_subclass__();
    Player2Controls.__init_subclass__();
    const p2 = actionSetOf(Player2Controls);
    expect(p2.parent).toBe(actionSetOf(Controls));
    expect(p2.actions.get('jump')).toBe(Controls.jump.__action__);
    expect(p2.actions.get('move')).toBe(Player2Controls.move.__action__);
    expect(p2.activeWhen).toBeUndefined();
    expect(registeredActionSets().map((s) => s.id)).toEqual(['Controls', 'Player2Controls']);
  });

  it('rejects bad scenes and non-Actions classes', () => {
    class Bad extends Actions { static override scenes = ['level']; }
    expect(code(() => actionSetOf(Bad))).toBe('PP4405');
    expect(code(() => actionSetOf(class NotActions {}))).toBe('PP4406');
    expect(new Button({ kind: 'button', bindings: [] })).toBeInstanceOf(Button);
  });
});
