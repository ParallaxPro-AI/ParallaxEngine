/**
 * Inside a scripted panel's sandboxed frame (see `frame_host.ts`): bundled as the engine's
 * `panel_frame.js` and loaded by the frame document, it builds the panel from the data its
 * document carries with the same binder as every panel, gives the panel's scripts their
 * only bridge, runs them, and then talks to the page in the fixed message set:
 *
 *   parallax.on_state(fn)            fn(state) now (if a state arrived) and on every change;
 *                                    state is JSON (str/number/bool/None/lists/dicts; other
 *                                    values as their text)
 *   parallax.action(name, payload)   one of the panel's actions, payload a small JSON object
 *
 * `data-action` clicks and `data-key` shortcuts work as in any panel. Keys the panel doesn't
 * use (not typed into a field, not a shortcut) go back to the page for the game's input.
 * The page's virtual cursor (a menu over a locked pointer) arrives as `cursor` messages and
 * is replayed here as presses, drags, hover and wheel (`virtual_cursor.ts`).
 */

import { inlineStyle } from './css.js';
import { PanelBinding } from './binding.js';
import { QUIET_FOCUS } from './dom.js';
import type { DomDocument, DomParent } from './dom.js';
import type { FrameInit } from './frame_host.js';
import { WIRE_VALUES } from './frame_values.js';
import type { Wire } from './frame_values.js';
import { urlResolver } from './markup.js';
import { CursorDispatch, frameCursorMessage, playFrameCursor } from './virtual_cursor.js';

interface StateMessage {
  readonly state: Readonly<Record<string, Wire>>;
  readonly strings: Readonly<Record<string, string>>;
  readonly enabled: Readonly<Record<string, boolean>>;
}

/** What a press lands on to stay in the panel (the page's PASS_THROUGH_CSS list). */
const CONTROLS = '[data-action], button, input, select, textarea, label, a, summary, details';

function editable(target: EventTarget | null): boolean {
  const el = target as { tagName?: string; isContentEditable?: boolean } | null;
  return el !== null && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable === true);
}

