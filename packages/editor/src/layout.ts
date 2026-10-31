/**
 * The editor's frame, laid out as a classic three-column editor: the top bar, then the hierarchy on
 * the left, the viewport over the bottom panel (assets & performance) in the middle, and the
 * properties on the right. A host page may put its own panel (e.g. a help or chat panel) in the right
 * column (`mountSide`); the properties then move under the hierarchy. Column widths, the left
 * split and the bottom height survive reloads (localStorage, best effort).
 *
 * On a phone (mobile.ts: a touch-primary device, or a window under 700 px) it takes the
 * phone layout instead: the viewport on top and, under a draggable divider,
 * the panels. With a host's side panel mounted that
 * panel is all a phone shows under the viewport; without one, Hierarchy, Properties and Assets
 * are tabs there. In landscape the viewport fills the screen and the panels slide up as a
 * sheet. The same panel elements move between the two arrangements, so nothing is rebuilt
 * when the window crosses the breakpoint.
 *
 * The panels show or hide (`setPanelsOpen`, `togglePanels`): the host's side panel on a
 * desktop, the panels under the viewport in phone portrait, the sheet in phone landscape
 * (closed until asked for). Without a host side panel a phone's top bar has its own toggle
 * (toolbar.ts); a host that mounts one adds its own (EditorHost.toggleSide).
 *
 * Chrome (`setChrome`): 'full', or 'viewport-only' — the viewport alone, no top bar, panels,
 * resizers or phone tabs (a native app embedding the editor draws its own controls). Read-only
 * (`setReadOnly`): a full-width banner under the top bar says why editing is locked; a host adds
 * its own banners there too (`setBanner`). In 'viewport-only' they lie over the viewport's top edge.
 */

import { h } from './dom.js';
import { onLanguageChange, t } from './i18n.js';
import { watchMobileLayout } from './mobile.js';

const STORE = 'parallax-editor:layout';

/** What the editor shows around the viewport. */
export type EditorChrome = 'full' | 'viewport-only';

/** A banner's color: 'accent' (the editor's), 'info', 'warning', 'error' or 'success'. */
export type BannerTone = 'accent' | 'info' | 'warning' | 'error' | 'success';

/** A full-width banner under the top bar (`EditorLayout.setBanner`, `EditorHost.setBanner`). */
export interface Banner {
  readonly text: string;
  /** Default 'accent'. */
  readonly tone?: BannerTone;
  /** A link after the text (opens in a new tab). */
  readonly link?: { readonly label: string; readonly href: string };
  /** An element of the host's own after the text (and link): a toggle, a status pill. */
  readonly element?: HTMLElement;
}

const READ_ONLY_BANNER = 'read-only';

interface Sizes { left: number; leftSplit: number; right: number; bottom: number }

const DEFAULTS: Sizes = { left: 300, leftSplit: 0.5, right: 380, bottom: 260 };

function loadSizes(): Sizes {
  try {
    const raw = globalThis.localStorage?.getItem(STORE);
    if (raw !== null && raw !== undefined) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Sizes>) };
  } catch {
    // No storage (private window, blocked site data): defaults.
  }
  return { ...DEFAULTS };
}

function saveSizes(sizes: Sizes): void {
  try {
    globalThis.localStorage?.setItem(STORE, JSON.stringify(sizes));
  } catch {
    // Not kept; the layout still works.
  }
}

export class EditorLayout {
  readonly el: HTMLElement;
  readonly top: HTMLElement;
  /** The left column's upper slot (the hierarchy). */
  readonly left: HTMLElement;
  /** The left column's lower slot: the properties while a host panel holds the right column. */
  readonly leftBottom: HTMLElement;
  readonly center: HTMLElement;
  readonly bottom: HTMLElement;
  /** The right column: the properties, or a host page's own panel. */
  readonly right: HTMLElement;
  readonly #leftColumn: HTMLElement;
  readonly #split: HTMLElement;
  #properties: HTMLElement | undefined;
  #side: HTMLElement | null = null;
  readonly #rightResizer: HTMLElement;
  readonly #middle: HTMLElement;
  readonly #body: HTMLElement;
  readonly #sizes = loadSizes();
  #mobile = false;
  readonly #phone: PhoneLayout;
  #chrome: EditorChrome = 'full';
  readonly #banner: HTMLElement;
  readonly #banners = new Map<string, HTMLElement>();
  /** Whether the host's side panel (desktop) / the phone's panels (portrait) are wanted open. */
  #sideOpen = true;
  readonly #panelListeners = new Set<() => void>();

