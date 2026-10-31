/**
 * `bootEditor`: the editor page. Lays out the panels, boots the game in edit mode inside
 * the viewport, opens an EditorSession on the project's documents and wires everything
 * together — Play on the top bar runs the game in place, Stop comes back to the edit world.
 *
 * Rebuilds from `parallax edit` (a .py file changed) hot-reload into the session; data
 * documents changed outside the editor go into the session in place (outside_changes.ts);
 * markup and assets changed outside reload the page when nothing is unsaved.
 */

import { bootBrowser } from '@parallax/runtime/boot';
import type { BrowserGame } from '@parallax/runtime/boot';
import type { Diagnostic } from '@parallax/runtime/core';
import type { BootBranding } from '@parallax/runtime/platform';
import { EditorSession, ProjectDocuments } from './session/index.js';
import { browserHost, exposeAutomation } from './session/browser.js';
import { BottomPanels } from './bottom_panels.js';
import { h, panelFrame } from './dom.js';
import { Editor, editorPageTitle } from './editor.js';
import { HierarchyPanel } from './hierarchy.js';
import { InspectorPanel } from './inspector.js';
import { EditorLayout } from './layout.js';
import type { EditorChrome } from './layout.js';
import { setSite } from './site.js';
import type { EditorSite } from './site.js';
import { needsCode, onBuild } from './server_link.js';
import { fetchProjectFiles, needsRuntime, planOutsideChanges } from './outside_changes.js';
import type { BuildEvent } from './server_link.js';
import { installShortcuts } from './shortcuts.js';
import { failedToolbar, Toolbar } from './toolbar.js';
import { t } from './i18n.js';
import type { CameraModeHost } from './toolbar.js';
import { AssetLibraryPanel } from './asset_library_panel.js';
import { PerformancePanel } from './performance_panel.js';
import { showEditorLoading } from './loading_screen.js';
import { serverUrl, setServerBase } from './paths.js';
import { createEditorHost } from './host.js';
import type { EditorHost } from './host.js';
import { comingSoonPublish } from './publish_dialog.js';
import { syncProjectUrl } from './project_switcher.js';
import { Viewport } from './viewport.js';
import { setToastRoot, showToast, toastSaves } from './toast.js';
import { showUnsupportedBrowser } from './unsupported_browser.js';

export interface EditorBootOptions {
  /** The element the editor fills. */
  readonly root: HTMLElement;
  /** The project's name, for the top bar. */
  readonly title: string;
  /** The build number the page was served with: modules under `/build/v<version>/`. */
  readonly version: number;
  readonly diagnostics: readonly Diagnostic[];
  readonly assetFiles: boolean;
  readonly panelFrame: string;
  readonly jobWorker: string;
  /** Where the editor's server lives (default `/`, as `parallax edit` serves it); a host page passes its own. */
  readonly base?: string;
  /** 'viewport-only': the viewport alone, no top bar or panels (`EditorHost.setChrome`). Default 'full'. */
  readonly chrome?: EditorChrome;
  /** Start locked (`EditorHost.setReadOnly`): the indicator's text. */
  readonly readOnly?: string;
  /** The platform names the editor shows (site.ts): name, host, top bar logo. */
  readonly site?: Partial<EditorSite>;
  /** The viewport's loading screen colors and logo (the game boot's `branding`). */
  readonly branding?: BootBranding;
  /**
   * The project menu under the name and `?project=` in the URL (`parallax edit`'s sibling
   * projects, `/__parallax__/projects.json`). Default true; a host that serves one project per
   * page passes false, and nothing asks for the listing.
   */
  readonly projectSwitcher?: boolean;
}

/**
 * The game could not start (a build error, a crash while starting): the editor shows the
 * frame and the error, and reloads after the next clean build. `globalThis.parallaxEditorFailure`
 * and the `parallax-editor-failed` window event's `detail`.
 */
export interface EditorBootFailure {
  /** The empty frame: `mountSide(panel)` still puts a host panel in the right column. */
  readonly layout: EditorLayout;
  readonly title: string;
  readonly diagnostics: readonly Diagnostic[];
}