function start(): void {
  const data = document.getElementById('parallax-panel')?.textContent;
  if (data === null || data === undefined) return;
  const init = JSON.parse(data) as FrameInit;
  const send = (message: Record<string, unknown>): void => window.parent.postMessage({ parallax: 1, ...message }, '*');
  // Without a project URL (a packed build), each file's URL comes from the page, once: until it
  // arrives the attribute is empty, then the binding is refreshed with the last state.
  const files = new Map<string, string>();
  const url = (path: string): string => {
    if (init.project !== null) return new URL(path.split('/').map(encodeURIComponent).join('/'), init.project).href;
    const known = files.get(path);
    if (known !== undefined) return known;
    files.set(path, '');
    send({ t: 'file', path });
    return '';
  };
  const folder = init.folder;
  const binding = new PanelBinding(document as unknown as DomDocument, init.nodes, document.body as unknown as DomParent, {
    url: urlResolver(folder, url),
    style: (css) => inlineStyle(css, folder, url),
  });
  const listeners: ((state: unknown) => void)[] = [];
  let last: StateMessage | undefined;

  const bridge = Object.freeze({
    on_state(fn: unknown): void {
      if (typeof fn !== 'function') throw new TypeError('parallax.on_state takes a function');
      listeners.push(fn as (state: unknown) => void);
      if (last !== undefined) (fn as (state: unknown) => void)(structuredClone(last.state));
    },
    action(name: unknown, payload: unknown = {}): void {
      if (typeof name !== 'string') throw new TypeError('parallax.action takes the action name (a string)');
      if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) throw new TypeError('parallax.action payload must be an object');
      send({ t: 'action', action: name, data: JSON.parse(JSON.stringify(payload)) as unknown });
    },
  });
  Object.defineProperty(window, 'parallax', { value: bridge, writable: false, configurable: false });

  document.addEventListener('click', (e) => {
    const target = binding.target(e.composedPath());
    if (target !== undefined) send({ t: 'action', action: target.action, data: target.data });
  });
  const key = (e: KeyboardEvent): void => {
    if (editable(e.target)) return;
    if (e.type === 'keydown' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const target = binding.shortcut(e.code);
      if (target !== undefined) {
        e.preventDefault();
        send({ t: 'action', action: target.action, data: target.data });
        return;
      }
    }
    // Enter / Space on a focused button are the button's own (a click above).
    const active = document.activeElement;
    if ((e.code === 'Enter' || e.code === 'Space') && active !== null && active !== document.body) return;
    send({ t: 'key', type: e.type, code: e.code, key: e.key, repeat: e.repeat });
  };
  document.addEventListener('keydown', key);
  document.addEventListener('keyup', key);
  // Every real press, on a control or not: the page learns only that one happened (a host
  // takes its pointer lock back on it, as on a press anywhere else in the game view). While
  // the page asks for capture presses (`capture`), the press is that and nothing else: no
  // control, script or game sees it, nor the click after it.
  let capture = false;
  const swallow = (e: Event): void => { e.preventDefault(); e.stopImmediatePropagation(); };
  document.addEventListener('pointerdown', (e) => {
    if (!e.isTrusted) return;
    send({ t: 'press' });
    if (!capture) return;
    capture = false;
    swallow(e);
    for (const type of ['mousedown', 'pointerup', 'mouseup', 'click']) document.addEventListener(type, swallow, { capture: true, once: true });
    setTimeout(() => { for (const type of ['mousedown', 'pointerup', 'mouseup', 'click']) document.removeEventListener(type, swallow, { capture: true }); }, 600);
  }, { capture: true });
  // A non-modal panel lets presses off its controls through to the game (as any panel does).
  if (!init.modal) {
    const control = (target: EventTarget | null): boolean => ((target as Element | null)?.closest?.(CONTROLS) ?? null) !== null;
    const forward = (e: PointerEvent): void => {
      if (e.type === 'pointerdown' && control(e.target)) return;
      if (e.type === 'pointerdown') e.preventDefault(); // no focus or text selection in the frame
      send({
        t: 'pointer',
        pointer: {
          type: e.type, x: e.clientX, y: e.clientY, buttons: e.buttons, pointerType: e.pointerType, pointerId: e.pointerId, isPrimary: e.isPrimary,
        },
      });
    };
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) document.addEventListener(type, (e) => forward(e as PointerEvent));
  }

  const cursor = new CursorDispatch(document);
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const virtual = frameCursorMessage(event.data);
    if (virtual !== undefined) {
      playFrameCursor(cursor, virtual);
      return;
    }
    const c = event.data as { parallax?: unknown; t?: unknown; on?: unknown };
    if (c?.parallax === 1 && c.t === 'capture') {
      capture = c.on === true;
      return;
    }
    const f = event.data as { parallax?: unknown; t?: unknown; path?: unknown; url?: unknown };
    if (f?.parallax === 1 && f.t === 'file') {
      if (typeof f.path !== 'string' || !files.has(f.path) || (typeof f.url !== 'string' && f.url !== null)) return;
      files.set(f.path, f.url ?? '');
      if (last !== undefined) binding.update({ state: last.state, values: WIRE_VALUES, strings: last.strings, enabled: last.enabled });
      return;
    }
    const m = event.data as { parallax?: unknown; t?: unknown } & Partial<StateMessage>;
    if (m.parallax !== 1 || m.t !== 'state' || m.state === undefined) return;
    last = { state: m.state, strings: m.strings ?? {}, enabled: m.enabled ?? {} };
    binding.update({ state: last.state, values: WIRE_VALUES, strings: last.strings, enabled: last.enabled });
    for (const fn of listeners) fn(structuredClone(last.state));
  });

  for (const script of init.scripts) {
    const el = document.createElement('script');
    if (script.module) el.type = 'module';
    el.textContent = script.code;
    document.body.append(el);
  }
  // Focus without the ring (focus-visible is for keyboard / gamepad moves), as on any modal panel.
  if (init.modal) (document.querySelector('[data-action]') as HTMLElement | null)?.focus(QUIET_FOCUS);
  send({ t: 'ready' });
}

start();
