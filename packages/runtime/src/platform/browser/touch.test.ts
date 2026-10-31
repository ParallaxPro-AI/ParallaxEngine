import { describe, expect, it } from 'vitest';
import type { TouchControlSpec } from '../../core/index.js';
import { skinStyle } from './touch.js';
import { touchGlyph } from './touch_icons.js';
import { JOYSTICK_RADIUS, LONG_PRESS_MS, NOTCH_PX, TouchState } from './touch_state.js';

const LAYOUT: TouchControlSpec[] = [
  { id: 'joystick:left', shape: 'joystick', analog: true, side: 'left' },
  { id: 'button:Jump', shape: 'button', analog: false, label: 'Jump' },
  { id: 'dpad', shape: 'dpad', analog: true },
  { id: 'dpad:up', shape: 'dpad', analog: false, direction: 'up' },
  { id: 'tap', shape: 'tap', analog: false },
  { id: 'swipe', shape: 'swipe', analog: true },
  { id: 'swipe:left', shape: 'swipe', analog: false, direction: 'left' },
  { id: 'drag', shape: 'drag', analog: true },
  { id: 'look', shape: 'look', analog: true },
];

const f = (id: number, x: number, y: number, t = 0) => ({ id, x, y, t });

describe('TouchState', () => {
  it('joystick floats to the finger, reads +y up, clamps to 1; buttons hold and press', () => {
    const s = new TouchState();
    s.setLayout(LAYOUT);
    s.joystickDown(f(1, 100, 500), 'joystick:left');
    s.move(f(1, 100 + JOYSTICK_RADIUS / 2, 500 - JOYSTICK_RADIUS * 4));
    s.buttonDown(f(2, 700, 500), 'button:Jump');
    let p = s.poll();
    expect(p.get('joystick:left')).toMatchObject({ held: true, pressed: true });
    expect(p.get('joystick:left')!.y).toBeGreaterThan(0.9);
    expect(Math.hypot(p.get('joystick:left')!.x, p.get('joystick:left')!.y)).toBeCloseTo(1);
    expect(p.get('button:Jump')).toEqual({ held: true, pressed: true, x: 0, y: 0 });
    s.up(f(2, 700, 500));
    p = s.poll();
    expect(p.get('button:Jump')).toEqual({ held: false, pressed: false, x: 0, y: 0 });
    expect(p.get('joystick:left')!.pressed).toBe(false);
    s.up(f(1, 100, 500));
    expect(s.poll().get('joystick:left')).toEqual({ held: false, pressed: false, x: 0, y: 0 });
  });

  it('d-pad: analog direction and its digital arms with press edges', () => {
    const s = new TouchState();
    s.setLayout(LAYOUT);
    s.dpadDown(f(1, 75, 40), 75, 75);
    let p = s.poll();
    expect(p.get('dpad')).toMatchObject({ held: true, x: 0, y: 1 });
    expect(p.get('dpad:up')).toMatchObject({ held: true, pressed: true });
    s.move(f(1, 110, 75));
    p = s.poll();
    expect(p.get('dpad')).toMatchObject({ x: 1, y: 0 });
    expect(p.get('dpad:up')).toMatchObject({ held: false, pressed: false });
  });

  it('play-area gestures: tap, swipe, drag deltas (+y up), and look on the right half', () => {
    const s = new TouchState();
    s.setLayout(LAYOUT);
    s.areaDown(f(1, 100, 100, 0), 800);
    s.up(f(1, 102, 101, 120));
    expect(s.poll().get('tap')!.pressed).toBe(true);
    s.areaDown(f(2, 300, 100, 0), 800);
    s.up(f(2, 200, 110, 200));
    let p = s.poll();
    expect(p.get('tap')!.pressed).toBe(false);
    expect(p.get('swipe')).toEqual({ held: false, pressed: true, x: -1, y: 0 });
    expect(p.get('swipe:left')!.pressed).toBe(true);
    s.areaDown(f(3, 100, 100, 0), 800);
    s.move(f(3, 110, 90));
    s.areaDown(f(4, 600, 300, 0), 800);
    s.move(f(4, 590, 300));
    p = s.poll();
    expect(p.get('drag')).toEqual({ held: true, pressed: true, x: 10, y: 10 });
    expect(p.get('look')).toEqual({ held: true, pressed: true, x: -10, y: 0 });
    expect(s.poll().get('drag')).toEqual({ held: true, pressed: false, x: 0, y: 0 });
    s.cancel(3);
    expect(s.poll().get('drag')!.held).toBe(false);
  });

  it('a finger on a control that leaves the layout lets go; gestures are read only when listed', () => {
    const s = new TouchState();
    s.setLayout(LAYOUT);
    s.buttonDown(f(1, 0, 0), 'button:Jump');
    s.setLayout([]);
    expect(s.holding(1)).toBe(false);
    expect(s.readsArea).toBe(false);
    expect(s.poll().size).toBe(0);
  });
});

