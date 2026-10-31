/**
 * The Performance tab: a live view of the game's `FrameStats` (`editor.game.stats`), laid
 * out as a profiler panel.
 *
 *   headline      FPS (colored by smoothness), the smoothness label, the render scale, Copy stats,
 *                 Copy camera (where the rendering camera is and looks, every game camera too)
 *   smoothness    wall frame time over the window, with 60 fps and 30 fps lines
 *   frame budget  the kernel's frame grouped into Scripts / Physics / Animation / Rendering /
 *                 Other, as a stacked bar with a legend
 *   on screen     draw calls, triangles, entities
 *   details       (collapsed) frame and engine milliseconds, memory, CPU phases, draws by
 *                 pass, renderer counts, per-script cost, plugin hooks, the JS heap chart
 *
 * Stats are on only while the tab is shown (`activate` / `deactivate`): hidden, the game
 * pays nothing. Polls at 4 Hz; the detail tables refresh at 1 Hz and only while open.
 * Rows and counters keep their DOM nodes across refreshes (text nodes are updated in place).
 */

import type { BudgetBucket, PerfSnapshot } from '@parallax/runtime/boot';
import { Vec3 } from '@parallax/runtime/core';
import type { Quat } from '@parallax/runtime/core';
import type { Editor } from './editor.js';
import { h, icon } from './dom.js';
import { lt, t } from './i18n.js';

const POLL_MS = 250;
const DETAIL_EVERY = 4;
const CONSUMER = 'performance-panel';
const TARGET_MS = 1000 / 60;

const BUCKET_COLORS: Readonly<Record<BudgetBucket, string>> = {
  Scripts: '#8860e6',
  Physics: '#d84c94',
  Animation: '#6ea8fe',
  Rendering: '#9bdb6a',
  Other: '#6a7591',
};

/** FPS thresholds and their label / tone (55 / 40 / 20 / 0). */
function smoothness(fps: number): { label: string; tone: 'smooth' | 'ok' | 'choppy' | 'laggy' | 'none' } {
  if (fps >= 55) return { label: t('perf.smooth'), tone: 'smooth' };
  if (fps >= 40) return { label: t('perf.ok'), tone: 'ok' };
  if (fps >= 20) return { label: t('perf.choppy'), tone: 'choppy' };
  if (fps > 0) return { label: t('perf.laggy'), tone: 'laggy' };
  return { label: '—', tone: 'none' };
}

export class PerformancePanel {
  readonly el: HTMLElement;
  readonly #editor: Editor;
  #timer: ReturnType<typeof setInterval> | undefined;
  #polls = 0;
  #last: PerfSnapshot | null = null;

  readonly #fps: HTMLElement;
  readonly #smooth: HTMLElement;
  readonly #scale: HTMLElement;
  readonly #mode: HTMLElement;
  readonly #copy: HTMLButtonElement;
  readonly #copyCamera: HTMLButtonElement;
  readonly #frameChart: HTMLCanvasElement;
  readonly #budgetBar: HTMLElement;
  readonly #budgetLegend: HTMLElement;
  readonly #budgetEmpty: HTMLElement;
  readonly #draws: HTMLElement;
  readonly #tris: HTMLElement;
  readonly #entities: HTMLElement;
  readonly #details: HTMLDetailsElement;
  readonly #frameMs: HTMLElement;
  readonly #cpuMs: HTMLElement;
  readonly #memory: HTMLElement;
  readonly #phases: HTMLTableSectionElement;
  readonly #passes: HTMLTableSectionElement;
  readonly #instances: HTMLElement;
  readonly #behaviors: HTMLElement;
  readonly #backend: HTMLElement;
  readonly #scripts: HTMLTableSectionElement;
  readonly #hooks: HTMLTableSectionElement;
  readonly #heapSection: HTMLElement;
  readonly #heapChart: HTMLCanvasElement;

