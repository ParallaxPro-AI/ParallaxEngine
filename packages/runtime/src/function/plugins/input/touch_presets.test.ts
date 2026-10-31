import { describe, expect, it } from 'vitest';
import type { ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import { HeadlessInput, input } from './index.js';
import type {
  ActionDecl, ActionSetDecl, Axis1Decl, Axis2Decl, BindingPart, ButtonDecl, GroupDecl, InputEngine, TouchControl, TouchPreset,
} from './index.js';

const DT = 1 / 60;
const keys = (...codes: string[]): BindingPart => ({ kind: 'keys', codes });
const WASD: BindingPart = { kind: 'composite', up: ['KeyW'], left: ['KeyA'], down: ['KeyS'], right: ['KeyD'] };
const ARROWS: BindingPart = { kind: 'composite', up: ['ArrowUp'], left: ['ArrowLeft'], down: ['ArrowDown'], right: ['ArrowRight'] };
const MOUSE_LEFT: BindingPart = { kind: 'mouse_button', button: 'left' };
const MOUSE_RIGHT: BindingPart = { kind: 'mouse_button', button: 'right' };
const DELTA: BindingPart = { kind: 'mouse_delta' };
const WHEEL: BindingPart = { kind: 'mouse_wheel' };
const START: BindingPart = { kind: 'pad_button', button: 'start' };
const touchPart = (control: TouchControl): BindingPart => ({ kind: 'touch', control });

const button = (...bindings: BindingPart[]): ButtonDecl => ({ kind: 'button', bindings });
const axis2 = (...bindings: BindingPart[]): Axis2Decl => ({ kind: 'axis2', bindings });
const axis1 = (init: Partial<Omit<Axis1Decl, 'kind'>>): Axis1Decl => ({ kind: 'axis1', negative: [], positive: [], gamepad: [], other: [], ...init });
const group = (...codes: string[]): GroupDecl => ({ kind: 'group', slots: codes.map((c) => ({ bindings: [keys(c)] })), touchLabels: [] });

function set(id: string, actions: Record<string, ActionDecl>, extra: Partial<Pick<ActionSetDecl, 'priority' | 'activeWhen' | 'touchPreset' | 'touchSkin'>> = {}): ActionSetDecl {
  return { id, priority: extra.priority ?? 0, scenes: [], actions: new Map(Object.entries(actions)), ...extra };
}

function rig(sets: ActionSetDecl[], options: { context?: unknown; muted?: () => boolean; touchLabel?: (l: string) => string } = {}): {
  devices: HeadlessInput; engine: InputEngine; step(): void;
} {
  const devices = new HeadlessInput();
  const plugin = input({ devices, sets, ...options });
  const text: Record<string, string> = { 'scenes/main/scene.json': JSON.stringify({ entities: [] }) };
  const files: ProjectFiles = { list: () => Object.keys(text), read: (p) => text[p]! };
  const kernel = new Kernel({
    project: loadProject(files), game: { components: [], resources: [], events: [], behaviors: [], systems: [] },
    plugins: [plugin], context: options.context ?? {},
  });
  kernel.start('main');
  return { devices, engine: plugin.engine, step: () => kernel.step(DT) };
}

/** id → zone (or shape for gestures) of the drawn layout. */
function layout(engine: InputEngine): Record<string, string> {
  return Object.fromEntries(engine.touchLayout().map(({ control }) => [control.id, control.zone ?? control.shape]));
}

function fps(preset: TouchPreset = 'fps'): Record<string, ActionDecl> {
  return {
    move: axis2(WASD, { kind: 'pad_stick', stick: 'left' }),
    look: axis2(DELTA, { kind: 'pad_stick', stick: 'right' }),
    fire: button(MOUSE_LEFT),
    aim: button(MOUSE_RIGHT),
    jump: button(keys('Space')),
    sprint: button(keys('ShiftLeft')),
    reload: button(keys('KeyR')),
    switch_weapon: axis1({ other: [WHEEL] }),
    slot: group('Digit1', 'Digit2', 'Digit3'),
    pause: button(keys('Escape'), START),
    ...(preset === 'custom' ? {} : {}),
  };
}

describe('touch presets', () => {
  it('fps: fills in every action that has no touch control, placed by role', () => {
    const r = rig([set('Fps', fps(), { touchPreset: 'fps' })]);
    expect(layout(r.engine)).toEqual({
      'joystick:left': 'joystick',
      look: 'look',
      'button:Fire': 'primary',
      'button:Aim': 'button',
      'button:Jump': 'button',
      'joystick:left:edge': 'stick_edge',
      'button:Reload': 'button',
      'stepper:switch_weapon': 'stepper',
      'hotbar:slot:0': 'hotbar', 'hotbar:slot:1': 'hotbar', 'hotbar:slot:2': 'hotbar',
      'button:Pause': 'system',
    });
    const labels = r.engine.touchLayout().filter((e) => e.control.id.startsWith('hotbar')).map((e) => e.control.label);
    expect(labels).toEqual(['1', '2', '3']);
  });

  it('derived controls read like declared ones (fire on the primary, sprint on the stick rim, slots on the hotbar)', () => {
    const actions = fps();
    const r = rig([set('Fps', actions, { touchPreset: 'fps' })]);
    r.step();
    r.devices.touchHold('button:Fire');
    r.devices.touchHold('joystick:left', 0, 1);
    r.devices.touchHold('joystick:left:edge');
    r.devices.touchPulse('hotbar:slot:1');
    r.step();
    expect(r.engine.held(actions['fire'] as ButtonDecl)).toBe(true);
    expect(r.engine.held(actions['sprint'] as ButtonDecl)).toBe(true);
    expect(r.engine.axis(actions['move'] as Axis2Decl).y).toBeCloseTo(1);
    expect(r.engine.pressedIndex(actions['slot'] as GroupDecl)).toBe(1);
  });

  it('rts / click: mouse buttons become a tap and a long press on the world, the wheel a pinch, WASD a drag', () => {
    const r = rig([set('Rts', {
      pan: axis2(WASD), select: button(MOUSE_LEFT), order: button(MOUSE_RIGHT), zoom: axis1({ other: [WHEEL] }), stop: button(keys('KeyS')),
    }, { touchPreset: 'rts' })]);
    expect(layout(r.engine)).toEqual({ drag: 'drag', tap: 'tap', long_press: 'long_press', pinch: 'pinch', 'button:Stop': 'button' });
  });

  it('racer: steering becomes the wheel, throttle the pedals; flight: look becomes a fixed right stick', () => {
    const drive = rig([set('Drive', {
      steer: axis1({ negative: ['KeyA', 'ArrowLeft'], positive: ['KeyD', 'ArrowRight'] }),
      throttle: axis1({ negative: ['KeyS'], positive: ['KeyW'], gamepad: [{ kind: 'pad_trigger', trigger: 'left' }, { kind: 'pad_trigger', trigger: 'right' }] }),
      boost: button(keys('Space')),
    }, { touchPreset: 'racer' })]);
    expect(layout(drive.engine)).toEqual({ steer: 'steer', 'pedals:Brake|Gas': 'pedals', 'button:Boost': 'primary' });

    const fly = rig([set('Fly', { power: axis2(WASD), stick: axis2(DELTA), flaps: button(keys('KeyF')) }, { touchPreset: 'flight' })]);
    const stick = fly.engine.touchLayout().find((e) => e.control.id === 'joystick:right')!.control;
    expect(stick.fixed).toBe(true);
    expect(layout(fly.engine)['joystick:left']).toBe('joystick');
  });

  it('platformer / sidescroller: left/right axis1 becomes ◀ ▶ under the left thumb, Space the primary; twin sticks take both sides', () => {
    const r = rig([set('Side', { walk: axis1({ negative: ['KeyA'], positive: ['KeyD'] }), jump: button(keys('Space')), dash: button(keys('KeyX')) }, { touchPreset: 'sidescroller' })]);
    const walk = r.engine.touchLayout().find((e) => e.control.id === 'stepper:walk')!.control;
    expect([walk.zone, walk.labels]).toEqual(['left', ['◀', '▶']]);
    expect(layout(r.engine)['button:Jump']).toBe('primary');

    const twin = rig([set('Twin', { move: axis2(WASD), aim: axis2(ARROWS) }, { touchPreset: 'topdown' })]);
    expect(Object.keys(layout(twin.engine))).toEqual(['joystick:left', 'joystick:right']);
  });

  it('keeps declared touch controls (only an unset zone is filled), honours touch.NONE, and does nothing without a preset', () => {
    const fire: ButtonDecl = { kind: 'button', bindings: [MOUSE_LEFT, touchPart({ id: 'button:Shoot', shape: 'button', analog: false, label: 'Shoot' })] };
    const wireframe: ButtonDecl = { kind: 'button', bindings: [keys('KeyV')], noTouch: true };
    const r = rig([set('Fps', { fire, wireframe }, { touchPreset: 'fps' })]);
    expect(layout(r.engine)).toEqual({ 'button:Shoot': 'primary' });
    expect(fire.bindings[1]).toEqual(touchPart({ id: 'button:Shoot', shape: 'button', analog: false, label: 'Shoot' })); // not mutated
    expect(layout(rig([set('Plain', fps())]).engine)).toEqual({});
    expect(layout(rig([set('Custom', fps(), { touchPreset: 'custom' })]).engine)).toEqual({});
  });

  it('per-context presets: each live set brings its own scheme (on foot vs driving)', () => {
    let driving = false;
    const r = rig([
      set('OnFoot', { move: axis2(WASD), jump: button(keys('Space')) }, { touchPreset: 'tps', activeWhen: () => !driving }),
      set('Driving', { steer: axis1({ negative: ['KeyA'], positive: ['KeyD'] }), exit: button(keys('KeyF')) }, { touchPreset: 'racer', activeWhen: () => driving }),
    ]);
    expect(Object.keys(layout(r.engine))).toEqual(['joystick:left', 'button:Jump']);
    driving = true;
    expect(Object.keys(layout(r.engine))).toEqual(['steer', 'button:Exit']);
  });
});

describe('touch control state from the game', () => {
  it('hides, disables, relabels, shows a cooldown and a selection, every frame; hidden and disabled read as idle', () => {
    const state = { ammo: 3, ready: true, cool: 0.5, mode: 0 };
    const fire = button(touchPart({
      id: 'button:Fire', shape: 'button', analog: false, label: 'fire', icon: 'target',
      state: {
        enabled: (ctx) => (ctx as typeof state).ready,
        relabel: (ctx) => ((ctx as typeof state).ammo === 0 ? { label: 'empty', icon: 'x' } : undefined),
        cooldown: (ctx) => (ctx as typeof state).cool,
      },
    }));
    const special = button(touchPart({ id: 'button:Special', shape: 'button', analog: false, label: 'Special', state: { visible: (ctx) => (ctx as typeof state).ammo > 2 } }));
    const modes: GroupDecl = {
      kind: 'group', touchLabels: ['A', 'B'],
      slots: ['A', 'B'].map((l, i) => ({ bindings: [touchPart({ id: `toggle:A|B:${i}`, shape: 'button', analog: false, label: l, zone: 'hotbar', group: 'toggle:A|B', state: { selected: (ctx) => (ctx as typeof state).mode === i } })] })),
    };
    const r = rig([set('C', { fire, special, modes })], { context: state, touchLabel: (l) => l.toUpperCase() });
    r.step();
    let specs = r.devices.output!.touch;
    expect(specs.find((s) => s.id === 'button:Fire')).toMatchObject({ label: 'FIRE', icon: 'target', cooldown: 0.5 });
    expect(specs.find((s) => s.id === 'button:Fire')!.disabled).toBeUndefined();
    expect(specs.map((s) => [s.id, s.selected])).toEqual([['button:Fire', undefined], ['button:Special', undefined], ['toggle:A|B:0', true], ['toggle:A|B:1', false]]);

    state.ammo = 0;
    state.ready = false;
    state.cool = 0;
    r.step();
    specs = r.devices.output!.touch;
    expect(specs.map((s) => s.id)).toEqual(['button:Fire', 'toggle:A|B:0', 'toggle:A|B:1']);
    expect(specs[0]).toMatchObject({ label: 'EMPTY', icon: 'x', disabled: true });
    expect(specs[0]!.cooldown).toBeUndefined();
    r.devices.touchHold('button:Fire');
    r.devices.touchHold('button:Special');
    r.step();
    expect([r.engine.held(fire), r.engine.held(special)]).toEqual([false, false]);
    state.ready = true;
    state.ammo = 5;
    r.step(); // the layout lifts the block at the end of this frame
    r.step();
    expect([r.engine.held(fire), r.engine.held(special)]).toEqual([true, true]);
  });

  it('two touch buttons on an axis1 are a -1 / +1 pair; a stepper reads its x; pinch is unclamped like the wheel', () => {
    const throttle = axis1({ other: [
      touchPart({ id: 'button:brake', shape: 'button', analog: false, label: 'brake' }),
      touchPart({ id: 'button:gas', shape: 'button', analog: false, label: 'gas' }),
    ] });
    const gear = axis1({ other: [touchPart({ id: 'stepper:-|+', shape: 'stepper', analog: true, labels: ['-', '+'] })] });
    const zoom = axis1({ other: [touchPart({ id: 'pinch', shape: 'pinch', analog: true })] });
    const r = rig([set('C', { throttle, gear, zoom })]);
    r.step();
    r.devices.touchHold('button:brake');
    r.devices.touchHold('stepper:-|+', 1);
    r.devices.touchPulse('pinch', 2.5);
    r.step();
    expect([r.engine.value(throttle), r.engine.value(gear), r.engine.value(zoom)]).toEqual([-1, 1, 2.5]);
    r.devices.touchRelease('button:brake');
    r.devices.touchHold('button:gas');
    r.step();
    expect(r.engine.value(throttle)).toBe(1);
  });

  it('sends the highest-priority live set skin with the layout', () => {
    let boat = false;
    const r = rig([
      set('Base', { jump: button(keys('Space')) }, { touchPreset: 'platformer', touchSkin: { accent: 'red' } }),
      set('Boat', { row: button(keys('KeyR')) }, { priority: 2, touchPreset: 'platformer', touchSkin: { accent: 'blue', shape: 'square' }, activeWhen: () => boat }),
    ]);
    r.step();
    expect(r.devices.output!.touchSkin).toEqual({ accent: 'red' });
    boat = true;
    r.step();
    expect(r.devices.output!.touchSkin).toEqual({ accent: 'blue', shape: 'square' });
  });
});