describe('TouchState: the previous overlay\'s controls', () => {
  const spec = (s: Partial<TouchControlSpec> & Pick<TouchControlSpec, 'id' | 'shape'>): TouchControlSpec => ({ analog: false, ...s });

  it('toggle buttons latch; disabled buttons swallow the finger; hold progress; toggle-group selection', () => {
    const s = new TouchState();
    s.setLayout([
      spec({ id: 'button:Crouch', shape: 'button', toggle: true }),
      spec({ id: 'button:Fire', shape: 'button', disabled: true }),
      spec({ id: 'button:Charge', shape: 'button', holdMs: 1000 }),
      spec({ id: 'seg:0', shape: 'button', group: 'g' }), spec({ id: 'seg:1', shape: 'button', group: 'g' }),
      spec({ id: 'tap', shape: 'tap' }),
    ]);
    s.buttonDown(f(1, 0, 0), 'button:Crouch');
    s.up(f(1, 0, 0));
    expect(s.poll().get('button:Crouch')).toMatchObject({ held: true, pressed: true });
    expect(s.poll().get('button:Crouch')).toMatchObject({ held: true, pressed: false });
    s.buttonDown(f(2, 0, 0), 'button:Crouch');
    s.up(f(2, 0, 0));
    expect(s.poll().get('button:Crouch')).toMatchObject({ held: false, pressed: false });

    s.buttonDown(f(3, 5, 5, 0), 'button:Fire');
    expect(s.holding(3)).toBe(true); // no gesture either
    s.up(f(3, 5, 5, 50));
    let p = s.poll();
    expect([p.get('button:Fire'), p.get('tap')!.pressed]).toEqual([{ held: false, pressed: false, x: 0, y: 0 }, false]);

    s.buttonDown(f(4, 0, 0, 100), 'button:Charge');
    expect(s.holdProgress('button:Charge', 600)).toBeCloseTo(0.5);
    expect(s.holdProgress('button:Charge', 5000)).toBe(1);

    s.buttonDown(f(5, 0, 0), 'seg:1');
    expect([s.selected('seg:0'), s.selected('seg:1')]).toEqual([false, true]);
    s.setLayout([spec({ id: 'seg:0', shape: 'button', group: 'g', selected: true }), spec({ id: 'seg:1', shape: 'button', group: 'g', selected: false })]);
    expect([s.selected('seg:0'), s.selected('seg:1')]).toEqual([true, false]); // the game's word wins
    p = s.poll();
    expect(p.has('button:Charge')).toBe(false);
  });

  it('steppers, a fixed (attitude) stick, the steering wheel and the stick rim', () => {
    const s = new TouchState();
    s.setLayout([
      spec({ id: 'stepper:-|+', shape: 'stepper', analog: true }),
      spec({ id: 'joystick:right', shape: 'joystick', analog: true, side: 'right', fixed: true }),
      spec({ id: 'joystick:left', shape: 'joystick', analog: true, side: 'left' }),
      spec({ id: 'joystick:left:edge', shape: 'stick_edge', side: 'left' }),
      spec({ id: 'steer', shape: 'steer', analog: true }),
    ]);
    s.stepperDown(f(1, 0, 0), 'stepper:-|+', -1);
    expect(s.poll().get('stepper:-|+')).toEqual({ held: true, pressed: true, x: -1, y: 0 });
    s.stepperDown(f(2, 0, 0), 'stepper:-|+', 1);
    expect(s.poll().get('stepper:-|+')!.x).toBe(0); // both halves: neither
    s.up(f(1, 0, 0));
    expect(s.poll().get('stepper:-|+')!.x).toBe(1);

    // A fixed stick reads the finger's offset from its rest point at once.
    s.joystickDown(f(3, 700, 300 - 28), 'joystick:right', { x: 700, y: 300 }, 56);
    expect(s.poll().get('joystick:right')).toMatchObject({ held: true, x: 0, y: 0.5 });

    s.joystickDown(f(4, 100, 300), 'joystick:left', undefined, 56);
    s.move(f(4, 130, 300));
    let p = s.poll();
    expect(p.get('joystick:left:edge')).toMatchObject({ held: false, pressed: false });
    s.move(f(4, 200, 300));
    p = s.poll();
    expect(p.get('joystick:left:edge')).toMatchObject({ held: true, pressed: true });
    expect(s.poll().get('joystick:left:edge')).toMatchObject({ held: true, pressed: false });

    s.joystickDown(f(5, 100, 100), 'steer', undefined, 64);
    s.move(f(5, 132, 40));
    expect(s.poll().get('steer')).toMatchObject({ held: true, x: 0.5, y: 0 });
  });

  it('double tap, long press (timed at poll), and two-finger pinch / scroll in wheel notches', () => {
    const s = new TouchState();
    s.setLayout([
      spec({ id: 'tap', shape: 'tap' }), spec({ id: 'double_tap', shape: 'double_tap' }), spec({ id: 'long_press', shape: 'long_press' }),
      spec({ id: 'pinch', shape: 'pinch', analog: true }), spec({ id: 'scroll', shape: 'scroll', analog: true }),
      spec({ id: 'drag', shape: 'drag', analog: true }),
    ]);
    s.areaDown(f(1, 100, 100, 0), 800);
    s.up(f(1, 100, 100, 80));
    s.areaDown(f(2, 110, 104, 200), 800);
    s.up(f(2, 110, 104, 260));
    let p = s.poll();
    expect([p.get('tap')!.pressed, p.get('double_tap')!.pressed]).toEqual([true, true]);

    s.areaDown(f(3, 300, 300, 1000), 800);
    expect(s.poll(1000 + LONG_PRESS_MS - 10).get('long_press')!.pressed).toBe(false);
    p = s.poll(1000 + LONG_PRESS_MS + 10);
    expect(p.get('long_press')).toMatchObject({ held: true, pressed: true });
    s.up(f(3, 300, 300, 2000));
    p = s.poll(2000);
    expect([p.get('tap')!.pressed, p.get('long_press')!.held]).toEqual([false, false]);

    s.areaDown(f(4, 200, 200, 3000), 800);
    s.areaDown(f(5, 300, 200, 3010), 800);
    s.move(f(5, 300 + NOTCH_PX, 200 - NOTCH_PX * 2));
    s.move(f(4, 200, 200 - NOTCH_PX * 2));
    p = s.poll(3020);
    expect(p.get('pinch')!.x).toBeGreaterThan(0.9);
    expect(p.get('pinch')!.held).toBe(true);
    expect(p.get('scroll')!.x).toBeCloseTo(2);
    expect(p.get('drag')).toMatchObject({ x: 0, y: 0 }); // the pinch's fingers feed no drag
    s.up(f(4, 200, 120, 3100));
    s.up(f(5, 340, 120, 3100));
    p = s.poll(3100);
    expect([p.get('tap')!.pressed, p.get('pinch')!.held]).toEqual([false, false]);
  });
});

