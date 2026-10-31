/**
 * On-screen touch controls (DESIGN §4.11: "the platform layer draws the touch joystick
 * and buttons"): drawn from the input plugin's touch layout (`InputOutput.touch`, looked
 * after `InputOutput.touchSkin`) in the stage's touch layer, under the panels, and read back
 * as `InputSnapshot.touch`. Geometry is `touch_layout.ts`, finger state `touch_state.ts`,
 * glyphs `touch_icons.ts`; this file is the DOM between them.
 *
 *   sticks     a joystick / steering wheel per side, low in the corner; a floating stick's
 *              base follows the finger, a fixed one (attitude stick) stays put
 *   buttons    the primary and its action arcs (right thumb), a left row, pedals, a hotbar
 *              strip (a toggle group's segments joined) and a top-right system tray; each
 *              may show a glyph, a hold-progress fill (`holdMs`), a cooldown sweep, a
 *              disabled or selected look, and stays down while a toggle is latched
 *   steppers   a −/+ pill (pedals: two tall halves)
 *   gestures   tap / double tap / long press / swipe / drag / look / pinch / scroll: fingers on
 *              the play area itself (see touch_state.ts)
 *
 * The layer shows only on a touch screen (a coarse pointer, touch points, or a touch seen)
 * and only while the layout lists controls (none while a modal panel is open). A finger on
 * a control is the control's alone: it never reaches the pointer (`ctx.input.pointer`).
 * The layout is rebuilt when the set of controls, the stage size or the skin changes; labels,
 * glyphs and the per-frame looks are patched in place.
 */

import type { TouchControlSnapshot, TouchControlSpec, TouchSkin } from '../../core/index.js';
import { drawn, layoutTouch, NO_INSETS } from './touch_layout.js';
import { resolvePanelFonts } from './ui/panel_fonts.js';
import type { Insets, PlacedControl, PlacedStick, TouchLayout } from './touch_layout.js';
import { touchGlyph } from './touch_icons.js';
import { EDGE, TouchState } from './touch_state.js';
import type { Finger } from './touch_state.js';

export interface TouchHost {
  /** Where finger moves and releases are heard (a finger may leave its control). */
  readonly window: EventTarget;
  readonly maxTouchPoints: number;
  readonly coarse: boolean;
}

export interface TouchControlsOptions {
  /** The stage: gestures on the play area land on it. */
  readonly stage: HTMLElement;
  /** The layer the controls are drawn in (inside the stage, above the canvas, under the panels). */
  readonly layer: HTMLElement;
  /** The panels layer: a finger on a panel control is not a gesture. */
  readonly ui?: Element;
  readonly host?: TouchHost;
}

