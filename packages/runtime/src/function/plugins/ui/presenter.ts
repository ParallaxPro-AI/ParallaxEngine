/**
 * The UI's side of the panel surface port (`core/ports/ui.ts`): each frame it turns the
 * engine's open panels, presentation requests and labels into one `UiFrame` for the
 * surface, and feeds the surface's clicks back into the engine — the same `click` a
 * headless playtest's `game.click` makes, so a browser button and a test click run the
 * same code with the same payload rules.
 *
 * Screen placement comes from the cameras the visuals plugin resolved (`camera.__view__`,
 * read by component id like every renderer): each seat's viewport for its PlayerPanel copy
 * and `to=player` feedback, and world → screen for floating text and labels.
 */

import { Vec3 } from '../../../core/index.js';
import type {
  Quat, Rgba, UiClick, UiCursor, UiEffect, UiFrame, UiLabelFrame, UiPanelFrame, UiRect, UiSurface, UiValueRules,
} from '../../../core/index.js';
import type { Kernel } from '../../kernel/index.js';
import type { Label, UiEngine, UiRequest } from './engine.js';

const CAMERA = 'camera';
const FULL: UiRect = [0, 0, 1, 1];

/** The fields of visuals' CameraView the presenter projects with. */
interface ViewLike {
  readonly seat: number;
  readonly active: boolean;
  readonly dimension: '2d' | '3d';
  readonly mode: 'perspective' | 'orthographic';
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly fov: number;
  readonly size: number;
  readonly near: number;
  readonly far: number;
  readonly viewport: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
  readonly aspect: number;
}

export interface UiPresenterOptions {
  readonly engine: UiEngine;
  readonly kernel: Kernel;
  readonly surface: UiSurface;
  /** The screen the cameras were resolved for, in pixels. */
  readonly screen: () => { readonly width: number; readonly height: number };
  /** The player's language and its locale strings. */
  readonly locale: () => { readonly language: string; readonly strings: Readonly<Record<string, string>> };
  /** How state values and request texts (str or Text keys) read in the game language. */
  readonly values: UiValueRules;
  /** True while a control is being rebound (the surface leaves keys and pads alone). Default never. */
  readonly capturing?: () => boolean;
  /** The game's cursor look (`Game(cursor=...)`), under any panel's own; default the engine ring. */
  readonly cursor?: UiCursor | null;
}

/** A seat's player (`to=` of feedback): anything with a seat `index`. */
function seatOf(to: unknown): number | null {
  if (to === null || to === undefined) return null;
  const index = (to as { index?: unknown }).index;
  return typeof index === 'number' ? index : null;
}

function rgba(color: { r: number; g: number; b: number; a: number } | null): Rgba | null {
  return color === null ? null : [color.r, color.g, color.b, color.a];
}

/** A world point in a view, as fractions of the screen; null when behind the camera or outside its viewport. */
export function projectToScreen(view: ViewLike, point: Vec3, screen: { readonly width: number; readonly height: number }): [number, number] | null {
  const right = view.rotation.rotate(Vec3.RIGHT);
  const up = view.rotation.rotate(Vec3.UP);
  const forward = view.rotation.rotate(Vec3.FORWARD);
  const v = point.__sub__(view.position);
  let nx: number;
  let ny: number;
  if (view.dimension === '2d' || view.mode === 'orthographic') {
    nx = v.dot(right) / (view.size * view.aspect);
    ny = v.dot(up) / view.size;
  } else {
    const depth = v.dot(forward);
    if (depth < view.near || depth > view.far) return null;
    const t = Math.tan((view.fov * Math.PI) / 360);
    nx = v.dot(right) / (depth * t * view.aspect);
    ny = v.dot(up) / (depth * t);
  }
  if (Math.abs(nx) > 1 || Math.abs(ny) > 1) return null;
  const vp = view.viewport;
  return [(vp.x + ((nx + 1) / 2) * vp.width) / screen.width, (vp.y + ((1 - ny) / 2) * vp.height) / screen.height];
}

export class UiPresenter {
  readonly #engine: UiEngine;
  readonly #kernel: Kernel;
  readonly #surface: UiSurface;
  readonly #options: UiPresenterOptions;
  readonly #labelKeys = new WeakMap<Label, number>();
  #nextLabel = 1;

  constructor(options: UiPresenterOptions) {
    this.#engine = options.engine;
    this.#kernel = options.kernel;
    this.#surface = options.surface;
    this.#options = options;
  }