const buildUrl = (version: number): string => serverUrl(`build/v${version}/`);

/** The boot's steps, as the loading screen names them. */
const STAGE_LABEL: Readonly<Record<string, string>> = {
  engine: 'boot.loadingScripts', data: 'boot.downloadingData', assets: 'boot.downloadingAssets', start: 'boot.preparingScene',
};

export async function bootEditor(options: EditorBootOptions): Promise<Editor | undefined> {
  setServerBase(options.base ?? '/');
  if (options.site !== undefined) setSite(options.site);
  // `?project=` names the project: switch the server to it first (the page reloads), or
  // write the served one into the URL.
  const switcher = options.projectSwitcher ?? true;
  const projectUrl: { reloading: boolean; problem?: string } = switcher ? await syncProjectUrl() : { reloading: false };
  if (projectUrl.reloading) return undefined;
  document.title = editorPageTitle(options.title);
  const layout = new EditorLayout();
  if (options.chrome !== undefined) layout.setChrome(options.chrome);
  const viewport = new Viewport();
  layout.center.append(viewport.el);
  options.root.append(layout.el);
  // The shell is up at once: the top bar (its project switcher already live) and each panel
  // in its empty state. Only the viewport shows the boot's progress, until the game is ready.
  layout.top.append(failedToolbar(options.title, t('toolbar.loading'), 'loading', { projectSwitcher: switcher }));
  const placeholder = (title: string, text: string): HTMLElement => {
    const frame = panelFrame(title);
    frame.body.append(h('p.panel-empty', { text }));
    return frame.root;
  };
  layout.left.append(placeholder(t('hierarchy.title'), t('toolbar.loading')));
  layout.setProperties(placeholder(t('properties.title'), t('properties.noSelection')));
  layout.bottom.append(placeholder(t('assets.title'), t('toolbar.loading')));
  const loading = showEditorLoading(viewport.el, { label: t('toolbar.loading'), compact: true });

  let version = options.version;
  let failure: { title: string; diagnostics: readonly Diagnostic[] } | undefined;
  let editor: Editor | undefined;
  let game: BrowserGame | undefined;
  game = await bootBrowser({
    mount: viewport.mount,
    build: buildUrl(version),
    project: serverUrl('project/'),
    fileIndex: serverUrl('project-files.json'),
    diagnostics: options.diagnostics,
    editing: true,
    seed: 1,
    assetFiles: options.assetFiles,
    panelFrame: options.panelFrame,
    jobWorker: options.jobWorker,
    ...(options.branding !== undefined && { branding: options.branding }),
    onProgress: (event) => loading.progress(event.overall, STAGE_LABEL[event.stage] === undefined ? undefined : t(STAGE_LABEL[event.stage]!)),
    onError: (title, diagnostics) => {
      if (editor === undefined || game === undefined) {
        failure = { title, diagnostics };
        return;
      }
      recover(editor, game, title, diagnostics);
    },
  });

  loading.done();
  if (game === undefined) {
    showUnsupportedBrowser(viewport.el, failure?.diagnostics); // neither WebGPU nor WebGL2: say so plainly
    // The build or the start failed: the stage shows why. Try again once a build is clean.
    // The same frame as a working editor, empty: the viewport shows what to fix.
    layout.top.replaceChildren(failedToolbar(options.title, failure?.title ?? t('boot.couldNotStart'), 'failed', { projectSwitcher: switcher }));
    const waiting = t('boot.fixProblems');
    layout.left.replaceChildren(placeholder(t('hierarchy.title'), waiting));
    layout.setProperties(placeholder(t('properties.title'), t('properties.noSelection')));
    layout.bottom.replaceChildren(placeholder(t('assets.title'), waiting));
    if (projectUrl.problem !== undefined) {
      const root = h('div.editor-toast-root');
      layout.center.append(root);
      setToastRoot(root);
      showToast(projectUrl.problem, 'warning');
    }
    onBuild((event) => { if (!event.diagnostics.some((d) => d.severity === 'error')) reloadForCleanBuild(); });
    // A host still gets the frame: its side panel (a tool that can help fix the project) has
    // to be reachable exactly when the game can't start. No EditorHost — there is no editor.
    const failed: EditorBootFailure = {
      layout, title: failure?.title ?? t('boot.couldNotStart'), diagnostics: failure?.diagnostics ?? [],
    };
    (globalThis as { parallaxEditorFailure?: EditorBootFailure }).parallaxEditorFailure = failed;
    globalThis.dispatchEvent?.(new CustomEvent('parallax-editor-failed', { detail: failed }));
    return undefined;
  }

  const documents = new ProjectDocuments(game.sources.files);
  const session = new EditorSession({ runtime: game.runtime, documents, host: browserHost(game, () => buildUrl(version)) });
  editor = new Editor(game, session, options.title);
  editor.buildDiagnostics = options.diagnostics;
  const bottom = new BottomPanels(editor, { library: new AssetLibraryPanel(editor), performance: new PerformancePanel(editor) });
  const camera = 'cameraMode' in viewport ? viewport as unknown as CameraModeHost : undefined;
  const toolbar = new Toolbar(editor, camera, { projectSwitcher: switcher });
  layout.top.replaceChildren(toolbar.el);
  // A phone's own panels toggle (Hierarchy / Properties / Assets): a host that mounts a side
  // panel there brings its own toggle (EditorHost.toggleSide), so this one steps aside.
  const syncPanelsToggle = (): void => toolbar.setPanelsToggle(() => layout.togglePanels(), layout.mobile && !layout.hasSide, layout.panelsOpen);
  layout.onPanelsChange(syncPanelsToggle);
  syncPanelsToggle();
  layout.left.replaceChildren(new HierarchyPanel(editor, () => bottom.showPrefabs()).el);
  layout.setProperties(new InspectorPanel(editor).el);
  layout.bottom.replaceChildren(bottom.el);
  layout.center.append(bottom.toast);
  viewport.attach(editor);
  installShortcuts(editor, viewport);

  const warnings = options.diagnostics.filter((d) => d.severity === 'warning');
  editor.write('info', `Editing ${session.scene} (${session.dimension}). Press Play on the top bar to run it here.`);
  if (warnings.length > 0) editor.write('warning', `The build has ${warnings.length} warning${warnings.length === 1 ? '' : 's'}`, warnings);
  if (projectUrl.problem !== undefined) editor.write('warning', projectUrl.problem);
  const problems = documents.project().diagnostics;
  if (problems.length > 0) editor.write('warning', 'The project\'s data has problems', problems);

  const ready = editor;
  // `build` once the event is taken in (the Asset Library places a just-added prefab then).
  const buildListeners = new Set<(event: BuildEvent) => void>();
  onBuild((event) => void rebuilt(ready, event, (v) => { version = v; }, viewport.el).finally(() => {
    ready.emit('build');
    for (const listener of [...buildListeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error('Parallax editor: a build listener threw', error);
      }
    }
  }));
  globalThis.addEventListener('beforeunload', (event) => {
    if (ready.documents.dirty().length > 0) event.preventDefault();
  });
  ready.startAutosave(); toastSaves(ready); // autosave every 30 s + on page hide, camera memory, "Project saved" toast
  exposeAutomation(game, session);
  // A host page extends the editor through this (host.ts): side panels, toolbar items, its own
  // Publish, bottom tabs, settings entries and events. `whenEditorReady` hands it over.
  const host = createEditorHost({
    editor, layout, toolbar, bottom, ...(camera !== undefined && { camera }), defaultPublish: () => comingSoonPublish(),
    onBuild: (listener) => { buildListeners.add(listener); return () => { buildListeners.delete(listener); }; },
  });
  if (options.readOnly !== undefined) host.setReadOnly(true, options.readOnly);
  const page = globalThis as { parallaxEditor?: Editor; parallaxEditorHost?: EditorHost; parallaxEditorLayout?: EditorLayout };
  page.parallaxEditor = editor;
  page.parallaxEditorHost = host;
  page.parallaxEditorLayout = layout; // kept for hosts written before EditorHost
  globalThis.dispatchEvent?.(new CustomEvent('parallax-editor-ready', { detail: { editor, layout, host } }));
  return editor;
}

