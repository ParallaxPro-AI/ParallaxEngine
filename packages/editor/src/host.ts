/**
 * `EditorHost`: what a page that embeds the editor (a site serving it, a plugin) may change.
 * Panels in the right column, items on the top bar, its own Publish, tabs in the bottom panel,
 * Settings-menu entries, the logo's destination, renaming the project, a viewport-only chrome,
 * a read-only lock, the viewport's camera mode, and the editor's events.
 *
 *   import { whenEditorReady } from '@parallax/editor';
 *   whenEditorReady((host) => {
 *     host.mountSide(myPanel);                        // Properties move under the Hierarchy
 *     host.addToolbarItem({ id: 'help', slot: 'right', label: 'Help', onClick: openHelp });
 *     host.setPublishAction(() => openMyPublishForm());
 *     host.on('selection', ({ ids }) => console.log(ids));
 *   });
 *
 * The host is created once the editor has booted; `whenEditorReady` runs its callback then
 * (or at once, if it already has). The page also gets it as `globalThis.parallaxEditorHost`
 * and in the `parallax-editor-ready` event's `detail.host`.
 */

import type { EntityId } from '@parallax/runtime/core';
import type { SessionMode } from './session/index.js';
import type { BottomPanels } from './bottom_panels.js';
import { h } from './dom.js';
import type { Editor } from './editor.js';
import type { Banner, EditorChrome, EditorLayout } from './layout.js';
import type { BuildEvent } from './server_link.js';
import { LANGUAGES, language, onLanguageChange, setLanguage, t } from './i18n.js';
import type { CameraModeHost, SettingsEntry, Toolbar, ToolbarSlot } from './toolbar.js';
import type { CameraMode } from './camera_controls.js';
import type { LogoAction } from './logo.js';
import type { RenameAction } from './project_name.js';

export type { SettingsEntry, ToolbarSlot } from './toolbar.js';
export type { LogoAction } from './logo.js';
export type { RenameAction, RenameContext } from './project_name.js';
export type { Banner, BannerTone, EditorChrome } from './layout.js';
export type { BuildEvent } from './server_link.js';
export type { CameraMode } from './camera_controls.js';

const CAMERA_MODES: readonly CameraMode[] = ['orbit', 'fly'];

/** Undo what an `add…`/`on` call did. */
export type Disposer = () => void;

/** A top-bar item: an element of the host's own, or a button built from `label`. */
export interface ToolbarItem {
  readonly id: string;
  /** 'left': after the gizmo controls; 'right' (default): just before Publish. */
  readonly slot?: ToolbarSlot;
  /** Lower first within the slot (default 0). */
  readonly order?: number;
  readonly element?: HTMLElement;
  readonly label?: string;
  readonly title?: string;
  /** 'accent' tints the button with the editor's accent color. */
  readonly variant?: 'default' | 'accent';
  readonly onClick?: () => void;
}

/** A tab in the bottom panel, after Files / Asset Library / Performance. */
export interface BottomTab {
  readonly id: string;
  readonly label: string;
  readonly element: HTMLElement;
  /** The tab was shown / hidden (e.g. start or stop polling). */
  readonly onActivate?: () => void;
  readonly onDeactivate?: () => void;
}

/** What a Publish action gets: the editor (saved or not — call `editor.save()` if needed). */
export interface PublishContext {
  readonly editor: Editor;
  /** The project's name, as on the top bar. */
  readonly title: string;
}

/** Publish's action; while its promise runs, Publish shows busy and ignores clicks. */
export type PublishAction = (context: PublishContext) => void | Promise<void>;