/** The engine's look; a skin overrides these custom properties. */
const CSS = `
:host {
  position: absolute; inset: 0; pointer-events: none; -webkit-user-select: none; user-select: none; touch-action: none;
  --fill: rgba(20, 22, 30, 0.45); --stroke: rgba(255, 255, 255, 0.5); --ink: #fff; --pressed: rgba(255, 255, 255, 0.4);
  --accent: rgba(255, 255, 255, 0.22); --opacity: 1; --radius: 50%; --rect-radius: 12px;
  --font: 600 1em/1.1 system-ui, -apple-system, sans-serif;
  --stroke-width: 2px; --backdrop: none; --press-scale: 1; --stick-base: rgba(255, 255, 255, 0.12);
}
.layer { position: absolute; inset: 0; opacity: var(--opacity); }
.zone { position: absolute; pointer-events: auto; touch-action: none; }
.base {
  position: absolute; border-radius: 50%; background: var(--stick-base); border: var(--stroke-width) solid var(--stroke);
  box-sizing: border-box; transform: translate(-50%, -50%); backdrop-filter: var(--backdrop); -webkit-backdrop-filter: var(--backdrop);
}
.base.rim::after { content: ''; position: absolute; inset: 8%; border-radius: 50%; border: 1.5px dashed var(--stroke); opacity: 0.6; }
.base.edge { box-shadow: 0 0 14px 2px var(--pressed); }
.knob { position: absolute; left: 50%; top: 50%; width: 46%; height: 46%; border-radius: 50%; background: var(--stick-knob, var(--pressed)); transform: translate(-50%, -50%); }
.wheel { position: absolute; inset: 6%; color: var(--ink); }
.wheel svg { width: 100%; height: 100%; }
.button, .stepper span {
  position: absolute; pointer-events: auto; touch-action: none; box-sizing: border-box; overflow: hidden;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px;
  color: var(--ink); font: var(--font); text-shadow: 0 1px 2px #000; text-align: center;
  background: var(--fill); border: var(--stroke-width) solid var(--stroke);
  backdrop-filter: var(--backdrop); -webkit-backdrop-filter: var(--backdrop);
}
.button { border-radius: var(--rect-radius); transition: transform 60ms ease-out; }
.button.round { border-radius: var(--radius); }
.button.primary { background: var(--accent); }
.button.down, .stepper span.down { background: var(--pressed); }
.button.down { transform: scale(var(--press-scale)); }
.button.selected { background: var(--accent); border-color: var(--ink); }
.button.disabled, .stepper.disabled span { opacity: 0.38; }
.button .label { max-width: 92%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.85em; }
.button.icon .label { font-size: 0.7em; }
.button .glyph { display: grid; place-items: center; line-height: 1; }
.button .fill, .button .cool { position: absolute; inset: 0; pointer-events: none; border-radius: inherit; }
.button .fill { background: conic-gradient(var(--pressed) calc(var(--p, 0) * 360deg), transparent 0); opacity: 0.8; }
.button .cool { background: conic-gradient(rgba(0, 0, 0, 0.55) calc(var(--c, 0) * 360deg), transparent 0); }
.button.seg { border-radius: 0; }
.button.seg.first { border-radius: var(--rect-radius) 0 0 var(--rect-radius); }
.button.seg.last { border-radius: 0 var(--rect-radius) var(--rect-radius) 0; }
.stepper { position: absolute; display: flex; gap: 4px; }
.stepper span { position: relative; flex: 1; border-radius: var(--rect-radius); }
.stepper.pill span:first-child { border-radius: 999px 0 0 999px; }
.stepper.pill span:last-child { border-radius: 0 999px 999px 0; }
.dpad { position: absolute; pointer-events: auto; touch-action: none; }
.dpad span {
  position: absolute; width: 33.3%; height: 33.3%; background: var(--fill); border: var(--stroke-width) solid var(--stroke); border-radius: 8px; box-sizing: border-box;
  backdrop-filter: var(--backdrop); -webkit-backdrop-filter: var(--backdrop);
}
.dpad .up { left: 33.3%; top: 0; } .dpad .down { left: 33.3%; bottom: 0; }
.dpad .left { left: 0; top: 33.3%; } .dpad .right { right: 0; top: 33.3%; }
.dpad span.on { background: var(--pressed); }
.probe { position: absolute; visibility: hidden; padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
`;

function defaultHost(): TouchHost {
  const g = globalThis as unknown as { window: EventTarget; navigator?: { maxTouchPoints?: number }; matchMedia?: (q: string) => { matches: boolean } };
  return { window: g.window, maxTouchPoints: g.navigator?.maxTouchPoints ?? 0, coarse: g.matchMedia?.('(any-pointer: coarse)').matches ?? false };
}

const now = (): number => (globalThis as { performance?: { now(): number } }).performance?.now() ?? Date.now();

/** Every custom property a skin may set (cleared before a new skin applies). */
const SKIN_PROPS = [
  '--fill', '--stroke', '--ink', '--pressed', '--accent', '--opacity', '--radius', '--rect-radius', '--font',
  '--stroke-width', '--backdrop', '--press-scale', '--stick-base', '--stick-knob',
] as const;

/**
 * The skin as custom properties on the layer. `font` is a family list; `resolveFont` renames
 * families a panel declared (`@font-face`) to the names they were registered under.
 */
