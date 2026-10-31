/**
 * The top bar: the logo, the project (a switcher between
 * the projects next to this one), Save / Undo / Redo, the gizmo (Move / Rotate / Scale, the
 * camera's Orbit or Fly mode, Global or Local space), Play (Stop while playing), Publish and
 * Settings (language, graphics quality) on the right.
 *
 * A host page extends it through `EditorHost` (host.ts): items in the left slot (after the
 * gizmo controls) or the right slot (before Publish), its own Publish action, and entries at
 * the end of the Settings dialog (a modal).
 */

import { currentSite } from './site.js';
import type { Editor } from './editor.js';
import { projectLabel } from './editor.js';
import { clear, h, icon } from './dom.js';
import { LANGUAGES, language, onLanguageChange, setLanguage, t } from './i18n.js';
import { applyQuality, QUALITIES, savedQuality, saveQuality } from './settings.js';
import { ProjectSwitcher } from './project_switcher.js';
import { logoClickPlan } from './logo.js';
import type { LogoAction } from './logo.js';
import { promptProjectName, renameProject } from './project_name.js';
import type { RenameAction } from './project_name.js';
import { showToast } from './toast.js';
import { showModal } from './modal.js';
import { urlQuality } from './quality_override.js';
import type { Modal } from './modal.js';
import type { GraphicsQuality } from './settings.js';
import type { GizmoMode } from './session/index.js';

const MODES: readonly { mode: GizmoMode; icon: 'move' | 'rotate' | 'scale'; label: string; title: string }[] = [
  { mode: 'translate', icon: 'move', label: 'toolbar.moveLabel', title: 'toolbar.translate' },
  { mode: 'rotate', icon: 'rotate', label: 'toolbar.rotateLabel', title: 'toolbar.rotate' },
  { mode: 'scale', icon: 'scale', label: 'toolbar.scaleLabel', title: 'toolbar.scale' },
];

/** The camera mode the viewport exposes (orbit around a point, or fly with WASD). */
export interface CameraModeHost {
  readonly cameraMode: 'orbit' | 'fly';
  setCameraMode(mode: 'orbit' | 'fly'): void;
}

/** Where a host's toolbar item goes: after the gizmo controls, or just before Publish. */
export type ToolbarSlot = 'left' | 'right';

/** An entry a host adds to the end of the Settings dialog: a button, or its own element. */
export interface SettingsEntry {
  readonly id: string;
  /** The button's text (ignored with `render`). */
  readonly label?: string;
  readonly onClick?: () => void;
  /** Build the entry's element each time the dialog opens (e.g. a select bound to host state). */
  readonly render?: () => HTMLElement;
}

function button(name: Parameters<typeof icon>[0], onclick: () => void, extra = ''): HTMLButtonElement {
  return h(`button.toolbar-btn${extra}`, { type: 'button', onclick: () => onclick() }, icon(name));
}

/** Set a toolbar button's icon, label and tooltip. */
function dress(el: HTMLButtonElement, name: Parameters<typeof icon>[0], label: string | null, title: string): void {
  el.replaceChildren(icon(name), ...(label === null ? [] : [h('span', { text: label })]));
  el.title = title;
  el.setAttribute('aria-label', title);
}

/** What the top bar needs to know besides the editor. */
export interface ToolbarOptions {
  /** The project menu under the name (`parallax edit`'s sibling projects); default true. */
  readonly projectSwitcher?: boolean;
}

/**
 * The top bar's logo: the site's image (site.ts), the built-in one (styles.css), or none. A
 * link (logo.ts): to the site in a new tab by default, or where a host's `LogoAction` says.
 */
class SiteLogo {
  readonly el: HTMLAnchorElement;
  #action: LogoAction | null = null;

