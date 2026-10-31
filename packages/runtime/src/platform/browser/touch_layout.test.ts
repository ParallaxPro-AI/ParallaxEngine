import { describe, expect, it } from 'vitest';
import type { TouchControlSpec } from '../../core/index.js';
import { clash, layoutTouch, touchScale } from './touch_layout.js';
import type { Shape, TouchLayout } from './touch_layout.js';

const btn = (id: string, extra: Partial<TouchControlSpec> = {}): TouchControlSpec => ({ id, shape: 'button', analog: false, label: id, ...extra });
const stick = (side: 'left' | 'right', extra: Partial<TouchControlSpec> = {}): TouchControlSpec => ({ id: `joystick:${side}`, shape: 'joystick', analog: true, side, ...extra });

/** Every drawn shape: buttons, steppers, d-pads, and each stick's base circle. */
function boxes(l: TouchLayout): [string, Shape][] {
  return [
    ...[...l.controls.values()].map((c) => [c.id, c] as [string, Shape]),
    ...[...l.sticks.values()].map((s) => [s.id, { x: s.cx - s.radius, y: s.cy - s.radius, w: s.radius * 2, h: s.radius * 2, round: true }] as [string, Shape]),
  ];
}

function expectClean(l: TouchLayout, width: number, height: number): void {
  const all = boxes(l);
  for (const [id, b] of all) {
    expect({ id, inside: b.x >= 0 && b.y >= 0 && b.x + b.w <= width + 0.5 && b.y + b.h <= height + 0.5 }).toEqual({ id, inside: true });
  }
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      expect({ pair: [all[i]![0], all[j]![0]], overlap: clash(all[i]![1], all[j]![1]) }).toEqual({ pair: [all[i]![0], all[j]![0]], overlap: false });
    }
  }
}

const FPS: TouchControlSpec[] = [
  stick('left'), { id: 'look', shape: 'look', analog: true },
  btn('button:Fire', { zone: 'primary' }), btn('button:Aim'), btn('button:Jump'), btn('button:Reload'), btn('button:Crouch'),
  btn('button:Use'), btn('button:Grenade'),
  { id: 'stepper:switch', shape: 'stepper', analog: true, labels: ['−', '+'] },
  ...[0, 1, 2, 3].map((i) => btn(`hotbar:slot:${i}`, { zone: 'hotbar', label: String(i + 1) })),
  btn('button:Pause', { zone: 'system' }), btn('button:Map', { zone: 'system' }),
];