describe('touch glyphs', () => {
  it('resolves names in either spelling, aliases, emoji and "auto" from the label', () => {
    expect(touchGlyph('chevrons_up', 'Jump', 24).kind).toBe('svg');
    expect(touchGlyph('chevronsUp', 'Jump', 24).kind).toBe('svg');
    expect(touchGlyph('grenade', '', 24)).toEqual(touchGlyph('bomb', '', 24));
    expect(touchGlyph('🔥', 'Fire', 24)).toEqual({ kind: 'text', text: '🔥' });
    expect(touchGlyph('auto', 'Reload', 24)).toEqual(touchGlyph('rotateCw', '', 24));
    expect(touchGlyph('no_such_glyph', 'Pause', 24)).toEqual(touchGlyph('pause', '', 24));
    expect(touchGlyph(undefined, 'Jump', 24)).toEqual({ kind: 'none' });
    expect(touchGlyph('auto', 'Zzz', 24)).toEqual({ kind: 'none' });
  });
});

describe('skinStyle', () => {
  it('maps a skin to the layer custom properties; the font goes through the panel-font resolver', () => {
    expect(skinStyle({
      stroke: 'red', strokeWidth: 3, blur: 6, pressScale: 0.9, joystickBase: 'blue', joystickKnob: 'white', font: 'Bangers, sans-serif',
    }, (list) => list.replace('Bangers', '"Bangers__pp1"'))).toEqual({
      '--stroke': 'red', '--stroke-width': '3px', '--backdrop': 'blur(6px)', '--press-scale': '0.9',
      '--stick-base': 'blue', '--stick-knob': 'white', '--font': '600 1em/1.1 "Bangers__pp1", sans-serif',
    });
    expect(skinStyle({ blur: 0 })).toEqual({});
  });
});
