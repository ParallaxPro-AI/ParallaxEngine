import { describe, expect, it } from 'vitest';
import { ParallaxError, Vec2, Vec3 } from '../../../core/index.js';
import type { ProjectFiles } from '../../../core/index.js';
import { loadProject } from '../../../resource/index.js';
import { Kernel } from '../../kernel/index.js';
import type { SceneScope, SystemDef } from '../../kernel/index.js';
import { HeadlessInput, InputApi, input } from './index.js';
import type {
  ActionDecl, ActionSetDecl, Axis1Decl, Axis2Decl, BindingPart, ButtonDecl, GroupDecl, InputEngine, Seat,
} from './index.js';

// ── Helpers ────────────────────────────────────────────────────────────────────

const DT = 1 / 60;

function files(contents: Record<string, unknown>): ProjectFiles {
  const text = Object.fromEntries(Object.entries(contents).map(([p, v]) => [p, JSON.stringify(v)]));
  return { list: () => Object.keys(text).sort(), read: (p) => text[p]! };
}

const PROJECT = {
  'scenes/main/scene.json': { tags: ['level'], entities: [] },
  'scenes/title/scene.json': { entities: [] },
};

const keys = (...codes: string[]): BindingPart => ({ kind: 'keys', codes });
const WASD: BindingPart = { kind: 'composite', up: ['KeyW'], left: ['KeyA'], down: ['KeyS'], right: ['KeyD'] };
const ARROWS: BindingPart = { kind: 'composite', up: ['ArrowUp'], left: ['ArrowLeft'], down: ['ArrowDown'], right: ['ArrowRight'] };

function button(bindings: BindingPart[], repeat?: [number, number]): ButtonDecl {
  return { kind: 'button', bindings, ...(repeat !== undefined && { repeat }) };
}

function axis2(bindings: BindingPart[], repeat?: [number, number]): Axis2Decl {
  return { kind: 'axis2', bindings, ...(repeat !== undefined && { repeat }) };
}

function axis1(init: Partial<Omit<Axis1Decl, 'kind'>>): Axis1Decl {
  return { kind: 'axis1', negative: [], positive: [], gamepad: [], other: [], ...init };
}

function actionSet(id: string, actions: Record<string, ActionDecl>, extra: {
  priority?: number; scenes?: SceneScope[]; activeWhen?: (ctx: unknown, owner: unknown) => boolean; parent?: ActionSetDecl;
} = {}): ActionSetDecl {
  const inherited = extra.parent === undefined ? [] : [...extra.parent.actions];
  return {
    id,
    priority: extra.priority ?? 0,
    scenes: extra.scenes ?? [],
    actions: new Map([...inherited, ...Object.entries(actions)]),
    ...(extra.activeWhen !== undefined && { activeWhen: extra.activeWhen }),
    ...(extra.parent !== undefined && { parent: extra.parent }),
  };
}

interface Rig {
  readonly kernel: Kernel;
  readonly devices: HeadlessInput;
  readonly engine: InputEngine;
  step(frames?: number): void;
}

function rig(sets: ActionSetDecl[], options: {
  muted?: () => boolean; seats?: Seat[]; systems?: SystemDef[]; scene?: string; context?: unknown;
  touchLabel?: (label: string) => string; overrides?: () => Record<string, string>;
} = {}): Rig {
  const devices = new HeadlessInput();
  const plugin = input({
    devices, sets, ...(options.muted !== undefined && { muted: options.muted }), ...(options.seats !== undefined && { seats: options.seats }),
    ...(options.touchLabel !== undefined && { touchLabel: options.touchLabel }),
    ...(options.overrides !== undefined && { overrides: options.overrides }),
  });
  const project = loadProject(files(PROJECT));
  expect(project.diagnostics).toEqual([]);
  const kernel = new Kernel({
    project,
    game: { components: [], resources: [], events: [], behaviors: [], systems: options.systems ?? [] },
    plugins: [plugin],
    context: options.context ?? {},
  });
  kernel.start(options.scene ?? 'main');
  return {
    kernel, devices, engine: plugin.engine,
    step(frames = 1) { for (let i = 0; i < frames; i++) kernel.step(DT); },
  };
}

function code(fn: () => unknown): string | undefined {
  try { fn(); } catch (e) { if (e instanceof ParallaxError) return e.diagnostic.code; throw e; }
  return undefined;
}

// ── Buttons ────────────────────────────────────────────────────────────────────

