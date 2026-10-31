/**
 * The bottom panel, "Project": Files,
 * Asset Library and Performance. Files is three sections:
 *
 *   SCENES       a row of scene cards; click one to open it
 *   PREFABS      a row of prefab tiles (their model's portrait); drag one onto the viewport,
 *                or press its "+" to place it ahead of the camera
 *   USED ASSETS  3D Models, Materials & Textures, Audio: collapsed rows with counts; opened,
 *                a grid of tiles (portrait, image, waveform)
 *
 * Clicking a tile opens its detail popover (asset_detail.ts): the big preview, a player for
 * audio, where it is used, and Replace… / Add to scene. Warnings and errors (build, save, hot
 * reload) surface as a toast over the viewport.
 */

import { formatDiagnostic } from '@parallax/runtime/core';
import type { Editor, LogEntry } from './editor.js';
import { clear, h, icon } from './dom.js';
import type { IconName } from './dom.js';
import { onLanguageChange, t } from './i18n.js';
import { replaceOps, scanUsedAssets } from './used_assets.js';
import type { UsedAsset, UsedAssetKind } from './used_assets.js';
import { assetUrl, catalogName, learnNames, portrait, prefabModel, settledPortrait, waveform } from './asset_previews.js';
import { showAssetDetail } from './asset_detail.js';
import type { AssetDetailAction } from './asset_detail.js';
import { showModal } from './modal.js';
import { setToastRoot, showToast } from './toast.js';
import type { FilePatch } from './session/index.js';

/** The drag payload a prefab card carries onto the viewport. */
export const PREFAB_DRAG_TYPE = 'application/x-parallax-prefab';

/** A tab body another module owns (the asset library, the performance panel). */
export interface TabPanel {
  readonly el: HTMLElement;
  activate(): void;
  deactivate?(): void;
}

/** The USED ASSETS rows, in display order. */
const CATEGORIES: readonly (readonly [UsedAssetKind, string, IconName])[] = [
  ['models', 'assets.category3dModels', 'box'],
  ['textures', 'assets.categoryMaterials', 'image'],
  ['audio', 'assets.categoryAudio', 'music'],
];

/** A tile: its thumbnail square (an icon until the preview arrives) and its name below. */
function tile(name: string, title: string, glyph: IconName, preview: Promise<string | null> | string | null, extra: { wave?: boolean; later?: () => Promise<string | null> } = {}): { el: HTMLElement; thumb: HTMLElement } {
  const thumb = h('span.asset-tile-thumb', {}, icon(glyph, 18));
  const el = h('div.asset-tile', { role: 'button', tabindex: 0, title }, thumb, h('span.asset-tile-name', { text: name }));
  const show = (url: string | null): void => {
    if (url === null) return;
    const img = thumb.querySelector('img');
    if (img !== null) {
      if (img.src !== url) img.src = url;
      return;
    }
    thumb.replaceChildren(h(extra.wave === true ? 'img.asset-tile-img.wave' : 'img.asset-tile-img', { src: url, alt: '', loading: 'lazy', draggable: 'false' }));
  };
  if (typeof preview === 'string') show(preview);
  else if (preview instanceof Promise) void preview.then(show);
  // A model's second, settled portrait replaces the first (textures loaded by then).
  if (extra.later !== undefined) void extra.later().then(show);
  return { el, thumb };
}

export type BottomTab = 'files' | 'library' | 'performance';

export class BottomPanels {
  readonly el: HTMLElement;
  /** Where warnings and errors stack (toast.ts); the layout puts it over the viewport. */
  readonly toast: HTMLElement;
  readonly #editor: Editor;
  readonly #tabs = new Map<BottomTab, { tab: HTMLButtonElement; body: HTMLElement; panel?: TabPanel }>();
  readonly #files: HTMLElement;
  readonly #filter: HTMLInputElement;
  #shownLog = 0;
  #active: BottomTab = 'files';
  /** Rows the user opened; they stay open across re-renders. All start closed. */
  readonly #expanded = new Set<string>();
  #scan: { version: number; assets: readonly UsedAsset[] } | undefined;

