/**
 * The project name on the top bar, and its menu of the projects next to this one (served by
 * `parallax edit`). Picking one switches the server to it and reloads the page. Works without
 * an editor session, so a project whose build fails can still be left.
 *
 * The page keeps the project in its URL (`?project=<name>`): `syncProjectUrl` (run by boot
 * before the game starts) switches the server to the project a link names, or writes the one
 * being served into the URL, so a reload or a shared link opens the same project.
 */

import { clear, h, icon } from './dom.js';
import { t } from './i18n.js';
import { serverUrl } from './paths.js';

export interface ProjectSwitcherHost {
  /** Unsaved changes to confirm before leaving (none: no prompt). */
  dirty(): number;
  /** Forget the unsaved changes, so the page leaves without the browser's prompt. */
  discard?(): void;
  error(text: string): void;
}

/** The query parameter naming the project. */
export const PROJECT_PARAM = 'project';

/** What `parallax edit` lists at `/__parallax__/projects.json`. */
export interface ProjectListing {
  readonly current: string;
  readonly projects: readonly string[];
}

export async function fetchProjects(fetcher: typeof fetch = fetch): Promise<ProjectListing> {
  const response = await fetcher(serverUrl('/__parallax__/projects.json'));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.json() as ProjectListing;
}

/** Ask the server to serve `name` instead; the error text when it refuses. */
export async function requestSwitch(name: string, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  const response = await fetcher(serverUrl('/__parallax__/switch'), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: name }),
  });
  if (response.ok) return undefined;
  const body = await response.json().catch(() => ({})) as { error?: string };
  return body.error ?? `Switching to ${name} failed (HTTP ${response.status})`;
}

/** `href` with `?project=<name>` set (other parameters and the hash kept). */
export function withProjectParam(href: string, name: string): string {
  const url = new URL(href);
  url.searchParams.set(PROJECT_PARAM, name);
  return url.toString();
}

/** What `syncProjectUrl` needs from the page (the real ones by default; a test passes fakes). */
export interface ProjectUrlEnv {
  readonly href: string;
  replace(href: string): void;
  reload(): void;
  fetch: typeof fetch;
  /** Survives the reload: the switch tried last, so a server that won't change can't loop. */
  readonly memory?: { get(): string | null; set(value: string | null): void };
}

const ATTEMPT = 'parallax-editor:project-switch';

function browserEnv(): ProjectUrlEnv {
  return {
    href: location.href,
    replace: (href) => history.replaceState(history.state, '', href),
    reload: () => location.reload(),
    fetch: (input, init) => fetch(input, init),
    memory: {
      get: () => { try { return sessionStorage.getItem(ATTEMPT); } catch { return null; } },
      set: (value) => {
        try {
          if (value === null) sessionStorage.removeItem(ATTEMPT);
          else sessionStorage.setItem(ATTEMPT, value);
        } catch {
          // No storage: a refused switch is still reported, once per load.
        }
      },
    },
  };
}

/**
 * Line the served project up with the URL. `?project=` naming another sibling project switches
 * the server to it and reloads (`'reloading'`: stop booting). Otherwise the URL is set to the
 * project being served; an unknown name (or a refused switch) comes back as a problem to show.
 */
export async function syncProjectUrl(env: ProjectUrlEnv = browserEnv()): Promise<{ reloading: boolean; problem?: string }> {
  const wanted = new URL(env.href).searchParams.get(PROJECT_PARAM)?.trim() || undefined;
  let listing: ProjectListing;
  try {
    listing = await fetchProjects(env.fetch);
  } catch {
    // Not served by `parallax edit` (a host page): nothing to line up.
    return { reloading: false };
  }
  const stay = (problem?: string): { reloading: false; problem?: string } => {
    env.memory?.set(null);
    env.replace(withProjectParam(env.href, listing.current));
    return problem === undefined ? { reloading: false } : { reloading: false, problem };
  };
  if (wanted === undefined || wanted === listing.current) return stay();
  if (!listing.projects.includes(wanted)) return stay(t('projects.noSuchProject', { name: wanted, current: listing.current }));
  if (env.memory?.get() === wanted) return stay(t('projects.switchRefused', { name: wanted, current: listing.current }));
  const refused = await requestSwitch(wanted, env.fetch);
  if (refused !== undefined) return stay(refused);
  env.memory?.set(wanted);
  env.reload();
  return { reloading: true };
}

