/**
 * The inspector's popups: a menu (optionally searchable, grouped, keyboard driven) and the
 * pickers built on it — assets with thumbnails (project files, hosted assets the project
 * uses, built-ins and the engine library's models) and the scene's entities. One popup is
 * open at a time; it sits on <body> above the panels and closes on Escape or a click outside.
 */

import { clear, h, icon } from './dom.js';
import type { IconName } from './dom.js';
import { filterAssets } from './fields.js';
import { t } from './i18n.js';
import type { AssetChoice, AssetFolder } from './fields.js';

export interface MenuItem {
  readonly label: string;
  /** Muted text after the label (a category, a path). */
  readonly detail?: string;
  /** Group heading the item is listed under. */
  readonly group?: string;
  readonly icon?: IconName;
  /** A thumbnail drawn in place of the icon (an image, a waveform…). */
  readonly thumb?: () => Node | null;
  readonly disabled?: boolean;
  readonly danger?: boolean;
  /** Searched besides the label and detail. */
  readonly keywords?: string;
  readonly run: () => void;
}

let open: { readonly el: HTMLElement; readonly close: () => void } | undefined;

/** Close the open popup, if any. */
export function closePopup(): void {
  open?.close();
}

export function popupOpen(): boolean {
  return open !== undefined;
}

/** Show `content` in a popup under `anchor` (above it when there is no room below). */
export function popup(anchor: HTMLElement, content: HTMLElement, options: { readonly width?: number; readonly className?: string } = {}): () => void {
  closePopup();
  const el = h('div.insp-popup', { role: 'dialog' }, content);
  if (options.className !== undefined) el.classList.add(options.className);
  el.style.width = `${options.width ?? Math.max(anchor.getBoundingClientRect().width, 220)}px`;
  document.body.append(el);
  const place = (): void => {
    const a = anchor.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const left = Math.max(8, Math.min(a.left, vw - r.width - 8));
    const below = a.bottom + 4;
    const top = below + r.height > vh - 8 && a.top - r.height - 4 > 8 ? a.top - r.height - 4 : Math.min(below, Math.max(8, vh - r.height - 8));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  };
  place();
  const outside = (event: Event): void => {
    if (!el.contains(event.target as Node) && !anchor.contains(event.target as Node)) close();
  };
  const key = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') { event.stopPropagation(); close(); anchor.focus?.(); }
  };
  const close = (): void => {
    if (open?.el !== el) return;
    open = undefined;
    el.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
    window.removeEventListener('resize', close);
  };
  // After this click finishes, or it would close the popup it opened.
  setTimeout(() => {
    if (open?.el !== el) return;
    document.addEventListener('pointerdown', outside, true);
  }, 0);
  document.addEventListener('keydown', key, true);
  window.addEventListener('resize', close);
  open = { el, close };
  requestAnimationFrame(place);
  return close;
}

