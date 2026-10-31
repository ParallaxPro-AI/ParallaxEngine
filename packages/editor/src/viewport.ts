/**
 * The viewport: the game's own stage (the engine draws the scene through the editor
 * camera) with an overlay canvas on top for the gizmo, selection boxes and the marquee.
 * The pointer and wheel (see camera_controls.ts for the math):
 *
 * Edit mode — the overlay takes the pointer:
 *   left click        select (Shift / Ctrl / Cmd: toggle; Alt: the innermost entity;
 *                     clicking the only selected entity deselects it)
 *   left drag         drag a gizmo handle, or draw a marquee on empty space (replaces the selection)
 *   orbit mode        right drag or Ctrl / Cmd / Alt + left drag: orbit; middle drag or
 *                     Shift + left drag: pan; wheel: zoom toward the pivot
 *   fly mode          W A S D (E / Space up, Q / Ctrl down, Shift faster) fly without a
 *                     button; left or right drag: look (pointer lock); wheel: fly speed
 *   2D                right / middle / modified-left drag: pan; wheel: zoom about the pointer
 *   double-click      frame what's under the pointer (F frames the selection)
 *   drop a prefab     place it where it lands (3D: on the ground plane y = 0)
 *   touch             one finger: orbit (2D: pan; fly mode: look), a tap selects, a gizmo
 *                     handle drags; two fingers: pan, and pinch to zoom; in fly mode a joystick moves and two
 *                     buttons fly up / down (touch_fly.ts)
 *
 * Playing or paused — a Game / Scene strip sits above the view, with a fullscreen button:
 *   Game   (default) the game's camera; the overlay lets everything through to the game. A
 *          desktop game gets the pointer lock on Play (see play_lock.ts)
 *   Scene  the editor camera over the live world, full-bleed, with the same navigation and
 *          selection (no gizmo: the play world isn't edited); the game keeps running, but its
 *          panels, touch controls and input are suspended (its HUD hidden there)
 *
 * Every coordinate handed to the session is in surface pixels (the game canvas's backing
 * size), so pointer positions are scaled by canvas.width / clientWidth.
 */

import { lt } from './i18n.js';
import { Vec3 } from '@parallax/runtime/core';
import type { EntityId } from '@parallax/runtime/core';
import { drawnFrame, screenBoxes } from './session/index.js';
import type { CameraPose, GizmoHandle, HandleShape, PixelRect, SessionMode, Snap } from './session/index.js';
import type { Editor } from './editor.js';
import { SNAP } from './editor.js';
import { h } from './dom.js';
import { TouchFlyControls } from './touch_fly.js';
import { FRUSTUM_HIT_PX, FRUSTUM_LENGTH, FRUSTUM_SELECTED_LENGTH, frustumSegments, nearestSegment, screenSegments } from './camera_frustum.js';
import type { FrustumCamera, ScreenSegment } from './camera_frustum.js';
import {
  distanceTo, flyLevel, flyRate, flySpeedAfterWheel, FLY_SPEED, look, orbit, ORBIT_DISTANCE, pan, PAN_PER_PIXEL,
  wheelPixels, zoom2dWheel, zoomOrbit,
} from './camera_controls.js';
import type { CameraMode } from './camera_controls.js';
import { PREFAB_DRAG_TYPE } from './bottom_panels.js';
import { FRAME_PRESS_EVENT } from '@parallax/runtime/platform';
import { capturesPress, lockChange, wantsPointerLock } from './play_lock.js';
import type { LockSituation } from './play_lock.js';

export type { CameraMode } from './camera_controls.js';
/** Which camera the viewport shows while the game plays. */
export type PlayView = 'game' | 'scene';

const GIZMO_PX = 90;
/** A modified click (or a fly-mode click) still selects when it moved at most this far (CSS px). */
const CLICK_SLOP = 4;
/** An unmodified left drag becomes a marquee past this (CSS px). */
const MARQUEE_SLOP = 5;
/** A finger wanders more than a mouse: a tap still selects within this (CSS px). */
const TAP_SLOP = 10;
/** Wheel pixels per CSS pixel the fingers pinch together (zoom out) or apart (zoom in). */
const PINCH_WHEEL = 3;
const COLORS: Readonly<Record<HandleShape['color'], string>> = {
  x: '#e05252', y: '#4caf50', z: '#69bbf3', plane: '#ffd166', screen: '#e0e0e0',
};
const HOVER = '#ffeb3b';
const FLY_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space', 'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight']);
const CAMERA = 'camera';

