/**
 * Where each on-screen touch control goes, without the DOM: the stage size, its safe-area
 * insets and the layout's specs in, rectangles out (stage pixels, top-left origin). The
 * engine owns the geometry; a game only names a control's zone (core's `TouchZone`).
 *
 *   left thumb   the left stick or steering wheel rests low in the corner; a d-pad, then the
 *                "left" row (◀ ▶, steppers) stack above it
 *   right thumb  pedals in the corner, a right stick above them, then the primary button with
 *                the action buttons on arcs around it (up and to the left); with no "primary"
 *                the first action button is promoted
 *   hotbar       a strip along the bottom centre, raised over both thumbs when it does not
 *                fit between them; a toggle group's segments touch
 *   system       small buttons along the top-right edge
 *
 * Sizes are tuned on a 390 px-tall landscape phone and scale with the shorter side (0.75 ..
 * 1.35), times the skin's `scale`, times a button's own `size`. A button with `at` is pinned:
 * centred on that point of the safe area (kept on screen), out of its zone's flow; the
 * flowing controls around it step aside where they can (the action arcs, the hotbar).
 */

import type { TouchControlSpec, TouchZone } from '../../core/index.js';

export interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Insets {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export const NO_INSETS: Insets = { top: 0, right: 0, bottom: 0, left: 0 };

/** A drawn control: a button, a stepper (two halves side by side), a d-pad. */
export interface PlacedControl extends Box {
  readonly id: string;
  readonly zone: TouchZone;
  /** Drawn round (circle buttons); otherwise a rounded rectangle. */
  readonly round: boolean;
}

/** A stick (joystick or steering wheel): where it rests, how far it travels, where a finger may land on it. */
export interface PlacedStick {
  readonly id: string;
  readonly side: 'left' | 'right';
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  /** The touch region: a finger landing here takes the stick. */
  readonly region: Box;
}

export interface TouchLayout {
  readonly scale: number;
  readonly controls: ReadonlyMap<string, PlacedControl>;
  readonly sticks: ReadonlyMap<string, PlacedStick>;
}

const BASE = { margin: 16, gap: 12, primary: 84, action: 62, small: 44, cell: 54, radius: 56, steer: 64, dpad: 150, stepper: 56, pedalW: 72, pedalH: 120, rest: 24 };

/** The control scale for a stage: its shorter side against a 390 px landscape phone. */
export function touchScale(width: number, height: number, skinScale = 1): number {
  return Math.min(1.35, Math.max(0.75, Math.min(width, height) / 390)) * skinScale;
}

/** The zone a drawn spec sits in. */
export function zoneOf(spec: TouchControlSpec): TouchZone {
  if (spec.shape === 'stepper') return spec.zone === 'pedals' || spec.zone === 'system' || spec.zone === 'hotbar' ? spec.zone : 'left';
  return spec.zone ?? 'actions';
}

/** Specs the platform draws (gestures, stick edges and one-direction d-pad parts are not drawn). */
export function drawn(spec: TouchControlSpec): boolean {
  return spec.shape === 'joystick' || spec.shape === 'steer' || spec.shape === 'button' || spec.shape === 'stepper'
    || (spec.shape === 'dpad' && spec.direction === undefined);
}

export function layoutTouch(specs: readonly TouchControlSpec[], width: number, height: number, insets: Insets = NO_INSETS, skinScale = 1): TouchLayout {
  const s = touchScale(width, height, skinScale);
  const size = Object.fromEntries(Object.entries(BASE).map(([k, v]) => [k, v * s])) as typeof BASE;
  const L = insets.left + size.margin;
  const R = width - insets.right - size.margin;
  const T = insets.top + size.margin;
  const B = height - insets.bottom - size.margin;
  const g = size.gap;
  const controls = new Map<string, PlacedControl>();
  const sticks = new Map<string, PlacedStick>();
  const put = (id: string, zone: TouchZone, x: number, y: number, w: number, h: number, round: boolean): void => {
    controls.set(id, { id, zone, x, y, w, h, round });
  };
  /** A button's own size factor; pinned buttons (`at`) leave their zone's flow. */
  const k = (sp: TouchControlSpec): number => (sp.shape === 'button' ? sp.size ?? 1 : 1);
  const flows = (sp: TouchControlSpec): boolean => sp.shape !== 'button' || sp.at === undefined;

  // Sticks: a stick on each side at most (the first listed wins).
  let leftTop = B;
  let rightTop = B;
  const stickOf = (side: 'left' | 'right'): TouchControlSpec | undefined =>
    specs.find((sp) => (sp.shape === 'joystick' && (sp.side ?? 'left') === side) || (sp.shape === 'steer' && side === 'left'));

  // Right thumb, bottom up: pedals, then the right stick.
  const pedals = specs.filter((sp) => sp.shape === 'stepper' && zoneOf(sp) === 'pedals');
  let px = R;
  for (const sp of pedals) {
    const w = size.pedalW * 2 + g;
    px -= w;
    put(sp.id, 'pedals', px, B - size.pedalH, w, size.pedalH, false);
    px -= g;
    rightTop = Math.min(rightTop, B - size.pedalH - g);
  }

  for (const side of ['left', 'right'] as const) {
    const sp = stickOf(side);
    if (sp === undefined) continue;
    const radius = sp.shape === 'steer' ? size.steer : size.radius;
    const base = side === 'left' ? B : rightTop;
    const cx = side === 'left' ? L + radius + size.rest : R - radius - size.rest;
    const cy = base - radius - size.rest;
    const region: Box = sp.fixed === true
      ? { x: cx - radius * 1.6, y: cy - radius * 1.6, w: radius * 3.2, h: radius * 3.2 }
      : { x: side === 'left' ? 0 : width * 0.58, y: height * 0.45, w: width * 0.42, h: height * 0.55 };
    sticks.set(sp.id, { id: sp.id, side, cx, cy, radius, region });
    if (side === 'left') leftTop = cy - radius - g;
    else rightTop = cy - radius - g;
  }

  // Left thumb: the d-pad, then the left row, above the stick.
  const dpad = specs.find((sp) => sp.shape === 'dpad' && sp.direction === undefined);
  if (dpad !== undefined) {
    put(dpad.id, 'left', L, leftTop - size.dpad, size.dpad, size.dpad, false);
    leftTop -= size.dpad + g;
  }
  const leftRow = specs.filter((sp) => (sp.shape === 'button' || sp.shape === 'stepper') && zoneOf(sp) === 'left' && flows(sp));
  if (leftRow.length > 0) {
    let x = L;
    const h = Math.max(...leftRow.map((sp) => (sp.shape === 'stepper' ? size.stepper : size.action * k(sp))));
    for (const sp of leftRow) {
      const w = sp.shape === 'stepper' ? size.stepper * 2 : size.action * k(sp);
      const ch = sp.shape === 'stepper' ? size.stepper : size.action * k(sp);
      put(sp.id, 'left', x, leftTop - ch, w, ch, sp.shape === 'button');
      x += w + g;
    }
    leftTop -= h + g;
  }

  // System tray: top-right, right to left.
  let sx = R;
  for (const sp of specs.filter((x) => (x.shape === 'button' || x.shape === 'stepper') && zoneOf(x) === 'system' && flows(x))) {
    const w = sp.shape === 'stepper' ? size.small * 2 : size.small * k(sp);
    sx -= w;
    put(sp.id, 'system', sx, T, w, sp.shape === 'stepper' ? size.small : size.small * k(sp), sp.shape === 'button');
    sx -= g / 2;
  }

  // Right thumb: the primary, then the action buttons on arcs around it (up and to the left),
  // each in the first free slot: slots that would cover a stick or another control are skipped.
  // Pinned buttons (`at`): centred on their point of the safe area, kept on screen.
  const pinned = new Set<string>();
  for (const sp of specs.filter((x) => x.shape === 'button' && x.at !== undefined)) {
    pinned.add(sp.id);
    const zone = zoneOf(sp);
    const base = zone === 'primary' ? size.primary : zone === 'system' ? size.small : zone === 'hotbar' ? size.cell : size.action;
    const d = base * k(sp);
    const [ax, ay] = sp.at!;
    const cx = insets.left + ax * (width - insets.left - insets.right);
    const cy = insets.top + ay * (height - insets.top - insets.bottom);
    const x = Math.min(Math.max(cx - d / 2, insets.left), width - insets.right - d);
    const y = Math.min(Math.max(cy - d / 2, insets.top), height - insets.bottom - d);
    put(sp.id, zone, x, y, d, d, zone !== 'hotbar');
  }

  const buttons = specs.filter((sp) => sp.shape === 'button' && flows(sp));
  const arc = buttons.filter((sp) => zoneOf(sp) === 'actions');
  const primary = buttons.find((sp) => zoneOf(sp) === 'primary') ?? arc.shift();
  for (const extra of buttons.filter((sp) => zoneOf(sp) === 'primary' && sp !== primary)) arc.unshift(extra);
  if (primary !== undefined) {
    const p = size.primary * k(primary);
    const cx = R - p / 2;
    const cy = rightTop - p / 2;
    put(primary.id, 'primary', cx - p / 2, cy - p / 2, p, p, true);
    let top = cy - p / 2;
    const d = size.action;
    const obstacles = (): Shape[] => [
      ...[...controls.values()].map(shapeOf),
      ...[...sticks.values()].map((st): Shape => ({ x: st.cx - st.radius, y: st.cy - st.radius, w: st.radius * 2, h: st.radius * 2, round: true })),
    ];
    let i = 0;
    for (let ring = 0; i < arc.length && ring < 12; ring++) {
      const r = p / 2 + g + d / 2 + ring * (d + g * 0.75);
      const step = 2 * Math.asin(Math.min(1, (d + g) / (2 * r)));
      const fits = Math.floor(Math.PI / 2 / step) + 1;
      const blocked = obstacles();
      for (let j = 0; j < fits && i < arc.length; j++) {
        const a = fits === 1 ? Math.PI * 1.25 : Math.PI + (j * (Math.PI / 2)) / (fits - 1);
        const bx = cx + r * Math.cos(a);
        const by = cy + r * Math.sin(a);
        const di = d * k(arc[i]!);
        if (bx - di / 2 < L - 0.5 || by - di / 2 < T - 0.5 || bx + di / 2 > R + 0.5 || by + di / 2 > B + 0.5) continue;
        const slot: Shape = { x: bx - di / 2, y: by - di / 2, w: di, h: di, round: true };
        if (blocked.some((o) => clash(slot, o, g / 2))) continue;
        put(arc[i]!.id, 'actions', slot.x, slot.y, di, di, true);
        blocked.push(slot);
        top = Math.min(top, slot.y);
        i++;
      }
    }
    // No free slot left (a cramped screen): a row above the cluster, so no button goes undrawn.
    for (let j = 0; i < arc.length; j++, i++) {
      const y = Math.max(T, top - g - d);
      put(arc[i]!.id, 'actions', Math.max(L, R - d - j * (d + g)), y, d, d, true);
    }
    rightTop = Math.min(top, ...[...controls.values()].filter((c) => c.zone === 'actions' && !pinned.has(c.id)).map((c) => c.y)) - g;
  }

  // Hotbar: bottom centre between the thumbs, or raised over them.
  const bar = specs.filter((sp) => (sp.shape === 'button' || sp.shape === 'stepper') && zoneOf(sp) === 'hotbar' && flows(sp));
  if (bar.length > 0) {
    const widthOf = (cell: number): number => bar.reduce((sum, sp, n) => {
      const w = sp.shape === 'stepper' ? cell * 2 : cell * k(sp);
      const joined = n > 0 && sp.group !== undefined && bar[n - 1]!.group === sp.group;
      return sum + w + (n === 0 ? 0 : joined ? 0 : g / 1.5);
    }, 0);
    let cell = size.cell;
    let y = B - cell;
    const band = (top: number, bottom: number): [number, number] => {
      let lo = L;
      let hi = R;
      for (const c of [...controls.values()]) {
        if (c.y >= bottom || c.y + c.h <= top) continue;
        if (c.x + c.w / 2 < width / 2) lo = Math.max(lo, c.x + c.w + g);
        else hi = Math.min(hi, c.x - g);
      }
      for (const st of sticks.values()) {
        if (st.cy - st.radius >= bottom || st.cy + st.radius <= top) continue;
        if (st.side === 'left') lo = Math.max(lo, st.cx + st.radius + g);
        else hi = Math.min(hi, st.cx - st.radius - g);
      }
      return [lo, hi];
    };
    let [lo, hi] = band(y, y + cell);
    if (widthOf(cell) > hi - lo) {
      cell = Math.max(size.cell * 0.75, Math.min(cell, cell * (hi - lo) / widthOf(cell)));
      y = B - cell;
      [lo, hi] = band(y, y + cell);
      if (widthOf(cell) > hi - lo) {
        // Raised over both thumbs, across the whole width.
        cell = Math.min(size.cell, cell * (R - L) / widthOf(cell));
        y = Math.min(leftTop, rightTop) - cell;
        lo = L;
        hi = R;
      }
    }
    const total = widthOf(cell);
    let x = Math.min(Math.max(lo, width / 2 - total / 2), hi - total);
    bar.forEach((sp, n) => {
      const joined = n > 0 && sp.group !== undefined && bar[n - 1]!.group === sp.group;
      if (n > 0) x += joined ? 0 : g / 1.5;
      const w = sp.shape === 'stepper' ? cell * 2 : cell * k(sp);
      const h = sp.shape === 'stepper' ? cell : cell * k(sp);
      put(sp.id, 'hotbar', x, y + cell - h, w, h, false); // bottom-aligned along the strip
      x += w;
    });
  }

  return { scale: s, controls, sticks };
}

/** A box, drawn round (a circle in it) or not. */
export interface Shape extends Box {
  readonly round: boolean;
}

const shapeOf = (c: PlacedControl): Shape => c;

/** Whether two placed boxes overlap. */
export function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Whether two drawn controls touch, closer than `pad`: circles as circles, the rest as boxes. */
export function clash(a: Shape, b: Shape, pad = 0): boolean {
  const circle = (s: Shape): { x: number; y: number; r: number } => ({ x: s.x + s.w / 2, y: s.y + s.h / 2, r: Math.min(s.w, s.h) / 2 });
  if (a.round && b.round) {
    const ca = circle(a);
    const cb = circle(b);
    return Math.hypot(ca.x - cb.x, ca.y - cb.y) < ca.r + cb.r + pad;
  }
  if (a.round || b.round) {
    const c = circle(a.round ? a : b);
    const box = a.round ? b : a;
    const nx = Math.max(box.x, Math.min(c.x, box.x + box.w));
    const ny = Math.max(box.y, Math.min(c.y, box.y + box.h));
    return Math.hypot(c.x - nx, c.y - ny) < c.r + pad;
  }
  return overlaps({ x: a.x - pad, y: a.y - pad, w: a.w + 2 * pad, h: a.h + 2 * pad }, b);
}