const RELOAD_KEY = 'parallax:editor:clean-build-reload';
/** At most one reload of a failed editor per this long (see reloadForCleanBuild). */
const RELOAD_SPACING_MS = 30_000;
let reloadPending = false;

/**
 * A failed editor heard a clean build: reload to boot it. A server may announce a build the
 * page doesn't get on reload (a host's in-progress preview while another tool is still
 * writing), and the reloaded page fails again and hears it again: reloads are spaced
 * RELOAD_SPACING_MS apart (kept in sessionStorage across them), so that never becomes a loop
 * that keeps wiping the page — a host's open side panel included.
 */
function reloadForCleanBuild(): void {
  if (reloadPending) return;
  let last = 0;
  try { last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0; } catch { /* no storage: no spacing memory */ }
  const wait = Math.max(0, last + RELOAD_SPACING_MS - Date.now());
  reloadPending = true;
  setTimeout(() => {
    try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch { /* reload anyway */ }
    location.reload();
  }, Math.min(wait, RELOAD_SPACING_MS));
}

/**
 * The game loop stopped on an error: report it, go back to the edit world and keep the
 * page drawing (in the editor a crash ends the play session, not the editor).
 */
function recover(editor: Editor, game: BrowserGame, title: string, diagnostics: readonly Diagnostic[]): void {
  const playing = !editor.editing;
  editor.write('error', `${title}${playing ? ' — back to editing' : ''}`, diagnostics);
  setTimeout(() => {
    if (playing) editor.stop();
    game.overlay.clear();
    game.loop.start();
  }, 0);
}

