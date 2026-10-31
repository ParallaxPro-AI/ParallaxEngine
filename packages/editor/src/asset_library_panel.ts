/**
 * The Asset Library tab: the engine's own `shared_library/` (code-built models under models/, plus
 * ui, gameplay, camera … pieces), searched by name and summary and filtered by category.
 * A piece is added to the open project by copying it in (`parallax library add`, done by the
 * server); a model piece's prefab can then be placed in the scene.
 *
 *   GET  /__parallax__/library.json   {"pieces": [{id, category, summary, added}]}
 *   POST /__parallax__/library-add    {"piece": id} → {"added": [path], "prefab": id | null}
 *
 *   GET  /__parallax__/library-model/<id>.json   a model piece's model document (thumbnails)
 *
 * The list is fetched once, on the first `activate()`. The grid shows the best PAGE_SIZE
 * matches and adds the next page as the list scrolls near its end (models/ alone holds
 * thousands of pieces); a new search or category starts again from the first page. A model
 * piece's card shows its portrait once it scrolls into view (asset_previews.ts
 * `libraryPortrait`: the piece's model document drawn by the game's 3D renderer); other
 * pieces, and every card in a 2D game, show an icon per category.
 *
 * Placing a just-added model waits for the build the add causes to be taken in (the `build`
 * change): the runtime lists the project's asset files when it is built, so the new model
 * document is only placeable once boot.ts has rebuilt it.
 */

import type { Editor } from './editor.js';
import { clear, h } from './dom.js';
import { lt, t } from './i18n.js';
import { PREFAB_DRAG_TYPE } from './bottom_panels.js';
import { libraryPortrait } from './asset_previews.js';
import { serverUrl } from './paths.js';

export const LIBRARY_URL = '/__parallax__/library.json';
export const LIBRARY_ADD_URL = '/__parallax__/library-add';

/** How many cards one page of the grid adds. */
export const PAGE_SIZE = 50;

/** Pixels from the end of the list at which the next page is added. */
export const MORE_MARGIN = 240;

export interface LibraryPiece {
  readonly id: string;
  readonly category: string;
  readonly summary: string;
  added: boolean;
}

export interface LibraryAddResult {
  readonly added: readonly string[];
  readonly prefab: string | null;
}

// ── Pure logic (tested) ───────────────────────────────────────────────────────

/**
 * Whether a `build` the editor took in settles an add that answered `prefab`: the prefab
 * document is in the project now (boot.ts takes the documents in, then rebuilds the runtime,
 * then says `build`), the piece has no prefab, or the build failed (nothing more is coming;
 * the dialog says so). Any other build is one that was already on its way when the add
 * landed (a save's, a slow server's): placing then would put the prefab into a runtime whose
 * asset list predates the piece's model (PP2063 in every frame).
 */
export function addSettled(prefab: string | null, prefabs: { has(id: string): boolean }, buildFailed: boolean): boolean {
  return prefab === null || buildFailed || prefabs.has(prefab);
}

/** A piece id as words: `ac_condenser_unit` → `ac condenser unit`. */
export function displayName(id: string): string {
  return id.replace(/[_-]+/g, ' ').trim();
}

/** Every category with its piece count, `models` first then alphabetical. */
export function categoriesOf(pieces: readonly LibraryPiece[]): { category: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const p of pieces) counts.set(p.category, (counts.get(p.category) ?? 0) + 1);
  return [...counts].map(([category, count]) => ({ category, count }))
    .sort((a, b) => (a.category === 'models' ? -1 : b.category === 'models' ? 1 : a.category.localeCompare(b.category)));
}

/**
 * The pieces in `category` ('' = all) whose name or summary holds every word of `query`,
 * best first: a name that starts with the query, then a name holding every word, then
 * summary-only matches; ties alphabetical.
 */