export interface ProjectSwitcherOptions {
  /**
   * List the sibling projects (`/__parallax__/projects.json`) in a menu under the name
   * (default true, as `parallax edit` serves them). False: the name is a label, renamable
   * when a host sets a rename (`setRename`).
   */
  readonly menu?: boolean;
}

export class ProjectSwitcher {
  readonly el: HTMLElement;
  #title: string;
  readonly #host: ProjectSwitcherHost;
  readonly #button: HTMLButtonElement;
  readonly #chevron: SVGSVGElement;
  readonly #menu: HTMLElement;
  readonly #menuEnabled: boolean;
  #rename: (() => void) | null = null;

  constructor(title: string, host: ProjectSwitcherHost, options: ProjectSwitcherOptions = {}) {
    this.#title = title;
    this.#host = host;
    this.#menuEnabled = options.menu ?? true;
    this.#menu = h('div.project-menu', { hidden: true, role: 'menu' });
    this.#chevron = icon('chevron', 12);
    this.#button = h('button.toolbar-project-name', {
      type: 'button', title,
      onclick: (event: Event) => {
        event.stopPropagation();
        if (this.#rename !== null) this.#rename();
        else if (this.#menuEnabled) void this.toggle();
      },
    }, h('span', { text: title }), this.#chevron);
    this.el = h('div.toolbar-project', {}, this.#button, this.#menu);
    this.#dress();
    document.addEventListener('click', () => this.close());
  }

  /**
   * Make a click on the name rename the project (`run` asks for the new name);
   * null gives the click back to the project menu (or nothing, without one).
   */
  setRename(run: (() => void) | null): void {
    this.#rename = run;
    this.close();
    this.#dress();
  }

  /** The project's name changed (a rename). */
  setTitle(title: string): void {
    this.#title = title;
    this.#dress();
  }

  #dress(): void {
    const renamable = this.#rename !== null;
    const menu = !renamable && this.#menuEnabled;
    this.#chevron.style.display = menu ? '' : 'none';
    this.#button.classList.toggle('renamable', renamable);
    this.#button.classList.toggle('static', !renamable && !menu);
    this.#button.title = renamable ? t('toolbar.renameTooltip') : this.#title;
    if (menu) this.#button.setAttribute('aria-haspopup', 'menu');
    else this.#button.removeAttribute('aria-haspopup');
  }

  close(): void {
    this.#menu.hidden = true;
  }

  /** The name shown on the bar ("tank_battle *" with unsaved changes). */
  setLabel(text: string): void {
    const label = this.#button.querySelector('span');
    if (label !== null && label.textContent !== text) label.textContent = text;
  }

  async toggle(): Promise<void> {
    if (!this.#menu.hidden) {
      this.close();
      return;
    }
    clear(this.#menu);
    this.#menu.hidden = false;
    this.#menu.append(h('div.project-menu-note', { text: t('toolbar.loading') }));
    let listing: ProjectListing;
    try {
      listing = await fetchProjects();
    } catch {
      clear(this.#menu);
      this.#menu.append(h('div.project-menu-note', { text: t('projects.listUnavailable') }));
      return;
    }
    clear(this.#menu);
    for (const name of listing.projects) {
      const item = h('button.project-menu-item', { type: 'button', role: 'menuitem', text: name, onclick: () => void this.#switch(name) });
      item.classList.toggle('active', name === listing.current);
      this.#menu.append(item);
    }
  }

  async #switch(name: string): Promise<void> {
    this.close();
    if (name === this.#title) return;
    if (this.#host.dirty() > 0 && !confirm(t('toolbar.unsavedConfirm'))) return;
    const refused = await requestSwitch(name);
    if (refused !== undefined) {
      this.#host.error(refused);
      return;
    }
    this.#host.discard?.();
    // The reload opens the new project's URL (and a later reload stays on it).
    history.replaceState(history.state, '', withProjectParam(location.href, name));
    location.reload();
  }
}