  constructor(editor: Editor, panels: { library?: TabPanel; performance?: TabPanel } = {}) {
    this.#editor = editor;
    this.#filter = h('input.panel-filter', { type: 'search', placeholder: t('assets.searchAssets'), 'aria-label': t('assets.searchAssets'), oninput: () => this.#renderFiles() });
    this.#files = h('div.assets-body');
    this.toast = h('div.editor-toast-root');
    setToastRoot(this.toast);
    const tabBar = h('div.panel-tabs');
    const bodies = h('div.panel-tab-bodies');
    const entries: [BottomTab, string, HTMLElement, TabPanel | undefined][] = [
      ['files', 'assets.projectFiles', h('div.tab-body', {}, h('div.panel-toolbar', {}, this.#filter), this.#files), undefined],
      ...(panels.library !== undefined ? [['library', 'assets.assetLibrary', h('div.tab-body', {}, panels.library.el), panels.library] as [BottomTab, string, HTMLElement, TabPanel]] : []),
      ...(panels.performance !== undefined ? [['performance', 'assets.performance', h('div.tab-body', {}, panels.performance.el), panels.performance] as [BottomTab, string, HTMLElement, TabPanel]] : []),
    ];
    for (const [id, text, body, panel] of entries) {
      const tab = h('button.panel-tab', { type: 'button', text: t(text), onclick: () => this.show(id) });
      onLanguageChange(() => { tab.textContent = t(text); });
      tabBar.append(tab);
      bodies.append(body);
      this.#tabs.set(id, { tab, body, ...(panel !== undefined && { panel }) });
    }
    const title = h('span.panel-title', { text: t('assets.title') });
    const header = h('div.panel-header', {}, title);
    onLanguageChange(() => { title.textContent = t('assets.title'); this.#filter.placeholder = t('assets.searchAssets'); this.#renderFiles(); });
    this.el = h('section.panel.bottom-panel', {}, header, tabBar, bodies);
    editor.on((changes) => {
      if (changes.has('log')) this.#renderLog();
      if (changes.has('documents') || changes.has('mode') || changes.has('world')) this.#renderFiles();
    });
    this.show('files');
    this.#renderFiles();
    this.#shownLog = editor.log.length;
  }

  show(id: BottomTab): void {
    const previous = this.#tabs.get(this.#active);
    if (previous !== undefined && this.#active !== id) previous.panel?.deactivate?.();
    this.#active = id;
    for (const [key, { tab, body }] of this.#tabs) {
      tab.classList.toggle('active', key === id);
      body.hidden = key !== id;
    }
    this.#tabs.get(id)?.panel?.activate();
  }

  /** Bring the project's prefabs forward (the hierarchy's "+"): the PREFABS section. */
  showPrefabs(): void {
    this.show('files');
    const section = this.#files.querySelector<HTMLElement>('.prefab-section');
    section?.scrollIntoView({ block: 'nearest' });
    section?.classList.remove('flash');
    void section?.offsetWidth;
    section?.classList.add('flash');
  }

  /** The used assets, rescanned only when the documents changed. */
  #usedAssets(): readonly UsedAsset[] {
    const version = this.#editor.documents.version;
    if (this.#scan?.version !== version) {
      this.#scan = { version, assets: scanUsedAssets(this.#editor.documents) };
      // Hosted assets' catalog names arrive later; the panel redraws with them.
      void learnNames(this.#scan.assets.map((a) => a.ref)).then((learned) => { if (learned) this.#renderFiles(); });
    }
    return this.#scan.assets;
  }

  #renderFiles(): void {
    const editor = this.#editor;
    const project = editor.documents.project();
    const query = this.#filter.value.trim().toLowerCase();
    const matches = (...texts: string[]): boolean => query === '' || texts.some((text) => text.toLowerCase().includes(query));
    const scroll = this.#files.scrollTop;
    clear(this.#files);

    const scenes = h('div.scene-grid');
    for (const scene of [...project.scenes.values()].sort((a, b) => a.id.localeCompare(b.id))) {
      const card = h('button.scene-card', {
        type: 'button', title: `${scene.id}\n${scene.path}${editor.editing ? '\nClick to open' : ''}`,
        onclick: () => { if (editor.editing) editor.openScene(scene.id); },
      }, h('span.scene-thumb', {}, icon('film', 20)), h('span.scene-name', { text: scene.id }));
      card.classList.toggle('active', scene.id === editor.session.scene);
      card.disabled = !editor.editing;
      scenes.append(card);
    }
    this.#files.append(h('div.project-section-header', { text: t('assets.scenes') }), scenes);

    const prefabs = [...project.prefabs.values()].filter((p) => matches(p.id)).sort((a, b) => a.id.localeCompare(b.id));
    const row = h('div.prefab-grid');
    for (const prefab of prefabs) {
      const model = prefabModel(editor, prefab.path);
      const { el } = tile(prefab.id, `${prefab.id}\n${prefab.path}${editor.editing ? '\nDrag onto the viewport, or press + to place it ahead of the camera' : ''}`,
        'package', model === undefined ? null : portrait(editor, model), model === undefined ? {} : { later: () => settledPortrait(editor, model) });
      el.classList.add('prefab-tile');
      el.draggable = editor.editing;
      el.addEventListener('dragstart', (event) => {
        event.dataTransfer?.setData(PREFAB_DRAG_TYPE, prefab.id);
        event.dataTransfer?.setData('text/plain', prefab.id);
      });
      el.addEventListener('click', () => this.#prefabDetail(prefab.id, prefab.path, model));
      if (editor.editing) {
        el.append(h('button.asset-add', {
          type: 'button', title: `${t('assets.addToScene')}: ${prefab.id}`, 'aria-label': `${t('assets.addToScene')}: ${prefab.id}`,
          onclick: (event: Event) => { event.stopPropagation(); editor.addPrefab(prefab.id); },
        }, icon('plus', 12)));
      }
      row.append(el);
    }
    if (prefabs.length === 0) row.append(h('p.asset-category-empty', { text: query === '' ? t('assets.noItemsFound') : t('assets.noAssetsFound') }));
    this.#files.append(h('div.prefab-section', {}, h('div.project-section-header', { text: t('assets.prefabs') }), row));

    this.#files.append(h('div.project-section-header', { text: t('assets.usedAssets') }));
    const used = this.#usedAssets();
    for (const [kind, label, glyph] of CATEGORIES) {
      const items = used.filter((a) => a.kind === kind && matches(this.#nameOf(a), a.ref));
      this.#appendCategory(kind, t(label), glyph, items.length, () => items.map((asset) => {
        const name = this.#nameOf(asset);
        const { el } = tile(name, `${name}\n${asset.ref}`, glyph, this.#preview(asset), {
          wave: kind === 'audio', ...(kind === 'models' && { later: () => settledPortrait(editor, asset.ref) }),
        });
        el.addEventListener('click', () => this.#assetDetail(asset, t(label), glyph));
        el.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); el.click(); } });
        return el;
      }));
    }
    this.#files.scrollTop = scroll;
  }

  #nameOf(asset: UsedAsset): string {
    return catalogName(asset.ref) ?? asset.name;
  }

  #preview(asset: UsedAsset, big = false): Promise<string | null> | string | null {
    if (asset.kind === 'textures') return assetUrl(asset.ref);
    if (asset.kind === 'audio') return big ? waveform(asset.ref, 640, 192) : waveform(asset.ref);
    return big ? settledPortrait(this.#editor, asset.ref, 320) : portrait(this.#editor, asset.ref, 128);
  }

  /** The prefab placing `ref` (the one that draws or plays it), if any. */
  #prefabUsing(asset: UsedAsset): string | undefined {
    const project = this.#editor.documents.project();
    const path = asset.usedIn.find((p) => p.startsWith('prefabs/'));
    return path === undefined ? undefined : [...project.prefabs.values()].find((p) => p.path === path)?.id;
  }