  constructor(private readonly dirty: () => number, private readonly context: () => Parameters<NonNullable<LogoAction['onClick']>>[0] | undefined) {
    const site = currentSite();
    this.el = h('a.toolbar-logo', { role: 'link' });
    if (site.logo === null) this.el.hidden = true;
    else if (site.logo !== undefined) this.el.style.backgroundImage = `url(${JSON.stringify(site.logo)})`;
    this.el.addEventListener('click', (event) => this.#click(event));
    this.set(null);
  }

  /**
   * A host's destination, or null for the default: the site's `home` (site.ts) as a link in
   * this tab, or without one, `https://<site.host>/` in a new tab.
   */
  set(action: LogoAction | null): void {
    const site = currentSite();
    const fallback = action === null && site.home === undefined;
    this.#action = action ?? (typeof site.home === 'string' ? { href: site.home } : null);
    const title = action?.title ?? site.name;
    const href = fallback ? `https://${site.host}/` : this.#action?.href ?? null;
    if (href === null) this.el.removeAttribute('href');
    else this.el.setAttribute('href', href);
    if (fallback) {
      this.el.target = '_blank';
      this.el.rel = 'noopener';
    } else {
      this.el.removeAttribute('target');
      this.el.removeAttribute('rel');
    }
    this.el.title = title;
    this.el.setAttribute('aria-label', title);
  }

  #click(event: MouseEvent): void {
    const action = this.#action;
    const plan = logoClickPlan(event, action);
    if (plan === 'native') return;
    event.preventDefault();
    if (plan === 'run') {
      const context = this.context();
      if (context !== undefined) action!.onClick!(context);
      return;
    }
    if (plan !== 'navigate') return;
    if (this.dirty() > 0 && !confirm(t('toolbar.unsavedConfirm'))) return;
    location.href = action!.href!;
  }
}

export class Toolbar {
  readonly el: HTMLElement;
  readonly #editor: Editor;
  readonly #camera: CameraModeHost | undefined;
  readonly #project: ProjectSwitcher;
  readonly #logo: SiteLogo;
  #rename: RenameAction | null = null;
  #renaming = false;
  readonly #save: HTMLButtonElement;
  readonly #undo: HTMLButtonElement;
  readonly #redo: HTMLButtonElement;
  readonly #modes: Map<GizmoMode, HTMLButtonElement>;
  readonly #orbit: HTMLButtonElement;
  readonly #space: HTMLButtonElement;
  /** The phone bar's panels toggle (`setPanelsToggle`): shown only while it has something to toggle. */
  readonly #panels: HTMLButtonElement;
  #panelsAction: (() => void) | null = null;
  readonly #play: HTMLButtonElement;
  readonly #publish: HTMLButtonElement;
  readonly #gear: HTMLButtonElement;
  /** The phone bar's ⋮: what the compact bar has no room for (an overflow menu). */
  readonly #more: HTMLButtonElement;
  readonly #moreMenu: HTMLElement;
  readonly #moreItems: Record<'save' | 'undo' | 'redo' | 'space' | 'settings', HTMLButtonElement>;
  #settings: Modal | undefined;
  readonly #slots: Record<ToolbarSlot, HTMLElement>;
  readonly #settingsEntries: SettingsEntry[] = [];
  #onPublish: () => void = () => {};
  #publishBusy = false;