describe('touch layout', () => {
  it('scales with the shorter side and the skin', () => {
    expect(touchScale(844, 390)).toBe(1);
    expect(touchScale(568, 200)).toBe(0.75);
    expect(touchScale(1366, 1024)).toBe(1.35);
    expect(touchScale(844, 390, 1.2)).toBeCloseTo(1.2);
  });

  it('an fps layout on a landscape phone: primary in the corner, arcs, hotbar between the thumbs, tray on top — nothing overlaps', () => {
    const l = layoutTouch(FPS, 844, 390);
    expectClean(l, 844, 390);
    const fire = l.controls.get('button:Fire')!;
    expect(fire.x + fire.w).toBeCloseTo(844 - 16);
    expect(fire.y + fire.h).toBeCloseTo(390 - 16);
    // Every action button sits up and to the left of the primary.
    for (const id of ['button:Aim', 'button:Jump', 'button:Reload', 'button:Crouch', 'button:Use', 'button:Grenade']) {
      const b = l.controls.get(id)!;
      expect(b.x + b.w / 2 <= fire.x + fire.w / 2 + 1 && b.y + b.h / 2 <= fire.y + fire.h / 2 + 1).toBe(true);
    }
    const slots = [0, 1, 2, 3].map((i) => l.controls.get(`hotbar:slot:${i}`)!);
    expect(slots.every((s) => s.y + s.h === 390 - 16)).toBe(true);
    expect(l.controls.get('button:Pause')!.y).toBe(16);
    const left = l.sticks.get('joystick:left')!;
    expect(left.cx).toBeLessThan(844 / 4);
    expect(l.controls.get('stepper:switch')!.zone).toBe('left'); // above the left stick
    expect(l.controls.get('stepper:switch')!.y + l.controls.get('stepper:switch')!.h).toBeLessThan(left.cy - left.radius);
  });

  it('stays on screen without overlaps in portrait and on a small phone (the hotbar rises over the thumbs)', () => {
    for (const [w, h] of [[390, 844], [568, 320], [1024, 768]] as const) expectClean(layoutTouch(FPS, w, h), w, h);
    const portrait = layoutTouch(FPS, 390, 844);
    const fire = portrait.controls.get('button:Fire')!;
    expect(portrait.controls.get('hotbar:slot:0')!.y + 54).toBeLessThanOrEqual(fire.y + 1);
  });

  it('racer: pedals in the corner, the steering wheel left, buttons above the pedals', () => {
    const specs: TouchControlSpec[] = [
      { id: 'steer', shape: 'steer', analog: true },
      { id: 'pedals:Brake|Gas', shape: 'stepper', analog: true, zone: 'pedals', labels: ['Brake', 'Gas'] },
      btn('button:Nitro'), btn('button:Drift'), btn('button:Horn', { zone: 'system' }),
    ];
    const l = layoutTouch(specs, 844, 390);
    expectClean(l, 844, 390);
    const pedals = l.controls.get('pedals:Brake|Gas')!;
    expect(pedals.x + pedals.w).toBeCloseTo(844 - 16);
    expect(l.controls.get('button:Nitro')!.zone).toBe('primary'); // promoted: no primary declared
    expect(l.controls.get('button:Nitro')!.y + 84).toBeLessThanOrEqual(pedals.y);
    expect(l.sticks.get('steer')!.side).toBe('left');
  });

  it('twin sticks: buttons ride above the right stick; a fixed stick takes touches only near its rest point', () => {
    const specs: TouchControlSpec[] = [stick('left'), stick('right', { fixed: true }), btn('button:Bomb'), btn('button:Dash')];
    const l = layoutTouch(specs, 844, 390);
    expectClean(l, 844, 390);
    const right = l.sticks.get('joystick:right')!;
    expect(l.controls.get('button:Bomb')!.y + 84).toBeLessThanOrEqual(right.cy - right.radius);
    expect(right.region.w).toBeCloseTo(right.radius * 3.2);
    expect(l.sticks.get('joystick:left')!.region).toEqual({ x: 0, y: 390 * 0.45, w: 844 * 0.42, h: 390 * 0.55 });
  });

  it('joins a toggle group\'s segments, respects safe-area insets, and draws nothing for gestures', () => {
    const specs: TouchControlSpec[] = [
      btn('toggle:0', { zone: 'hotbar', group: 'g' }), btn('toggle:1', { zone: 'hotbar', group: 'g' }), btn('toggle:2', { zone: 'hotbar', group: 'g' }),
      { id: 'tap', shape: 'tap', analog: false }, { id: 'swipe', shape: 'swipe', analog: true }, { id: 'dpad:up', shape: 'dpad', analog: false, direction: 'up' },
      btn('button:Go'),
    ];
    const l = layoutTouch(specs, 844, 390, { top: 0, right: 44, bottom: 21, left: 44 });
    const [a, b, c] = [0, 1, 2].map((i) => l.controls.get(`toggle:${i}`)!);
    expect([a!.x + a!.w, b!.x + b!.w]).toEqual([b!.x, c!.x]);
    const go = l.controls.get('button:Go')!;
    expect(go.x + go.w).toBeCloseTo(844 - 44 - 16);
    expect(go.y + go.h).toBeCloseTo(390 - 21 - 16);
    expect([...l.controls.keys()].sort()).toEqual(['button:Go', 'toggle:0', 'toggle:1', 'toggle:2']);
  });

  it('a pinned button sits centred on its point of the safe area; a sized one scales; the arcs step around it', () => {
    const insets = { top: 0, right: 40, bottom: 20, left: 40 };
    const l = layoutTouch([
      stick('left'), btn('button:Fire', { zone: 'primary', size: 1.5 }), btn('button:Aim'), btn('button:Jump', { size: 0.5 }),
      btn('button:Dash', { at: [0.5, 0.5] }), btn('button:Edge', { at: [1, 0], size: 2 }), btn('button:Bar', { zone: 'hotbar', size: 1.2 }),
    ], 844, 390, insets);
    const dash = l.controls.get('button:Dash')!;
    expect(dash.zone).toBe('actions');
    expect(dash.x + dash.w / 2).toBeCloseTo(40 + 0.5 * (844 - 80));
    expect(dash.y + dash.h / 2).toBeCloseTo(0.5 * (390 - 20));
    expect(dash.w).toBeCloseTo(62);
    const edge = l.controls.get('button:Edge')!;
    expect([edge.w, edge.x + edge.w, edge.y]).toEqual([124, 844 - 40, 0]); // kept on screen
    expect(l.controls.get('button:Fire')!.w).toBeCloseTo(126);
    expect(l.controls.get('button:Jump')!.w).toBeCloseTo(31);
    expect(l.controls.get('button:Bar')!.w).toBeCloseTo(54 * 1.2);
    const arcs = ['button:Aim', 'button:Jump'].map((id) => l.controls.get(id)!);
    for (const a of arcs) expect(clash(a, dash) || clash(a, edge)).toBe(false);
  });
});