  #assetDetail(asset: UsedAsset, category: string, glyph: IconName): void {
    const editor = this.#editor;
    const actions: AssetDetailAction[] = [];
    // Replace rewrites the data files that name it (code is left alone), as one undoable edit.
    if (editor.editing && asset.usedIn.some((p) => p.endsWith('.json'))) actions.push({ label: t('assets.replaceAction'), run: () => this.#replace(asset) });
    // Add to scene places the prefab that uses it (a model's or a sound's own prefab).
    const prefab = this.#prefabUsing(asset);
    if (editor.editing && prefab !== undefined) actions.push({ label: t('assets.addToScene'), primary: true, run: () => editor.addPrefab(prefab) });
    showAssetDetail({
      name: this.#nameOf(asset), category, usedIn: asset.usedIn.length, ref: asset.ref, glyph,
      preview: this.#preview(asset, true), actions,
      ...(asset.kind === 'audio' && { audio: assetUrl(asset.ref) }),
    });
  }

  #prefabDetail(id: string, path: string, model: string | undefined): void {
    const editor = this.#editor;
    const placed = editor.documents.list().filter((p) => p.endsWith('.json') && p !== path && editor.documents.read(p).includes(`"${id}"`) && /"prefab"\s*:/.test(editor.documents.read(p))).length;
    showAssetDetail({
      name: id, category: t('assets.prefabs'), usedIn: placed, ref: path, glyph: 'package',
      preview: model === undefined ? null : settledPortrait(editor, model, 320),
      actions: editor.editing ? [{ label: t('assets.addToScene'), primary: true, run: () => editor.addPrefab(id) }] : [],
    });
  }