  /**
   * Before the `ui` hook: the surface's clicks become engine clicks. A click on a panel that
   * closed since it was drawn, or on an action that is disabled now, is dropped — the player
   * clicked something that is no longer there.
   */
  takeClicks(): void {
    for (const click of this.#surface.takeClicks()) this.#click(click);
  }

  #click(click: UiClick): void {
    const decl = this.#engine.panels.find((d) => d.id === click.panel);
    if (decl === undefined || !this.#engine.isOpen(decl)) return;
    if (this.#engine.view(decl)?.enabled[click.action] === false) return;
    this.#engine.click(decl, click.action, click.data, click.seat);
  }

  /** After the `ui` hook (and after other plugins read this frame's requests): draw. */
  present(): void {
    const screen = this.#options.screen();
    // Camera views are read only when something is placed by them (a seat's copy, a label, world text).
    let found: ViewLike[] | undefined;
    const views = (): ViewLike[] => (found ??= this.#views());
    const seatViewport = (seat: number): UiRect => {
      const view = views().find((v) => v.seat === seat);
      if (view === undefined) return FULL;
      const vp = view.viewport;
      return [vp.x / screen.width, vp.y / screen.height, vp.width / screen.width, vp.height / screen.height];
    };
    const panels: UiPanelFrame[] = [];
    let cursor: UiCursor | null = this.#options.cursor ?? null;
    for (const open of this.#engine.openPanels) {
      if (open.decl.cursor !== undefined) cursor = open.decl.cursor; // the newest panel with a cursor wins
      const view = this.#engine.view(open.decl);
      if (view === undefined) continue; // opened after this frame's ui hook: drawn next frame
      panels.push({
        id: open.decl.id,
        html: open.decl.html,
        layer: open.decl.layer,
        modal: open.decl.modal,
        ...(open.decl.scale !== undefined && { scale: open.decl.scale }),
        instances: view.states.map((state, seat) => ({ seat, viewport: open.decl.perPlayer ? seatViewport(seat) : FULL, state })),
        enabled: view.enabled,
      });
    }
    const values = this.#options.values;
    const effects: UiEffect[] = [];
    for (const request of this.#engine.takeRequests()) this.#effect(request, effects, views, screen, seatViewport);
    const labels: UiLabelFrame[] = [];
    for (const label of this.#engine.labels) {
      const record = this.#kernel.world.get(label.entity);
      if (record === undefined) continue;
      const offset = label.offset ?? new Vec3(0, 0, 0);
      const point = record.transform.worldPosition().__add__(offset);
      let key = this.#labelKeys.get(label);
      if (key === undefined) {
        key = this.#nextLabel++;
        this.#labelKeys.set(label, key);
      }
      for (const view of views()) {
        const at = projectToScreen(view, point, screen);
        if (at !== null) labels.push({ key: views().length > 1 ? key * 16 + view.seat : key, text: values.text(label.text), at, ...(label.kind !== undefined && { kind: label.kind }) });
      }
    }
    const { language, strings } = this.#options.locale();
    const capturing = this.#options.capturing?.() ?? false;
    const frame: UiFrame = { time: this.#kernel.time.realNow, panels, effects, labels, language, strings, values, capturing, cursor };
    this.#surface.present(frame);
  }

  #effect(
    request: UiRequest, out: UiEffect[], views: () => readonly ViewLike[], screen: { width: number; height: number },
    seatViewport: (seat: number) => UiRect,
  ): void {
    const values = this.#options.values;
    switch (request.kind) {
      case 'toast': {
        const seat = seatOf(request.to);
        out.push({ kind: 'toast', text: values.text(request.text), seconds: request.seconds, viewport: seat === null ? FULL : seatViewport(seat) });
        return;
      }
      case 'announce': {
        const seat = seatOf(request.to);
        out.push({
          kind: 'announce', title: values.text(request.title),
          subtitle: request.subtitle === null ? null : values.text(request.subtitle),
          seconds: request.seconds, viewport: seat === null ? FULL : seatViewport(seat),
        });
        return;
      }
      case 'float_text': {
        const seat = seatOf(request.to);
        const at = request.at instanceof Vec3 ? request.at : new Vec3(request.at.x, request.at.y, 0);
        for (const view of views()) {
          if (seat !== null && view.seat !== seat) continue;
          const point = projectToScreen(view, at, screen);
          if (point !== null) {
            out.push({ kind: 'float_text', text: request.text, at: point, color: rgba(request.color), ...(request.style !== null && { style: request.style }) });
          }
        }
        return;
      }
      case 'flash':
        // An entity tint is the renderers' to draw; the panel surface has nothing to show.
        return;
    }
  }

  /** Active camera views, one per seat (the first found). */
  #views(): ViewLike[] {
    const views: ViewLike[] = [];
    for (const record of this.#kernel.world.live()) {
      const camera = record.components.get(CAMERA);
      const view = (camera as { __view__?: ViewLike } | undefined)?.__view__;
      if (view === undefined || !view.active || views.some((v) => v.seat === view.seat)) continue;
      if (!(view.viewport.width > 0 && view.viewport.height > 0)) continue;
      views.push(view);
    }
    return views.sort((a, b) => a.seat - b.seat);
  }
}