  constructor(editor: Editor, camera?: CameraModeHost, options: ToolbarOptions = {}) {
    this.#editor = editor;
    this.#camera = camera;
    this.#project = new ProjectSwitcher(editor.title, {
      dirty: () => editor.documents.dirty().length,
      discard: () => editor.documents.markSaved(editor.documents.dirty()),
      error: (text) => editor.write('error', text),
    }, { menu: options.projectSwitcher ?? true });
    this.#logo = new SiteLogo(() => editor.documents.dirty().length, () => ({ editor }));

    this.#save = button('save', () => void editor.save());
    this.#undo = button('undo', () => editor.undo());
    this.#redo = button('redo', () => editor.redo());
    this.#modes = new Map(MODES.map((m) => [m.mode, button(m.icon, () => {
      editor.gizmo.mode = m.mode;
      editor.emit('gizmo');
    })]));
    // On a phone the Orbit / Fly toggle stays on the bar, with its label.
    this.#orbit = button('orbit', () => {
      if (camera === undefined) return;
      camera.setCameraMode(camera.cameraMode === 'orbit' ? 'fly' : 'orbit');
      editor.emit('gizmo');
    }, '.toolbar-orbit.keep-label');
    this.#space = button('globe', () => {
      editor.gizmo.space = editor.gizmo.space === 'world' ? 'local' : 'world';
      editor.emit('gizmo');
    }, '.toolbar-space');
    this.#panels = button('panels', () => this.#panelsAction?.(), '.toolbar-panels');
    this.#panels.hidden = true;
    this.#play = button('play', () => { if (editor.editing) editor.play(); else editor.stop(); }, '.play-btn');
    this.#publish = h('button.toolbar-btn.publish-btn', { type: 'button', onclick: () => { if (!this.#publishBusy) this.#onPublish(); } });
    this.#gear = h('button.toolbar-btn', {
      type: 'button', onclick: (event: Event) => { event.stopPropagation(); this.#toggleSettings(); },
    }, icon('gear'));
    const entry = (name: Parameters<typeof icon>[0], run: () => void): HTMLButtonElement => {
      const el = h('button.toolbar-overflow-item', { type: 'button', role: 'menuitem' }, icon(name), h('span'));
      el.addEventListener('click', (event) => {
        event.stopPropagation();
        if (el.classList.contains('disabled')) return;
        this.#moreMenu.hidden = true;
        run();
      });
      return el;
    };
    this.#moreItems = {
      save: entry('save', () => void editor.save()),
      undo: entry('undo', () => editor.undo()),
      redo: entry('redo', () => editor.redo()),
      space: entry('globe', () => this.#space.click()),
      settings: entry('gear', () => this.#toggleSettings()),
    };
    const rule = (): HTMLElement => h('div.toolbar-overflow-divider');
    this.#moreMenu = h('div.toolbar-overflow-menu', { hidden: true, role: 'menu', onclick: (event: Event) => event.stopPropagation() },
      this.#moreItems.save, this.#moreItems.undo, this.#moreItems.redo, rule(), this.#moreItems.space, rule(), this.#moreItems.settings);
    this.#more = h('button.toolbar-btn.toolbar-overflow-btn', {
      type: 'button', 'aria-haspopup': 'menu',
      onclick: (event: Event) => { event.stopPropagation(); this.#project.close(); this.#moreMenu.hidden = !this.#moreMenu.hidden; },
    }, icon('more'));
    document.addEventListener('click', () => { this.#moreMenu.hidden = true; });
    this.#slots = {
      left: h('div.toolbar-group.toolbar-slot.left', { hidden: true }),
      right: h('div.toolbar-group.toolbar-slot.right', { hidden: true }),
    };

    this.el = h('div.toolbar', {},
      this.#logo.el,
      this.#project.el,
      h('span.toolbar-divider'),
      h('div.toolbar-group.toolbar-history', {}, this.#save, this.#undo, this.#redo),
      h('span.toolbar-divider'),
      h('div.toolbar-group.toolbar-modes', {}, ...this.#modes.values()),
      h('span.toolbar-divider'),
      h('div.toolbar-group.toolbar-camera', {}, this.#orbit, this.#space),
      this.#slots.left,
      h('span.toolbar-spacer'),
      // A host's right-slot items sit before Play: Play and Publish close the bar.
      this.#slots.right,
      h('div.toolbar-group', {}, this.#play),
      h('span.toolbar-divider'),
      this.#panels,
      h('div.toolbar-group', {}, this.#publish),
      h('div.toolbar-settings', {}, this.#gear),
      h('div.toolbar-overflow', {}, this.#more, this.#moreMenu),
    );
    editor.on((changes) => {
      if (changes.has('mode')) applyQuality(editor);
      if (changes.has('title')) this.#project.setTitle(editor.title);
      if (changes.has('log') && changes.size === 1) return;
      this.update();
    });
    onLanguageChange(() => {
      this.update();
      // The open dialog follows the language it was just switched to.
      if (this.#settings !== undefined) this.#fillSettings(this.#settings);
    });
    applyQuality(editor);
    this.update();
  }

  /** What Publish does (the editor's default, or a host's replacement). */
  setPublishAction(action: () => void): void {
    this.#onPublish = action;
  }

  /** What the logo does (logo.ts); null: the default link to the site. */
  setLogoAction(action: LogoAction | null): void {
    this.#logo.set(action);
  }

  /**
   * Make the project name renamable through `action` (project_name.ts), or not (null). A
   * click on the name then asks for the new one.
   */
  setRenameAction(action: RenameAction | null): void {
    this.#rename = action;
    this.#project.setRename(action === null ? null : () => void this.renameProject());
  }

  /** Ask for a new name and rename the project (a click on the name does this). */
  async renameProject(): Promise<boolean> {
    const action = this.#rename;
    if (action === null || this.#renaming) return false;
    this.#renaming = true;
    try {
      const name = await promptProjectName(this.#editor.title);
      const renamed = await renameProject(this.#editor, name, action, this.#editor);
      if (renamed) showToast(t('toolbar.projectRenamed'), 'success');
      return renamed;
    } finally {
      this.#renaming = false;
    }
  }

  /** Publish shows it is working (and ignores clicks) while `busy`. */
  setPublishBusy(busy: boolean): void {
    this.#publishBusy = busy;
    this.#publish.classList.toggle('busy', busy);
    this.#publish.setAttribute('aria-busy', String(busy));
  }

  /**
   * The phone bar's panels toggle: `action` runs on a click; `visible` shows the button and
   * `open` highlights it (the layout's panels are showing). Null `action` hides it.
   */
  setPanelsToggle(action: (() => void) | null, visible = action !== null, open = false): void {
    this.#panelsAction = action;
    this.#panels.hidden = action === null || !visible;
    this.#panels.classList.toggle('active', open);
    this.#panels.setAttribute('aria-pressed', String(open));
  }

  /** Put a host's element in a slot, ordered by `order` (lower first); returns a remover. */
  addItem(slot: ToolbarSlot, el: HTMLElement, order = 0): () => void {
    const host = this.#slots[slot];
    el.dataset['order'] = String(order);
    const after = [...host.children].find((c) => Number((c as HTMLElement).dataset['order'] ?? 0) > order);
    host.insertBefore(el, after ?? null);
    host.hidden = false;
    return () => {
      el.remove();
      host.hidden = host.childElementCount === 0;
    };
  }

  /** Add an entry at the end of the Settings dialog; returns a remover. */
  addSettingsEntry(entry: SettingsEntry): () => void {
    this.#settingsEntries.push(entry);
    return () => {
      const at = this.#settingsEntries.indexOf(entry);
      if (at >= 0) this.#settingsEntries.splice(at, 1);
    };
  }

  /** Close the Settings dialog (a host entry that opens its own UI calls this). */
  closeSettings(): void {
    this.#settings?.close();
  }

  /** Whether the Settings dialog is open. */
  get settingsOpen(): boolean {
    return this.#settings !== undefined;
  }

  #toggleSettings(): void {
    this.#project.close();
    this.#moreMenu.hidden = true;
    if (this.#settings !== undefined) {
      this.closeSettings();
      return;
    }
    const modal = showModal({ title: t('toolbar.settings'), className: 'settings-modal', width: '400px', closeLabel: t('settings.close'), onClose: () => { this.#settings = undefined; } });
    this.#settings = modal;
    this.#fillSettings(modal);
    (modal.body.querySelector('select') as HTMLSelectElement | null)?.focus();
  }

  /** The dialog's rows: Language, Graphics Quality, then the host's entries. */
  #fillSettings(modal: Modal): void {
    modal.setTitle(t('toolbar.settings'));
    clear(modal.body);
    // Each choice applies at once (the language re-renders the editor in place).
    const languages = h('select.settings-select', {
      id: 'settings-language',
      onchange: () => setLanguage(languages.value),
    }, ...LANGUAGES.map((l) => h('option', { value: l.code, text: l.label, selected: l.code === language() })));
    const quality = h('select.settings-select', {
      id: 'settings-quality',
      onchange: () => {
        const value = quality.value as GraphicsQuality;
        saveQuality(value);
        applyQuality(this.#editor, value);
      },
    }, ...QUALITIES.map((q) => h('option', {
      // A `?quality=` override is what this page runs at, so it shows as the choice.
      value: q, selected: q === (urlQuality() ?? savedQuality()),
      text: q === 'auto' ? t('settings.qualityAuto') : t(`settings.quality${q[0]!.toUpperCase()}${q.slice(1)}`),
    })));
    modal.body.append(
      h('div.settings-row', {}, h('label.settings-label', { for: 'settings-language', text: t('settings.language') }), languages),
      h('div.settings-row', {}, h('label.settings-label', { for: 'settings-quality', text: t('settings.graphicsQuality') }), quality),
    );
    for (const entry of this.#settingsEntries) {
      modal.body.append(entry.render?.() ?? h('button.settings-entry', {
        type: 'button', text: entry.label ?? entry.id,
        onclick: () => { this.closeSettings(); entry.onClick?.(); },
      }));
    }
  }

  update(): void {
    const editor = this.#editor;
    const session = editor.session;
    const editing = session.mode === 'edit';

    dress(this.#save, 'save', t('settings.save'), t('toolbar.save'));
    dress(this.#undo, 'undo', null, t('toolbar.undo'));
    dress(this.#redo, 'redo', null, t('toolbar.redo'));
    // The label on a desktop bar; a phone bar shows the upload icon alone (styles.css).
    this.#publish.replaceChildren(icon('upload'), h('span', { text: t('toolbar.publish') }));
    this.#publish.title = t('toolbar.publish');
    this.#publish.setAttribute('aria-label', t('toolbar.publish'));
    this.#gear.title = t('toolbar.settings');
    this.#gear.setAttribute('aria-label', t('toolbar.settings'));

    const dirty = session.documents.dirty().length;
    this.#project.setLabel(projectLabel(editor.title, editor.dirty));
    // Read-only (a host's lock): nothing to save, undo or redo until it lifts.
    const writable = editing && editor.readOnly === null;
    this.#save.classList.toggle('disabled', !writable || dirty === 0 || editor.saving);
    this.#save.classList.toggle('dirty', dirty > 0);
    this.#undo.classList.toggle('disabled', !writable || !session.history.canUndo);
    this.#redo.classList.toggle('disabled', !writable || !session.history.canRedo);

    for (const m of MODES) {
      const el = this.#modes.get(m.mode)!;
      dress(el, m.icon, t(m.label), t(m.title));
      el.classList.toggle('active', editor.gizmo.mode === m.mode);
      el.classList.toggle('disabled', !editing);
    }
    const fly = this.#camera?.cameraMode === 'fly';
    dress(this.#orbit, 'orbit', t(fly ? 'toolbar.flyLabel' : 'toolbar.orbitLabel'), t(fly ? 'toolbar.flyMode' : 'toolbar.orbitMode'));
    this.#orbit.classList.toggle('active', fly);
    this.#orbit.hidden = this.#camera === undefined;
    const world = editor.gizmo.space === 'world';
    // Global is the default; Local is the toggled state, highlighted as Fly is.
    dress(this.#space, world ? 'globe' : 'box', t(world ? 'toolbar.globalLabel' : 'toolbar.localLabel'), t(world ? 'toolbar.globalSpace' : 'toolbar.localSpace'));
    this.#space.classList.toggle('active', !world);
    this.#space.classList.toggle('disabled', !editing);
    dress(this.#panels, 'panels', null, t('mobile.panels'));

    dress(this.#play, editing ? 'play' : 'stop', t(editing ? 'toolbar.play' : 'toolbar.stop'), editing ? t('toolbar.playCtrlP') : `${t('toolbar.stop')} (Ctrl+P)`);
    this.#play.classList.toggle('play-btn', editing);
    this.#play.classList.toggle('stop-btn', !editing);
    document.body.dataset['mode'] = session.mode;

    const more = this.#moreItems;
    const label = (el: HTMLButtonElement, text: string): void => { el.querySelector('span')!.textContent = text; };
    label(more.save, t('settings.save'));
    label(more.undo, t('toolbar.undo'));
    label(more.redo, t('toolbar.redo'));
    label(more.space, t(world ? 'toolbar.globalSpace' : 'toolbar.localSpace'));
    label(more.settings, t('toolbar.settings'));
    more.save.classList.toggle('disabled', this.#save.classList.contains('disabled'));
    more.undo.classList.toggle('disabled', this.#undo.classList.contains('disabled'));
    more.redo.classList.toggle('disabled', this.#redo.classList.contains('disabled'));
    more.space.classList.toggle('disabled', !editing);
    this.#more.title = t('mobile.more');
    this.#more.setAttribute('aria-label', t('mobile.more'));
  }
}

/**
 * The top bar while the project's build fails (or while it is still loading): the same bar,
 * with editing and Play disabled, the project switcher live (to leave for another project)
 * and why it can't run yet.
 */
export function failedToolbar(title: string, status: string, kind: 'failed' | 'loading' = 'failed', options: ToolbarOptions = {}): HTMLElement {
  const off = (name: Parameters<typeof icon>[0], label: string | null, tip: string): HTMLButtonElement => {
    const el = h('button.toolbar-btn.disabled', { type: 'button', disabled: true });
    dress(el, name, label, tip);
    return el;
  };
  const project = new ProjectSwitcher(title, { dirty: () => 0, error: (text) => { globalThis.alert?.(text); } }, { menu: options.projectSwitcher ?? true });
  return h('div.toolbar', {},
    new SiteLogo(() => 0, () => undefined).el,
    project.el,
    h('span.toolbar-divider'),
    h('div.toolbar-group', {}, off('save', t('settings.save'), t('toolbar.save')), off('undo', null, t('toolbar.undo')), off('redo', null, t('toolbar.redo'))),
    h('span.toolbar-divider'),
    h('div.toolbar-group', {}, ...MODES.map((m) => off(m.icon, t(m.label), t(m.title)))),
    h('span.toolbar-divider'),
    h('div.toolbar-group', {}, off('orbit', t('toolbar.orbitLabel'), t('toolbar.orbitMode')), off('globe', t('toolbar.globalLabel'), t('toolbar.globalSpace'))),
    h('span.toolbar-spacer'),
    h(kind === 'failed' ? 'span.toolbar-status.dirty' : 'span.toolbar-status', { text: status }),
    h('div.toolbar-group', {}, off('play', t('toolbar.play'), t('toolbar.playCtrlP'))),
    h('span.toolbar-divider'),
    h('div.toolbar-group', {}, h('button.toolbar-btn.publish-btn.disabled', { type: 'button', disabled: true, text: t('toolbar.publish'), title: t('toolbar.publish') })),
  );
}