  constructor() {
    this.top = h('header.editor-top');
    this.left = h('div.editor-left-slot');
    this.leftBottom = h('div.editor-left-slot.lower');
    this.#split = this.#splitResizer();
    this.#leftColumn = h('aside.editor-column.left', {}, this.left, this.#split, this.leftBottom);
    this.center = h('main.editor-viewport-slot');
    this.bottom = h('div.editor-bottom');
    this.right = h('aside.editor-column.right');
    this.#rightResizer = this.#columnResizer('right');
    this.#middle = h('div.editor-column.center', {}, this.center, this.#rowResizer(), this.bottom);
    this.#body = h('div.editor-body', {}, this.#leftColumn, this.#columnResizer('left'), this.#middle, this.#rightResizer, this.right);
    this.#banner = h('div.editor-banners', { hidden: true });
    this.el = h('div.editor-app', {}, this.top, this.#banner, this.#body);
    this.#phone = new PhoneLayout(() => this.#panelsChanged());
    watchMobileLayout((mobile) => this.#setMobile(mobile));
    this.#apply();
  }

  /** Whether the phone layout is in use. */
  get mobile(): boolean {
    return this.#mobile;
  }

  /** Whether a host's side panel is mounted (`mountSide`). */
  get hasSide(): boolean {
    return this.#side !== null;
  }

  /**
   * Whether the panels show: on a desktop the host's side panel (false without one); on a
   * phone the panels under the viewport (portrait) or the sheet over it (landscape).
   */
  get panelsOpen(): boolean {
    if (this.#mobile) return this.#phone.landscape ? this.#phone.sheetOpen : this.#sideOpen;
    return this.#side !== null && this.#sideOpen;
  }

  /** Show or hide the panels (see `panelsOpen`); the viewport takes the space they free. */
  setPanelsOpen(open: boolean): void {
    if (open === this.panelsOpen) return;
    if (this.#mobile && this.#phone.landscape) {
      this.#phone.setSheet(open);
      return;
    }
    this.#sideOpen = open;
    this.#place();
    // The viewport's size changed: its canvas follows on the next resize event.
    globalThis.dispatchEvent?.(new Event('resize'));
  }

  /** Flip `panelsOpen`; returns the new state. */
  togglePanels(): boolean {
    this.setPanelsOpen(!this.panelsOpen);
    return this.panelsOpen;
  }

  /**
   * Call `listener` whenever the panels' state may have changed: opened or closed, the phone
   * layout or orientation flipped, a side panel mounted or removed. Returns a remover.
   */
  onPanelsChange(listener: () => void): () => void {
    this.#panelListeners.add(listener);
    return () => { this.#panelListeners.delete(listener); };
  }

  #panelsChanged(): void {
    for (const listener of [...this.#panelListeners]) {
      try {
        listener();
      } catch (error) {
        console.error('Parallax editor: a panels listener threw', error);
      }
    }
  }

  get chrome(): EditorChrome {
    return this.#chrome;
  }

  /** 'viewport-only' hides everything but the viewport; 'full' brings it all back as it was. */
  setChrome(chrome: EditorChrome): void {
    this.#chrome = chrome;
    this.el.classList.toggle('chrome-viewport-only', chrome === 'viewport-only');
    // The viewport's size changed: its canvas follows on the next resize event.
    globalThis.dispatchEvent?.(new Event('resize'));
  }

  /**
   * Show why editing is locked (a banner across the editor), or hide it (null). `look`: its tone
   * and an element of the host's own in it (default: the accent tone, no element).
   */
  setReadOnly(reason: string | null, look: Pick<Banner, 'tone' | 'element'> = {}): void {
    this.setBanner(READ_ONLY_BANNER, reason === null ? null : { text: reason, ...look });
    this.#banners.get(READ_ONLY_BANNER)?.setAttribute('title', t('editor.readOnlyTitle'));
    this.el.classList.toggle('read-only', reason !== null);
  }

  /**
   * Show a full-width banner under the top bar, or replace the one shown under `id`; null
   * removes it. Banners stack in the order first shown; the read-only one is first.
   */
  setBanner(id: string, banner: Banner | null): void {
    const old = this.#banners.get(id);
    if (banner === null) {
      old?.remove();
      this.#banners.delete(id);
    } else {
      const children: (HTMLElement | string)[] = [h('span.editor-banner-text', {}, banner.text)];
      if (banner.link !== undefined) {
        children.push(h('a.editor-banner-link', { href: banner.link.href, target: '_blank', rel: 'noopener noreferrer' }, banner.link.label));
      }
      if (banner.element !== undefined) children.push(banner.element);
      const el = h(`div.editor-banner.tone-${banner.tone ?? 'accent'}` as 'div.editor-banner', { role: 'status' }, ...children);
      if (old !== undefined) old.replaceWith(el);
      else if (id === READ_ONLY_BANNER) this.#banner.prepend(el);
      else this.#banner.append(el);
      this.#banners.set(id, el);
    }
    this.#banner.hidden = this.#banners.size === 0;
  }

  #setMobile(mobile: boolean): void {
    if (mobile === this.#mobile) return;
    this.#mobile = mobile;
    this.el.classList.toggle('mobile', mobile);
    if (mobile) {
      this.#phone.viewport.append(this.center);
      this.#phone.pane('hierarchy').append(this.left);
      this.#phone.pane('assets').append(this.bottom);
      this.el.replaceChildren(this.top, this.#banner, this.#phone.el);
    } else {
      this.#leftColumn.replaceChildren(this.left, this.#split, this.leftBottom);
      this.#middle.replaceChildren(this.center, this.#middle.querySelector('.row-resizer') ?? this.#rowResizer(), this.bottom);
      this.el.replaceChildren(this.top, this.#banner, this.#body);
    }
    this.#place();
  }

  /** The properties panel: on the right, or under the hierarchy while a host panel is mounted. */
  setProperties(panel: HTMLElement): void {
    this.#properties = panel;
    this.#place();
  }

  /** Put a host's panel in the right column; null gives the column back to the properties. */
  mountSide(panel: HTMLElement | null): void {
    this.#side = panel;
    this.#place();
  }

  #place(): void {
    const props = this.#properties === undefined ? [] : [this.#properties];
    if (this.#mobile) {
      this.right.replaceChildren();
      this.leftBottom.replaceChildren();
      this.#phone.pane('properties').replaceChildren(...props);
      this.#phone.setSide(this.#side);
      this.#phone.setClosed(!this.#sideOpen);
      this.#apply();
      this.#panelsChanged();
      return;
    }
    this.#phone.setSide(null);
    this.#phone.setClosed(false);
    // A closed side panel gives the right column back to the properties.
    if (this.#side !== null && this.#sideOpen) {
      this.right.replaceChildren(this.#side);
      this.leftBottom.replaceChildren(...props);
    } else {
      this.right.replaceChildren(...props);
      this.leftBottom.replaceChildren();
    }
    this.#apply();
    this.#panelsChanged();
  }

  #apply(): void {
    const side = this.right.childElementCount > 0;
    this.right.hidden = !side;
    this.#rightResizer.hidden = !side;
    const lower = this.leftBottom.childElementCount > 0;
    this.leftBottom.hidden = !lower;
    this.#split.hidden = !lower;
    this.#leftColumn.style.width = `${this.#sizes.left}px`;
    this.right.style.width = `${this.#sizes.right}px`;
    this.left.style.flex = lower ? `${this.#sizes.leftSplit} 1 0` : '1 1 0';
    this.leftBottom.style.flex = `${1 - this.#sizes.leftSplit} 1 0`;
    // On a phone the bottom panel fills its tab instead.
    this.bottom.style.height = this.#mobile ? '' : `${this.#sizes.bottom}px`;
  }

  #drag(onMove: (dx: number, dy: number) => void): (event: PointerEvent) => void {
    return (down: PointerEvent) => {
      down.preventDefault();
      const target = down.currentTarget as HTMLElement;
      target.setPointerCapture(down.pointerId);
      target.classList.add('dragging');
      let x = down.clientX;
      let y = down.clientY;
      const move = (event: PointerEvent): void => {
        onMove(event.clientX - x, event.clientY - y);
        x = event.clientX;
        y = event.clientY;
        this.#apply();
      };
      const up = (): void => {
        target.classList.remove('dragging');
        target.removeEventListener('pointermove', move);
        target.removeEventListener('pointerup', up);
        target.removeEventListener('pointercancel', up);
        saveSizes(this.#sizes);
      };
      target.addEventListener('pointermove', move);
      target.addEventListener('pointerup', up);
      target.addEventListener('pointercancel', up);
    };
  }

  #columnResizer(side: 'left' | 'right'): HTMLElement {
    return h('div.column-resizer', {
      onpointerdown: this.#drag((dx) => {
        const next = this.#sizes[side] + (side === 'left' ? dx : -dx);
        this.#sizes[side] = Math.max(200, Math.min(640, next));
      }) as (event: Event) => void,
    });
  }

  #splitResizer(): HTMLElement {
    return h('div.row-resizer', {
      onpointerdown: this.#drag((_dx, dy) => {
        const height = Math.max(1, this.#leftColumn.clientHeight);
        this.#sizes.leftSplit = Math.max(0.15, Math.min(0.85, this.#sizes.leftSplit + dy / height));
      }) as (event: Event) => void,
    });
  }