/** The events a host can hear, and what each carries. Each fires only on an actual change. */
export interface EditorHostEvents {
  /** The selected entities changed. */
  readonly selection: { readonly ids: readonly EntityId[] };
  /** Edit / playing / paused. */
  readonly mode: { readonly mode: SessionMode };
  /** A save finished: the paths written (or removed), and whether anything was left unsaved. */
  readonly save: { readonly saved: readonly string[]; readonly failed: boolean };
  /** The set of unsaved documents changed. */
  readonly documents: { readonly dirty: readonly string[] };
  /** The scene being edited changed. */
  readonly scene: { readonly scene: string };
  /** The viewport's camera mode changed (the top bar's toggle, F, or `setCameraMode`). */
  readonly camera: { readonly mode: CameraMode };
  /** The side panel was shown or hidden (`setSideOpen`, `toggleSide`, or a phone's rotation). */
  readonly side: { readonly open: boolean };
  /** The editor's language changed (Settings, or `setLanguage`): a code from `languages`. */
  readonly language: { readonly language: string };
  /**
   * The server announced a build and the editor has taken it in (files changed outside, or a
   * rebuild): the event as the server sent it, any fields of its own included.
   */
  readonly build: BuildEvent;
}

export type EditorHostEvent = keyof EditorHostEvents;

export interface EditorHost {
  /** The API's version; additions keep it, a breaking change bumps it. */
  readonly apiVersion: 1;
  readonly editor: Editor;
  readonly layout: EditorLayout;
  /**
   * Put a panel in the right column (Properties move under the Hierarchy); null removes it.
   * On a phone it is the only panel, under the viewport (portrait) or in a sheet over it
   * (landscape, closed until opened): add a top-bar toggle for it with `toggleSide`.
   */
  mountSide(panel: HTMLElement | null): void;
  /**
   * Whether the side panel shows: the right column on a desktop; on a phone the panel under
   * the viewport (portrait) or the sheet (landscape).
   */
  readonly sideOpen: boolean;
  /** Show or hide the side panel (the viewport takes the space); fires `side` when it changes. */
  setSideOpen(open: boolean): void;
  /** Flip `sideOpen` (a host's top-bar toggle calls this); returns the new state. */
  toggleSide(): boolean;
  addToolbarItem(item: ToolbarItem): Disposer;
  /** Replace what Publish does; null restores the editor's default (publish via `parallax edit`). */
  setPublishAction(action: PublishAction | null): void;
  /** Run the current Publish action, as a click on Publish does. */
  publish(): Promise<void>;
  addBottomTab(tab: BottomTab): Disposer;
  /** Show a bottom tab: a host tab's id, or 'files' / 'library' / 'performance'. */
  showBottomTab(id: string): void;
  addSettingsEntry(entry: SettingsEntry): Disposer;
  /**
   * What the top bar's logo does: a link (`href`, same tab, asking before leaving unsaved
   * edits; modified clicks open a new tab) and/or a plain-click handler. Null restores the
   * default (the site's `home`, else the site in a new tab).
   */
  setLogoAction(action: LogoAction | null): void;
  /**
   * Make the project's name renamable: a click on it asks for a new name, `action` stores it
   * (a rejection is reported and the old name kept), then the editor shows it everywhere.
   * Null makes the name a label again (or the project menu, under `parallax edit`).
   */
  setRenameAction(action: RenameAction | null): void;
  /** Ask for a new name now, as a click on the name does (false: no rename action, cancelled or failed). */
  renameProject(): Promise<boolean>;
  /** 'viewport-only': hide the top bar, hierarchy, properties, bottom panels and phone tabs; 'full' (default) shows them. */
  setChrome(chrome: EditorChrome): void;
  /**
   * Lock editing (e.g. while another tool writes the project) or unlock it. Locked: a
   * full-width banner under the top bar shows `reason` (default "Read-only") in `look`'s tone,
   * with `look.element` after it; every edit is refused, saves wait; selecting, looking around
   * and Play still work, and files changed outside (`build` events) are taken in place even
   * over unsaved edits.
   */
  setReadOnly(locked: boolean, reason?: string, look?: Pick<Banner, 'tone' | 'element'>): void;
  /**
   * Show a banner of the host's own under the top bar (a connection problem, a notice), or
   * replace the one under `id`; null removes it. They stack under the read-only banner.
   */
  setBanner(id: string, banner: Banner | null): void;
  /**
   * The viewport's camera: 'orbit' (default; orbit, pan and zoom about a pivot) or 'fly'
   * (W A S D and mouse-look), as the top bar's Orbit / Fly toggle sets it. Fly applies in a
   * 3D scene; a 2D scene's camera pans and zooms in either mode.
   */
  readonly cameraMode: CameraMode;
  /** Set the camera mode, as a click on the top bar's toggle does (fires `camera` when it changes). */
  setCameraMode(mode: CameraMode): void;
  /** The editor's language, a code from `languages` ('en', 'zh-CN', 'pt-BR', ...). */
  readonly language: string;
  /** The languages the editor offers: a code and its own name for itself. */
  readonly languages: readonly { readonly code: string; readonly label: string }[];
  /** Switch the language (kept for the next visit), as Settings does; an unknown code is ignored. Fires `language`. */
  setLanguage(code: string): void;
  on<E extends EditorHostEvent>(event: E, listener: (detail: EditorHostEvents[E]) => void): Disposer;
}