describe('buttons', () => {
  it('reports pressed on the first frame, held while down, released on the frame it goes up', () => {
    const jump = button([keys('Space')]);
    const r = rig([actionSet('Controls', { jump })]);
    r.devices.keyDown('Space');
    r.step();
    expect([r.engine.pressed(jump), r.engine.held(jump), r.engine.released(jump)]).toEqual([true, true, false]);
    r.step();
    expect([r.engine.pressed(jump), r.engine.held(jump), r.engine.released(jump)]).toEqual([false, true, false]);
    r.devices.keyUp('Space');
    r.step();
    expect([r.engine.pressed(jump), r.engine.held(jump), r.engine.released(jump)]).toEqual([false, false, true]);
    r.step();
    expect(r.engine.released(jump)).toBe(false);
  });

  it('counts a tap that goes down and up between two frames', () => {
    const jump = button([keys('Space')]);
    const r = rig([actionSet('Controls', { jump })]);
    r.devices.tapKey('Space');
    r.step();
    expect([r.engine.pressed(jump), r.engine.held(jump), r.engine.released(jump)]).toEqual([true, false, true]);
  });

  it('treats a key tuple as alternatives and does not press again when a second key joins', () => {
    const up = button([keys('ArrowUp', 'KeyW')]);
    const r = rig([actionSet('Controls', { up })]);
    r.devices.keyDown('KeyW');
    r.step();
    expect(r.engine.pressed(up)).toBe(true);
    r.devices.keyDown('ArrowUp');
    r.step();
    expect([r.engine.pressed(up), r.engine.held(up)]).toEqual([false, true]);
    r.devices.keyUp('KeyW');
    r.step();
    expect([r.engine.held(up), r.engine.released(up)]).toEqual([true, false]);
  });

  it('is pressed in every phase of its frame, including the first fixed_update', () => {
    const jump = button([keys('Space')]);
    const seen: string[] = [];
    let engine: InputEngine | undefined;
    const sys: SystemDef = {
      id: 'reader', scenes: [], handlers: [],
      create: () => ({
        fixed_update: () => { if (engine!.pressed(jump)) seen.push('fixed'); },
        update: () => { if (engine!.pressed(jump)) seen.push('update'); },
        late_update: () => { if (engine!.pressed(jump)) seen.push('late'); },
      }),
    };
    const r = rig([actionSet('Controls', { jump })], { systems: [sys] });
    engine = r.engine;
    r.devices.keyDown('Space');
    r.step();
    r.step();
    expect(seen).toEqual(['fixed', 'update', 'late']);
  });

  it('repeats while held: after the delay, then every interval', () => {
    const step = button([keys('ArrowRight')], [0.25, 0.1]);
    const r = rig([actionSet('Grid', { step })]);
    r.devices.keyDown('ArrowRight');
    const fired: number[] = [];
    for (let frame = 1; frame <= 40; frame++) {
      r.step();
      if (r.engine.pressed(step)) fired.push(frame);
    }
    // frame 1: the press; +0.25s = 15 frames later; then every 6 frames (0.1s).
    expect(fired).toEqual([1, 16, 22, 28, 34, 40]);
    r.devices.keyUp('ArrowRight');
    r.step();
    expect(r.engine.pressed(step)).toBe(false);
  });

  it('reads gamepad buttons, triggers past half way, mouse buttons, the wheel and touch buttons', () => {
    const fire = button([{ kind: 'pad_trigger', trigger: 'right' }]);
    const jump = button([{ kind: 'pad_button', button: 'south' }]);
    const shoot = button([{ kind: 'mouse_button', button: 'left' }]);
    const next = button([{ kind: 'mouse_wheel' }]);
    const touchJump = button([{ kind: 'touch', control: { id: 'button:Jump', shape: 'button', analog: false, label: 'Jump' } }]);
    const r = rig([actionSet('Controls', { fire, jump, shoot, next, touchJump })]);
    r.devices.padAxis('rightTrigger', 0.4);
    r.devices.padDown('south');
    r.devices.pointerDown('left');
    r.devices.wheel(1);
    r.devices.touchHold('button:Jump');
    r.step();
    expect([r.engine.held(fire), r.engine.pressed(jump), r.engine.pressed(shoot), r.engine.pressed(next), r.engine.pressed(touchJump)])
      .toEqual([false, true, true, true, true]);
    r.devices.padAxis('rightTrigger', 0.8);
    r.step();
    expect([r.engine.pressed(fire), r.engine.pressed(next), r.engine.held(touchJump)]).toEqual([true, false, true]);
  });
});

// ── Axes ───────────────────────────────────────────────────────────────────────

describe('axes', () => {
  it('axis1 from a key pair, a stick axis with its dead zone, and a trigger pair', () => {
    const steer = axis1({ negative: ['KeyA', 'ArrowLeft'], positive: ['KeyD', 'ArrowRight'] });
    const stick = axis1({ gamepad: [{ kind: 'pad_axis', axis: 'left_x' }] });
    const pedals = axis1({ gamepad: [{ kind: 'pad_trigger', trigger: 'left' }, { kind: 'pad_trigger', trigger: 'right' }] });
    const zoom = axis1({ other: [{ kind: 'mouse_wheel' }] });
    const r = rig([actionSet('Drive', { steer, stick, pedals, zoom })]);
    r.devices.keyDown('ArrowLeft');
    r.devices.padAxis('leftX', 0.1);
    r.devices.padAxis('leftTrigger', 1);
    r.devices.wheel(-2);
    r.step();
    expect(r.engine.value(steer)).toBe(-1);
    expect(r.engine.value(stick)).toBe(0); // inside the 0.2 dead zone
    expect(r.engine.value(pedals)).toBe(-1);
    expect(r.engine.value(zoom)).toBe(-2);
    r.devices.keyDown('KeyD');
    r.devices.padAxis('leftX', 0.6);
    r.devices.padAxis('rightTrigger', 1);
    r.step();
    expect(r.engine.value(steer)).toBe(0);
    expect(r.engine.value(stick)).toBeCloseTo(0.5); // (0.6 - 0.2) / 0.8
    expect(r.engine.value(pedals)).toBe(0);
    expect(r.engine.value(zoom)).toBe(0);
  });

  it('axis2: composites normalize diagonals, alternatives combine, sticks are dead-zoned, mouse delta is unbounded with +y up', () => {
    const move = axis2([WASD, ARROWS, { kind: 'pad_stick', stick: 'left' }]);
    const look = axis2([{ kind: 'mouse_delta' }]);
    const r = rig([actionSet('Controls', { move, look })]);
    r.devices.keyDown('KeyW');
    r.devices.keyDown('ArrowRight');
    r.devices.mouseMotion(12, 5);
    r.step();
    const v = r.engine.axis(move);
    expect(v.x).toBeCloseTo(Math.SQRT1_2);
    expect(v.y).toBeCloseTo(Math.SQRT1_2);
    expect(r.engine.axis(look).__eq__(new Vec2(12, -5))).toBe(true);
    r.devices.keyUp('KeyW');
    r.devices.keyUp('ArrowRight');
    r.devices.padAxis('leftX', 0.15);
    r.step();
    expect(r.engine.axis(move).__eq__(Vec2.ZERO)).toBe(true);
    expect(r.engine.axis(look).__eq__(Vec2.ZERO)).toBe(true);
    r.devices.padAxis('leftY', -1);
    r.devices.padAxis('leftX', 0);
    r.step();
    expect(r.engine.axis(move).y).toBeCloseTo(-1);
  });

  it('reads the d-pad and a touch joystick as 2D axes', () => {
    const move = axis2([{ kind: 'pad_dpad' }, { kind: 'touch', control: { id: 'joystick:left', shape: 'joystick', analog: true, side: 'left' } }]);
    const r = rig([actionSet('Controls', { move })]);
    r.devices.padDown('dpad_left');
    r.step();
    expect(r.engine.axis(move).__eq__(Vec2.LEFT)).toBe(true);
    r.devices.padUp('dpad_left');
    r.devices.touchHold('joystick:left', 0, 0.5);
    r.step();
    expect(r.engine.axis(move).__eq__(new Vec2(0, 0.5))).toBe(true);
  });
});