export function skinStyle(skin: TouchSkin | undefined, resolveFont: (list: string) => string = (l) => l): Record<string, string> {
  const out: Record<string, string> = {};
  if (skin === undefined) return out;
  for (const key of ['fill', 'stroke', 'ink', 'pressed', 'accent'] as const) if (skin[key] !== undefined) out[`--${key}`] = skin[key]!;
  if (skin.joystickBase !== undefined) out['--stick-base'] = skin.joystickBase;
  if (skin.joystickKnob !== undefined) out['--stick-knob'] = skin.joystickKnob;
  if (skin.opacity !== undefined) out['--opacity'] = String(skin.opacity);
  if (skin.shape === 'rounded') out['--radius'] = '22%';
  if (skin.shape === 'square') { out['--radius'] = '6px'; out['--rect-radius'] = '6px'; }
  if (skin.font !== undefined) out['--font'] = `600 1em/1.1 ${resolveFont(skin.font)}`;
  if (skin.strokeWidth !== undefined) out['--stroke-width'] = `${skin.strokeWidth}px`;
  if (skin.blur !== undefined && skin.blur > 0) out['--backdrop'] = `blur(${skin.blur}px)`;
  if (skin.pressScale !== undefined) out['--press-scale'] = String(skin.pressScale);
  return out;
}

interface DrawnButton {
  readonly el: HTMLElement;
  readonly glyph: HTMLElement;
  readonly label: HTMLElement;
  readonly fill: HTMLElement | undefined;
  readonly cool: HTMLElement;
  readonly place: PlacedControl;
  /** What was last written, so a frame only touches what changed. */
  shown: string;
}

interface DrawnStick {
  readonly zone: HTMLElement;
  readonly base: HTMLElement;
  readonly knob: HTMLElement | undefined;
  readonly wheel: HTMLElement | undefined;
  readonly place: PlacedStick;
  readonly fixed: boolean;
}

interface Drawn {
  readonly key: string;
  readonly layout: TouchLayout;
  readonly sticks: Map<string, DrawnStick>;
  readonly buttons: Map<string, DrawnButton>;
  readonly steppers: Map<string, { el: HTMLElement; halves: [HTMLElement, HTMLElement]; shown: string }>;
  readonly dpad: { el: HTMLElement; arms: Record<'up' | 'down' | 'left' | 'right', HTMLElement> } | undefined;
}

export class TouchControls {
  readonly #stage: HTMLElement;
  readonly #layer: HTMLElement;
  readonly #ui: Element | undefined;
  readonly #root: ShadowRoot;
  readonly #canvas: HTMLElement;
  readonly #probe: HTMLElement;
  readonly #state = new TouchState();
  readonly #dispose: (() => void)[] = [];
  /** The drawn controls' listeners, dropped with them on a rebuild. */
  #built: (() => void)[] = [];
  #touchScreen: boolean;
  #drawn: Drawn | undefined;
  #skinKey = '';

  constructor(options: TouchControlsOptions) {
    const host = options.host ?? defaultHost();
    this.#stage = options.stage;
    this.#layer = options.layer;
    this.#ui = options.ui;
    this.#touchScreen = host.maxTouchPoints > 0 || host.coarse;
    this.#root = this.#layer.attachShadow({ mode: 'open' });
    const style = this.#layer.ownerDocument.createElement('style');
    style.textContent = CSS;
    this.#root.append(style);
    this.#probe = this.#el('probe', this.#root);
    this.#canvas = this.#el('layer', this.#root);
    this.#layer.style.display = 'none';
    this.#listen(this.#stage, 'pointerdown', (e) => this.#areaDown(e as PointerEvent));
    this.#listen(host.window, 'pointermove', (e) => this.#move(e as PointerEvent));
    this.#listen(host.window, 'pointerup', (e) => this.#up(e as PointerEvent));
    this.#listen(host.window, 'pointercancel', (e) => this.#state.cancel((e as PointerEvent).pointerId));
  }