/** The editor state the event bridge reads (an `Editor` has it; tests pass a fake). */
export interface EditorEventSource {
  on(listener: (changes: ReadonlySet<string>) => void): () => void;
  readonly saving: boolean;
  readonly session: {
    readonly selection: readonly EntityId[];
    readonly mode: SessionMode;
    readonly scene: string;
    readonly documents: { dirty(): readonly string[] };
  };
}

/**
 * Turns the editor's coarse change sets into the host's events, firing each only when its
 * value actually changed. A save is the `saving` flag going back down: what was dirty when it
 * started and is clean now was saved.
 */
export class HostEvents {
  readonly #listeners = new Map<EditorHostEvent, Set<(detail: never) => void>>();
  #selection: string;
  #mode: SessionMode;
  #scene: string;
  #dirty: string;
  #saving: boolean;
  #camera: CameraMode | undefined;
  #dirtyAtSave: readonly string[] = [];
  readonly #stop: () => void;

  /** `camera`: the viewport (its mode changes announce themselves as editor changes). */
  constructor(readonly source: EditorEventSource, readonly camera?: Pick<CameraModeHost, 'cameraMode'>) {
    const s = source.session;
    this.#camera = camera?.cameraMode;
    this.#selection = s.selection.join('\u0000');
    this.#mode = s.mode;
    this.#scene = s.scene;
    this.#dirty = [...s.documents.dirty()].sort().join('\u0000');
    this.#saving = source.saving;
    this.#stop = source.on(() => this.#check());
  }

  on<E extends EditorHostEvent>(event: E, listener: (detail: EditorHostEvents[E]) => void): Disposer {
    let set = this.#listeners.get(event);
    if (set === undefined) this.#listeners.set(event, set = new Set());
    set.add(listener as (detail: never) => void);
    return () => { set.delete(listener as (detail: never) => void); };
  }

  dispose(): void {
    this.#stop();
    this.#listeners.clear();
  }

  /** Fire an event that doesn't come from the editor's change sets (e.g. `side`, from the layout). */
  announce<E extends EditorHostEvent>(event: E, detail: EditorHostEvents[E]): void {
    this.#emit(event, detail);
  }

  #emit<E extends EditorHostEvent>(event: E, detail: EditorHostEvents[E]): void {
    for (const listener of this.#listeners.get(event) ?? []) {
      try {
        (listener as (d: EditorHostEvents[E]) => void)(detail);
      } catch (error) {
        console.error(`Parallax editor: a host's "${event}" listener threw`, error);
      }
    }
  }

  #check(): void {
    const s = this.source.session;
    const selection = s.selection.join('\u0000');
    if (selection !== this.#selection) {
      this.#selection = selection;
      this.#emit('selection', { ids: [...s.selection] });
    }
    if (s.mode !== this.#mode) {
      this.#mode = s.mode;
      this.#emit('mode', { mode: s.mode });
    }
    if (s.scene !== this.#scene) {
      this.#scene = s.scene;
      this.#emit('scene', { scene: s.scene });
    }
    const camera = this.camera?.cameraMode;
    if (camera !== undefined && camera !== this.#camera) {
      this.#camera = camera;
      this.#emit('camera', { mode: camera });
    }
    const dirtyList = [...s.documents.dirty()].sort();
    const saving = this.source.saving;
    if (saving && !this.#saving) this.#dirtyAtSave = dirtyList;
    const dirty = dirtyList.join('\u0000');
    if (dirty !== this.#dirty) {
      this.#dirty = dirty;
      this.#emit('documents', { dirty: dirtyList });
    }
    if (!saving && this.#saving) {
      const still = new Set(dirtyList);
      this.#emit('save', { saved: this.#dirtyAtSave.filter((p) => !still.has(p)), failed: this.#dirtyAtSave.some((p) => still.has(p)) });
      this.#dirtyAtSave = [];
    }
    this.#saving = saving;
  }
}