// ── Directions ─────────────────────────────────────────────────────────────────

describe('pressed_direction', () => {
  it('fires once per stick flick, with hysteresis near the threshold', () => {
    const cursor = axis2([{ kind: 'pad_stick', stick: 'left' }]);
    const r = rig([actionSet('Menu', { cursor })]);
    const seen: (string | null)[] = [];
    const record = (): void => {
      const d = r.engine.pressedDirection(cursor);
      seen.push(d === null ? null : `${d.x},${d.y}`);
    };
    for (const x of [1, 1, 0.9, 0.55, 1, 0.1, 1]) {
      r.devices.padAxis('leftX', x);
      r.step();
      record();
    }
    // 0.55 → 0.44 after the dead zone: still "right" (stays above 0.3), so the return to 1 is not a new flick.
    expect(seen).toEqual(['1,0', null, null, null, null, null, '1,0']);
  });

  it('repeats a held direction when the axis declares repeat=', () => {
    const cursor = axis2([ARROWS], [0.2, 0.1]);
    const r = rig([actionSet('Menu', { cursor })]);
    r.devices.keyDown('ArrowUp');
    const fired: number[] = [];
    for (let frame = 1; frame <= 25; frame++) {
      r.step();
      if (r.engine.pressedDirection(cursor)?.__eq__(Vec2.UP) === true) fired.push(frame);
    }
    expect(fired).toEqual([1, 13, 19, 25]);
  });

  it('turning to a new direction is a new press; a grid step has up = row - 1', () => {
    const cursor = axis2([ARROWS]);
    const r = rig([actionSet('Menu', { cursor })]);
    r.devices.keyDown('ArrowUp');
    r.step();
    expect(r.engine.pressedStep(cursor)).toEqual({ col: 0, row: -1 });
    r.devices.keyUp('ArrowUp');
    r.devices.keyDown('ArrowLeft');
    r.step();
    expect(r.engine.pressedStep(cursor)).toEqual({ col: -1, row: 0 });
    // ctx.input.pressed_step gives it as a Cell.
    const step = new InputApi(r.engine).pressed_step(cursor);
    expect([step?.col, step?.row]).toEqual([-1, 0]);
    r.step();
    expect(r.engine.pressedStep(cursor)).toBeNull();
    expect(new InputApi(r.engine).pressed_step(cursor)).toBeNull();
  });

  it('a swipe is one direction for one frame', () => {
    const swipe = axis2([{ kind: 'touch', control: { id: 'swipe', shape: 'swipe', analog: true } }]);
    const r = rig([actionSet('Runner', { swipe })]);
    r.devices.touchPulse('swipe', 0, -1);
    r.step();
    expect(r.engine.pressedDirection(swipe)?.__eq__(Vec2.DOWN)).toBe(true);
    r.step();
    expect(r.engine.pressedDirection(swipe)).toBeNull();
  });

  it('axis1 gives -1 / +1 on the frame it crosses into a direction (lane changes)', () => {
    const lane = axis1({ negative: ['KeyA'], positive: ['KeyD'] });
    const r = rig([actionSet('Runner', { lane })]);
    r.devices.keyDown('KeyD');
    r.step();
    expect(r.engine.pressedDirection(lane)).toBe(1);
    r.step();
    expect(r.engine.pressedDirection(lane)).toBeNull();
    r.devices.keyUp('KeyD');
    r.devices.keyDown('KeyA');
    r.step();
    expect(r.engine.pressedDirection(lane)).toBe(-1);
  });

  it('a key tapped down and up between two frames still steps once (axis2 and axis1)', () => {
    const cursor = axis2([WASD]);
    const lane = axis1({ negative: ['KeyA'], positive: ['KeyD'] });
    const r = rig([actionSet('Hop', { cursor, lane })]);
    r.devices.tapKey('KeyW');
    r.step();
    expect(r.engine.pressedStep(cursor)).toEqual({ col: 0, row: -1 });
    expect(r.engine.axis(cursor).__eq__(Vec2.ZERO)).toBe(true); // the tap moves nothing continuously
    r.step();
    expect(r.engine.pressedStep(cursor)).toBeNull();
    r.devices.tapKey('KeyD');
    r.step();
    expect(r.engine.pressedDirection(lane)).toBe(1);
    expect(r.engine.value(lane)).toBe(0);
    r.step();
    expect(r.engine.pressedDirection(lane)).toBeNull();
  });
});

// ── Button groups ──────────────────────────────────────────────────────────────