  constructor(editor: Editor) {
    this.#editor = editor;

    // Headline
    this.#fps = h('div.perf-big', { text: '-- FPS' });
    this.#smooth = h('div.perf-pill', { text: '—' });
    this.#scale = h('div.perf-pill', { text: 'RS —', ...lt('perf.scaleTitle', 'title') });
    this.#mode = h('div.perf-pill', { text: '' });
    this.#copy = h('button.perf-button', { type: 'button', ...lt('perf.copyStats'), ...lt('perf.copyStatsTitle', 'title'), onclick: () => void this.#copyStats() });
    this.#copyCamera = h('button.perf-button', {
      type: 'button', text: t('performance.copyCamera'), title: t('performance.copyCameraHint'), onclick: () => void this.#copyCameraPose(),
    });
    const headline = h('div.perf-headline', {}, this.#fps, this.#smooth, this.#scale, this.#mode, h('div.perf-actions', {}, this.#copy, this.#copyCamera));

    // Smoothness chart
    this.#frameChart = h('canvas.perf-chart', { width: 600, height: 90 });
    const frame = section('perf.smoothness', 'perf.smoothnessHint', this.#frameChart);

    // Frame budget
    this.#budgetBar = h('div.perf-budget-bar');
    this.#budgetLegend = h('div.perf-legend');
    this.#budgetEmpty = h('div.perf-empty', lt('perf.noData'));
    for (const [bucket, color] of Object.entries(BUCKET_COLORS)) {
      const seg = h('div.perf-budget-seg', { 'data-bucket': bucket });
      seg.style.background = color;
      this.#budgetBar.append(seg);
      const swatch = h('span.perf-swatch');
      swatch.style.background = color;
      this.#budgetLegend.append(h('div.perf-legend-item', {}, swatch, h('span', lt(`perf.bucket.${bucket}`))));
    }
    this.#budgetLegend.append(this.#budgetEmpty);
    const budget = section('perf.budget', 'perf.budgetHint',
      this.#budgetBar, this.#budgetLegend);

    // On screen
    const quick = h('div.perf-grid');
    this.#draws = miniStat(quick, 'perf.drawCalls', 'perf.drawCallsHint');
    this.#tris = miniStat(quick, 'perf.triangles', 'perf.trianglesHint');
    this.#entities = miniStat(quick, 'perf.entities', 'perf.entitiesHint');
    const onScreen = section('perf.onScreen', '', quick);

    // Details
    this.#frameMs = h('div.perf-big.perf-frame-ms', { text: '-- ms' });
    this.#cpuMs = h('div.perf-big.perf-cpu-ms', { text: '-- ms' });
    this.#memory = h('div.perf-big.perf-memory', { text: '-- MB' });
    const detailHead = h('div.perf-headline', {},
      labelled('perf.frame', this.#frameMs), labelled('perf.engine', this.#cpuMs), labelled('perf.jsHeap', this.#memory));

    const phaseTable = table(['perf.phase', 'perf.avg', 'perf.max', 'P95', '%']);
    this.#phases = phaseTable.body;
    const phases = section('perf.phases', 'perf.phasesHint', phaseTable.el);

    const passTable = table(['perf.pass', 'perf.draws', 'perf.triangles', '%']);
    this.#passes = passTable.body;
    const passes = section('perf.passes', 'perf.passesHint', passTable.el);

    const rendererGrid = h('div.perf-grid');
    this.#instances = miniStat(rendererGrid, 'perf.instances', 'perf.instancesHint');
    this.#behaviors = miniStat(rendererGrid, 'perf.behaviors', 'perf.behaviorsHint');
    this.#backend = miniStat(rendererGrid, 'perf.renderer', 'perf.rendererHint');
    const renderer = section('perf.rendererSection', '', rendererGrid);

    const scriptTable = table(['perf.script', 'perf.kind', 'perf.now', 'perf.avg', 'P95', 'perf.max', 'perf.calls']);
    this.#scripts = scriptTable.body;
    const scripts = section('perf.scripts', 'perf.scriptsHint', scriptTable.el);

    const hookTable = table(['perf.hook', 'perf.plugin', 'perf.avg', 'perf.max']);
    this.#hooks = hookTable.body;
    const hooks = section('perf.plugins', 'perf.pluginsHint', hookTable.el);

    this.#heapChart = h('canvas.perf-chart.perf-heap-chart', { width: 600, height: 70 });
    this.#heapSection = section('perf.heap', 'perf.heapHint', this.#heapChart);

    this.#details = h('details.perf-details', {
      ontoggle: () => { if (this.#details.open && this.#last !== null) this.#renderDetails(this.#last); },
    }, h('summary.perf-summary', {}, icon('chevron', 12), h('span', lt('perf.showDetails'))),
    h('div.perf-details-body', {}, detailHead, phases, passes, renderer, scripts, hooks, this.#heapSection));

    this.el = h('div.perf-panel', {}, headline, frame, budget, onScreen, this.#details);
  }

  /** The tab is shown: turn the stats on and start polling. */
  activate(): void {
    if (this.#timer !== undefined) return;
    this.#editor.game.stats.enable(CONSUMER);
    this.#polls = 0;
    this.#tick();
    this.#timer = setInterval(() => this.#tick(), POLL_MS);
  }

  /** The tab is hidden: stop polling and let the game stop measuring. */
  deactivate(): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#editor.game.stats.disable(CONSUMER);
  }

  #tick(): void {
    const snap = this.#editor.game.stats.snapshot();
    this.#last = snap;
    this.#renderSummary(snap);
    if (this.#details.open && this.#polls++ % DETAIL_EVERY === 0) this.#renderDetails(snap);
  }

  #renderSummary(snap: PerfSnapshot): void {
    const s = smoothness(snap.fps);
    setText(this.#fps, snap.frames < 2 ? '-- FPS' : `${snap.fps} FPS`);
    this.#fps.dataset['tone'] = s.tone;
    setText(this.#smooth, s.label);
    this.#smooth.dataset['tone'] = s.tone;
    const r = snap.render;
    if (r !== null) {
      const pct = Math.round(r.renderScale * 100);
      setText(this.#scale, `RS ${pct}% · ${r.renderWidth}×${r.renderHeight}`);
      this.#scale.dataset['tone'] = r.renderScale < 0.99 ? 'ok' : 'none';
    } else {
      setText(this.#scale, 'RS —');
    }
    const mode = this.#editor.session.mode;
    setText(this.#mode, mode === 'edit' ? t('perf.editMode') : mode === 'paused' ? t('perf.paused') : t('perf.playing'));
    this.#mode.title = mode === 'edit' ? t('perf.editModeTitle') : '';

    drawFrameChart(this.#frameChart, snap.frameMsHistory);
    this.#renderBudget(snap);

    setText(this.#draws, r === null ? '--' : r.drawCalls.toLocaleString());
    setText(this.#tris, r === null ? '--' : r.triangles === null ? 'n/a' : r.triangles.toLocaleString());
    setText(this.#entities, snap.counts.entities.toLocaleString());
  }

  #renderBudget(snap: PerfSnapshot): void {
    const total = snap.budget.reduce((a, b) => a + b.ms, 0);
    // One fixed slot per bucket (BUCKET_COLORS order); a bucket with no time this window is hidden.
    Object.keys(BUCKET_COLORS).forEach((bucket, i) => {
      const slice = snap.budget.find((b) => b.bucket === bucket);
      const seg = this.#budgetBar.children[i] as HTMLElement;
      const item = this.#budgetLegend.children[i] as HTMLElement;
      const ms = slice?.ms ?? 0;
      const pct = (slice?.pct ?? 0) * 100;
      const label = `${t(`perf.bucket.${bucket}`)} — ${ms.toFixed(2)} ms (${pct.toFixed(0)}%)`;
      seg.hidden = ms <= 0;
      item.hidden = ms <= 0;
      seg.style.flex = `${pct} 0 0`;
      seg.title = label;
      setText(item.lastElementChild!, label);
    });
    this.#budgetEmpty.hidden = total > 0;
  }

  #renderDetails(snap: PerfSnapshot): void {
    setText(this.#frameMs, snap.frames === 0 ? '-- ms' : `${snap.frameMs.avg.toFixed(2)} ms (max ${snap.frameMs.max.toFixed(1)})`);
    setText(this.#cpuMs, snap.cpuMsHistory.length === 0 ? '-- ms' : `${snap.cpuMs.avg.toFixed(2)} ms (max ${snap.cpuMs.max.toFixed(1)})`);
    setText(this.#memory, snap.memory.supported ? `${snap.memory.usedMB.toFixed(1)} MB / ${snap.memory.totalMB.toFixed(0)} MB` : 'n/a');

    const active = snap.phases.filter((p) => p.maxMs > 0);
    tableRows(this.#phases, active.map((p) => [p.name, p.avgMs.toFixed(3), p.maxMs.toFixed(3), p.p95Ms.toFixed(3), null]), t('perf.noData'), 5);
    active.forEach((p, i) => {
      const cell = this.#phases.children[i]!.children[4] as HTMLElement;
      if (cell.firstElementChild === null) cell.append(h('div.perf-share', {}, h('div.perf-share-fill')));
      (cell.firstElementChild!.firstElementChild as HTMLElement).style.width = `${Math.min(100, p.pct * 100).toFixed(1)}%`;
    });

    const r = snap.render;
    const passRows = r === null ? [] : Object.entries(r.drawCallsByPass).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([pass, n]) => {
      const tris = r.trianglesByPass[pass];
      return [pass, n.toLocaleString(), tris === undefined ? 'n/a' : tris.toLocaleString(),
        r.triangles !== null && r.triangles > 0 && tris !== undefined ? `${((tris / r.triangles) * 100).toFixed(1)}%` : '—'];
    });
    tableRows(this.#passes, passRows, r === null ? t('perf.nothingDrawnYet') : t('perf.nothingDrawnLast'), 4);
    setText(this.#instances, r === null ? '--' : r.instances.toLocaleString());
    setText(this.#behaviors, snap.counts.behaviors.toLocaleString());
    setText(this.#backend, r === null ? '--' : r.backend === 'webgpu' ? 'WebGPU' : r.backend === 'webgl2' ? 'WebGL2' : 'Canvas 2D');

    tableRows(this.#scripts, snap.scripts.slice(0, 30).map((s) => [s.name, s.kind, s.lastMs.toFixed(3), s.avgMs.toFixed(3), s.p95Ms.toFixed(3),
      s.maxMs.toFixed(3), s.callsPerFrame.toFixed(1)]),
    this.#editor.session.mode === 'edit' ? t('perf.noScriptsEdit') : t('perf.noScriptsRan'), 7);
    tableRows(this.#hooks, snap.hooks.slice(0, 20).map((k) => [k.point, k.owner, k.avgMs.toFixed(3), k.maxMs.toFixed(3)]), t('perf.noData'), 4);

    this.#heapSection.hidden = !snap.memory.supported;
    if (snap.memory.supported) drawLineChart(this.#heapChart, snap.memory.historyMB, '#e09f54');
  }

  async #copyStats(): Promise<void> {
    const snap = this.#editor.game.stats.enabled ? this.#editor.game.stats.snapshot() : this.#last;
    if (snap === null) return;
    const ok = await copyText(formatReport(snap, this.#editor.session.mode));
    const label = ok ? t('toolbar.copied') : t('perf.copyFailed');
    setText(this.#copy, label);
    this.#copy.disabled = true;
    setTimeout(() => { setText(this.#copy, t('perf.copyStats')); this.#copy.disabled = false; }, 1200);
  }

  /** Copy where the camera is and looks (the editor's, the drawn view's and every game camera's) as text. */
  async #copyCameraPose(): Promise<void> {
    const ok = await copyText(formatCamera(cameraReport(this.#editor)));
    setText(this.#copyCamera, ok ? t('performance.copyCameraDone') : t('performance.copyCameraFailed'));
    this.#copyCamera.disabled = true;
    setTimeout(() => { setText(this.#copyCamera, t('performance.copyCamera')); this.#copyCamera.disabled = false; }, 1200);
  }
}

// ── Camera ──────────────────────────────────────────────────────────────────────

/** One camera's pose and lens for the copied text. */
export interface CameraLines {
  readonly label: string;
  readonly position: Vec3;
  readonly rotation: Quat;
  readonly mode?: 'perspective' | 'orthographic';
  readonly fov?: number;
  readonly size?: number;
  readonly near?: number;
  readonly far?: number;
  /** The camera the game draws through (its seat's main camera). */
  readonly active?: boolean;
}

export interface CameraReport {
  readonly mode: string;
  readonly location?: string;
  readonly scene: string;
  readonly dimension: '2d' | '3d';
  /** The editor camera (edit mode, or the Scene tab while playing). */
  readonly editor: CameraLines | null;
  /** What the viewport draws through: 'editor' or the game camera's label. */
  readonly rendering: string;
  readonly cameras: readonly CameraLines[];
}

const v3 = (v: Vec3): string => `(${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})`;
const round = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * Bearing and elevation of a forward vector, degrees: yaw 0 looks down +z and +90 down +x
 * (Vec3.rotated_y's sense), pitch is up from the horizon. Euler degrees as Quat.to_euler.
 */
export function aim(rotation: Quat): { yaw: number; pitch: number; forward: Vec3 } {
  const forward = rotation.rotate(Vec3.FORWARD);
  return { yaw: (Math.atan2(forward.x, forward.z) * 180) / Math.PI, pitch: (Math.asin(Math.max(-1, Math.min(1, forward.y))) * 180) / Math.PI, forward };
}

/** The copyable camera text: what renders, the editor camera, each game camera, and a placement JSON line for the editor's pose. */
export function formatCamera(report: CameraReport): string {
  const L: string[] = [];
  L.push(`Parallax camera — ${report.location ?? ''}${report.location === undefined ? '' : ' — '}scene ${report.scene} — ${report.mode === 'edit' ? 'edit mode' : report.mode}`);
  L.push(`rendering through: ${report.rendering === 'editor' ? 'the editor camera' : report.rendering}`);
  const kv = (label: string, value: string, note = ''): void => { L.push(`    ${label.padEnd(12)}${note === '' ? value : value.padEnd(28) + note}`); };
  const block = (c: CameraLines, heading: string): void => {
    L.push('', `  ${heading}`);
    kv('position', v3(c.position));
    if (report.dimension === '3d') {
      const a = aim(c.rotation);
      kv('looking', v3(a.forward), `yaw ${a.yaw.toFixed(1)}°, pitch ${a.pitch.toFixed(1)}°`);
      kv('rotation', v3(c.rotation.to_euler()), 'euler degrees (x pitch, y yaw, z roll)');
    } else {
      kv('angle', `${c.rotation.to_euler().z.toFixed(1)}°`);
    }
    const lens: string[] = [];
    if (c.mode === 'orthographic' || (c.mode === undefined && c.size !== undefined && c.fov === undefined)) {
      if (c.size !== undefined) lens.push(`size ${c.size.toFixed(2)} (half-height)`);
    } else if (c.fov !== undefined) {
      lens.push(`fov ${c.fov.toFixed(1)}°`);
    }
    if (c.near !== undefined) lens.push(`near ${round(c.near)}`);
    if (c.far !== undefined) lens.push(`far ${round(c.far)}`);
    if (lens.length > 0) kv('lens', lens.join(', '));
  };
  if (report.editor !== null) block(report.editor, `EDITOR CAMERA${report.rendering === 'editor' ? ' — rendering' : ''}`);
  if (report.cameras.length === 0) L.push('', '  game cameras: none in the scene');
  for (const c of report.cameras) block(c, `${c.label}${c.active === true ? ' (active)' : ''}${report.rendering === c.label ? ' — rendering' : ''}`);
  if (report.editor !== null) {
    const p = report.editor.position;
    const e = report.editor.rotation.to_euler();
    const json = report.dimension === '3d'
      ? { at: [round(p.x), round(p.y), round(p.z)], rotation: [round(e.x), round(e.y), round(e.z)] }
      : { at: [round(p.x), round(p.y)] };
    L.push('', `  editor pose as a placement: ${JSON.stringify(json)}`);
  }
  return L.join('\n');
}

/** The editor's cameras now, for formatCamera. */
function cameraReport(editor: Editor): CameraReport {
  const session = editor.session;
  const world = session.runtime.kernel.world;
  const own = new Set<number | undefined>([session.cameraEntity, editor.playCamera]);
  let drawn: number | null = null;
  try {
    drawn = session.view()?.camera ?? null;
  } catch {
    // No frame drawn yet.
  }
  const cameras: CameraLines[] = [];
  let rendering = drawn !== null && own.has(drawn) ? 'editor' : '';
  for (const record of world.live()) {
    const fields = record.components.get('camera') as ({ readonly __view__?: Omit<CameraLines, 'label'> } & Record<string, unknown>) | undefined;
    if (fields === undefined || own.has(record.id)) continue;
    const label = record.placedId ?? record.name ?? record.childName ?? record.prefab ?? `entity ${record.id}`;
    let view: Omit<CameraLines, 'label'> | undefined;
    try {
      view = fields.__view__;
    } catch {
      view = undefined;
    }
    cameras.push(view === undefined
      ? { label, position: record.transform.position, rotation: record.transform.rotation, fov: fields['fov'] as number | undefined, size: fields['size'] as number | undefined }
      : { label, position: view.position, rotation: view.rotation, mode: view.mode, fov: view.fov, size: view.size, near: view.near, far: view.far, active: view.active });
    if (record.id === drawn) rendering = label;
    if (cameras.length >= 12) break;
  }
  const navigating = session.mode === 'edit' || editor.playCamera !== undefined;
  const pose = session.cameraPose;
  return {
    mode: session.mode,
    location: globalThis.location?.href,
    scene: session.scene,
    dimension: session.dimension,
    editor: navigating ? { label: 'editor', position: pose.position, rotation: pose.rotation, fov: pose.fov, size: pose.size } : null,
    rendering: rendering === '' ? 'nothing drawn yet' : rendering,
    cameras,
  };
}

// ── Report ──────────────────────────────────────────────────────────────────────

/** The copyable text report: the verdict first, then frame budget, phases, scripts, renderer, memory. */
export function formatReport(snap: PerfSnapshot, mode: string): string {
  const L: string[] = [];
  const row = (cells: [string, number][]): string => cells.map(([s, w]) => (w < 0 ? s.padStart(-w) : s.padEnd(w))).join('');
  const rule = (title: string, summary = ''): void => {
    const head = `── ${title} `;
    L.push('', head + '─'.repeat(Math.max(3, 62 - head.length)) + (summary === '' ? '' : `  ${summary}`));
  };
  const wall = snap.frameMs.avg;
  const cpu = snap.cpuMs.avg;
  L.push(`Parallax performance — ${new Date().toISOString()} — ${mode === 'edit' ? 'edit mode (game logic off)' : mode}`);
  const r = snap.render;
  if (r !== null) L.push(`${r.backend} · drawing ${r.renderWidth}x${r.renderHeight} (render scale ${(r.renderScale * 100).toFixed(0)}%)`);

  L.push('', 'VERDICT');
  if (snap.frames === 0) {
    L.push('  No frames measured yet.');
  } else {
    const status = wall <= TARGET_MS + 1 ? 'at target' : wall <= TARGET_MS * 2 + 1 ? 'below target (30-60 fps band)' : 'well below target';
    L.push(`  ${snap.fps} fps · ${wall.toFixed(2)} ms frame vs ${TARGET_MS.toFixed(2)} ms target — ${status.toUpperCase()}`);
    if (cpu > wall * 0.6) L.push(`  Bound by ENGINE CPU — ${cpu.toFixed(2)} ms of the ${wall.toFixed(2)} ms frame. See CPU below.`);
    else L.push(`  Engine CPU ${cpu.toFixed(2)} ms of ${wall.toFixed(2)} ms; the rest is the browser, the GPU and the wait to present.`);
  }

  rule('FRAME', `${wall.toFixed(2)} ms wall · ${cpu.toFixed(2)} ms engine`);
  L.push('  ' + row([['', 16], ['avg', -9], ['min', -9], ['max', -9], ['p95', -9], ['last', -9]]));
  for (const [name, d] of [['wall frame', snap.frameMs], ['engine', snap.cpuMs]] as const) {
    L.push('  ' + row([[name, 16], [d.avg.toFixed(2), -9], [d.min.toFixed(2), -9], [d.max.toFixed(2), -9], [d.p95.toFixed(2), -9], [d.last.toFixed(2), -9]]));
  }
  L.push(`  fixed steps per frame ${snap.fixedStepsPerFrame.toFixed(2)}`);

  rule('BUDGET');
  for (const b of snap.budget) L.push('  ' + row([[b.bucket, 16], [b.ms.toFixed(3), -9], [' ms', 4], [`${(b.pct * 100).toFixed(1)}%`, -8]]));

  rule('CPU — PHASES', `${cpu.toFixed(2)} ms/frame`);
  L.push('  ' + row([['phase', 18], ['avg', -9], ['max', -9], ['p95', -9], ['share', -8]]));
  for (const p of snap.phases) {
    L.push('  ' + row([[p.name, 18], [p.avgMs.toFixed(3), -9], [p.maxMs.toFixed(3), -9], [p.p95Ms.toFixed(3), -9], [`${(p.pct * 100).toFixed(1)}%`, -8]]));
  }
  if (snap.scripts.length > 0) {
    L.push('', '  Per-script cost');
    L.push('  ' + row([['script', 30], ['kind', 10], ['now', -9], ['avg', -9], ['p95', -9], ['max', -9], ['calls', -7]]));
    for (const s of snap.scripts.slice(0, 30)) {
      L.push('  ' + row([[s.name.slice(0, 29), 30], [s.kind, 10], [s.lastMs.toFixed(3), -9], [s.avgMs.toFixed(3), -9], [s.p95Ms.toFixed(3), -9],
        [s.maxMs.toFixed(3), -9], [s.callsPerFrame.toFixed(1), -7]]));
    }
  }
  if (snap.hooks.length > 0) {
    L.push('', '  Engine plugins');
    L.push('  ' + row([['point', 12], ['plugin', 20], ['avg', -9], ['max', -9]]));
    for (const k of snap.hooks.slice(0, 20)) L.push('  ' + row([[k.point, 12], [k.owner.slice(0, 19), 20], [k.avgMs.toFixed(3), -9], [k.maxMs.toFixed(3), -9]]));
  }

  rule('SCENE & RENDERER', r === null ? 'nothing drawn' : `${r.drawCalls} draws · ${r.triangles === null ? 'n/a' : r.triangles.toLocaleString()} tris`);
  L.push('  ' + row([['entities', 18], [String(snap.counts.entities), -12]]));
  L.push('  ' + row([['behaviors', 18], [String(snap.counts.behaviors), -12]]));
  if (r !== null) {
    L.push('  ' + row([['mesh instances', 18], [String(r.instances), -12]]));
    L.push('  ' + row([['render cpu', 18], [`${r.cpuMs.toFixed(2)} ms`, -12]]) + '   planning + recording, inside the render phase');
    L.push('', '  Draws by pass');
    for (const [pass, n] of Object.entries(r.drawCallsByPass).sort((a, b) => b[1] - a[1])) {
      const tris = r.trianglesByPass[pass];
      L.push('  ' + row([[pass, 14], [String(n), -8], [' draws', 8], [tris === undefined ? '' : tris.toLocaleString(), -14], [tris === undefined ? '' : ' tris', 5]]));
    }
  }

  if (snap.memory.supported) {
    rule('MEMORY', `${snap.memory.usedMB.toFixed(1)} MB used / ${snap.memory.totalMB.toFixed(0)} MB total`);
    const h = snap.memory.historyMB;
    if (h.length > 1) L.push(`  over the last ${h.length} readings: min ${Math.min(...h).toFixed(1)} MB, max ${Math.max(...h).toFixed(1)} MB`);
  }
  return L.join('\n');
}

// ── DOM helpers ─────────────────────────────────────────────────────────────────

/** A titled block; `title` and `hint` are i18n keys (they follow language changes). */
function section(title: string, hint: string, ...content: Node[]): HTMLElement {
  return h('section.perf-section', {}, h('div.perf-section-title', lt(title)), hint === '' ? null : h('div.perf-hint', lt(hint)), ...content);
}

function miniStat(parent: HTMLElement, label: string, title: string): HTMLElement {
  const value = h('div.perf-mini-value', { text: '--' });
  parent.append(h('div.perf-mini', lt(title, 'title'), h('div.perf-mini-label', lt(label)), value));
  return value;
}

function labelled(label: string, value: HTMLElement): HTMLElement {
  return h('div.perf-labelled', {}, h('div.perf-mini-label', lt(label)), value);
}

function table(headers: readonly string[]): { el: HTMLTableElement; body: HTMLTableSectionElement } {
  const body = h('tbody');
  const el = h('table.perf-table', {}, h('thead', {}, h('tr', {}, ...headers.map((key) => h('th', lt(key))))), body);
  return { el, body };
}

/** Update an element's text without replacing its text node when it is the only child. */
function setText(el: Element, value: string): void {
  if (el.textContent === value) return;
  if (el.childNodes.length === 1 && el.firstChild?.nodeType === 3) el.firstChild.nodeValue = value;
  else el.textContent = value;
}

/** Rows are positional: a refresh changes cell text, never the table's nodes. A null cell is left for the caller. */
function tableRows(body: HTMLTableSectionElement, rows: readonly (readonly (string | null)[])[], empty: string, columns: number): void {
  const count = rows.length === 0 ? 1 : rows.length;
  while (body.children.length > count) body.lastElementChild!.remove();
  while (body.children.length < count) body.append(h('tr'));
  for (let i = 0; i < count; i++) {
    const tr = body.children[i] as HTMLTableRowElement;
    const values = rows.length === 0 ? [empty] : rows[i]!;
    tr.classList.toggle('perf-empty-row', rows.length === 0);
    while (tr.children.length > values.length) tr.lastElementChild!.remove();
    while (tr.children.length < values.length) tr.append(h('td'));
    for (let j = 0; j < values.length; j++) {
      const td = tr.children[j] as HTMLTableCellElement;
      const span = rows.length === 0 ? columns : 1;
      if (td.colSpan !== span) td.colSpan = span;
      const value = values[j];
      if (value !== null && value !== undefined) {
        if (td.firstElementChild !== null) td.textContent = '';
        setText(td, value);
      }
    }
  }
}

// ── Charts ──────────────────────────────────────────────────────────────────────

/** Size a canvas's backing store to its CSS box (at most 2× DPR); null while it isn't laid out. */
function fit(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number; dpr: number } | null {
  const ctx = canvas.getContext('2d');
  if (ctx === null || canvas.clientWidth === 0 || canvas.clientHeight === 0) return null;
  const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
  const w = Math.round(canvas.clientWidth * dpr);
  const hh = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== hh) canvas.height = hh;
  ctx.clearRect(0, 0, w, hh);
  return { ctx, w, h: hh, dpr };
}

/** Frame times, with 60 fps and 30 fps guidelines; the y axis fits the worst frame plus headroom. */
function drawFrameChart(canvas: HTMLCanvasElement, history: readonly number[]): void {
  const f = fit(canvas);
  if (f === null) return;
  const { ctx, w, h: height, dpr } = f;
  const yMax = Math.max(33.3, ...history) * 1.1;
  const guideline = (ms: number, color: string): void => {
    const y = height - (ms / yMax) * height;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.font = `${10 * dpr}px sans-serif`;
    ctx.textAlign = 'right';
    ctx.fillText(ms.toFixed(1), w - 4, y - 2);
  };
  guideline(16.67, '#a04848');
  guideline(33.3, '#a08048');
  if (history.length < 2) return;
  ctx.strokeStyle = '#9bdb6a';
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  history.forEach((ms, i) => {
    const x = (i / (history.length - 1)) * w;
    const y = height - (ms / yMax) * height;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawLineChart(canvas: HTMLCanvasElement, history: readonly number[], color: string): void {
  const f = fit(canvas);
  if (f === null || history.length < 2) return;
  const { ctx, w, h: height, dpr } = f;
  const min = Math.min(...history);
  let max = Math.max(...history);
  if (max - min < 1) max = min + 1;
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath();
  history.forEach((v, i) => {
    const x = (i / (history.length - 1)) * w;
    const y = height - ((v - min) / (max - min)) * height;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.fillStyle = '#6a7591';
  ctx.font = `${10 * dpr}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText(`${min.toFixed(1)} – ${max.toFixed(1)}`, 4 * dpr, 10 * dpr);
}

/** The clipboard, falling back to a selected textarea where the async API is denied (an iframe without clipboard-write). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h('textarea', { readonly: true });
    area.value = text;
    Object.assign(area.style, { position: 'fixed', left: '-9999px', top: '0' });
    document.body.append(area);
    area.select();
    try {
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      area.remove();
    }
  }
}