const SVG = (body: string): string => `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const MAXIMIZE = SVG('<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" x2="14" y1="3" y2="10"/><line x1="3" x2="10" y1="21" y2="14"/>');
const MINIMIZE = SVG('<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" x2="21" y1="10" y2="3"/><line x1="3" x2="10" y1="21" y2="14"/>');

/** A left press that becomes a selection click if it barely moves. */
interface Click {
  readonly x: number;
  readonly y: number;
  readonly additive: boolean;
  readonly deep: boolean;
}

type Gesture =
  | { kind: 'gizmo' }
  | { kind: 'select'; click: Click; cx: number; cy: number; ox: number; oy: number; moved: boolean }
  | { kind: 'orbit' | 'look' | 'pan'; button: number; cx: number; cy: number; ox: number; oy: number; click?: Click };

/** The editor camera inside the play world (the Scene tab): its entity and the game camera it replaced. */
interface SceneCamera {
  readonly runtime: unknown;
  readonly id: EntityId;
  game: EntityId | undefined;
}

/** A marquee between two surface points as a rectangle. */
export function rectBetween(ax: number, ay: number, bx: number, by: number): PixelRect {
  return { x: Math.min(ax, bx), y: Math.min(ay, by), width: Math.abs(bx - ax), height: Math.abs(by - ay) };
}

/** Whether `el` can scroll further in the wheel's direction (a game panel's list), so the wheel is its, not the game's. */
export function canScroll(el: Pick<Element, 'scrollTop' | 'scrollHeight' | 'clientHeight' | 'scrollLeft' | 'scrollWidth' | 'clientWidth'>, overflowY: string, overflowX: string, dx: number, dy: number): boolean {
  const scrolls = (o: string): boolean => o === 'auto' || o === 'scroll' || o === 'overlay';
  if (dy !== 0 && scrolls(overflowY) && el.scrollHeight > el.clientHeight + 1) {
    if (dy < 0 ? el.scrollTop > 0 : el.scrollTop + el.clientHeight < el.scrollHeight - 1) return true;
  }
  if (dx !== 0 && scrolls(overflowX) && el.scrollWidth > el.clientWidth + 1) {
    if (dx < 0 ? el.scrollLeft > 0 : el.scrollLeft + el.clientWidth < el.scrollWidth - 1) return true;
  }
  return false;
}

export class Viewport {
  /** Where bootBrowser builds the game's stage. */
  readonly mount: HTMLElement;
  readonly el: HTMLElement;
  readonly #stage: HTMLElement;
  readonly #overlay: HTMLCanvasElement;
  readonly #tabs: HTMLElement;
  readonly #gameTab: HTMLButtonElement;
  readonly #sceneTab: HTMLButtonElement;
  readonly #fullscreen: HTMLButtonElement;
  #editor: Editor | undefined;
  #gesture: Gesture | undefined;
  #hover: GizmoHandle | null = null;
  #marquee: PixelRect | null = null;
  readonly #keys = new Set<string>();
  #frame = 0;
  #lastTick = 0;
  #cameraMode: CameraMode = 'orbit';
  /** The orbit pivot's distance ahead of the camera. */
  #distance: number = ORBIT_DISTANCE.initial;
  #flySpeed: number = FLY_SPEED.initial;
  #playView: PlayView = 'game';
  #sceneCamera: SceneCamera | undefined;
  #lastMode: SessionMode = 'edit';
  #lastView: PlayView = 'game';
  /** Fingers on the overlay, by pointer id (client px). */
  readonly #touches = new Map<number, { x: number; y: number }>();
  /** Two fingers down: their last midpoint and spread. */
  #pinch: { mx: number; my: number; spread: number } | undefined;
  /** After a pinch, the last finger does nothing until every finger is up. */
  #touchSpent = false;
  /** Fly mode's joystick and up / down buttons, shown on a phone or tablet while flying. */
  readonly #touchFly = new TouchFlyControls();
  /** Camera frustums drawn last frame (surface px): a click near one selects its camera. */
  #frustums: { readonly id: EntityId; readonly segments: readonly ScreenSegment[] }[] = [];
  /** Surface px per CSS px at the last draw. */
  #frustumRatio = 1;

  constructor() {
    this.mount = h('div.viewport-game');
    this.#overlay = h('canvas.viewport-overlay');
    this.#gameTab = h('button.viewport-tab.active', { type: 'button', ...lt('viewport.game'), ...lt('viewport.gameTitle', 'title') });
    this.#sceneTab = h('button.viewport-tab', { type: 'button', ...lt('viewport.scene'), ...lt('viewport.sceneTitle', 'title') });
    this.#fullscreen = h('button.viewport-tab.viewport-fullscreen', { type: 'button', ...lt('viewport.fullscreen', 'title'), ...lt('viewport.fullscreen', 'aria-label') });
    this.#fullscreen.innerHTML = MAXIMIZE;
    this.#fullscreen.hidden = !fullscreenApi().available;
    this.#tabs = h('div.viewport-tabs', { role: 'tablist' }, this.#gameTab, this.#sceneTab, h('span.viewport-tabs-spacer'), this.#fullscreen);
    this.#tabs.hidden = true;
    this.#stage = h('div.viewport-stage', {}, this.mount, this.#overlay, this.#touchFly.el);
    this.el = h('section.viewport', {}, this.#tabs, this.#stage);
  }

  /** Start editing on the booted game. */
  attach(editor: Editor): void {
    this.#editor = editor;
    const overlay = this.#overlay;
    overlay.addEventListener('contextmenu', (event) => event.preventDefault());
    overlay.addEventListener('pointerdown', (event) => this.#down(editor, event));
    overlay.addEventListener('pointermove', (event) => this.#move(editor, event));
    overlay.addEventListener('pointerup', (event) => this.#up(editor, event));
    overlay.addEventListener('pointercancel', (event) => {
      if (event.pointerType === 'touch') this.#touchEnd(event);
      this.#cancel(editor);
    });
    overlay.addEventListener('wheel', (event) => this.#wheel(editor, event), { passive: false });
    overlay.addEventListener('dblclick', (event) => this.#doubleClick(editor, event));
    // The game's stage takes every wheel (and cancels it) for its own input; a game panel that
    // can still scroll gets the wheel instead, before the stage sees it.
    this.#stage.addEventListener('wheel', (event) => {
      if (this.#scrollsPanel(event)) event.stopPropagation();
    }, { capture: true });
    // Click to capture: while the game plays unlocked (after Escape), the first press on the
    // game view locks the pointer and goes no further.
    this.#stage.addEventListener('pointerdown', (event) => {
      if (!capturesPress(this.#lockSituation(editor), event, this.#gameLocked(editor))) return;
      // The browser refused the lock (no permission, an embedding page, headless): presses go
      // to the game as they are, so its menus still work; each press asks for the lock again.
      if (this.#lockRefused) {
        editor.game.input.lock();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      this.#swallowClick();
      editor.game.input.lock();
      // Not every refusal fires pointerlockerror (some just never grant): give up after a second.
      setTimeout(() => {
        if (this.#gameLocked(editor) || !wantsPointerLock(this.#lockSituation(editor))) return;
        this.#lockRefused = true;
        this.#syncPressCapture(editor);
      }, 1000);
    }, { capture: true });
    // A press inside a scripted panel's frame never reaches the page as a pointer event; the
    // frame reports it, and while the game is unlocked it is only that (setPressCapture): it locks.
    this.#stage.addEventListener(FRAME_PRESS_EVENT, () => {
      if (wantsPointerLock(this.#lockSituation(editor)) && !this.#gameLocked(editor)) editor.game.input.lock();
    });
    document.addEventListener('pointerlockchange', () => {
      if (this.#gameLocked(editor)) this.#lockRefused = false;
      this.#syncPressCapture(editor);
    });
    document.addEventListener('pointerlockerror', () => {
      this.#lockRefused = true;
      this.#syncPressCapture(editor);
    });
    this.#gameTab.addEventListener('click', () => this.setPlayView('game'));
    this.#sceneTab.addEventListener('click', () => this.setPlayView('scene'));
    this.#fullscreen.addEventListener('click', () => this.toggleFullscreen());
    const onFullscreen = (): void => { this.#fullscreen.innerHTML = fullscreenApi().element() === this.#stage ? MINIMIZE : MAXIMIZE; };
    document.addEventListener('fullscreenchange', onFullscreen);
    document.addEventListener('webkitfullscreenchange', onFullscreen);
    this.el.addEventListener('dragover', (event) => {
      if (editor.editing && event.dataTransfer?.types.includes(PREFAB_DRAG_TYPE)) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }
    });
    this.el.addEventListener('drop', (event) => {
      const prefab = event.dataTransfer?.getData(PREFAB_DRAG_TYPE);
      if (prefab === undefined || prefab === '' || !editor.editing) return;
      event.preventDefault();
      const point = this.#surfacePoint(event);
      editor.addPrefab(prefab, point === null ? undefined : this.#dropPoint(editor, point.x, point.y));
    });
    globalThis.addEventListener('keydown', (event) => {
      if (!FLY_KEYS.has(event.code) || typing(event.target)) return;
      this.#keys.add(event.code);
      // Space would scroll a page; the fly keys belong to the camera while it flies.
      if (this.#flyActive(editor) && !event.ctrlKey && !event.metaKey) event.preventDefault();
    });
    globalThis.addEventListener('keyup', (event) => this.#keys.delete(event.code));
    globalThis.addEventListener('blur', () => {
      this.#keys.clear();
      if (this.#gesture !== undefined && this.#gesture.kind !== 'gizmo') this.#cancel(editor);
    });
    editor.on((changes) => {
      if (changes.has('mode')) {
        this.#cancel(editor);
        this.#syncMode(editor);
      }
    });
    this.#distance = initialDistance(editor.session.cameraPose);
    this.#syncMode(editor);
    const tick = (time: number): void => {
      this.#frame = requestAnimationFrame(tick);
      const dt = this.#lastTick === 0 ? 0 : Math.min(0.1, (time - this.#lastTick) / 1000);
      this.#lastTick = time;
      this.#touchFly.setVisible(this.#flyActive(editor) && touchFlyWanted());
      // The game's own touch controls (the runtime's .parallax-touch layer) belong to play: in
      // edit mode, paused, or on the Scene tab they would sit over the editor's own controls.
      this.#stage.classList.toggle('game-touch-off', editor.session.mode !== 'playing' || this.#playView === 'scene');
      this.#flyStep(editor, dt);
      this.#syncSceneCamera(editor);
      this.#draw(editor);
    };
    this.#frame = requestAnimationFrame(tick);
  }

  // ── Camera mode (the top bar's Orbit / Fly toggle) ───────────────────────────

  /** 'orbit' (default) or 'fly'; a change emits editor 'gizmo'. */
  get cameraMode(): CameraMode {
    return this.#cameraMode;
  }

  setCameraMode(mode: CameraMode): void {
    if (mode === this.#cameraMode) return;
    if (this.#gesture !== undefined && this.#gesture.kind !== 'gizmo' && this.#gesture.kind !== 'select') this.#endCameraGesture();
    this.#cameraMode = mode;
    this.#editor?.emit('gizmo');
  }

  toggleCameraMode(): void {
    this.setCameraMode(this.#cameraMode === 'orbit' ? 'fly' : 'orbit');
  }

  /** The fly-mode speed in meters per second (the wheel changes it while flying). */
  get flySpeed(): number {
    return this.#flySpeed;
  }

  /** Whether the camera is flying (fly mode in 3D, or a look drag): W / E / R aren't gizmo keys then. */
  get flying(): boolean {
    const editor = this.#editor;
    if (this.#gesture?.kind === 'look') return true;
    return editor !== undefined && this.#flyActive(editor);
  }

  /** F: frame the selection, orbit about it (switches to orbit mode). */
  frameSelection(): void {
    const editor = this.#editor;
    if (editor === undefined || !this.#navigating(editor)) return;
    const session = editor.session;
    const ids = session.selection;
    if (ids.length === 0) return;
    editor.run('Frame', () => session.frameSelection());
    const center = ids.map((id) => session.poseOf(id).position).reduce((a, b) => a.__add__(b), Vec3.ZERO).__mul__(1 / ids.length);
    this.#distance = distanceTo(session.cameraPose, center, this.#distance);
    this.setCameraMode('orbit');
  }

  // ── Play view (Game / Scene) and fullscreen ──────────────────────────────────

  /** While playing: 'game' (the game's camera, the game has the pointer) or 'scene' (the editor camera). */
  get playView(): PlayView {
    return this.#playView;
  }

  setPlayView(view: PlayView): void {
    const editor = this.#editor;
    if (editor === undefined) return;
    if (view === 'scene' && editor.editing) return;
    if (view === this.#playView) return;
    this.#cancel(editor);
    this.#playView = view;
    this.#syncMode(editor);
    editor.emit('gizmo');
  }

  // ── The game's pointer lock (play_lock.ts) ───────────────────────────────────

  #lockSituation(editor: Editor): LockSituation {
    return { mode: editor.session.mode, view: this.#playView, touch: touchPrimary(), gameLocks: editor.session.runtime.game.pointer_lock !== false };
  }

  #gameLocked(editor: Editor): boolean {
    return document.pointerLockElement === editor.game.stage.stage;
  }

  /** The last lock request was refused: presses aren't swallowed as capture clicks (see pointerdown). */
  #lockRefused = false;

  /** Lock the pointer to the game now when it plays with mouse-look (call from a user gesture). */
  #lockIfWanted(editor: Editor): void {
    if (wantsPointerLock(this.#lockSituation(editor)) && !this.#gameLocked(editor)) editor.game.input.lock();
  }

  /** Scripted panels' frames swallow a press as the capture click while the game wants the lock and lacks it. */
  #syncPressCapture(editor: Editor): void {
    editor.game.ui.setPressCapture(wantsPointerLock(this.#lockSituation(editor)) && !this.#gameLocked(editor) && !this.#lockRefused);
  }

  #releaseGameLock(editor: Editor): void {
    if (this.#gameLocked(editor)) document.exitPointerLock();
  }

  /** The capture press's click (if the lock comes after the release) must not press a panel button either. */
  #swallowClick(): void {
    const eat = (event: Event): void => { event.preventDefault(); event.stopPropagation(); };
    this.#stage.addEventListener('click', eat, { capture: true, once: true });
    setTimeout(() => this.#stage.removeEventListener('click', eat, { capture: true }), 600);
  }

  /** The game's input reads the keyboard from the window and the pointer from its stage. */
  #focusGame(): void {
    this.mount.querySelector<HTMLElement>('.parallax-stage')?.focus({ preventScroll: true });
  }

  /** Fullscreen the game view (not the tab strip); again to leave. The game keeps the keyboard (and its pointer lock). */
  toggleFullscreen(): void {
    const api = fullscreenApi();
    if (!api.available) return;
    const editor = this.#editor;
    // Lock first: a fullscreen request uses up the click's user activation.
    if (editor !== undefined) this.#lockIfWanted(editor);
    const done = api.element() !== null ? api.exit() : api.request(this.#stage);
    void Promise.resolve(done).catch(() => { /* the browser refused (no user gesture, policy) */ });
    // The button took focus: Space / Enter would press it again instead of reaching the game.
    if (editor !== undefined && !editor.editing && this.#playView === 'game') this.#focusGame();
  }

  get fullscreen(): boolean {
    return fullscreenApi().element() === this.#stage;
  }

  #syncMode(editor: Editor): void {
    const mode = editor.session.mode;
    const before = { mode: this.#lastMode, view: this.#lastView };
    if (mode === 'edit') {
      this.#playView = 'game';
      this.#sceneCamera = undefined; // stop() restored the edit world: the entity is gone with the play world
      editor.playCamera = undefined;
      if (this.#lastMode !== 'edit') {
        // Carry the Scene tab's view back into edit mode (the restored camera entity has the old pose).
        editor.session.setCamera(editor.session.cameraPose);
        if (fullscreenApi().element() === this.#stage) void Promise.resolve(fullscreenApi().exit()).catch(() => {});
      }
    } else if (this.#lastMode === 'edit') {
      this.#playView = 'game';
    }
    this.#lastMode = mode;
    this.#lastView = this.#playView;
    const scene = mode !== 'edit' && this.#playView === 'scene';
    this.el.dataset['mode'] = mode;
    this.el.dataset['view'] = mode === 'edit' ? 'edit' : this.#playView;
    this.#tabs.hidden = mode === 'edit';
    this.#gameTab.classList.toggle('active', this.#playView === 'game');
    this.#sceneTab.classList.toggle('active', this.#playView === 'scene');
    this.#gameTab.setAttribute('aria-selected', String(this.#playView === 'game'));
    this.#sceneTab.setAttribute('aria-selected', String(this.#playView === 'scene'));
    this.#overlay.style.pointerEvents = mode === 'edit' || scene ? 'auto' : 'none';
    if (!scene) this.#dropSceneCamera(editor);
    // The Scene tab shows the world, not the game's screen: its panels, touch controls and
    // input sleep there (the game still runs), and wake with the Game tab or Stop.
    editor.game.input.setSuspended(scene);
    editor.game.ui.setSuspended(scene);
    if (mode !== 'edit' && !scene) this.#focusGame();
    // Play, Resume and the Game tab are the click a lock needs; Pause, Stop and Scene free it.
    const situation = this.#lockSituation(editor);
    const change = lockChange(before, situation);
    if (change === 'lock' && !this.#gameLocked(editor)) editor.game.input.lock();
    else if (change === 'release') this.#releaseGameLock(editor);
    this.#syncPressCapture(editor);
  }

  /** The editor camera moves (edit mode, or the Scene tab while playing). */
  #navigating(editor: Editor): boolean {
    return editor.editing || this.#playView === 'scene';
  }

  #flyActive(editor: Editor): boolean {
    return this.#cameraMode === 'fly' && editor.session.dimension === '3d' && this.#navigating(editor);
  }

  // ── The Scene tab's camera in the play world ─────────────────────────────────

  /**
   * The play world has no editor camera (the session removes it for play), so the Scene tab
   * adds one — a fixed-rig camera entity made active with camera.use() — and follows the
   * editor pose with it every frame. The game camera it replaced is made active again on Game.
   */
  #syncSceneCamera(editor: Editor): void {
    const session = editor.session;
    if (session.mode === 'edit' || this.#playView !== 'scene') return;
    const runtime = session.runtime;
    const kernel = runtime.kernel;
    let cam = this.#sceneCamera;
    if (cam !== undefined && (cam.runtime !== runtime || kernel.world.get(cam.id) === undefined)) cam = undefined;
    const pose = session.cameraPose;
    if (cam === undefined) {
      const game = runtime.visuals.rig.active();
      // The game camera's clear color, so the world sits on its own backdrop rather than the
      // engine's default; nothing else of it (rig, fit, viewport): the scene view is full-bleed.
      const background = game === undefined ? undefined : kernel.world.get(game)?.components.get(CAMERA)?.['background'];
      const record = kernel.world.create({ name: 'editor_scene_camera' });
      record.transform.position = pose.position;
      record.transform.rotation = pose.rotation;
      kernel.addComponent(record.id, CAMERA, {
        rig: 'fixed',
        mode: session.dimension === '2d' ? 'orthographic' : 'perspective',
        ...(pose.fov !== undefined && { fov: pose.fov }),
        ...(pose.size !== undefined && { size: pose.size }),
        ...(background !== undefined && background !== null && { background }),
      });
      cam = { runtime, id: record.id, game };
      this.#sceneCamera = cam;
      editor.playCamera = record.id;
    }
    const record = kernel.world.require(cam.id);
    record.transform.position = pose.position;
    record.transform.rotation = pose.rotation;
    const fields = record.components.get(CAMERA);
    if (fields !== undefined) {
      if (pose.fov !== undefined) fields['fov'] = pose.fov;
      if (pose.size !== undefined) fields['size'] = pose.size;
    }
    const active = runtime.visuals.rig.active();
    if (active !== cam.id) {
      // The game switched cameras meanwhile: that is the one to give back.
      if (active !== undefined) cam.game = active;
      useCamera(runtime, cam.id);
    }
  }

  #dropSceneCamera(editor: Editor): void {
    const cam = this.#sceneCamera;
    this.#sceneCamera = undefined;
    editor.playCamera = undefined;
    if (cam === undefined) return;
    const runtime = editor.session.runtime;
    if (cam.runtime !== runtime || editor.session.mode === 'edit') return;
    const kernel = runtime.kernel;
    editor.run('Scene camera', () => {
      if (kernel.world.get(cam.id) !== undefined) kernel.destroy(cam.id);
      if (cam.game !== undefined && kernel.world.get(cam.game)?.components.has(CAMERA) === true && runtime.visuals.rig.active() !== cam.game) {
        useCamera(runtime, cam.game);
      }
    });
  }

  // ── Coordinates ────────────────────────────────────────────────────────────

  #canvas(): HTMLCanvasElement | null {
    return this.mount.querySelector('.parallax-surface canvas');
  }

  /** A pointer event's position in the game canvas's surface pixels. */
  #surfacePoint(event: Pick<MouseEvent, 'clientX' | 'clientY'>): { x: number; y: number } | null {
    const canvas = this.#canvas();
    if (canvas === null) return null;
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    return { x: (event.clientX - r.left) * (canvas.width / r.width), y: (event.clientY - r.top) * (canvas.height / r.height) };
  }

  #snap(editor: Editor, event: MouseEvent): Snap {
    const on = editor.gizmo.snap !== (event.ctrlKey || event.metaKey);
    return on ? SNAP : {};
  }

  /** Where a dropped prefab lands: the ground plane under the pointer (3D), or the pointer's world point (2D). */
  #dropPoint(editor: Editor, x: number, y: number): number[] | undefined {
    const view = editor.session.view();
    if (view === null) return undefined;
    const ray = view.ray(x, y);
    if (editor.session.dimension === '2d') return [ray.origin.x, ray.origin.y];
    if (Math.abs(ray.direction.y) > 1e-6) {
      const t = -ray.origin.y / ray.direction.y;
      if (t > 0 && t < 500) {
        const p = ray.origin.__add__(ray.direction.__mul__(t));
        return [p.x, 0, p.z];
      }
    }
    const p = ray.origin.__add__(ray.direction.__mul__(10));
    return [p.x, p.y, p.z];
  }

  #scrollsPanel(event: WheelEvent): boolean {
    for (const target of event.composedPath()) {
      if (target === this.#stage || target === this.#overlay) return false;
      if (!(target instanceof Element)) continue;
      const style = getComputedStyle(target);
      if (canScroll(target, style.overflowY, style.overflowX, event.deltaX, event.deltaY)) return true;
    }
    return false;
  }

  // ── Pointer ────────────────────────────────────────────────────────────────

  #down(editor: Editor, event: PointerEvent): void {
    if (event.pointerType === 'touch' && this.#touchDown(editor, event)) return;
    if (!this.#navigating(editor) || this.#gesture !== undefined) return;
    const point = this.#surfacePoint(event);
    if (point === null) return;
    // A field keeps the keyboard otherwise: the viewport's keys (F, Delete, the fly keys) need it.
    if (typing(document.activeElement)) (document.activeElement as HTMLElement).blur();
    const session = editor.session;
    const is2d = session.dimension === '2d';
    const fly = this.#cameraMode === 'fly' && !is2d;
    const start = { cx: event.clientX, cy: event.clientY, ox: event.clientX, oy: event.clientY };
    const capture = (): void => this.#overlay.setPointerCapture(event.pointerId);
    if (event.button === 0) {
      // The gizmo comes first, whatever the modifiers and the camera mode (none while read-only).
      if (editor.editing && editor.readOnly === null) {
        const handle = editor.run('Gizmo', () => session.handleAt(point.x, point.y, editor.gizmo.mode, editor.gizmo.space, GIZMO_PX)) ?? null;
        if (handle !== null) {
          const began = editor.run('Drag', () => { session.beginDrag(editor.gizmo.mode, handle, editor.gizmo.space, point.x, point.y); return true; });
          if (began === true) {
            capture();
            this.#gesture = { kind: 'gizmo' };
          }
          return;
        }
      }
      const modified = event.shiftKey || event.ctrlKey || event.metaKey;
      const click: Click = { x: point.x, y: point.y, additive: modified, deep: event.altKey && !modified };
      if (fly) {
        event.preventDefault();
        this.#gesture = { kind: 'look', button: 0, ...start, click };
        this.#lockPointer(); // pointer lock routes the pointer here; no capture needed
        return;
      }
      capture();
      if (event.shiftKey) {
        event.preventDefault();
        this.#gesture = { kind: 'pan', button: 0, ...start, click };
      } else if (event.ctrlKey || event.metaKey || event.altKey) {
        event.preventDefault();
        this.#gesture = { kind: is2d ? 'pan' : 'orbit', button: 0, ...start, click };
      } else {
        this.#gesture = { kind: 'select', click, ...start, moved: false };
      }
    } else if (event.button === 2) {
      this.#gesture = { kind: is2d ? 'pan' : fly ? 'look' : 'orbit', button: 2, ...start };
      if (fly) this.#lockPointer();
      else capture();
    } else if (event.button === 1) {
      event.preventDefault();
      // Fly mode has no middle-drag pan.
      if (fly) return;
      capture();
      this.#gesture = { kind: 'pan', button: 1, ...start };
    }
  }

  #lockPointer(): void {
    try {
      const done = this.#overlay.requestPointerLock() as unknown;
      if (done instanceof Promise) done.catch(() => { /* drags still work unlocked */ });
    } catch { /* unsupported */ }
  }

  #move(editor: Editor, event: PointerEvent): void {
    if (event.pointerType === 'touch' && this.#touchMove(editor, event)) return;
    if (!this.#navigating(editor)) return;
    const session = editor.session;
    const g = this.#gesture;
    if (g === undefined) {
      if (!editor.editing) return;
      const point = this.#surfacePoint(event);
      if (point === null) return;
      this.#hover = editor.run('Gizmo', () => session.handleAt(point.x, point.y, editor.gizmo.mode, editor.gizmo.space, GIZMO_PX)) ?? null;
      this.#overlay.style.cursor = this.#hover === null ? 'default' : 'grab';
      return;
    }
    switch (g.kind) {
      case 'gizmo': {
        const point = this.#surfacePoint(event);
        if (point === null) return;
        editor.run('Drag', () => session.dragTo(point.x, point.y, this.#snap(editor, event)));
        this.#overlay.style.cursor = 'grabbing';
        break;
      }
      case 'select': {
        const point = this.#surfacePoint(event);
        if (point === null) return;
        if (!g.moved && Math.hypot(event.clientX - g.ox, event.clientY - g.oy) > MARQUEE_SLOP) g.moved = true;
        this.#marquee = g.moved ? rectBetween(g.click.x, g.click.y, point.x, point.y) : null;
        break;
      }
      default: {
        const locked = document.pointerLockElement === this.#overlay;
        const dx = locked ? event.movementX : event.clientX - g.cx;
        const dy = locked ? event.movementY : event.clientY - g.cy;
        g.cx = event.clientX;
        g.cy = event.clientY;
        if (locked) { g.ox -= dx; g.oy -= dy; } // the drag's travel, for the click slop
        if (dx === 0 && dy === 0) break;
        const pose = session.cameraPose;
        if (g.kind === 'look') session.setCamera(look(pose, dx, dy));
        else if (g.kind === 'orbit') session.setCamera(orbit(pose, dx, dy, this.#distance));
        else session.setCamera(pan(pose, dx, dy, this.#panMetersPerPixel(editor, pose)));
        this.#overlay.style.cursor = g.kind === 'pan' ? 'move' : 'grabbing';
      }
    }
  }

  /** World meters per CSS pixel of a pan: 2D follows the pointer exactly; 3D scales with the pivot distance. */
  #panMetersPerPixel(editor: Editor, pose: CameraPose): number {
    const session = editor.session;
    if (session.dimension === '3d') return PAN_PER_PIXEL * this.#distance;
    const view = session.view();
    const canvas = this.#canvas();
    if (view === null || canvas === null) return 0;
    return view.pixelSize(pose.position) * (canvas.width / Math.max(1, canvas.clientWidth));
  }

  #up(editor: Editor, event: PointerEvent): void {
    if (event.pointerType === 'touch' && this.#touchEnd(event)) return;
    const g = this.#gesture;
    // pointerup comes once the last button is released, so it ends any gesture.
    if (g === undefined) return;
    this.#gesture = undefined;
    this.#overlay.style.cursor = 'default';
    this.#unlockPointer();
    if (!this.#navigating(editor)) return;
    const session = editor.session;
    if (g.kind === 'gizmo') {
      editor.run('Drag', () => session.endDrag(), 'world', 'selection');
      return;
    }
    if (g.kind === 'select') {
      const rect = this.#marquee;
      this.#marquee = null;
      if (g.moved && rect !== null) {
        // The marquee replaces the selection (Shift / Ctrl drags navigate instead).
        editor.select(editor.run('Select', () => session.pickIn(rect)) ?? []);
        return;
      }
      this.#clickSelect(editor, g.click);
      return;
    }
    // A modified (or fly-mode) left press that barely moved is a click.
    const travel = Math.hypot(event.clientX - g.ox, event.clientY - g.oy);
    if (g.click !== undefined && travel <= (event.pointerType === 'touch' ? TAP_SLOP : CLICK_SLOP)) this.#clickSelect(editor, g.click);
  }

  // ── Touch ──────────────────────────────────────────────────────────────────

  /** A finger lands: one finger navigates (or drags a handle), a second starts a pinch. True: handled. */
  #touchDown(editor: Editor, event: PointerEvent): boolean {
    if (!this.#navigating(editor)) return true;
    event.preventDefault();
    this.#touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    try {
      this.#overlay.setPointerCapture(event.pointerId);
    } catch {
      // Already released.
    }
    if (this.#touches.size === 2) {
      // The second finger turns whatever the first began into a pinch.
      if (this.#gesture?.kind === 'gizmo') editor.run('Drag', () => editor.session.cancelDrag(), 'world');
      this.#gesture = undefined;
      this.#marquee = null;
      this.#pinch = this.#spread();
      return true;
    }
    if (this.#touches.size > 2 || this.#touchSpent || this.#gesture !== undefined) return true;
    const point = this.#surfacePoint(event);
    if (point === null) return true;
    if (typing(document.activeElement)) (document.activeElement as HTMLElement).blur();
    const session = editor.session;
    if (editor.editing) {
      const handle = editor.run('Gizmo', () => session.handleAt(point.x, point.y, editor.gizmo.mode, editor.gizmo.space, GIZMO_PX * 1.4)) ?? null;
      if (handle !== null) {
        const began = editor.run('Drag', () => { session.beginDrag(editor.gizmo.mode, handle, editor.gizmo.space, point.x, point.y); return true; });
        if (began === true) this.#gesture = { kind: 'gizmo' };
        return true;
      }
    }
    const is2d = session.dimension === '2d';
    const kind = is2d ? 'pan' : this.#cameraMode === 'fly' ? 'look' : 'orbit';
    const click: Click = { x: point.x, y: point.y, additive: false, deep: false };
    this.#gesture = { kind, button: 0, cx: event.clientX, cy: event.clientY, ox: event.clientX, oy: event.clientY, click };
    return true;
  }

  /** A finger moves: two fingers pan and pinch-zoom; one goes through the usual drag. True: handled. */
  #touchMove(editor: Editor, event: PointerEvent): boolean {
    if (!this.#touches.has(event.pointerId)) return true;
    this.#touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.#pinch === undefined) return this.#gesture === undefined;
    if (!this.#navigating(editor)) return true;
    const next = this.#spread();
    if (next === undefined) return true;
    const session = editor.session;
    const dx = next.mx - this.#pinch.mx;
    const dy = next.my - this.#pinch.my;
    const deltaY = (this.#pinch.spread - next.spread) * PINCH_WHEEL;
    this.#pinch = next;
    if (dx !== 0 || dy !== 0) session.setCamera(pan(session.cameraPose, dx, dy, this.#panMetersPerPixel(editor, session.cameraPose)));
    if (deltaY === 0) return true;
    if (session.dimension === '2d') {
      const point = this.#surfacePoint({ clientX: next.mx, clientY: next.my });
      const view = session.view();
      if (point === null || view === null) return true;
      const at = view.ray(point.x, point.y).origin;
      session.setCamera(zoom2dWheel(session.cameraPose, deltaY, { x: at.x, y: at.y }));
    } else {
      const zoomed = zoomOrbit(session.cameraPose, this.#distance, deltaY);
      this.#distance = zoomed.distance;
      session.setCamera(zoomed.pose);
    }
    return true;
  }

  /** A finger lifts. True: handled here (a pinch, or a finger that started none); false: end the drag. */
  #touchEnd(event: PointerEvent): boolean {
    if (!this.#touches.delete(event.pointerId)) return true;
    if (this.#pinch !== undefined || this.#touchSpent) {
      if (this.#touches.size < 2) this.#pinch = undefined;
      this.#touchSpent = this.#touches.size > 0;
      return true;
    }
    return this.#touches.size > 0;
  }

  /** The two fingers' midpoint and distance (client px). */
  #spread(): { mx: number; my: number; spread: number } | undefined {
    const [a, b] = [...this.#touches.values()];
    if (a === undefined || b === undefined) return undefined;
    return { mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, spread: Math.hypot(a.x - b.x, a.y - b.y) };
  }

  /** The camera whose frustum (drawn last frame) passes under a surface point. */
  #frustumAt(x: number, y: number): EntityId | null {
    return nearestSegment(this.#frustums, x, y, FRUSTUM_HIT_PX * this.#frustumRatio);
  }

  #clickSelect(editor: Editor, click: Click): void {
    const session = editor.session;
    // Nothing drawn under the pointer: a camera's frustum lines (cameras draw nothing themselves).
    const id = editor.run('Select', () => session.pickAt(click.x, click.y, { deep: click.deep })) ?? this.#frustumAt(click.x, click.y);
    const current = session.selection;
    if (click.additive) {
      if (id === null) return;
      editor.select(current.includes(id) ? current.filter((c) => c !== id) : [...current, id]);
    } else if (id !== null && current.length === 1 && current[0] === id) {
      editor.select([]);
    } else {
      editor.select(id === null ? [] : [id]);
    }
  }

  #doubleClick(editor: Editor, event: MouseEvent): void {
    if (!this.#navigating(editor)) return;
    const point = this.#surfacePoint(event);
    // The two clicks before a double-click toggle the selection: frame what is under the pointer.
    const id = point === null ? null : editor.run('Select', () => editor.session.pickAt(point.x, point.y, { deep: event.altKey })) ?? this.#frustumAt(point.x, point.y);
    if (id !== null) editor.select([id]);
    this.frameSelection();
  }

  #unlockPointer(): void {
    if (document.pointerLockElement === this.#overlay) document.exitPointerLock();
  }

  #endCameraGesture(): void {
    this.#gesture = undefined;
    this.#overlay.style.cursor = 'default';
    this.#unlockPointer();
  }

  #cancel(editor: Editor): void {
    if (this.#gesture?.kind === 'gizmo') editor.run('Drag', () => editor.session.cancelDrag(), 'world');
    this.#gesture = undefined;
    this.#marquee = null;
    this.#overlay.style.cursor = 'default';
    this.#unlockPointer();
  }

  /** Escape during a drag puts the entity back. */
  cancelGesture(editor: Editor): boolean {
    if (this.#gesture === undefined) return false;
    this.#cancel(editor);
    return true;
  }

  #wheel(editor: Editor, event: WheelEvent): void {
    if (!this.#navigating(editor)) return;
    event.preventDefault();
    const session = editor.session;
    const deltaY = wheelPixels(event);
    if (deltaY === 0) return;
    if (session.dimension === '2d') {
      const point = this.#surfacePoint(event);
      const view = session.view();
      if (point === null || view === null) return;
      const at = view.ray(point.x, point.y).origin;
      session.setCamera(zoom2dWheel(session.cameraPose, deltaY, { x: at.x, y: at.y }));
      return;
    }
    if (this.#cameraMode === 'fly') {
      this.#flySpeed = flySpeedAfterWheel(this.#flySpeed, deltaY);
      return;
    }
    const zoomed = zoomOrbit(session.cameraPose, this.#distance, deltaY);
    this.#distance = zoomed.distance;
    session.setCamera(zoomed.pose);
  }

  #flyStep(editor: Editor, dt: number): void {
    if (dt === 0 || !this.#flyActive(editor) || this.#gesture?.kind === 'gizmo') return;
    const k = this.#keys;
    // The keys, plus the touch joystick (analog: a half push flies at half speed) and up / down.
    const touch = this.#touchFly.visible ? this.#touchFly.input : { x: 0, y: 0, z: 0 };
    const axis = (v: number): number => Math.max(-1, Math.min(1, v));
    const x = axis((k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0) + touch.x);
    const y = axis((k.has('KeyE') || k.has('Space') ? 1 : 0) - (k.has('KeyQ') || k.has('ControlLeft') || k.has('ControlRight') ? 1 : 0) + touch.y);
    const z = axis((k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0) + touch.z);
    if (x === 0 && y === 0 && z === 0) return;
    const pose = editor.session.cameraPose;
    const step = flyRate(this.#flySpeed, k.has('ShiftLeft') || k.has('ShiftRight'), pose.position.y) * dt;
    editor.session.setCamera(flyLevel(pose, x * step, y * step, z * step));
  }

  // ── Drawing ────────────────────────────────────────────────────────────────

  #draw(editor: Editor): void {
    const overlay = this.#overlay;
    const canvas = this.#canvas();
    if (canvas === null) return;
    if (overlay.width !== canvas.width || overlay.height !== canvas.height) {
      overlay.width = canvas.width;
      overlay.height = canvas.height;
    }
    const ctx = overlay.getContext('2d');
    if (ctx === null) return;
    ctx.clearRect(0, 0, overlay.width, overlay.height);
    this.#frustums = [];
    if (!this.#navigating(editor)) return;
    const session = editor.session;
    const ratio = canvas.width / Math.max(1, canvas.clientWidth);
    let view;
    try {
      view = session.view();
    } catch {
      return;
    }
    if (view === null) return;

    // Selection boxes: 2D always; 3D when the engine has no outline to draw them with (the
    // session outlines only the edit world, so the Scene tab boxes them too).
    const selection = session.selection;
    const outlined = editor.editing && session.dimension === '3d' && session.runtime.kernel.registry.components.has('outline');
    if (selection.length > 0 && !outlined) {
      const frame = drawnFrame(session.runtime);
      if (frame !== null) {
        const boxes = screenBoxes(frame, view);
        const ids = new Set(selection);
        const world = session.runtime.kernel.world;
        const visit = (id: EntityId): void => { ids.add(id); for (const c of world.get(id)?.children ?? []) visit(c); };
        for (const id of selection) visit(id);
        let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
        for (const [id, r] of boxes) {
          if (!ids.has(id)) continue;
          box = box === null ? { x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height }
            : { x0: Math.min(box.x0, r.x), y0: Math.min(box.y0, r.y), x1: Math.max(box.x1, r.x + r.width), y1: Math.max(box.y1, r.y + r.height) };
        }
        if (box !== null) {
          ctx.strokeStyle = '#ff9a1a';
          ctx.lineWidth = 1.5 * ratio;
          ctx.setLineDash([5 * ratio, 3 * ratio]);
          ctx.strokeRect(box.x0, box.y0, box.x1 - box.x0, box.y1 - box.y0);
          ctx.setLineDash([]);
        }
      }
    }

    this.#drawCameras(editor, ctx, view, ratio);

    const layout = editor.editing ? editor.run('Gizmo', () => session.gizmoLayout(editor.gizmo.mode, editor.gizmo.space, GIZMO_PX)) ?? null : null;
    if (layout !== null) {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const shape of layout.shapes) {
        const pts = shape.points;
        if (pts.length < 2) continue;
        const color = shape.handle === this.#hover ? HOVER : COLORS[shape.color];
        ctx.beginPath();
        ctx.moveTo(pts[0]!, pts[1]!);
        for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
        if (shape.closed) ctx.closePath();
        if (shape.closed && pts.length === 8) {
          ctx.globalAlpha = 0.35;
          ctx.fillStyle = color;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = (shape.handle === this.#hover ? 3.5 : 2.5) * ratio;
        ctx.stroke();
      }
    }

    if (this.#marquee !== null) {
      const m = this.#marquee;
      ctx.fillStyle = 'rgba(134, 72, 230, 0.15)';
      ctx.strokeStyle = 'rgba(134, 72, 230, 0.9)';
      ctx.lineWidth = ratio;
      ctx.fillRect(m.x, m.y, m.width, m.height);
      ctx.strokeRect(m.x, m.y, m.width, m.height);
    }
  }

  /**
   * Every game camera as a wireframe frustum (the one the view looks through excepted):
   * cameras draw nothing, so this is how they are seen and clicked. Selected ones are
   * orange and reach further ahead.
   */
  #drawCameras(editor: Editor, ctx: CanvasRenderingContext2D, view: NonNullable<ReturnType<Editor['session']['view']>>, ratio: number): void {
    const session = editor.session;
    const world = session.runtime.kernel.world;
    const selected = new Set(session.selection);
    this.#frustumRatio = ratio;
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    for (const record of world.live()) {
      const camera = record.components.get(CAMERA) as { readonly __view__?: FrustumCamera } | undefined;
      if (camera === undefined || record.id === view.camera || record.id === session.cameraEntity || record.id === this.#sceneCamera?.id) continue;
      if (session.isEditorHidden(record.id)) continue;
      let resolved: FrustumCamera | undefined;
      try {
        resolved = camera.__view__;
      } catch {
        continue;
      }
      if (resolved === undefined) continue;
      const on = selected.has(record.id);
      const world3d = frustumSegments(resolved, on ? FRUSTUM_SELECTED_LENGTH : FRUSTUM_LENGTH);
      // 2D views have no depth to clip against: project the end points as they are.
      const segments = view.dimension === '2d'
        ? world3d.flatMap(([a, b]) => {
          const pa = view.project(a);
          const pb = view.project(b);
          return pa === null || pb === null ? [] : [{ x0: pa.x, y0: pa.y, x1: pb.x, y1: pb.y }];
        })
        : screenSegments(view, world3d);
      if (segments.length === 0) continue;
      this.#frustums.push({ id: record.id, segments });
      ctx.strokeStyle = on ? '#ff9a1a' : 'rgba(220, 226, 240, 0.75)';
      ctx.lineWidth = (on ? 1.75 : 1.25) * ratio;
      ctx.beginPath();
      for (const s of segments) {
        ctx.moveTo(s.x0, s.y0);
        ctx.lineTo(s.x1, s.y1);
      }
      ctx.stroke();
    }
  }

  dispose(): void {
    cancelAnimationFrame(this.#frame);
  }
}

/** Fly mode's touch controls show on a touch-primary device or in the phone layout (`body.mobile`, mobile.ts). */
function touchFlyWanted(): boolean {
  return (globalThis.document?.body?.classList.contains('mobile') ?? false) || touchPrimary();
}

/** A touch-primary device (touch and a coarse pointer: a phone or tablet): no pointer lock there. */
function touchPrimary(): boolean {
  const touch = 'ontouchstart' in globalThis || (globalThis.navigator?.maxTouchPoints ?? 0) > 0;
  return touch && (globalThis.matchMedia?.('(pointer: coarse)')?.matches ?? false);
}

function typing(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
}

/** The pivot starts where the view meets the ground (y = 0) when it looks down at it, else 15 m ahead. */
function initialDistance(pose: CameraPose): number {
  const forward = pose.rotation.rotate(Vec3.FORWARD);
  if (forward.y < -0.05 && pose.position.y > 0) {
    return Math.max(ORBIT_DISTANCE.min, Math.min(500, pose.position.y / -forward.y));
  }
  return ORBIT_DISTANCE.initial;
}

function useCamera(runtime: Editor['session']['runtime'], id: EntityId): void {
  const camera = (runtime.ctx as unknown as { camera: { use(entity: unknown): void } }).camera;
  camera.use(runtime.wrap(id));
}

/** The Fullscreen API, with Safari's prefixed names; unavailable where an element can't go fullscreen (iPhone Safari). */
function fullscreenApi(): { available: boolean; element(): Element | null; request(el: HTMLElement): unknown; exit(): unknown } {
  const d = document as Document & { webkitFullscreenEnabled?: boolean; webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => void };
  const proto = HTMLElement.prototype as HTMLElement & { webkitRequestFullscreen?: () => void };
  const canRequest = typeof proto.requestFullscreen === 'function' || typeof proto.webkitRequestFullscreen === 'function';
  const canExit = typeof d.exitFullscreen === 'function' || typeof d.webkitExitFullscreen === 'function';
  return {
    available: canRequest && canExit && (d.fullscreenEnabled === true || d.webkitFullscreenEnabled === true),
    element: () => d.fullscreenElement ?? d.webkitFullscreenElement ?? null,
    request: (el) => {
      const e = el as HTMLElement & { webkitRequestFullscreen?: () => void };
      return typeof e.requestFullscreen === 'function' ? e.requestFullscreen() : e.webkitRequestFullscreen?.();
    },
    exit: () => (typeof d.exitFullscreen === 'function' ? d.exitFullscreen() : d.webkitExitFullscreen?.()),
  };
}