describe('button groups', () => {
  it('reports which slot went down, with None slots unbound on that device', () => {
    const hotbar: GroupDecl = {
      kind: 'group',
      slots: [
        { bindings: [keys('Digit1'), { kind: 'pad_button', button: 'dpad_left' }] },
        { bindings: [] },
        { bindings: [keys('Digit3')] },
      ],
      touchLabels: [],
    };
    const r = rig([actionSet('Hotbar', { hotbar })]);
    r.step();
    expect(r.engine.pressedIndex(hotbar)).toBeNull();
    r.devices.tapKey('Digit3');
    r.step();
    expect(r.engine.pressedIndex(hotbar)).toBe(2);
    r.devices.padDown('dpad_left');
    r.step();
    expect(r.engine.pressedIndex(hotbar)).toBe(0);
    r.step();
    expect(r.engine.pressedIndex(hotbar)).toBeNull();
    r.engine.injectIndex(hotbar, 1);
    r.step();
    expect(r.engine.pressedIndex(hotbar)).toBe(1);
    expect(code(() => r.engine.injectIndex(hotbar, 3))).toBe('PP3406');
  });
});

// ── Liveness: scenes, active_when, priority, mute ──────────────────────────────

describe('which action sets are live', () => {
  it('scenes= scopes a set by scene id or scene tag', () => {
    const jump = button([keys('Space')]);
    const tagged = button([keys('KeyE')]);
    const r = rig([
      actionSet('Title', { jump }, { scenes: [{ scene: 'title' }] }),
      actionSet('Level', { use: tagged }, { scenes: [{ tag: 'level' }] }),
    ]);
    r.devices.keyDown('Space');
    r.devices.keyDown('KeyE');
    r.step();
    expect(r.engine.held(jump)).toBe(false);
    expect(r.engine.held(tagged)).toBe(true);
    r.kernel.requestScene('title');
    r.step();
    r.step();
    expect(r.engine.held(jump)).toBe(true);
    expect(r.engine.held(tagged)).toBe(false);
  });

  it('active_when is evaluated for the reading owner', () => {
    const drive = button([keys('KeyW')]);
    const inCar = new Set(['car_owner']);
    const r = rig([actionSet('Driving', { drive }, { activeWhen: (_ctx, owner) => inCar.has(owner as string) })]);
    r.devices.keyDown('KeyW');
    r.step();
    expect(r.engine.held(drive, { seat: 0, owner: 'car_owner' })).toBe(true);
    expect(r.engine.held(drive, { seat: 0, owner: 'walker' })).toBe(false);
  });

  it('a strictly higher priority live set keeps a shared key; when it goes idle the lower set gets it back', () => {
    const jump = button([keys('Space'), keys('KeyJ')]);
    const boost = button([keys('Space')]);
    const lean = axis2([WASD]);
    let driving = true;
    const r = rig([
      actionSet('OnFoot', { jump, lean }),
      actionSet('Vehicle', { boost }, { priority: 1, activeWhen: () => driving }),
    ]);
    r.devices.keyDown('Space');
    r.devices.keyDown('KeyW');
    r.step();
    expect(r.engine.pressed(boost)).toBe(true);
    expect(r.engine.held(jump)).toBe(false);
    expect(r.engine.axis(lean).__eq__(Vec2.UP)).toBe(true); // W isn't claimed
    r.devices.keyDown('KeyJ');
    r.step();
    expect(r.engine.held(jump)).toBe(true); // J isn't claimed
    r.devices.keyUp('KeyJ');
    driving = false;
    r.step();
    expect(r.engine.held(jump)).toBe(true);
    expect(r.engine.held(boost)).toBe(false);
  });

  it('equal priorities share an input', () => {
    const a = button([keys('Space')]);
    const b = button([keys('Space')]);
    const r = rig([actionSet('A', { a }), actionSet('B', { b })]);
    r.devices.keyDown('Space');
    r.step();
    expect([r.engine.pressed(a), r.engine.pressed(b)]).toEqual([true, true]);
  });

  it('muted gameplay input reads idle, except through ignoreMute (the UI\'s own toggle key)', () => {
    const pause = button([keys('Escape')]);
    let muted = false;
    const r = rig([actionSet('Controls', { pause })], { muted: () => muted });
    muted = true;
    r.devices.keyDown('Escape');
    r.step();
    expect(r.engine.pressed(pause)).toBe(false);
    expect(r.engine.pressed(pause, { seat: 0, owner: null }, { ignoreMute: true })).toBe(true);
  });
});

// ── Any button (dialogue) ──────────────────────────────────────────────────────

describe('anyButtonPressed', () => {
  it('sees a press of any button or group slot, through scenes, active_when and the mute', () => {
    const talk = button([keys('KeyE')]);
    const hotbar: GroupDecl = { kind: 'group', slots: [{ bindings: [keys('Digit1')] }, { bindings: [keys('Digit2')] }], touchLabels: [null, null] };
    const look = axis2([WASD]);
    let muted = true;
    const r = rig([
      actionSet('Town', { talk }, { scenes: [{ scene: 'title' }], activeWhen: () => false }),
      actionSet('Bar', { hotbar, look }),
    ], { muted: () => muted });
    expect(r.engine.anyButtonPressed(0)).toBe(false);
    r.devices.keyDown('KeyE');
    r.step();
    expect(r.engine.pressed(talk)).toBe(false);
    expect(r.engine.anyButtonPressed(0)).toBe(true);
    r.step();
    expect(r.engine.anyButtonPressed(0)).toBe(false);
    r.devices.keyDown('Digit2');
    r.devices.keyDown('KeyW');
    r.step();
    expect(r.engine.anyButtonPressed(0)).toBe(true);
    muted = false;
    r.devices.keyUp('Digit2');
    r.step();
    // An axis is not a button.
    expect(r.engine.anyButtonPressed(0)).toBe(false);
  });

  it('counts only the seat\'s own per-seat controls', () => {
    const jump = button([keys('Space')]);
    const p1 = actionSet('Controls', { jump });
    const p2 = actionSet('Player2Controls', { jump: button([keys('Enter')]) }, { parent: p1 });
    const r = rig([p1, p2], {
      seats: [
        { index: 0, keyboard: true, mouse: true, touch: true, gamepad: 0, controls: p1 },
        { index: 1, keyboard: true, mouse: false, touch: false, gamepad: 1, controls: p2 },
      ],
    });
    r.devices.keyDown('Enter');
    r.step();
    expect([r.engine.anyButtonPressed(0), r.engine.anyButtonPressed(1)]).toEqual([false, true]);
    expect(code(() => r.engine.anyButtonPressed(2))).toBe('PP3403');
  });
});