export interface HostParts {
  readonly editor: Editor;
  readonly layout: EditorLayout;
  readonly toolbar: Toolbar;
  readonly bottom: BottomPanels;
  /** The editor's own Publish (`setPublishAction(null)` comes back to it). */
  readonly defaultPublish: PublishAction;
  /** The viewport's camera mode (absent: the viewport has none, and it stays 'orbit'). */
  readonly camera?: CameraModeHost;
  /** Hear the builds the editor has taken in (for the `build` event). Returns a remover. */
  readonly onBuild?: (listener: (event: BuildEvent) => void) => () => void;
}

/** Built by `bootEditor`; a host gets it from `whenEditorReady`. */
export function createEditorHost(parts: HostParts): EditorHost {
  const { editor, layout, toolbar, bottom, camera } = parts;
  const events = new HostEvents(editor as unknown as EditorEventSource, camera);
  let action: PublishAction = parts.defaultPublish;
  let running: Promise<void> | undefined;

  const publish = (): Promise<void> => {
    if (running !== undefined) return running;
    toolbar.setPublishBusy(true);
    running = (async () => {
      try {
        await action({ editor, title: editor.title });
      } catch (error) {
        editor.fail('Publish', error);
      } finally {
        running = undefined;
        toolbar.setPublishBusy(false);
      }
    })();
    return running;
  };
  toolbar.setPublishAction(() => void publish());

  onLanguageChange(() => events.announce('language', { language: language() }));
  parts.onBuild?.((event) => events.announce('build', event));

  // The layout's panels: a host hears `side` only when their open state actually changes.
  let sideOpen = layout.panelsOpen;
  layout.onPanelsChange(() => {
    const open = layout.panelsOpen;
    if (open === sideOpen) return;
    sideOpen = open;
    events.announce('side', { open });
  });

  // Host tabs live beside BottomPanels' own: showing one first shows 'files' (so the active
  // built-in tab deactivates), then takes over the tab bar; a click on a built-in tab hides ours.
  const tabBar = bottom.el.querySelector<HTMLElement>('.panel-tabs');
  const bodies = bottom.el.querySelector<HTMLElement>('.panel-tab-bodies');
  const tabs = new Map<string, { tab: HTMLButtonElement; body: HTMLElement; spec: BottomTab }>();
  let activeTab: string | undefined;
  const hideHostTab = (): void => {
    if (activeTab === undefined) return;
    const current = tabs.get(activeTab);
    activeTab = undefined;
    if (current === undefined) return;
    current.tab.classList.remove('active');
    current.body.hidden = true;
    current.spec.onDeactivate?.();
  };
  tabBar?.addEventListener('click', (event) => {
    const tab = (event.target as Element | null)?.closest?.('.panel-tab');
    if (tab !== null && tab !== undefined && !(tab as HTMLElement).dataset['hostTab']) hideHostTab();
  }, true);
  const showBottomTab = (id: string): void => {
    const mine = tabs.get(id);
    if (mine === undefined) {
      hideHostTab();
      if (id === 'files' || id === 'library' || id === 'performance') bottom.show(id);
      return;
    }
    if (activeTab === id) return;
    hideHostTab();
    bottom.show('files');
    for (const el of tabBar?.children ?? []) el.classList.remove('active');
    for (const el of bodies?.children ?? []) (el as HTMLElement).hidden = true;
    mine.tab.classList.add('active');
    mine.body.hidden = false;
    activeTab = id;
    mine.spec.onActivate?.();
  };

  return {
    apiVersion: 1,
    editor,
    layout,
    get cameraMode(): CameraMode {
      return camera?.cameraMode ?? 'orbit';
    },
    get language(): string {
      return language();
    },
    languages: LANGUAGES,
    setLanguage: (code) => setLanguage(code),
    setCameraMode: (mode) => {
      if (!CAMERA_MODES.includes(mode)) throw new TypeError(`setCameraMode takes 'orbit' or 'fly', not ${JSON.stringify(mode)}`);
      camera?.setCameraMode(mode);
    },
    mountSide: (panel) => layout.mountSide(panel),
    get sideOpen(): boolean {
      return layout.panelsOpen;
    },
    setSideOpen: (open) => layout.setPanelsOpen(open),
    toggleSide: () => layout.togglePanels(),
    addToolbarItem: (item) => {
      const el = item.element ?? h(`button.toolbar-btn${item.variant === 'accent' ? '.host-accent' : ''}`, {
        type: 'button', text: item.label ?? item.id,
        ...(item.title !== undefined && { title: item.title, 'aria-label': item.title }),
        ...(item.onClick !== undefined && { onclick: () => item.onClick!() }),
      });
      el.dataset['hostItem'] = item.id;
      return toolbar.addItem(item.slot ?? 'right', el, item.order ?? 0);
    },
    setPublishAction: (next) => { action = next ?? parts.defaultPublish; },
    publish,
    addBottomTab: (spec) => {
      if (tabBar === null || bodies === null) throw new Error('The bottom panel has no tab bar');
      if (tabs.has(spec.id) || ['files', 'library', 'performance'].includes(spec.id)) throw new Error(`A bottom tab "${spec.id}" already exists`);
      const tab = h('button.panel-tab', { type: 'button', text: spec.label, onclick: () => showBottomTab(spec.id) });
      tab.dataset['hostTab'] = spec.id;
      const body = h('div.tab-body', { hidden: true }, spec.element);
      tabBar.append(tab);
      bodies.append(body);
      tabs.set(spec.id, { tab, body, spec });
      return () => {
        if (activeTab === spec.id) {
          hideHostTab();
          bottom.show('files');
        }
        tab.remove();
        body.remove();
        tabs.delete(spec.id);
      };
    },
    showBottomTab,
    addSettingsEntry: (entry) => toolbar.addSettingsEntry(entry),
    setLogoAction: (logo) => toolbar.setLogoAction(logo),
    setRenameAction: (rename) => toolbar.setRenameAction(rename),
    renameProject: () => toolbar.renameProject(),
    setChrome: (chrome) => layout.setChrome(chrome),
    setReadOnly: (locked, reason, look) => {
      const text = locked ? reason ?? t('editor.readOnly') : null;
      editor.setReadOnly(text);
      layout.setReadOnly(text, look);
    },
    setBanner: (id, banner) => layout.setBanner(id, banner),
    on: (event, listener) => events.on(event, listener),
  };
}

type HostGlobal = { parallaxEditorHost?: EditorHost };

/**
 * Run `callback` with the editor's host once it has booted (at once if it already has).
 * Returns a function that cancels a callback still waiting.
 */
export function whenEditorReady(callback: (host: EditorHost) => void): Disposer {
  const ready = (globalThis as HostGlobal).parallaxEditorHost;
  if (ready !== undefined) {
    callback(ready);
    return () => {};
  }
  const listener = (event: Event): void => {
    const host = (event as CustomEvent<{ host?: EditorHost }>).detail?.host;
    if (host === undefined) return;
    globalThis.removeEventListener('parallax-editor-ready', listener);
    callback(host);
  };
  globalThis.addEventListener('parallax-editor-ready', listener);
  return () => globalThis.removeEventListener('parallax-editor-ready', listener);
}