  #rowResizer(): HTMLElement {
    return h('div.row-resizer', {
      onpointerdown: this.#drag((_dx, dy) => {
        this.#sizes.bottom = Math.max(80, Math.min(globalThis.innerHeight - 200, this.#sizes.bottom - dy));
      }) as (event: Event) => void,
    });
  }
}

type PhoneTab = 'side' | 'hierarchy' | 'properties' | 'assets';

/**
 * The phone arrangement: the viewport container, the
 * divider (drag it to give the viewport 25–75% of the height) and the panels: a host's side
 * panel alone, or tabs for the editor's own. In landscape the panels are a sheet over the
 * viewport, opened from the top bar (EditorLayout.setPanelsOpen).
 */
class PhoneLayout {
  readonly el: HTMLElement;
  readonly viewport: HTMLElement;
  readonly #panels: HTMLElement;
  readonly #strip: HTMLElement;
  readonly #tabs = new Map<PhoneTab, { tab: HTMLButtonElement; pane: HTMLElement }>();
  readonly #landscape = globalThis.matchMedia?.('(orientation: landscape)');
  #active: PhoneTab = 'hierarchy';

  /** `changed`: the sheet opened or closed, or the orientation flipped. */
  constructor(private readonly changed: () => void) {
    this.viewport = h('div.mobile-viewport-container');
    this.#strip = h('div.mobile-panel-tabs', { role: 'tablist' });
    const panes = h('div.mobile-panel-panes');
    const labels: Record<Exclude<PhoneTab, 'side'>, () => string> = {
      hierarchy: () => t('hierarchy.title'),
      properties: () => t('properties.title'),
      assets: () => t('mobile.assets'),
    };
    for (const id of ['side', 'hierarchy', 'properties', 'assets'] as const) {
      // The side panel never has a tab: when mounted it is the only thing shown.
      const tab = h('button.mobile-panel-tab', { type: 'button', role: 'tab', text: id === 'side' ? '' : labels[id](), onclick: () => this.show(id) });
      tab.hidden = id === 'side';
      const pane = h('div.mobile-panel-pane', { role: 'tabpanel' });
      this.#strip.append(tab);
      panes.append(pane);
      this.#tabs.set(id, { tab, pane });
    }
    const handle = h('button.mobile-sheet-handle', { type: 'button', 'aria-label': t('mobile.closePanels') });
    this.#panels = h('div.mobile-panels', {}, handle, this.#strip, panes);
    this.#sheetHandle(handle);
    const divider = h('div.mobile-divider', {}, h('div.mobile-divider-handle'));
    this.#divider(divider);
    this.el = h('div.mobile-editor-body', {}, this.viewport, divider, this.#panels);
    // Rotating hands the space back to the stylesheet and closes the landscape sheet.
    this.#landscape?.addEventListener?.('change', () => {
      this.viewport.style.flex = '';
      this.viewport.style.height = '';
      this.#panels.classList.remove('open');
      this.#panels.style.height = '';
      this.changed();
      globalThis.dispatchEvent?.(new Event('resize'));
    });
    onLanguageChange(() => {
      for (const [id, { tab }] of this.#tabs) if (id !== 'side') tab.textContent = labels[id]();
      handle.setAttribute('aria-label', t('mobile.closePanels'));
    });
    this.setSide(null);
    this.show('hierarchy');
  }