// ── Seats ──────────────────────────────────────────────────────────────────────

describe('seats', () => {
  it('per-seat controls override actions by name; gamepads map to seats', () => {
    const move = axis2([WASD, { kind: 'pad_stick', stick: 'left' }]);
    const jump = button([keys('Space')]);
    const p1 = actionSet('Controls', { move, jump });
    const p2 = actionSet('Player2Controls', { move: axis2([ARROWS, { kind: 'pad_stick', stick: 'left' }]), jump: button([keys('Enter')]) }, { parent: p1 });
    const r = rig([p1, p2], {
      seats: [
        { index: 0, keyboard: true, mouse: true, touch: true, gamepad: 0, controls: p1 },
        { index: 1, keyboard: true, mouse: false, touch: false, gamepad: 1, controls: p2 },
      ],
    });
    r.devices.keyDown('KeyD');
    r.devices.keyDown('ArrowUp');
    r.devices.keyDown('Enter');
    r.devices.padAxis('leftY', -1, 1);
    r.step();
    expect(r.engine.axis(move, { seat: 0, owner: null }).__eq__(Vec2.RIGHT)).toBe(true);
    // Seat 1 reads `Controls.move` through Player2Controls: arrows up + its own pad's stick down.
    expect(r.engine.axis(move, { seat: 1, owner: null }).length()).toBeCloseTo(0);
    expect(r.engine.pressed(jump, { seat: 0, owner: null })).toBe(false);
    expect(r.engine.pressed(jump, { seat: 1, owner: null })).toBe(true);
    r.devices.keyUp('ArrowUp');
    r.step();
    expect(r.engine.axis(move, { seat: 1, owner: null }).y).toBeCloseTo(-1);
    expect(code(() => r.engine.held(jump, { seat: 2, owner: null }))).toBe('PP3403');
  });

  it('rejects seats that are misnumbered or use unregistered controls', () => {
    const r = rig([actionSet('Controls', {})]);
    expect(code(() => r.engine.setSeats([{ index: 1, keyboard: true, mouse: true, touch: true, gamepad: null }]))).toBe('PP3401');
    expect(code(() => r.engine.setSeats([
      { index: 0, keyboard: true, mouse: true, touch: true, gamepad: null, controls: actionSet('Stray', {}) },
    ]))).toBe('PP3402');
  });
});

// ── Pointer ────────────────────────────────────────────────────────────────────

describe('pointer', () => {
  it('a press on a UI panel reaches neither the pointer nor mouse-bound actions, until released', () => {
    const select = button([{ kind: 'mouse_button', button: 'left' }]);
    const r = rig([actionSet('Tower', { select })]);
    const api = new InputApi(r.engine);
    r.devices.pointerDown('left', { overUi: true });
    r.step();
    expect([api.pointer.pressed, api.pointer.held, r.engine.pressed(select)]).toEqual([false, false, false]);
    r.step();
    expect(r.engine.held(select)).toBe(false);
    r.devices.pointerUp('left');
    r.step();
    r.devices.pointerDown('left');
    r.step();
    expect([api.pointer.pressed, r.engine.pressed(select)]).toEqual([true, true]);
  });

  it('reading `over` on a pressed frame consumes the click for mouse-bound actions; empty ground does not', () => {
    const order = button([{ kind: 'mouse_button', button: 'left' }]);
    const r = rig([actionSet('Moba', { order })]);
    let under: unknown = 7;
    r.engine.setPointerResolver({ world: (s) => new Vec3(s.x, 0, s.y), over: () => under });
    const api = new InputApi(r.engine);
    r.devices.pointerMove(3, 4);
    r.devices.pointerDown('left');
    r.step();
    expect(r.engine.pressed(order)).toBe(true); // nothing read `over` yet
    expect(api.pointer.over).toBe(7);
    expect(r.engine.pressed(order)).toBe(false);
    expect(r.engine.held(order)).toBe(false);
    expect(api.pointer.pressed).toBe(true); // the world still saw the click
    expect(api.pointer.world.__eq__(new Vec3(3, 0, 4))).toBe(true);
    r.devices.pointerUp('left');
    r.step();
    under = null;
    r.devices.pointerDown('left');
    r.step();
    expect(api.pointer.over).toBeNull();
    expect(r.engine.pressed(order)).toBe(true);
    api.pointer.consume();
    expect(r.engine.pressed(order)).toBe(false);
  });

  it('reports screen position, movement and drag while held; world/over need a resolver', () => {
    const r = rig([actionSet('Controls', {})]);
    const api = new InputApi(r.engine);
    r.devices.pointerMove(10, 20);
    r.step();
    expect([api.pointer.screen.x, api.pointer.screen.y, api.pointer.moved]).toEqual([10, 20, true]);
    expect(api.pointer.drag.__eq__(Vec2.ZERO)).toBe(true);
    r.devices.pointerDown('left');
    r.devices.pointerMove(15, 18);
    r.step();
    expect(api.pointer.drag.__eq__(new Vec2(5, -2))).toBe(true);
    r.step();
    expect(api.pointer.moved).toBe(false);
    expect(code(() => api.pointer.world)).toBe('PP3405');
  });
});

// ── Device requests, touch layout, text ────────────────────────────────────────