export function filterPieces(pieces: readonly LibraryPiece[], query: string, category = ''): LibraryPiece[] {
  const q = query.trim().toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ');
  const words = q === '' ? [] : q.split(' ');
  const scored: { piece: LibraryPiece; rank: number }[] = [];
  for (const piece of pieces) {
    if (category !== '' && piece.category !== category) continue;
    if (words.length === 0) {
      scored.push({ piece, rank: 0 });
      continue;
    }
    const name = displayName(piece.id).toLowerCase();
    const text = `${name} ${piece.summary.toLowerCase()}`;
    if (!words.every((w) => text.includes(w))) continue;
    const rank = name === q ? 0 : name.startsWith(q) ? 1 : words.every((w) => name.includes(w)) ? 2 : 3;
    scored.push({ piece, rank });
  }
  return scored.sort((a, b) => a.rank - b.rank || a.piece.id.localeCompare(b.piece.id)).map((s) => s.piece);
}

/** The first `pages` pages of `items`, and whether more remain. */
export function pageOf<T>(items: readonly T[], pages: number, size = PAGE_SIZE): { shown: T[]; more: boolean } {
  const end = Math.max(0, pages) * size;
  return { shown: items.slice(0, end), more: items.length > end };
}

/** Whether a scrolled list is within `margin` pixels of its end (or doesn't fill its box yet). */
export function nearEnd(scrollTop: number, clientHeight: number, scrollHeight: number, margin = MORE_MARGIN): boolean {
  return scrollHeight - scrollTop - clientHeight <= margin;
}

/** The status line under the grid. */
export function statusText(shown: number, total: number, all: number): string {
  if (all === 0) return t('library.empty');
  if (total === 0) return t('library.noMatch');
  const of = total === all ? t('library.pieces', { count: all }) : t('library.matchingOf', { count: total, total: all });
  return shown < total ? t('library.showing', { count: shown, of }) : of;
}

// ── Server ────────────────────────────────────────────────────────────────────

export async function fetchLibrary(get: typeof fetch = fetch): Promise<LibraryPiece[]> {
  const response = await get(serverUrl(LIBRARY_URL), { headers: { Accept: 'application/json' } });
  const body = await response.json().catch(() => ({})) as { pieces?: LibraryPiece[]; error?: string };
  if (!response.ok) throw new Error(body.error ?? `Loading the library failed (HTTP ${response.status})`);
  return (body.pieces ?? []).map((p) => ({ id: p.id, category: p.category, summary: p.summary ?? '', added: p.added === true }));
}

export async function addPiece(piece: string, post: typeof fetch = fetch): Promise<LibraryAddResult> {
  const response = await post(serverUrl(LIBRARY_ADD_URL), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ piece }),
  });
  const body = await response.json().catch(() => ({})) as { added?: string[]; prefab?: string | null; error?: string };
  if (!response.ok) throw new Error(body.error ?? `Adding ${piece} failed (HTTP ${response.status})`);
  return { added: body.added ?? [], prefab: body.prefab ?? null };
}

// ── Icons ─────────────────────────────────────────────────────────────────────

/** Lucide-style glyphs (24×24) per library category; `box` for anything else. */
const CATEGORY_ICONS: Readonly<Record<string, string>> = {
  models: '<path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5"/><path d="M12 22V12"/>',
  ui: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/>',
  core: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3"/><path d="M12 19v3"/><path d="m4.9 4.9 2.1 2.1"/><path d="m17 17 2.1 2.1"/><path d="M2 12h3"/><path d="M19 12h3"/><path d="m4.9 19.1 2.1-2.1"/><path d="m17 7 2.1-2.1"/>',
  movement: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/>',
  combat: '<path d="M14.5 17.5 3 6V3h3l11.5 11.5"/><path d="m13 19 6-6"/><path d="m16 16 4 4"/><path d="m19 21 2-2"/>',
  gameplay: '<line x1="6" x2="10" y1="12" y2="12"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="15" x2="15.01" y1="13" y2="13"/><line x1="18" x2="18.01" y1="11" y2="11"/><rect x="2" y="6" width="20" height="12" rx="2"/>',
  audio: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>',
  clips: '<rect x="2" y="2" width="20" height="20" rx="2.18"/><path d="M7 2v20"/><path d="M17 2v20"/><path d="M2 12h20"/><path d="M2 7h5"/><path d="M2 17h5"/><path d="M17 17h5"/><path d="M17 7h5"/>',
  net: '<rect x="16" y="16" width="6" height="6" rx="1"/><rect x="2" y="16" width="6" height="6" rx="1"/><rect x="9" y="2" width="6" height="6" rx="1"/><path d="M5 16v-3a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v3"/><path d="M12 12V8"/>',
  procgen: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
  props: '<path d="M2 20h20"/><path d="M5 20V9l7-5 7 5v11"/><path d="M9 20v-6h6v6"/>',
  world: '<path d="m8 3 4 8 5-5 5 15H2L8 3z"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  close: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
};