  get landscape(): boolean {
    return this.#landscape?.matches === true;
  }

  /** Whether the landscape sheet is open. */
  get sheetOpen(): boolean {
    return this.#panels.classList.contains('open');
  }

  pane(id: PhoneTab): HTMLElement {
    return this.#tabs.get(id)!.pane;
  }

  /** A host's side panel is all the phone shows under the viewport, or (null) the editor's tabs come back. */
  setSide(panel: HTMLElement | null): void {
    const side = this.#tabs.get('side')!;
    if (side.pane.firstElementChild !== panel) side.pane.replaceChildren(...(panel === null ? [] : [panel]));
    this.#strip.hidden = panel !== null;
    if (panel !== null) this.show('side');
    else if (this.#active === 'side') this.show('hierarchy');
  }

  /** Portrait: hide the panels under the viewport (it takes the whole height), or bring them back. */
  setClosed(closed: boolean): void {
    this.el.classList.toggle('panels-closed', closed);
  }

  show(id: PhoneTab): void {
    this.#active = id;
    for (const [key, { tab, pane }] of this.#tabs) {
      tab.classList.toggle('active', key === id);
      tab.setAttribute('aria-selected', String(key === id));
      pane.hidden = key !== id;
    }
  }

  setSheet(open: boolean): void {
    if (open === this.sheetOpen) return;
    // Opens full height (under the top bar, over the whole viewport); a drag made it shorter.
    if (open) this.#panels.style.height = '';
    this.#panels.classList.toggle('open', open);
    this.changed();
  }

  /**
   * Landscape: the sheet's handle. A tap closes the sheet; a drag resizes it (25–100% of the
   * space under the top bar), and letting go below a quarter closes it.
   */
  #sheetHandle(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (down) => {
      down.preventDefault();
      handle.setPointerCapture?.(down.pointerId);
      const total = this.el.getBoundingClientRect().height;
      const bottom = this.el.getBoundingClientRect().bottom;
      let moved = false;
      let height = this.#panels.getBoundingClientRect().height;
      this.#panels.style.transition = 'none';
      const move = (event: PointerEvent): void => {
        if (Math.abs(event.clientY - down.clientY) > 4) moved = true;
        if (!moved) return;
        height = Math.max(0, Math.min(total, bottom - event.clientY));
        this.#panels.style.height = `${Math.round(height)}px`;
      };
      const up = (): void => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        this.#panels.style.transition = '';
        if (!moved || height < total * 0.25) this.setSheet(false);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  /** Portrait: drag the divider to share the height between the viewport and the panels. */
  #divider(divider: HTMLElement): void {
    divider.addEventListener('pointerdown', (down) => {
      if (this.#landscape?.matches === true) return;
      down.preventDefault();
      divider.setPointerCapture(down.pointerId);
      const startY = down.clientY;
      const startHeight = this.viewport.getBoundingClientRect().height;
      const move = (event: PointerEvent): void => {
        const total = this.el.getBoundingClientRect().height;
        const height = Math.max(total * 0.25, Math.min(total * 0.75, startHeight + event.clientY - startY));
        this.viewport.style.flex = 'none';
        this.viewport.style.height = `${height}px`;
      };
      const up = (): void => {
        divider.removeEventListener('pointermove', move);
        divider.removeEventListener('pointerup', up);
        divider.removeEventListener('pointercancel', up);
      };
      divider.addEventListener('pointermove', move);
      divider.addEventListener('pointerup', up);
      divider.addEventListener('pointercancel', up);
    });
  }
}