describe('devices', () => {
  it('locks the cursor for mouse-look while gameplay input is live, frees it when muted', () => {
    const look = axis2([{ kind: 'mouse_delta' }]);
    let muted = false;
    const r = rig([actionSet('Look', { look }, { scenes: [{ tag: 'level' }] })], { muted: () => muted });
    r.step();
    expect(r.devices.output?.cursor).toBe('locked');
    muted = true;
    r.step();
    expect(r.devices.output?.cursor).toBe('free');
    muted = false;
    r.kernel.requestScene('title');
    r.step();
    r.step();
    expect(r.devices.output?.cursor).toBe('free');
  });

  it('asks for the virtual cursor only while a modal frees the cursor over a mouse-look scene', () => {
    const look = axis2([{ kind: 'mouse_delta' }]);
    let muted = false;
    const r = rig([actionSet('Look', { look }, { scenes: [{ tag: 'level' }] })], { muted: () => muted });
    r.step();
    expect(r.devices.output?.virtualCursor).toBe(false);
    muted = true;
    r.step();
    expect([r.devices.output?.cursor, r.devices.output?.virtualCursor]).toEqual(['free', true]);
    expect(r.engine.virtualCursor()).toBe(true);
    muted = false;
    r.kernel.requestScene('title'); // no mouse-look there: a menu is the OS cursor's
    r.step();
    muted = true;
    r.step();
    expect([r.devices.output?.cursor, r.devices.output?.virtualCursor]).toEqual(['free', false]);
  });

  it('typed text, the last device used, rumble and the on-screen keyboard request', () => {
    const r = rig([actionSet('Controls', {})]);
    const api = new InputApi(r.engine);
    r.devices.type('hi');
    r.step();
    expect(api.text).toBe('hi');
    expect(api.device).toBe('keyboard');
    api.rumble(0.5, 0.2);
    r.devices.padDown('south');
    r.step();
    expect(api.text).toBe('');
    expect(api.device).toBe('gamepad');
    expect(r.devices.output?.textEntry).toBe(true);
    expect(r.devices.output?.rumble).toEqual([{ pad: null, strength: 0.5, seconds: 0.2 }]);
    r.devices.touchPulse('tap');
    r.step();
    expect(api.device).toBe('touch');
  });

  it('a live set with touch_keyboard False keeps the phone keyboard shut; rumble_pattern sends its pulses', () => {
    let typing = true;
    const own = { ...actionSet('Typing', {}, { activeWhen: () => typing }), touchKeyboard: false as const };
    const r = rig([actionSet('Controls', {}), own]);
    const api = new InputApi(r.engine);
    void api.text;
    r.step();
    expect(r.devices.output?.textEntry).toBe(false);
    typing = false;
    void api.text;
    r.step();
    expect(r.devices.output?.textEntry).toBe(true);
    api.rumble_pattern([[1, 0.05], [0, 0.05], [0.4, 0.1]]);
    r.step();
    expect(r.devices.output?.rumble).toEqual([{ pad: null, strength: 1, seconds: 0.2, pattern: [[1, 0.05], [0, 0.05], [0.4, 0.1]] }]);
    for (const bad of [[], [[2, 0.1]], [[0.5, 0]], [[0.5]], 'buzz']) {
      let code: string | undefined;
      try { api.rumble_pattern(bad); } catch (e) { code = (e as { diagnostic?: { code: string } }).diagnostic?.code; }
      expect(code, JSON.stringify(bad)).toBe('PP3411');
    }
  });

  it('lists the touch controls of in-scope sets for the platform to draw, none while muted', () => {
    const stick = { id: 'joystick:left', shape: 'joystick', analog: true, side: 'left' } as const;
    const jumpBtn = { id: 'button:Jump', shape: 'button', analog: false, label: 'Jump' } as const;
    let muted = false;
    const r = rig([
      actionSet('Controls', { move: axis2([{ kind: 'touch', control: stick }]), jump: button([{ kind: 'touch', control: jumpBtn }]) }),
      actionSet('Driving', { steer: axis1({ other: [{ kind: 'touch', control: stick }] }) }),
      actionSet('Title', { go: button([{ kind: 'touch', control: { id: 'tap', shape: 'tap', analog: false } }]) }, { scenes: [{ scene: 'title' }] }),
    ], { muted: () => muted });
    expect(r.engine.touchLayout()).toEqual([
      { control: stick, actions: ['Controls.move', 'Driving.steer'] },
      { control: jumpBtn, actions: ['Controls.jump'] },
    ]);
    muted = true;
    expect(r.engine.touchLayout()).toEqual([]);
  });

  it('leaves out the touch controls of a set whose active_when is false (asked with no owner)', () => {
    const launch = { id: 'button:Launch', shape: 'button', analog: false, label: 'Launch' } as const;
    let serving = false;
    const owners: unknown[] = [];
    const r = rig([actionSet('Serve', { launch: button([{ kind: 'touch', control: launch }]) }, {
      activeWhen: (_ctx, owner) => { owners.push(owner); return serving; },
    })]);
    expect(r.engine.touchLayout()).toEqual([]);
    serving = true;
    expect(r.engine.touchLayout()).toEqual([{ control: launch, actions: ['Serve.launch'] }]);
    expect(owners.every((o) => o === null)).toBe(true);
  });
});