/** A list of items, filtered by a search box when `search` is set; arrows move, Enter picks. */
export function menuList(items: readonly MenuItem[], options: { readonly search?: string; readonly empty?: string; readonly onPick?: () => void } = {}): HTMLElement {
  const list = h('div.insp-menu-list', { role: 'menu' });
  const input = options.search === undefined ? undefined
    : h('input.insp-menu-search', { type: 'search', placeholder: options.search, spellcheck: 'false', 'aria-label': options.search });
  let rows: { el: HTMLElement; item: MenuItem }[] = [];
  let active = -1;
  const highlight = (i: number): void => {
    rows[active]?.el.classList.remove('active');
    active = rows.length === 0 ? -1 : (i + rows.length) % rows.length;
    rows[active]?.el.classList.add('active');
    rows[active]?.el.scrollIntoView?.({ block: 'nearest' });
  };
  const pick = (item: MenuItem): void => {
    if (item.disabled === true) return;
    options.onPick?.();
    closePopup();
    item.run();
  };
  const draw = (): void => {
    clear(list);
    const words = (input?.value ?? '').trim().toLowerCase().split(/\s+/).filter((w) => w !== '');
    const shown = items.filter((item) => {
      const text = `${item.label} ${item.detail ?? ''} ${item.group ?? ''} ${item.keywords ?? ''}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
    rows = [];
    let group: string | undefined;
    for (const item of shown) {
      if (item.group !== undefined && item.group !== group) {
        group = item.group;
        list.append(h('div.insp-menu-group', { text: group }));
      }
      const thumb = item.thumb?.() ?? (item.icon !== undefined ? icon(item.icon, 14) : null);
      const row = h('button.insp-menu-item', { type: 'button', role: 'menuitem', disabled: item.disabled === true, onclick: () => pick(item) },
        thumb !== null ? h('span.insp-menu-icon', {}, thumb) : null,
        h('span.insp-menu-label', { text: item.label }),
        item.detail !== undefined ? h('span.insp-menu-detail', { text: item.detail }) : null);
      if (item.danger === true) row.classList.add('danger');
      row.addEventListener('pointermove', () => { const i = rows.findIndex((r) => r.el === row); if (i !== active) highlight(i); });
      rows.push({ el: row, item });
      list.append(row);
    }
    if (shown.length === 0) list.append(h('div.insp-menu-empty', { text: options.empty ?? t('picker.nothingMatches') }));
    active = -1;
    if (input !== undefined && rows.length > 0) highlight(0);
  };
  const keys = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowDown') { event.preventDefault(); highlight(active + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); highlight(active - 1); }
    else if (event.key === 'Enter' && rows[active] !== undefined) { event.preventDefault(); pick(rows[active]!.item); }
  };
  input?.addEventListener('input', draw);
  input?.addEventListener('keydown', keys);
  list.addEventListener('keydown', keys);
  draw();
  const root = h('div.insp-menu', {}, input ?? null, list);
  if (input !== undefined) requestAnimationFrame(() => input.focus({ preventScroll: true }));
  return root;
}

/** A menu under `anchor`. */
export function openMenu(anchor: HTMLElement, items: readonly MenuItem[], options: { readonly search?: string; readonly empty?: string; readonly width?: number } = {}): void {
  popup(anchor, menuList(items, options), { ...(options.width !== undefined && { width: options.width }) });
}

// ── Asset picker ─────────────────────────────────────────────────────────────────────────

export interface LibraryChoice {
  readonly id: string;
  readonly summary: string;
}

export interface AssetPickerSource {
  /** The project's and hosted assets of the folder (may take a moment: the files are scanned). */
  readonly choices: (folder: AssetFolder) => AssetChoice[];
  /** The engine library's pieces for the folder (models only); undefined when there is no library. */
  readonly library?: (folder: AssetFolder) => Promise<readonly LibraryChoice[]> | undefined;
  /** Copy a library piece into the project; the reference to set, or undefined if it failed. */
  readonly addFromLibrary?: (piece: string) => Promise<string | undefined>;
  /** A thumbnail for a choice (an image, a portrait, a waveform), or null for the folder's icon. */
  readonly thumb: (ref: string, folder: AssetFolder) => Node | null;
}

export const FOLDER_ICONS: Readonly<Record<AssetFolder, IconName>> = { models: 'box', images: 'image', sfx: 'music', music: 'music', vfx: 'film' };

/** Browse the assets a field can name; `pick('')` clears it. */
export function openAssetPicker(anchor: HTMLElement, folder: AssetFolder, current: string, source: AssetPickerSource, pick: (ref: string) => void): void {
  const tabs = h('div.insp-picker-tabs');
  const search = h('input.insp-menu-search', { type: 'search', placeholder: t('picker.search', { folder: t(`picker.folder.${folder}`) }), spellcheck: 'false' });
  const grid = h('div.insp-picker-grid');
  const status = h('div.insp-picker-status');
  let tab: 'project' | 'library' = 'project';
  let library: readonly LibraryChoice[] | undefined;
  const choices = source.choices(folder);
  const libraryLoad = source.library?.(folder);

  const card = (ref: string, name: string, detail: string, onPick: () => void, thumb: Node | null): HTMLElement => {
    const el = h('button.insp-picker-card', { type: 'button', title: ref === '' ? name : `${name}\n${ref}`, onclick: onPick },
      h('span.insp-picker-thumb', {}, thumb ?? icon(FOLDER_ICONS[folder], 20)),
      h('span.insp-picker-name', { text: name }),
      detail !== '' ? h('span.insp-picker-detail', { text: detail }) : null);
    if (ref !== '' && ref === current) el.classList.add('current');
    return el;
  };

  const draw = (): void => {
    clear(grid);
    status.textContent = '';
    if (tab === 'project') {
      grid.append(card('', t('inspector.none'), t('picker.clear'), () => { closePopup(); pick(''); }, icon('x', 18)));
      const shown = filterAssets(choices, search.value);
      for (const c of shown.slice(0, 300)) {
        grid.append(card(c.ref, c.name, c.source === 'project' ? '' : c.source, () => { closePopup(); pick(c.ref); }, source.thumb(c.ref, folder)));
      }
      if (shown.length === 0) status.textContent = choices.length === 0 ? t('picker.projectHasNone', { folder: t(`picker.folder.${folder}`) }) : t('picker.nothingMatches');
      else if (shown.length > 300) status.textContent = t('picker.showingOf', { count: 300, total: shown.length });
      return;
    }
    if (library === undefined) { status.textContent = t('library.loading'); return; }
    const words = search.value.trim().toLowerCase().split(/\s+/).filter((w) => w !== '');
    const shown = library.filter((p) => words.every((w) => `${p.id.replace(/_/g, ' ')} ${p.summary}`.toLowerCase().includes(w)));
    for (const piece of shown.slice(0, 200)) {
      grid.append(card(piece.id, piece.id.replace(/_/g, ' '), t('picker.libraryTag'), () => {
        status.textContent = t('picker.adding', { name: piece.id });
        void source.addFromLibrary?.(piece.id).then((ref) => {
          closePopup();
          if (ref !== undefined) pick(ref);
        });
      }, null));
    }
    status.textContent = shown.length > 200 ? t('picker.showingOf', { count: 200, total: shown.length }) : shown.length === 0 ? t('picker.nothingMatches') : '';
  };

  const tabButton = (which: 'project' | 'library', text: string): HTMLButtonElement => {
    const b = h('button.seg', { type: 'button', text, onclick: () => { tab = which; for (const c of tabs.children) c.classList.toggle('active', c === b); draw(); } });
    if (which === tab) b.classList.add('active');
    return b;
  };
  if (libraryLoad !== undefined) {
    tabs.append(h('div.segmented', {}, tabButton('project', t('picker.projectTab')), tabButton('library', t('picker.libraryTab'))));
    void libraryLoad.then((pieces) => { library = pieces; if (tab === 'library') draw(); }, () => { library = []; if (tab === 'library') draw(); });
  }
  search.addEventListener('input', draw);
  draw();
  popup(anchor, h('div.insp-picker', {}, tabs.childElementCount > 0 ? tabs : null, search, grid, status), { width: 320, className: 'insp-asset-popup' });
  requestAnimationFrame(() => search.focus({ preventScroll: true }));
}

// ── Entity picker ────────────────────────────────────────────────────────────────────────

export interface EntityChoice {
  /** The entity's placed id, if it has one (what a reference stores). */
  readonly placedId: string | undefined;
  readonly label: string;
  readonly prefab: string | undefined;
  readonly pick: () => void;
}

/** Choose one of the scene's entities, or none. */
export function openEntityPicker(anchor: HTMLElement, current: string | null, entities: readonly EntityChoice[], clearValue: () => void): void {
  const items: MenuItem[] = [
    { label: t('inspector.none'), icon: 'x', run: clearValue },
    ...entities.map((e): MenuItem => ({
      label: e.label,
      detail: e.placedId === undefined ? `${e.prefab ?? ''} · ${t('picker.getsAnId')}` : e.prefab,
      icon: 'box',
      keywords: e.placedId ?? '',
      disabled: e.placedId !== undefined && e.placedId === current,
      run: e.pick,
    })),
  ];
  openMenu(anchor, items, { search: t('hierarchy.searchEntities'), empty: t('picker.noEntityMatches'), width: 260 });
}
