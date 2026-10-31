/**
 * Fly mode's on-screen controls for touch (a phone or tablet has no W A S D): a virtual
 * joystick in the viewport's lower-left corner moves the camera on the ground plane, and two
 * buttons in the lower-right fly it up and down. Dragging elsewhere on the viewport still
 * looks around (viewport.ts). The viewport shows them only while the camera flies.
 *
 * Each control follows one finger (pointer events, by pointer id), so the joystick, a button
 * and a look drag can run at once.
 */

import { h, icon } from './dom.js';
import { onLanguageChange, t } from './i18n.js';

/** The joystick's input inside this fraction of its reach counts as rest. */
export const JOYSTICK_DEAD_ZONE = 0.1;

/**
 * A joystick offset (pixels from its center) as a stick position: x right, y down, each in
 * -1..1, clamped to the unit circle and zero inside the dead zone.
 */
export function stickPosition(dx: number, dy: number, reach: number): { x: number; y: number } {
  if (!(reach > 0)) return { x: 0, y: 0 };
  let x = dx / reach;
  let y = dy / reach;
  const length = Math.hypot(x, y);
  if (length > 1) {
    x /= length;
    y /= length;
  }
  if (Math.hypot(x, y) < JOYSTICK_DEAD_ZONE) return { x: 0, y: 0 };
  return { x, y };
}

export class TouchFlyControls {
  readonly el: HTMLElement;
  readonly #joystick: HTMLElement;
  readonly #thumb: HTMLElement;
  readonly #up: HTMLButtonElement;
  readonly #down: HTMLButtonElement;
  #stick: { id: number; cx: number; cy: number; reach: number } | undefined;
  #x = 0;
  #y = 0;
  readonly #held = { up: -1, down: -1 };

  constructor() {
    this.#thumb = h('div.touch-fly-thumb');
    this.#joystick = h('div.touch-fly-joystick', { role: 'presentation' }, h('div.touch-fly-base'), this.#thumb);
    this.#up = this.#button('up');
    this.#down = this.#button('down');
    this.el = h('div.touch-fly', { hidden: true }, this.#joystick, h('div.touch-fly-vertical', {}, this.#up, this.#down));
    this.#joystick.addEventListener('pointerdown', (event) => this.#stickDown(event));
    this.#joystick.addEventListener('pointermove', (event) => this.#stickMove(event));
    this.#joystick.addEventListener('pointerup', (event) => this.#stickUp(event));
    this.#joystick.addEventListener('pointercancel', (event) => this.#stickUp(event));
    // A long press would open the context menu (or select text) instead of flying.
    this.el.addEventListener('contextmenu', (event) => event.preventDefault());
    const label = (): void => {
      this.#joystick.setAttribute('aria-label', t('mobile.flyMove'));
      this.#up.title = t('mobile.flyUp');
      this.#up.setAttribute('aria-label', t('mobile.flyUp'));
      this.#down.title = t('mobile.flyDown');
      this.#down.setAttribute('aria-label', t('mobile.flyDown'));
    };
    label();
    onLanguageChange(label);
  }

  /** Movement: x right, z forward (each -1..1), y up (-1, 0 or 1). */
  get input(): { x: number; y: number; z: number } {
    return { x: this.#x, y: (this.#held.up >= 0 ? 1 : 0) - (this.#held.down >= 0 ? 1 : 0), z: -this.#y };
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  /** Show or hide the controls; hiding lets go of everything. */
  setVisible(visible: boolean): void {
    if (visible === !this.el.hidden) return;
    this.el.hidden = !visible;
    if (!visible) this.reset();
  }

  /** Let go: no movement until a finger comes down again. */
  reset(): void {
    this.#stick = undefined;
    this.#x = 0;
    this.#y = 0;
    this.#thumb.style.transform = '';
    this.#thumb.classList.remove('active');
    for (const which of ['up', 'down'] as const) {
      this.#held[which] = -1;
      (which === 'up' ? this.#up : this.#down).classList.remove('active');
    }
  }

  #button(which: 'up' | 'down'): HTMLButtonElement {
    const el = h('button.touch-fly-btn', { type: 'button' }, icon('chevron', 24));
    el.classList.add(which);
    const release = (event: PointerEvent): void => {
      if (this.#held[which] !== event.pointerId) return;
      this.#held[which] = -1;
      el.classList.remove('active');
    };
    el.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      el.setPointerCapture?.(event.pointerId);
      this.#held[which] = event.pointerId;
      el.classList.add('active');
    });
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    return el;
  }

  #stickDown(event: PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();
    if (this.#stick !== undefined) return;
    const rect = this.#joystick.getBoundingClientRect();
    const thumb = this.#thumb.getBoundingClientRect();
    this.#joystick.setPointerCapture?.(event.pointerId);
    this.#stick = {
      id: event.pointerId,
      cx: rect.left + rect.width / 2,
      cy: rect.top + rect.height / 2,
      reach: Math.max(1, (rect.width - thumb.width) / 2),
    };
    this.#thumb.classList.add('active');
    this.#stickTo(event.clientX, event.clientY);
  }

  #stickMove(event: PointerEvent): void {
    if (this.#stick?.id !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    this.#stickTo(event.clientX, event.clientY);
  }

  #stickUp(event: PointerEvent): void {
    if (this.#stick?.id !== event.pointerId) return;
    this.#stick = undefined;
    this.#x = 0;
    this.#y = 0;
    this.#thumb.style.transform = '';
    this.#thumb.classList.remove('active');
  }

  #stickTo(clientX: number, clientY: number): void {
    const stick = this.#stick!;
    let dx = clientX - stick.cx;
    let dy = clientY - stick.cy;
    const distance = Math.hypot(dx, dy);
    if (distance > stick.reach) {
      dx *= stick.reach / distance;
      dy *= stick.reach / distance;
    }
    this.#thumb.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    const position = stickPosition(dx, dy, stick.reach);
    this.#x = position.x;
    this.#y = position.y;
  }
}