async function rebuilt(editor: Editor, event: BuildEvent, setVersion: (v: number) => void, stage: HTMLElement): Promise<void> {
  const errors = event.diagnostics.filter((d) => d.severity === 'error');
  editor.buildDiagnostics = event.diagnostics;
  if (errors.length > 0) {
    editor.write('error', `The build has ${errors.length} error${errors.length === 1 ? '' : 's'}; still running the last good build`, errors);
    return;
  }
  // Files changed on disk: data documents in place; markup and assets need the page reloaded.
  const plan = planOutsideChanges(event.changed, new Set(editor.documents.dirty()), editor.readOnly !== null);
  if (plan.reload.length > 0 && editor.documents.dirty().length === 0 && editor.editing) {
    location.reload();
    return;
  }
  if (plan.documents.length > 0) {
    try {
      editor.takeOutsideChanges(await fetchProjectFiles(plan.documents));
    } catch (error) {
      editor.fail('Files changed outside', error);
    }
  }
  if (plan.conflicts.length > 0) {
    editor.write('warning', `Changed on disk: ${plan.conflicts.join(', ')}, which you have unsaved edits to. Save to overwrite them, or reload the page to take them (unsaved edits are lost).`);
  }
  if (plan.reload.length > 0) editor.write('warning', `Changed on disk: ${plan.reload.join(', ')}. Reload the page to see them.`);
  // New code, or a new asset document (a library model) the runtime's asset list lacks.
  if (!needsCode(event.changed) && !(editor.editing && needsRuntime(event.changed))) return;
  setVersion(event.version);
  // The viewport shows the reload; the panels keep working.
  const loading = showEditorLoading(stage, { label: t('boot.reloadingCode'), compact: true, delayMs: 150 });
  try {
    const result = await editor.session.reload();
    editor.write('info', result.restored || editor.editing ? 'Reloaded the game\'s code' : 'Reloaded the game\'s code; the scene restarted', result.diagnostics);
    editor.emit('world', 'selection', 'mode', 'documents');
  } catch (error) {
    editor.fail('Hot reload', error);
  } finally {
    loading.done();
  }
}