describe('touch controls to draw, remapping, remote pointers', () => {
  it('hands the platform the touch layout each frame, labels localized', () => {
    const jumpBtn = { id: 'button:jump_label', shape: 'button', analog: false, label: 'jump_label' } as const;
    const r = rig([actionSet('Controls', { jump: button([{ kind: 'touch', control: jumpBtn }]) })], {
      touchLabel: (label) => (label === 'jump_label' ? 'Saltar' : label),
    });
    r.step();
    expect(r.devices.output?.touch).toEqual([{ ...jumpBtn, label: 'Saltar' }]);
  });

  it('remaps primary bindings: a button key, a group slot, an axis1 side and an axis2 direction; masks follow', () => {
    const overrides: Record<string, string> = {};
    const r = rig([
      actionSet('Controls', {
        jump: button([keys('Space'), { kind: 'pad_button', button: 'south' }]),
        move: axis2([WASD, ARROWS]),
        slots: { kind: 'group', slots: [{ bindings: [keys('Digit1')] }, { bindings: [keys('Digit2')] }], touchLabels: [] },
        zoom: axis1({ negative: ['KeyQ'], positive: ['KeyE'] }),
      }),
      actionSet('Menu', { pick: button([keys('KeyJ')]) }, { priority: 5 }),
    ], { overrides: () => overrides });
    const c = r.engine.sets[0]!.actions;
    const jump = c.get('jump') as ButtonDecl;
    expect(r.engine.remapSlots().map((s) => s.slot)).toEqual([
      'Controls.jump:key', 'Controls.jump:pad', 'Controls.move:up', 'Controls.move:down', 'Controls.move:left', 'Controls.move:right',
      'Controls.slots.0:key', 'Controls.slots.1:key', 'Controls.zoom:negative', 'Controls.zoom:positive', 'Menu.pick:key',
    ]);
    Object.assign(overrides, {
      'Controls.jump:key': 'KeyK', 'Controls.move:up': 'KeyI', 'Controls.slots.1:key': 'KeyX', 'Controls.zoom:positive': 'KeyR',
    });
    r.devices.tapKey('KeyK');
    r.step();
    expect(r.engine.pressed(jump)).toBe(true);
    r.devices.tapKey('Space');
    r.step();
    expect(r.engine.pressed(jump)).toBe(false);
    r.devices.keyDown('KeyI');
    r.devices.keyDown('KeyR');
    r.devices.tapKey('KeyX');
    r.step();
    expect(r.engine.axis(c.get('move') as Axis2Decl).__eq__(new Vec2(0, 1))).toBe(true);
    expect(r.engine.value(c.get('zoom') as Axis1Decl)).toBe(1);
    expect(r.engine.pressedIndex(c.get('slots') as never)).toBe(1);
    r.devices.keyUp('KeyI');
    r.devices.keyDown('ArrowUp'); // the alternate composite stays
    r.step();
    expect(r.engine.axis(c.get('move') as Axis2Decl).__eq__(new Vec2(0, 1))).toBe(true);
    // Remapping jump onto the higher-priority menu's key: the menu keeps it.
    overrides['Controls.jump:key'] = 'KeyJ';
    r.devices.tapKey('KeyJ');
    r.step();
    expect(r.engine.pressed(jump)).toBe(false);
    expect(r.engine.pressed(r.engine.sets[1]!.actions.get('pick') as ButtonDecl)).toBe(true);
  });

  it('captures the next key or gamepad button for a slot; Escape cancels; unknown slots are refused', () => {
    const r = rig([actionSet('Controls', { jump: button([keys('Space'), { kind: 'pad_button', button: 'south' }]) })]);
    const got: (string | null)[] = [];
    r.engine.beginCapture('Controls.jump:pad', (b) => got.push(b));
    r.devices.tapKey('KeyQ'); // a key is not a gamepad button
    r.step();
    expect(r.engine.capturing).toBe('Controls.jump:pad');
    r.devices.padDown('north');
    r.step();
    r.engine.beginCapture('Controls.jump:key', (b) => got.push(b));
    r.devices.tapKey('Escape');
    r.step();
    expect(got).toEqual(['north', null]);
    expect(r.engine.capturing).toBe(null);
    expect(code(() => r.engine.beginCapture('Controls.jump:up', () => {}))).toBe('PP3408');
  });

  it('ctx.input rebinding: controls() rows, rebind stores the next key, reset one slot or all', () => {
    const jump = button([keys('Space'), { kind: 'pad_button', button: 'south' }]);
    const fire = button([keys('KeyF')]);
    const r = rig([actionSet('Controls', { jump, fire })]);
    const api = new InputApi(r.engine);
    expect(api.controls().map((c) => [c.slot, c.label, c.binding, c.changed])).toEqual([
      ['Controls.jump:key', 'Jump', 'Space', false], ['Controls.jump:pad', 'Jump', 'A / ✕', false], ['Controls.fire:key', 'Fire', 'F', false],
    ]);
    expect(api.controls({ __action__: fire }).map((c) => c.slot)).toEqual(['Controls.fire:key']);
    api.rebind('Controls.jump:key');
    expect(api.rebinding).toBe('Controls.jump:key');
    expect(api.controls()[0]!.capturing).toBe(true);
    r.devices.tapKey('KeyJ');
    r.step();
    expect(api.rebinding).toBe(null);
    expect(api.controls()[0]).toMatchObject({ binding: 'J', code: 'KeyJ', changed: true, capturing: false });
    r.devices.tapKey('KeyJ');
    r.step();
    expect(r.engine.pressed(jump)).toBe(true);
    api.rebind('Controls.fire:key');
    r.devices.tapKey('KeyG');
    r.step();
    api.reset_controls('Controls.jump:key');
    expect(api.controls().map((c) => c.code)).toEqual(['Space', 'south', 'KeyG']);
    api.rebind('Controls.jump:pad');
    api.cancel_rebind();
    expect(api.rebinding).toBe(null);
    api.reset_controls();
    expect(api.controls().some((c) => c.changed)).toBe(false);
    expect(code(() => api.rebind('Controls.jmp:key'))).toBe('PP3408');
    expect(code(() => api.reset_controls(3))).toBe('PP3408');
  });

  it('rebind writes through setOverrides when the game stores remaps', () => {
    let stored: Record<string, string> = { 'Controls.jump:pad': 'east' };
    const devices = new HeadlessInput();
    const plugin = input({
      devices, sets: [actionSet('Controls', { jump: button([keys('Space'), { kind: 'pad_button', button: 'south' }]) })],
      overrides: () => stored, setOverrides: (next) => { stored = { ...next }; },
    });
    const kernel = new Kernel({
      project: loadProject(files(PROJECT)), game: { components: [], resources: [], events: [], behaviors: [], systems: [] }, plugins: [plugin], context: {},
    });
    kernel.start('main');
    plugin.engine.rebind('Controls.jump:key');
    devices.tapKey('KeyK');
    kernel.step(DT);
    expect(stored).toEqual({ 'Controls.jump:pad': 'east', 'Controls.jump:key': 'KeyK' });
  });

  it('a remote seat reads the pointer its client sent, from the next frame; other seats read this machine', () => {
    const seats: Seat[] = [
      { index: 0, keyboard: true, mouse: true, touch: true, gamepad: 'any' },
      { index: 1, keyboard: false, mouse: false, touch: false, gamepad: null },
    ];
    const r = rig([actionSet('Controls', { jump: button([keys('Space')]) })], { seats });
    const remote = { seat: 1, owner: null };
    const unit = { id: 'unit' };
    r.engine.injectPointer(1, { x: 40, y: 30, world: new Vec3(5, 0, 2), over: unit, held: true, pressed: true });
    expect(r.engine.pointerButton(remote).pressed).toBe(false);
    r.step();
    expect(r.engine.pointerButton(remote)).toEqual({ held: true, pressed: true, released: false });
    expect(r.engine.pointerWorld(remote).__eq__(new Vec3(5, 0, 2))).toBe(true);
    expect(r.engine.pointerOver(remote)).toBe(unit);
    expect(r.engine.pointerScreen(remote).__eq__(new Vec2(40, 30))).toBe(true);
    expect(r.engine.pointerButton({ seat: 0, owner: null }).pressed).toBe(false);
    r.engine.injectPointer(1, { x: 44, y: 30, world: null, over: null, held: false, pressed: false });
    r.step();
    expect(r.engine.pointerButton(remote)).toEqual({ held: false, pressed: false, released: true });
    expect(r.engine.pointerDelta(remote).__eq__(new Vec2(4, 0))).toBe(true);
    expect(code(() => r.engine.pointerWorld(remote))).toBe('PP3409');
  });
});