function glyph(name: string, size: number): SVGSVGElement {
  const wrap = document.createElement('span');
  wrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${CATEGORY_ICONS[name] ?? CATEGORY_ICONS['models']}</svg>`;
  return wrap.firstChild as SVGSVGElement;
}

// ── Panel ─────────────────────────────────────────────────────────────────────

export class AssetLibraryPanel {
  readonly el: HTMLElement;
  readonly #editor: Editor;
  readonly #search: HTMLInputElement;
  readonly #category: HTMLSelectElement;
  readonly #content: HTMLElement;
  readonly #status: HTMLElement;
  #pieces: LibraryPiece[] = [];
  #filtered: LibraryPiece[] = [];
  #pages = 1;
  #loading: Promise<void> | undefined;
  #grid: HTMLElement | undefined;
  #sentinel: HTMLElement | undefined;
  /** Draws model cards' portraits as they scroll into view. */
  #observer: IntersectionObserver | undefined;
  /** Pieces just added whose build hasn't been taken in yet (id → the add's prefab): not placeable until it is. */
  readonly #awaitingBuild = new Map<string, string | null>();
  /** Redraws the open details dialog (after an add, a rebuild, a mode change). */
  #refreshDetails: (() => void) | undefined;
  #closeDetails: (() => void) | undefined;

  constructor(editor: Editor) {
    this.#editor = editor;
    this.#search = h('input', { type: 'search', ...lt('library.search', 'placeholder'), ...lt('library.search', 'aria-label'), autocomplete: 'off', oninput: () => this.#refilter() });
    this.#category = h('select.lib-category', { ...lt('assets.metaCategory', 'aria-label'), onchange: () => this.#refilter() });
    const all = new Option(t('library.allCategories'), '');
    all.setAttribute('data-i18n', 'library.allCategories');
    this.#category.append(all);
    const field = h('label.lib-search-field', {}, h('span.lib-search-icon', {}, glyph('search', 14)), this.#search);
    this.#content = h('div.lib-content');
    this.#content.addEventListener('scroll', () => this.#moreIfNearEnd(), { passive: true });
    this.#status = h('div.lib-status');
    this.el = h('div.lib-panel', {}, h('div.lib-search', {}, field, this.#category), this.#content, this.#status);
    this.#empty(t('library.openTab'));
    editor.on((changes) => {
      if (changes.has('build')) {
        const prefabs = editor.documents.project().prefabs;
        const failed = editor.buildDiagnostics.some((d) => d.severity === 'error');
        for (const [id, prefab] of [...this.#awaitingBuild]) if (addSettled(prefab, prefabs, failed)) this.#awaitingBuild.delete(id);
      }
      if (changes.has('documents') || changes.has('mode') || changes.has('build')) {
        this.#refreshDetails?.();
        this.#syncPlaceable();
      }
    });
  }

  /** Show the tab: loads the list the first time. */
  activate(): void {
    this.#loading ??= this.#load();
  }

  async #load(): Promise<void> {
    this.#empty(t('library.loading'));
    this.#status.textContent = '';
    try {
      this.#pieces = await fetchLibrary();
    } catch (error) {
      this.#loading = undefined;
      const message = (error as Error).message ?? String(error);
      this.#empty(message);
      this.#status.append(h('button.lib-retry', { type: 'button', text: t('library.retry'), onclick: () => this.activate() }));
      this.#editor.write('error', `Asset library: ${message}`);
      return;
    }
    const chosen = this.#category.value;
    while (this.#category.options.length > 1) this.#category.remove(1);
    for (const { category, count } of categoriesOf(this.#pieces)) this.#category.append(new Option(`${category} (${count})`, category));
    this.#category.value = chosen;
    this.#refilter();
  }

  #empty(text: string): void {
    this.#observer?.disconnect();
    this.#grid = undefined;
    clear(this.#content);
    this.#content.append(h('p.panel-empty', { text }));
  }

  #refilter(): void {
    if (this.#loading === undefined) return;
    this.#filtered = filterPieces(this.#pieces, this.#search.value, this.#category.value);
    this.#pages = 1;
    this.#content.scrollTop = 0;
    this.#render();
  }

  #render(): void {
    const { shown, more } = pageOf(this.#filtered, this.#pages);
    this.#status.textContent = statusText(shown.length, this.#filtered.length, this.#pieces.length);
    if (shown.length === 0) {
      this.#empty(this.#pieces.length === 0 ? t('library.noPieces') : t('library.noPieceMatches'));
      return;
    }
    this.#observer?.disconnect();
    this.#observer = undefined;
    clear(this.#content);
    this.#grid = h('div.lib-grid', {}, ...shown.map((p) => this.#card(p)));
    this.#content.append(this.#grid);
    this.#sentinel = undefined;
    if (more) this.#appendSentinel();
    this.#fillLater();
  }

  /** The "Show more" button at the end: a click adds the next page (scrolling near it does too). */
  #appendSentinel(): void {
    const sentinel = h('button.lib-more', { type: 'button', ...lt('library.showMore'), onclick: () => this.#nextPage() });
    this.#sentinel = sentinel;
    this.#content.append(sentinel);
  }

  /** The next page, when the list is scrolled near its end (or doesn't fill the panel yet). */
  #moreIfNearEnd(): void {
    if (this.#sentinel === undefined || this.#content.clientHeight === 0) return;
    if (nearEnd(this.#content.scrollTop, this.#content.clientHeight, this.#content.scrollHeight)) this.#nextPage();
  }

  /** After a page is drawn: a page shorter than the panel gets the next one (no scrollbar to scroll). */
  #fillLater(): void {
    if (typeof requestAnimationFrame === 'undefined') return;
    requestAnimationFrame(() => this.#moreIfNearEnd());
  }

  #nextPage(): void {
    if (this.#grid === undefined) return;
    const before = pageOf(this.#filtered, this.#pages).shown.length;
    const { shown, more } = pageOf(this.#filtered, this.#pages + 1);
    if (shown.length === before) return;
    this.#pages++;
    this.#grid.append(...shown.slice(before).map((p) => this.#card(p)));
    this.#status.textContent = statusText(shown.length, this.#filtered.length, this.#pieces.length);
    if (!more) {
      this.#sentinel?.remove();
      this.#sentinel = undefined;
    } else {
      this.#fillLater();
    }
  }

  /** A model card's portrait in place of its icon, drawn once the card scrolls into view. */
  #thumbnail(slot: HTMLElement, piece: LibraryPiece): void {
    if (piece.category !== 'models') return;
    const draw = (): void => {
      void libraryPortrait(this.#editor, piece.id).then((url) => {
        if (url !== null && slot.isConnected) slot.replaceChildren(h('img.lib-card-img', { src: url, alt: '', draggable: false }));
      });
    };
    if (typeof IntersectionObserver === 'undefined') {
      draw();
      return;
    }
    this.#observer ??= new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        this.#observer?.unobserve(entry.target);
        (entry.target as HTMLElement & { drawThumbnail?: () => void }).drawThumbnail?.();
      }
    }, { root: this.#content, rootMargin: '120px' });
    (slot as HTMLElement & { drawThumbnail?: () => void }).drawThumbnail = draw;
    this.#observer.observe(slot);
  }

  #prefabReady(piece: LibraryPiece): boolean {
    return piece.added && !this.#awaitingBuild.has(piece.id) && this.#editor.documents.project().prefabs.has(piece.id);
  }

  #card(piece: LibraryPiece): HTMLElement {
    const card = h('div.lib-card', {
      title: `${displayName(piece.id)}\n${piece.summary}`, 'data-piece': piece.id, tabindex: 0, role: 'button',
      onclick: () => this.#openDetails(piece),
      onkeydown: (event: Event) => { if ((event as KeyboardEvent).key === 'Enter') this.#openDetails(piece); },
      ondragstart: (event: Event) => {
        const drag = event as DragEvent;
        drag.dataTransfer?.setData(PREFAB_DRAG_TYPE, piece.id);
        drag.dataTransfer?.setData('text/plain', piece.id);
      },
    }, h('span.lib-card-thumb', {}, glyph(piece.category, 22)), h('span.lib-card-name', { text: displayName(piece.id) }));
    this.#thumbnail(card.querySelector<HTMLElement>('.lib-card-thumb')!, piece);
    this.#markCard(card, piece);
    return card;
  }

  /** Added pieces carry a badge; a placeable one drags onto the viewport like a project prefab. */
  #markCard(card: HTMLElement, piece: LibraryPiece): void {
    card.classList.toggle('added', piece.added);
    const placeable = this.#editor.editing && this.#prefabReady(piece);
    card.draggable = placeable;
    const badge = card.querySelector('.lib-card-badge');
    if (piece.added && badge === null) card.append(h('span.lib-card-badge', { text: t('library.added'), 'aria-label': t('library.inProject') }));
    else if (!piece.added) badge?.remove();
  }

  #syncPlaceable(): void {
    if (this.#grid === undefined) return;
    const byId = new Map(this.#pieces.map((p) => [p.id, p]));
    for (const card of this.#grid.querySelectorAll<HTMLElement>('.lib-card.added')) {
      const piece = byId.get(card.dataset['piece'] ?? '');
      if (piece !== undefined) this.#markCard(card, piece);
    }
  }

  #openDetails(piece: LibraryPiece): void {
    this.#closeDetails?.();
    const editor = this.#editor;
    let busy = false;
    let error = '';
    let copied: readonly string[] = [];
    /** The prefab the add answered with (model pieces: the piece id). */
    let prefab: string | null = piece.added && editor.documents.project().prefabs.has(piece.id) ? piece.id : null;
    let placeWhenReady = false;
    /** This dialog's add wrote files: its build is awaited before placing. */
    let added = false;

    const overlay = h('div.lib-overlay');
    const close = (): void => {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
      if (this.#closeDetails === close) {
        this.#closeDetails = undefined;
        this.#refreshDetails = undefined;
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });

    const actions = h('div.lib-actions');
    const note = h('div.lib-note');
    const meta = h('div.lib-meta');
    const preview = h('div.lib-preview', {}, h('span.lib-preview-icon', {}, glyph(piece.category, 56)));
    if (piece.category === 'models') {
      void libraryPortrait(editor, piece.id, 256).then((url) => {
        if (url !== null && overlay.isConnected) preview.replaceChildren(h('img.lib-preview-img', { src: url, alt: '' }));
      });
    }
    const dialog = h('div.lib-dialog', { role: 'dialog', 'aria-modal': 'true', 'aria-label': displayName(piece.id) },
      h('button.lib-close', { type: 'button', title: t('settings.close'), 'aria-label': t('settings.close'), onclick: close }, glyph('close', 16)),
      preview,
      h('div.lib-info', {},
        h('div.lib-name', { text: displayName(piece.id) }),
        meta,
        h('p.lib-summary', { text: piece.summary || t('library.noSummary') })),
      note, actions);
    overlay.append(dialog);
    document.body.append(overlay);

    const placeNow = (id: string): void => {
      placeWhenReady = false;
      close();
      editor.addPrefab(id);
    };

    const draw = (): void => {
      const project = editor.documents.project();
      const building = this.#awaitingBuild.has(piece.id);
      const ready = prefab !== null && !building && project.prefabs.has(prefab);
      if (ready && placeWhenReady && editor.editing) {
        placeNow(prefab!);
        return;
      }
      if (added && !building && placeWhenReady && !ready && error === '') {
        // The build came, but without the prefab: it failed (the console says why).
        placeWhenReady = false;
        error = 'The build after the add has problems, so the prefab could not be placed. See the console.';
      }
      clear(meta);
      meta.append(h('span', { text: t('library.categoryMeta', { category: piece.category }) }), h('span', { text: t('library.idMeta', { id: piece.id }) }));
      if (piece.added) meta.append(h('span.lib-in-project', { text: t('library.inProject') }));

      clear(note);
      note.className = 'lib-note';
      if (error !== '') {
        note.classList.add('error');
        note.textContent = error;
      } else if (busy) {
        note.textContent = t('library.copying');
      } else if (copied.length > 0) {
        note.textContent = t('library.copied', { files: copied.join(', ') });
        if (prefab !== null && !ready) note.append(h('br'), t('library.rebuilding'));
      } else if (piece.added && prefab === null && piece.category !== 'models') {
        note.textContent = t('library.alreadyAdded');
      }

      clear(actions);
      if (!piece.added || busy) {
        actions.append(h('button.lib-action.primary', { type: 'button', text: busy ? t('library.adding') : t(piece.category === 'models' && editor.editing ? 'assets.addToScene' : 'library.addToProject'), disabled: busy, onclick: () => void add() }));
      }
      if (piece.added && prefab === null && piece.category === 'models' && !busy) {
        // Added before (or by the CLI) but the prefab isn't loaded yet: it is the piece id.
        prefab = piece.id;
      }
      if (piece.added && prefab !== null) {
        const label = ready ? t('library.place') : placeWhenReady ? t('library.placingAfterBuild') : t('library.place');
        const button = h('button.lib-action.primary', { type: 'button', text: label, title: editor.editing ? t('library.placeTitle', { name: prefab }) : t('library.stopToPlace') }) as HTMLButtonElement;
        button.disabled = !editor.editing || placeWhenReady;
        button.addEventListener('click', () => {
          if (ready) placeNow(prefab!);
          else {
            placeWhenReady = true;
            draw();
          }
        });
        actions.append(button);
      }
      actions.append(h('button.lib-action', { type: 'button', text: t('settings.close'), onclick: close }));
    };

    const add = async (): Promise<void> => {
      if (busy || piece.added) return;
      busy = true;
      error = '';
      draw();
      try {
        const result = await addPiece(piece.id);
        piece.added = true;
        copied = result.added;
        prefab = result.prefab;
        if (result.added.length > 0) {
          // Placeable once the build the add causes is taken in (boot.ts rebuilds the runtime for a new model).
          added = true;
          this.#awaitingBuild.set(piece.id, result.prefab);
        }
        // A model piece goes straight into the scene: "Add" is one click.
        if (prefab !== null && editor.editing) placeWhenReady = true;
        editor.write('info', `Added ${piece.id} from the library${result.added.length > 0 ? `: ${result.added.join(', ')}` : ''}`);
      } catch (failure) {
        error = (failure as Error).message ?? String(failure);
        editor.write('error', `Library add ${piece.id}: ${error}`);
      } finally {
        busy = false;
        const card = this.#grid?.querySelector<HTMLElement>(`.lib-card[data-piece="${CSS.escape(piece.id)}"]`);
        if (card) this.#markCard(card, piece);
        if (this.#closeDetails === close) draw();
      }
    };

    this.#closeDetails = close;
    this.#refreshDetails = draw;
    draw();
    (actions.querySelector('button') as HTMLButtonElement | null)?.focus();
  }
}