  /** Replace…: ask for the file or URL to use instead, then rewrite every data file that names it. */
  #replace(asset: UsedAsset): void {
    const editor = this.#editor;
    const input = h('input.settings-select.replace-input', { type: 'text', value: asset.ref, spellcheck: 'false', 'aria-label': t('assets.replaceWithRef') });
    const files = asset.usedIn.filter((p) => p.endsWith('.json'));
    const apply = (): void => {
      const to = input.value.trim();
      if (to === '' || to === asset.ref) { modal.close(); return; }
      const patches: FilePatch[] = [];
      for (const path of files) {
        const ops = replaceOps(editor.documents.json(path), asset.ref, to);
        if (ops.length > 0) patches.push({ path, ops: ops as FilePatch['ops'] });
      }
      modal.close();
      if (patches.length === 0) {
        editor.write('warning', t('assets.replaceNoUses'));
        return;
      }
      editor.run(t('assets.replaceUndoLabel'), () => {
        editor.session.history.commit(t('assets.replaceUndoLabel'), patches);
        editor.session.refresh();
      }, 'documents', 'world', 'selection');
      editor.write('info', `Replaced ${asset.ref} with ${to} in ${patches.map((p) => p.path).join(', ')}`);
    };
    input.addEventListener('keydown', (event) => { if (event.key === 'Enter') apply(); });
    const modal = showModal({
      title: t('assets.replaceTitle'), width: '460px', closeLabel: t('settings.close'),
      body: [
        h('div.settings-row', {}, h('label.settings-label', { text: t('assets.replaceWithRef') }), input,
          h('span.settings-hint', { text: t('assets.replaceHint', { count: files.length }) })),
        h('div.modal-actions', {}, h('button.modal-button', { type: 'button', text: t('settings.cancel'), onclick: () => modal.close() }),
          h('button.modal-button.primary', { type: 'button', text: t('assets.replaceConfirm'), onclick: apply })),
      ],
    });
    input.focus();
    input.select();
  }

  /** A collapsible USED ASSETS row: chevron, icon, label, count; its tiles when open. */
  #appendCategory(id: string, label: string, glyph: IconName, count: number, items: () => HTMLElement[]): void {
    // A search opens every row it found something in.
    const open = this.#expanded.has(id) || (this.#filter.value.trim() !== '' && count > 0);
    const header = h('button.asset-category-header', {
      type: 'button', 'aria-expanded': String(open),
      onclick: () => {
        if (this.#expanded.has(id)) this.#expanded.delete(id);
        else this.#expanded.add(id);
        this.#renderFiles();
      },
    }, h('span.asset-category-arrow', {}, icon('chevron', 12)), h('span.asset-category-icon', {}, icon(glyph, 14)), h('span.asset-category-label', { text: label }), h('span.asset-category-count', { text: String(count) }));
    const section = h(`div.asset-category.${id}`, {}, header);
    section.classList.toggle('open', open);
    if (open) {
      const grid = h('div.asset-tile-grid');
      const tiles = items();
      if (tiles.length === 0) grid.append(h('p.asset-category-empty', { text: this.#filter.value.trim() === '' ? t('assets.noItemsFound') : t('assets.noAssetsFound') }));
      grid.append(...tiles);
      section.append(grid);
    }
    this.#files.append(section);
  }

  /** Warnings and errors since the last look, as toasts (they stack; click one to dismiss it). */
  #renderLog(): void {
    const log = this.#editor.log;
    if (log.length < this.#shownLog) this.#shownLog = 0;
    const fresh = log.slice(this.#shownLog).filter((e) => e.level !== 'info');
    this.#shownLog = log.length;
    for (const entry of fresh.slice(-3)) this.#showToast(entry);
  }

  /** One toast system (toast.ts): the entry's text, its first diagnostics under it; errors stay until clicked. */
  #showToast(entry: LogEntry): void {
    if (entry.level === 'info') return;
    const toast = showToast(entry.text, entry.level, entry.level === 'error' ? { durationMs: 0 } : {});
    if (entry.diagnostics.length > 0 && toast.el.querySelector('.toast-diagnostics') === null) {
      toast.el.append(h('pre.toast-diagnostics', { text: entry.diagnostics.slice(0, 3).map(formatDiagnostic).join('\n\n') }));
    }
  }

}