// ── Injection and the namespace ────────────────────────────────────────────────

describe('injection (test harness) and ctx.input', () => {
  it('press, hold for seconds, set an axis and move a stick, all subject to liveness', () => {
    const jump = button([keys('Space')]);
    const sail = axis1({ negative: ['KeyS'], positive: ['KeyW'] });
    const move = axis2([WASD]);
    let muted = false;
    const r = rig([actionSet('Controls', { jump, sail, move })], { muted: () => muted });
    r.engine.inject(jump);
    r.step();
    expect([r.engine.pressed(jump), r.engine.held(jump)]).toEqual([true, false]);
    r.step();
    expect(r.engine.pressed(jump)).toBe(false);

    r.engine.injectHold(jump, 0.1);
    const held: boolean[] = [];
    for (let i = 0; i < 8; i++) { r.step(); held.push(r.engine.held(jump)); }
    expect(held).toEqual([true, true, true, true, true, true, false, false]);

    r.engine.injectValue(sail, 0.5, null);
    r.engine.injectVector(move, new Vec2(0, 2), null);
    r.step();
    expect(r.engine.value(sail)).toBe(0.5);
    expect(r.engine.axis(move).__eq__(Vec2.UP)).toBe(true); // clamped to unit length
    muted = true;
    r.step();
    expect(r.engine.value(sail)).toBe(0);
    muted = false;
    r.engine.injectRelease(sail);
    r.step();
    expect(r.engine.value(sail)).toBe(0);
  });

  it('an injected hold is pressed on its first frame and released on the frame after injectRelease', () => {
    const jump = button([keys('Space')]);
    const r = rig([actionSet('Controls', { jump })]);
    const frame = (): boolean[] => { r.step(); return [r.engine.pressed(jump), r.engine.held(jump), r.engine.released(jump)]; };
    r.engine.injectHold(jump, null);
    expect(frame()).toEqual([true, true, false]);
    expect(frame()).toEqual([false, true, false]);
    r.engine.injectRelease(jump);
    expect(frame()).toEqual([false, false, true]);
    expect(frame()).toEqual([false, false, false]);
    // A timed hold ends on its own, with a release edge.
    r.engine.injectHold(jump, 2 * DT);
    const timed: boolean[][] = [];
    for (let i = 0; i < 5; i++) timed.push(frame());
    expect(timed.map(([p]) => p)).toEqual([true, false, false, false, false]);
    expect(timed.map(([, held]) => held)).toEqual([true, true, false, false, false]);
    expect(timed.map(([, , rel]) => rel)).toEqual([false, false, true, false, false]);
  });

  it('ctx.input reads through the api handle and the current reader', () => {
    const jump = button([keys('Space')]);
    const handle = { __action__: jump };
    let owner: unknown = 'a';
    const r = rig([actionSet('Controls', { jump }, { activeWhen: (_c, o) => o === 'a' })]);
    const api = new InputApi(r.engine, { current: () => ({ seat: 0, owner }) });
    r.devices.keyDown('Space');
    r.step();
    expect(api.pressed(handle)).toBe(true);
    owner = 'b';
    expect(api.pressed(handle)).toBe(false);
    expect(code(() => api.value(handle))).toBe('PP3404');
    expect(code(() => api.pressed(42))).toBe('PP3407');
    expect(code(() => api.pressed({ __action__: button([keys('KeyQ')]) }))).toBe('PP3400');
  });

  it('rejects two action sets with the same name', () => {
    const r = rig([actionSet('Controls', {})]);
    expect(code(() => r.engine.addSet(actionSet('Controls', {})))).toBe('PP4400');
  });

  it('is exposed as the ctx namespace "input"', () => {
    const plugin = input({ devices: new HeadlessInput() });
    expect(plugin.namespace?.name).toBe('input');
  });
});