  /** Draw this frame's layout (rebuilt only when the controls, the stage size or the skin change). */
  present(specs: readonly TouchControlSpec[], skin?: TouchSkin): void {
    this.#state.setLayout(specs);
    // The font is resolved every frame: a panel declaring its family may be shown after the skin applies.
    const font = skin?.font === undefined ? '' : resolvePanelFonts(this.#layer.ownerDocument, skin.font);
    const skinKey = `${JSON.stringify(skin ?? {})}|${font}`;
    if (skinKey !== this.#skinKey) {
      this.#skinKey = skinKey;
      const style = skinStyle(skin, () => font);
      for (const [k, v] of Object.entries({ ...Object.fromEntries(SKIN_PROPS.map((p) => [p, ''])), ...style })) {
        if (v === '') this.#canvas.style.removeProperty(k);
        else this.#canvas.style.setProperty(k, v);
      }
    }
    const show = this.#touchScreen && specs.length > 0;
    this.#layer.style.display = show ? 'block' : 'none';
    if (!show) return;
    const r = this.#stage.getBoundingClientRect();
    const key = `${Math.round(r.width)}x${Math.round(r.height)}|${skin?.scale ?? 1}|${specs.filter(drawn).map((s) => `${s.id}/${s.shape}/${s.zone ?? ''}/${s.group ?? ''}/${s.fixed === true ? 'f' : ''}/${s.size ?? ''}/${s.at?.join(',') ?? ''}/${s.ring ?? ''}`).join('|')}`;
    if (this.#drawn?.key !== key) this.#build(key, specs, r.width, r.height, skin?.scale ?? 1);
    this.#paint(specs);
  }

  poll(): ReadonlyMap<string, TouchControlSnapshot> {
    return this.#state.poll(now());
  }

  dispose(): void {
    for (const fn of [...this.#dispose.splice(0), ...this.#built.splice(0)]) fn();
  }

  // ── Drawing ───────────────────────────────────────────────────────────────────

  #el(className: string, parent: ParentNode, tag = 'div'): HTMLElement {
    const el = this.#layer.ownerDocument.createElement(tag);
    el.className = className;
    parent.append(el);
    return el;
  }

  #insets(): Insets {
    const cs = (this.#layer.ownerDocument.defaultView as { getComputedStyle?: (el: Element) => CSSStyleDeclaration } | null)?.getComputedStyle?.(this.#probe);
    if (cs === undefined) return NO_INSETS;
    const px = (v: string): number => Number.parseFloat(v) || 0;
    return { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
  }

  #box(el: HTMLElement, b: { x: number; y: number; w: number; h: number }): void {
    Object.assign(el.style, { left: `${b.x}px`, top: `${b.y}px`, width: `${b.w}px`, height: `${b.h}px` });
  }

  #build(key: string, specs: readonly TouchControlSpec[], width: number, height: number, scale: number): void {
    this.#canvas.replaceChildren();
    for (const fn of this.#built.splice(0)) fn();
    const layout = layoutTouch(specs, width, height, this.#insets(), scale);
    const sticks = new Map<string, DrawnStick>();
    const buttons = new Map<string, DrawnButton>();
    const steppers: Drawn['steppers'] = new Map();
    let dpad: Drawn['dpad'];
    const edges = new Set(specs.filter((s) => s.shape === 'stick_edge').map((s) => `joystick:${s.side ?? 'left'}`));
    const font = `${Math.round(14 * layout.scale)}px`;
    this.#canvas.style.fontSize = font;

    for (const spec of specs) {
      const stick = layout.sticks.get(spec.id);
      if (stick !== undefined) {
        const zone = this.#el('zone', this.#canvas);
        this.#box(zone, stick.region);
        const base = this.#el(`base${edges.has(spec.id) ? ' rim' : ''}`, zone);
        base.style.width = base.style.height = `${stick.radius * 2}px`;
        let knob: HTMLElement | undefined;
        let wheel: HTMLElement | undefined;
        if (spec.shape === 'steer') {
          wheel = this.#el('wheel', base);
          const g = touchGlyph('steer', '', stick.radius * 2);
          if (g.kind === 'svg') wheel.innerHTML = g.html;
        } else {
          knob = this.#el('knob', base);
        }
        const fixed = spec.fixed === true;
        sticks.set(spec.id, { zone, base, knob, wheel, place: stick, fixed });
        this.#grab(zone, (f) => this.#state.joystickDown(f, spec.id, fixed ? { x: stick.cx, y: stick.cy } : undefined, stick.radius));
        continue;
      }
      const place = layout.controls.get(spec.id);
      if (place === undefined) continue;
      if (spec.shape === 'dpad') {
        if (dpad !== undefined) continue;
        const el = this.#el('dpad', this.#canvas);
        this.#box(el, place);
        dpad = { el, arms: { up: this.#el('up', el, 'span'), down: this.#el('down', el, 'span'), left: this.#el('left', el, 'span'), right: this.#el('right', el, 'span') } };
        this.#grab(el, (f) => this.#state.dpadDown(f, place.x + place.w / 2, place.y + place.h / 2));
      } else if (spec.shape === 'stepper') {
        const el = this.#el(`stepper${place.zone === 'pedals' ? '' : ' pill'}`, this.#canvas);
        this.#box(el, place);
        const minus = this.#el('', el, 'span');
        const plus = this.#el('', el, 'span');
        steppers.set(spec.id, { el, halves: [minus, plus], shown: '' });
        this.#grab(minus, (f) => this.#state.stepperDown(f, spec.id, -1));
        this.#grab(plus, (f) => this.#state.stepperDown(f, spec.id, 1));
      } else if (spec.shape === 'button') {
        const el = this.#el(`button${place.round ? ' round' : ''}${place.zone === 'primary' ? ' primary' : ''}`, this.#canvas);
        this.#box(el, place);
        if (place.zone === 'system') el.style.fontSize = '0.8em';
        if (spec.ring !== undefined) el.style.borderColor = spec.ring;
        const fill = spec.holdMs !== undefined ? this.#el('fill', el) : undefined;
        const cool = this.#el('cool', el);
        const glyph = this.#el('glyph', el);
        const label = this.#el('label', el);
        buttons.set(spec.id, { el, glyph, label, fill, cool, place, shown: '' });
        this.#grab(el, (f) => this.#state.buttonDown(f, spec.id));
      }
    }
    // A toggle group's segments touch: round off the strip's ends only.
    const segs = specs.filter((s) => s.shape === 'button' && s.group !== undefined && buttons.has(s.id));
    segs.forEach((s, i) => {
      const el = buttons.get(s.id)!.el;
      el.classList.add('seg');
      if (segs[i - 1]?.group !== s.group) el.classList.add('first');
      if (segs[i + 1]?.group !== s.group) el.classList.add('last');
    });
    this.#drawn = { key, layout, sticks, buttons, steppers, dpad };
  }

  /** Patch labels, glyphs and per-frame looks; knobs follow fingers, held controls light up. */
  #paint(specs: readonly TouchControlSpec[]): void {
    const drawnNow = this.#drawn!;
    const t = now();
    for (const spec of specs) {
      const button = drawnNow.buttons.get(spec.id);
      if (button !== undefined) {
        const label = spec.label ?? spec.id;
        const shown = `${label}|${spec.icon ?? ''}`;
        if (button.shown !== shown) {
          button.shown = shown;
          const glyph = touchGlyph(spec.icon, label, Math.round(Math.min(button.place.w, button.place.h) * 0.42));
          if (glyph.kind === 'svg') button.glyph.innerHTML = glyph.html;
          else button.glyph.textContent = glyph.kind === 'text' ? glyph.text : '';
          button.el.classList.toggle('icon', glyph.kind !== 'none');
          // A small round button with a glyph shows the glyph alone; the label stays for screen readers.
          const glyphOnly = glyph.kind !== 'none' && (button.place.zone === 'system' || button.place.w < 56 * (drawnNow.layout.scale || 1));
          button.label.textContent = glyphOnly ? '' : label;
          button.el.setAttribute('aria-label', label);
        }
        button.el.classList.toggle('down', this.#state.buttonHeld(spec.id));
        button.el.classList.toggle('disabled', spec.disabled === true);
        button.el.classList.toggle('selected', this.#state.selected(spec.id));
        if (button.fill !== undefined) button.fill.style.setProperty('--p', String(this.#state.holdProgress(spec.id, t)));
        button.cool.style.setProperty('--c', String(spec.cooldown ?? 0));
        continue;
      }
      const stepper = drawnNow.steppers.get(spec.id);
      if (stepper !== undefined) {
        const [minus, plus] = spec.labels ?? ['−', '+'];
        const shown = `${minus}|${plus}`;
        if (stepper.shown !== shown) {
          stepper.shown = shown;
          stepper.halves[0].textContent = minus;
          stepper.halves[1].textContent = plus;
        }
        const v = this.#state.stepper(spec.id);
        stepper.halves[0].classList.toggle('down', v < 0);
        stepper.halves[1].classList.toggle('down', v > 0);
        stepper.el.classList.toggle('disabled', spec.disabled === true);
      }
    }
    const edgeHeld = new Set(specs.filter((s) => s.shape === 'stick_edge').map((s) => `joystick:${s.side ?? 'left'}`));
    for (const [id, stick] of drawnNow.sticks) {
      const held = this.#state.knob(id);
      const { region, cx: restX, cy: restY, radius } = stick.place;
      const floating = !stick.fixed && held !== undefined;
      stick.base.style.left = `${(floating ? held.cx : restX) - region.x}px`;
      stick.base.style.top = `${(floating ? held.cy : restY) - region.y}px`;
      if (stick.knob !== undefined) stick.knob.style.transform = held === undefined ? '' : `translate(calc(-50% + ${held.x * radius}px), calc(-50% + ${-held.y * radius}px))`;
      if (stick.wheel !== undefined) stick.wheel.style.transform = held === undefined ? '' : `rotate(${held.x * 90}deg)`;
      stick.base.classList.toggle('edge', edgeHeld.has(id) && held !== undefined && Math.hypot(held.x, held.y) >= EDGE);
    }
    if (drawnNow.dpad !== undefined) {
      const [x, y] = this.#state.dpad();
      const { arms } = drawnNow.dpad;
      arms.up.classList.toggle('on', y > 0);
      arms.down.classList.toggle('on', y < 0);
      arms.left.classList.toggle('on', x < 0);
      arms.right.classList.toggle('on', x > 0);
    }
  }

  // ── Fingers ───────────────────────────────────────────────────────────────────

  #finger(e: PointerEvent): Finger {
    const r = this.#stage.getBoundingClientRect();
    return { id: e.pointerId, x: e.clientX - r.left, y: e.clientY - r.top, t: e.timeStamp };
  }

  /** A control takes the finger that lands on it: no pointer press, no gesture. */
  #grab(el: HTMLElement, down: (f: Finger) => void): void {
    const fn = (event: Event): void => {
      const e = event as PointerEvent;
      if (e.pointerType === 'mouse') return;
      e.stopPropagation();
      e.preventDefault();
      this.#touchScreen = true;
      down(this.#finger(e));
    };
    el.addEventListener('pointerdown', fn);
    this.#built.push(() => el.removeEventListener('pointerdown', fn));
  }

  #areaDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse') return;
    this.#touchScreen = true;
    const target = e.target as Node | null;
    if (this.#ui !== undefined && target !== this.#ui && this.#ui.contains(target)) return; // a panel control
    if (!this.#state.readsArea || this.#state.holding(e.pointerId)) return;
    this.#state.areaDown(this.#finger(e), this.#stage.getBoundingClientRect().width);
  }

  #move(e: PointerEvent): void {
    if (this.#state.holding(e.pointerId)) this.#state.move(this.#finger(e));
  }

  #up(e: PointerEvent): void {
    if (this.#state.holding(e.pointerId)) this.#state.up(this.#finger(e));
  }

  #listen(target: EventTarget, type: string, fn: (e: Event) => void): void {
    target.addEventListener(type, fn);
    this.#dispose.push(() => target.removeEventListener(type, fn));
  }
}
