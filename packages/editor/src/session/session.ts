/**
 * An editor session over one running game: edit mode, selection, gizmos, write-back with
 * undo, play / stop in place, pause, step, time scale and hot reload.
 *
 *   edit     the kernel's logic is off: the scene is drawn from the documents through an
 *            editor camera, nothing of the game runs. Every edit goes to the documents
 *            (a patch, undoable); the live world follows — transforms are applied live,
 *            anything else rebuilds the world from the documents (`refresh`).
 *   playing  `play()` snapshots the edit world and loads the scene fresh with logic on,
 *            exactly as the game starts on /play. Edits are refused (PP9631) until `stop()`,
 *            which restores the snapshot: the edit world, its ids and the editor camera.
 *   paused   logic off mid-play: drawn, not run; `step()` runs single frames.
 *
 * Hot reload (`reload()`) asks the host for a new runtime built from the current modules
 * and documents, moves the game into it (the play snapshot is restored into the new code;
 * edit mode rebuilds from the documents) and keeps the editor's own state — documents,
 * history, selection, camera pose — untouched.
 *
 * The session never draws: the editor overlays gizmos from `gizmoLayout()` and the
 * selection from `observe()`/picking boxes. 3D selections are highlighted with the
 * engine's Outline component.
 */

import { diagnostic, fail, Quat, Vec3 } from '@parallax/runtime/core';
import type { Diagnostic, EntityId, ProjectFiles } from '@parallax/runtime/core';
import type { GameRuntime } from '@parallax/runtime/api';
import { diagnosticsOf } from '@parallax/runtime/boot';
import { decode } from '@parallax/runtime/kernel';
import type { Fields, Snapshot } from '@parallax/runtime/kernel';
import type { Json, JsonObject } from '@parallax/runtime/resource';
import { boundsOf, drawnFrame, viewOf, worldCorners } from './drawn.js';
import type { FilePatch, ProjectDocuments } from './documents.js';
import { GizmoDrag, gizmoHandles, hitHandle } from './gizmo.js';
import type { GizmoHandle, GizmoLayout, GizmoMode, GizmoSpace, Pose, Snap } from './gizmo.js';
import { EditHistory } from './history.js';
import type { Edit } from './history.js';
import { observe } from './observe.js';
import type { Observation, ObserveOptions } from './observe.js';
import { pick, pickRect } from './picking.js';
import { Profiler } from './profiler.js';
import { mapSources } from './sources.js';
import type { EntitySource, SourceMap } from './sources.js';
import type { PixelRect, ScreenView } from './view_math.js';
import { addPlacementPatch, fieldPatch, paramPatch, removePlacementPatch, revertPatch, transformPatch } from './write_back.js';
import { addComponentPatch, componentValuesPatch, environmentPatch, removeComponentPatch, renamePatch, requiredFields } from './component_ops.js';
import type { EditTarget, LocalTransform } from './write_back.js';
import {
  copyEntries, createChildPlan, createScenePatch, deletePlan, deleteScenePatches, duplicatePlan, inheritedFrom, insertPlan, movePlan, primitive, primitivePlan,
  renameScenePatches, visiblePatches,
} from './entity_ops.js';
import type { EntryCopy, OpsContext, OpsPlan, PrimitiveKind } from './entity_ops.js';

export type SessionMode = 'edit' | 'playing' | 'paused';

/** What a host page provides for hot reload. */
export interface SessionHost {
  /**
   * A new runtime of the same game from its current compiled modules, on `files`, started in
   * edit mode (`startGame({ editing: true })`; in a page, `BrowserGame.rebuild(build, { editing: true, files })`).
   */
  rebuild?(files: ProjectFiles): Promise<GameRuntime>;
  /** Step `next` from now on (a page's `BrowserGame.replace`). Absent: the session disposes the old runtime itself. */
  replace?(next: GameRuntime): void;
}

export interface EditorSessionOptions {
  /** Started in edit mode (logic off), on `documents`. */
  readonly runtime: GameRuntime;
  readonly documents: ProjectDocuments;
  readonly host?: SessionHost;
  /** The seed play starts with (default 1, so a play session is reproducible). */
  readonly seed?: number;
  /** The selection outline (3D). */
  readonly highlight?: { readonly color?: readonly [number, number, number, number]; readonly width?: number };
}

export interface CameraPose {
  readonly position: Vec3;
  readonly rotation: Quat;
  /** Perspective: vertical field of view, degrees. */
  readonly fov?: number;
  /** Orthographic: half-height in meters. */
  readonly size?: number;
}

export interface ReloadResult {
  /** True when the game carried over into the new code (snapshot restored); false when its scene had to restart. */
  readonly restored: boolean;
  readonly diagnostics: readonly Diagnostic[];
}

interface Drag {
  readonly drag: GizmoDrag;
  readonly targets: readonly { readonly id: EntityId; readonly start: Pose }[];
  last: Pose;
}

const CAMERA = 'camera';
const OUTLINE = 'outline';

/**
 * Selection keys after placements are removed: a placement later in the same file's
 * "entities" moves up one index per removed placement before it.
 */
function shiftKeys(keys: readonly string[], removed: readonly EntitySource[]): string[] {
  return keys.map((key) => {
    const match = /^([^#]+)#\/entities\/(\d+)(.*)$/.exec(key);
    if (match === null) return key;
    const [, path, index, rest] = match as unknown as [string, string, string, string];
    const before = removed.filter((s) => {
      const m = /^\/entities\/(\d+)$/.exec(s.pointer);
      return s.path === path && m !== null && Number(m[1]) < Number(index);
    }).length;
    if (before === 0) return key;
    // Child keys repeat the root's key after ">": shift every occurrence of the root.
    const root = `${path}#/entities/${index}`;
    return `${path}#/entities/${Number(index) - before}${rest.split(`>${root}`).join(`>${path}#/entities/${Number(index) - before}`)}`;
  });
}

export class EditorSession {
  readonly documents: ProjectDocuments;
  readonly history: EditHistory;
  readonly profiler = new Profiler();
  readonly #host: SessionHost;
  readonly #seed: number;
  readonly #highlight: { color: readonly number[]; width: number };
  #runtime: GameRuntime;
  #mode: SessionMode = 'edit';
  #scene: string;
  /** The scene the running game started in (play mode); the edited scene otherwise. */
  #playScene: string;
  #sources: SourceMap = { sources: new Map(), byKey: new Map(), problems: [] };
  #camera: EntityId | undefined;
  #pose: CameraPose;
  /** Selected entities by source key (entity ids change when the world is rebuilt). */
  #selection: string[] = [];
  /** Outline fields an entity had before the selection outline replaced them. */
  #outlined = new Map<EntityId, Fields | null>();
  #editSnapshot: Snapshot | undefined;
  /** The next edit world takes its view from the scene's own camera (a newly opened scene). */
  #poseFromScene = false;
  #drag: Drag | undefined;
  #profiling = false;
  /** Entities hidden in the editor only (eye toggle), by source key; what `visible` they had. */
  #editorHidden = new Set<string>();
  #hiddenWas = new Map<EntityId, boolean>();
  /** The open scene before and after a scene edit, so undo and redo follow it. */
  readonly #sceneSteps = new WeakMap<Edit, { readonly before: string; readonly after: string }>();

  constructor(options: EditorSessionOptions) {
    const kernel = options.runtime.kernel;
    if (kernel.logic) {
      fail('PP9630', 'An editor session needs a game started in edit mode', {
        fix: 'Boot it with startGame({ editing: true }) (bootBrowser({ editing: true }) in a page).',
      });
    }
    const scene = kernel.scene;
    if (scene === undefined) fail('PP9630', 'An editor session needs a started game', { fix: 'Start it in edit mode first.' });
    this.#runtime = options.runtime;
    this.documents = options.documents;
    this.history = new EditHistory(options.documents);
    this.#host = options.host ?? {};
    this.#seed = options.seed ?? 1;
    this.#highlight = { color: options.highlight?.color ?? [1, 0.6, 0.1, 1], width: options.highlight?.width ?? 3 };
    this.#scene = scene.id;
    this.#playScene = scene.id;
    this.#pose = this.#gameCameraPose();
    this.#enterEditWorld();
  }

  get runtime(): GameRuntime {
    return this.#runtime;
  }

  get mode(): SessionMode {
    return this.#mode;
  }

  get scene(): string {
    return this.#scene;
  }

  /** The scene the game starts in (`Game(start_scene=...)`): where Play begins by default in the editor. */
  get startScene(): string {
    return this.#runtime.game.start_scene.id;
  }

  /** The scene Play started (while playing or paused), else the edited scene. */
  get playScene(): string {
    return this.#mode === 'edit' ? this.#scene : this.#playScene;
  }

  /** A gizmo drag is in progress (between beginDrag and endDrag / cancelDrag). */
  get dragging(): boolean {
    return this.#drag !== undefined;
  }

  get dimension(): '2d' | '3d' {
    return this.#runtime.mode;
  }

  /** Where each entity of the edit world came from (empty while playing). */
  get sources(): SourceMap {
    return this.#sources;
  }

  sourceOf(id: EntityId): EntitySource | undefined {
    return this.#sources.sources.get(id);
  }

  /** The editor camera's entity (edit mode; it doesn't exist while playing). */
  get cameraEntity(): EntityId | undefined {
    return this.#mode === 'edit' ? this.#camera : undefined;
  }

  // ── The edit world ───────────────────────────────────────────────────────────

  /** The editor camera, the document map and the selection outline, after the world was (re)built. */
  #enterEditWorld(): void {
    this.#outlined.clear();
    if (this.#poseFromScene) {
      this.#poseFromScene = false;
      this.#pose = this.#gameCameraPose();
    }
    this.#createCamera();
    this.#sources = mapSources(this.#runtime.kernel.world, this.documents.project(), this.#runtime.kernel.scene!, (id) => id === this.#camera);
    this.#outline(this.selection);
    this.#hiddenWas.clear();
    this.#applyEditorHidden();
  }

  /** The active game camera's pose (where the edit view starts), else a default. */
  #gameCameraPose(): CameraPose {
    const id = this.#runtime.visuals.rig.active();
    const record = id === undefined ? undefined : this.#runtime.kernel.world.get(id);
    if (record === undefined) {
      return this.dimension === '2d'
        ? { position: new Vec3(0, 0, 0), rotation: Quat.IDENTITY, size: 5 }
        : { position: new Vec3(0, 5, -10), rotation: Quat.look_rotation(new Vec3(0, -5, 10)), fov: 60 };
    }
    const fields = record.components.get(CAMERA)!;
    return {
      position: record.transform.worldPosition(),
      rotation: record.transform.worldRotation(),
      fov: fields['fov'] as number,
      size: fields['size'] as number,
    };
  }

  #createCamera(): void {
    const kernel = this.#runtime.kernel;
    // The scene's own clear color (the game camera's), not the engine default around it.
    const game = this.#runtime.visuals.rig.active();
    const background = game === undefined ? undefined : kernel.world.get(game)?.components.get(CAMERA)?.['background'];
    const record = kernel.world.create({ name: 'editor_camera' });
    record.transform.position = this.#pose.position;
    record.transform.rotation = this.#pose.rotation;
    kernel.addComponent(record.id, CAMERA, {
      rig: 'fixed',
      mode: this.dimension === '2d' ? 'orthographic' : 'perspective',
      ...(this.#pose.fov !== undefined && { fov: this.#pose.fov }),
      ...(this.#pose.size !== undefined && { size: this.#pose.size }),
      ...(background !== undefined && background !== null && { background }),
    });
    this.#camera = record.id;
    this.#useCamera();
  }

  #useCamera(): void {
    const camera = (this.#runtime.ctx as unknown as { camera: { use(entity: unknown): void } }).camera;
    camera.use(this.#runtime.wrap(this.#camera!));
  }

  /** Move the editor camera. */
  setCamera(pose: Partial<CameraPose>): void {
    this.#pose = { ...this.#pose, ...pose };
    if (this.#mode !== 'edit' || this.#camera === undefined) return;
    const record = this.#runtime.kernel.world.require(this.#camera);
    record.transform.position = this.#pose.position;
    record.transform.rotation = this.#pose.rotation;
    const fields = record.components.get(CAMERA)!;
    if (pose.fov !== undefined) fields['fov'] = pose.fov;
    if (pose.size !== undefined) fields['size'] = pose.size;
  }

  get cameraPose(): CameraPose {
    return this.#pose;
  }

  /** Aim the editor camera so the selection fills about two thirds of the view (needs a drawn frame). */
  frameSelection(): void {
    const frame = drawnFrame(this.#runtime);
    const ids = new Set(this.#selectedWithChildren());
    const points = frame?.shapes.filter((s) => ids.has(s.entity)).flatMap((s) => worldCorners(s)) ?? [];
    const box = boundsOf(points);
    if (box === null) return;
    const center = box.min.lerp(box.max, 0.5);
    const radius = Math.max(box.max.__sub__(box.min).length() / 2, 0.5);
    if (this.dimension === '2d') {
      this.setCamera({ position: new Vec3(center.x, center.y, this.#pose.position.z), size: radius * 1.5 });
      return;
    }
    const fov = this.#pose.fov ?? 60;
    const distance = (radius * 1.5) / Math.tan((fov * Math.PI) / 360);
    const forward = this.#pose.rotation.rotate(Vec3.FORWARD);
    this.setCamera({ position: center.__sub__(forward.__mul__(distance)) });
  }

  /** The view the editor camera drew last frame (edit mode), else the game's main view. */
  view(): ScreenView | null {
    const frame = drawnFrame(this.#runtime);
    return frame === null ? null : viewOf(frame, this.cameraEntity ?? null);
  }

  #requireView(what: string): ScreenView {
    const view = this.view();
    if (view === null) fail('PP9634', `${what} needs a drawn frame`, { fix: 'Step the game one frame (the page loop does) before picking or dragging.' });
    return view;
  }

  // ── Selection and picking ────────────────────────────────────────────────────

  /** The selected entities (edit world ids; while playing, the play world's placed entities with the same id). */
  get selection(): EntityId[] {
    const out: EntityId[] = [];
    for (const key of this.#selection) {
      const id = this.#idOfKey(key);
      if (id !== undefined) out.push(id);
    }
    return out;
  }

  #idOfKey(key: string): EntityId | undefined {
    if (this.#mode === 'edit') {
      const mapped = this.#sources.byKey.get(key);
      if (mapped !== undefined) return mapped;
    }
    if (key.startsWith('entity:')) {
      const id = Number(key.slice('entity:'.length)) as EntityId;
      return this.#runtime.kernel.world.get(id) === undefined ? undefined : id;
    }
    if (key.startsWith('placed:')) {
      const placed = key.slice('placed:'.length);
      for (const record of this.#runtime.kernel.world.live()) if (record.placedId === placed) return record.id;
    }
    return undefined;
  }

  #keyOf(id: EntityId): string {
    const source = this.#sources.sources.get(id);
    if (source !== undefined && this.#mode === 'edit') return source.key;
    const placed = this.#runtime.kernel.world.get(id)?.placedId;
    return placed !== undefined ? `placed:${placed}` : `entity:${id}`;
  }

  /** Replace the selection (an empty list clears it). */
  select(ids: readonly EntityId[]): void {
    const before = this.selection;
    this.#selection = [...new Set(ids.map((id) => this.#keyOf(id)))];
    if (this.#mode === 'edit') {
      this.#unoutline(before.filter((id) => !ids.includes(id)));
      this.#outline(this.selection);
    }
  }

  /** The entity to select under a screen point: the placement it belongs to (`deep`: the innermost documented entity). */
  pickAt(x: number, y: number, options: { readonly deep?: boolean } = {}): EntityId | null {
    const frame = drawnFrame(this.#runtime);
    if (frame === null) return null;
    const hit = pick(frame, this.#requireView('pickAt()'), x, y, { ignore: (id) => id === this.#camera || this.#underHidden(id) });
    return hit === null ? null : this.#selectable(hit.entity, options.deep === true);
  }

  /** Every selectable entity whose drawn box overlaps a screen rectangle (marquee). */
  pickIn(rect: PixelRect): EntityId[] {
    const frame = drawnFrame(this.#runtime);
    if (frame === null) return [];
    const ids = pickRect(frame, this.#requireView('pickIn()'), rect, { ignore: (id) => id === this.#camera || this.#underHidden(id) });
    return [...new Set(ids.map((id) => this.#selectable(id, false)))];
  }

  #selectable(id: EntityId, deep: boolean): EntityId {
    const world = this.#runtime.kernel.world;
    let at: EntityId | undefined = id;
    let found: EntityId | undefined;
    while (at !== undefined) {
      const source = this.#sources.sources.get(at);
      if (source !== undefined) {
        if (deep) return at;
        if (source.kind === 'placement') return at;
        found ??= at;
      }
      const parent: EntityId | null | undefined = world.get(at)?.parent;
      if (parent === null || parent === undefined) return found ?? at;
      at = parent;
    }
    return found ?? id;
  }

  #selectedWithChildren(): EntityId[] {
    const world = this.#runtime.kernel.world;
    const out: EntityId[] = [];
    const visit = (id: EntityId): void => {
      out.push(id);
      for (const child of world.get(id)?.children ?? []) visit(child);
    };
    for (const id of this.selection) visit(id);
    return out;
  }

  #outline(ids: readonly EntityId[]): void {
    const kernel = this.#runtime.kernel;
    if (this.dimension !== '3d' || !kernel.registry.components.has(OUTLINE)) return;
    for (const id of ids) {
      const record = kernel.world.get(id);
      if (record === undefined || this.#outlined.has(id)) continue;
      const own = record.components.get(OUTLINE);
      this.#outlined.set(id, own === undefined ? null : { ...own });
      const [r, g, b, a] = this.#highlight.color;
      kernel.addComponent(id, OUTLINE, {
        color: decode({ kind: 'color' }, [r!, g!, b!, a!], 'editor outline'), width: this.#highlight.width, through_walls: true,
      });
    }
  }

  #unoutline(ids: readonly EntityId[]): void {
    const kernel = this.#runtime.kernel;
    for (const id of ids) {
      if (!this.#outlined.has(id)) continue;
      const own = this.#outlined.get(id)!;
      this.#outlined.delete(id);
      if (kernel.world.get(id) === undefined) continue;
      if (own === null) kernel.removeComponent(id, OUTLINE);
      else kernel.addComponent(id, OUTLINE, own);
    }
  }

  // ── Transforms and gizmos ────────────────────────────────────────────────────

  /** An entity's world pose. */
  poseOf(id: EntityId): Pose {
    const t = this.#runtime.kernel.world.require(id).transform;
    return { position: t.worldPosition(), rotation: t.worldRotation(), scale: t.worldScale() };
  }

  /** Put an entity at a world pose, live only (a drag's preview). */
  #placeLive(id: EntityId, pose: Pose): void {
    const t = this.#runtime.kernel.world.require(id).transform;
    const parent = t.parent;
    if (parent === null) {
      t.position = pose.position;
      t.rotation = pose.rotation;
      t.scale = pose.scale;
      return;
    }
    const ps = parent.worldScale();
    t.position = parent.toLocal(pose.position);
    t.rotation = parent.worldRotation().inverse().__mul__(pose.rotation);
    t.scale = new Vec3(pose.scale.x / ps.x, pose.scale.y / ps.y, pose.scale.z / ps.z);
  }

  #requireEdit(what: string): void {
    if (this.#mode !== 'edit') {
      fail('PP9631', `${what} changes the documents, which only happens in edit mode`, { fix: 'Stop the game first (session.stop()).' });
    }
  }

  #sourceFor(id: EntityId, what: string): EntitySource {
    const source = this.#sources.sources.get(id);
    if (source === undefined) {
      fail('PP9629', `${what}: entity ${id} isn't in the documents (it wasn't placed by the scene)`, { fix: 'Select a placed entity or one of its prefab\'s children.' });
    }
    return source;
  }

  /**
   * Move entities to world poses and write their transforms to the documents (one undo
   * step; `merge` joins steps with the same key). Placements change only themselves;
   * a prefab child changes in its prefab, so every instance of it follows (the world is rebuilt).
   */
  setPoses(poses: ReadonlyMap<EntityId, Pose>, options: { readonly merge?: string; readonly label?: string } = {}): Edit | undefined {
    this.#requireEdit('Moving an entity');
    const sources = [...poses.keys()].map((id) => this.#sourceFor(id, 'Moving it'));
    for (const [id, pose] of poses) this.#placeLive(id, pose);
    const project = this.documents.project();
    const patches = [...poses.keys()].map((id, i) => {
      const t = this.#runtime.kernel.world.require(id).transform;
      const local: LocalTransform = { position: t.position, rotation: t.rotation, scale: t.scale };
      return transformPatch(this.documents, project, sources[i]!, local, this.dimension);
    }).filter((p) => p.ops.length > 0);
    if (patches.length === 0) return undefined;
    const edit = this.history.commit(options.label ?? 'Move', patches, options.merge === undefined ? {} : { merge: options.merge });
    if (sources.some((s) => s.kind === 'child')) this.refresh();
    return edit;
  }

  /** The gizmo of the selection's first entity, laid out for drawing and hit testing (null: nothing selected or drawn). */
  gizmoLayout(mode: GizmoMode, space: GizmoSpace, sizePx = 100): GizmoLayout | null {
    const [first] = this.selection;
    const view = this.view();
    if (first === undefined || view === null) return null;
    return gizmoHandles(view, this.poseOf(first), mode, space, sizePx);
  }

  /** Which gizmo handle is under a screen point. */
  handleAt(x: number, y: number, mode: GizmoMode, space: GizmoSpace, sizePx = 100): GizmoHandle | null {
    const layout = this.gizmoLayout(mode, space, sizePx);
    return layout === null ? null : hitHandle(layout, x, y);
  }

  /** Start dragging a handle of the selection's gizmo, pivoting on its first entity (`sizePx` as drawn: `gizmoLayout`'s). */
  beginDrag(mode: GizmoMode, handle: GizmoHandle, space: GizmoSpace, x: number, y: number, sizePx = 100): void {
    this.#requireEdit('Dragging a gizmo');
    const ids = this.selection;
    if (ids.length === 0) fail('PP9635', 'beginDrag() needs a selection', { fix: 'Select an entity first (session.select([...])).' });
    for (const id of ids) this.#sourceFor(id, 'Dragging it');
    const view = this.#requireView('beginDrag()');
    const targets = ids.map((id) => ({ id, start: this.poseOf(id) }));
    const pose = targets[0]!.start;
    const radius = view.pixelSize(pose.position) * sizePx;
    const drag = new GizmoDrag({ mode, handle, space, pose, ray: view.ray(x, y), view, radius });
    this.#drag = { drag, targets, last: targets[0]!.start };
  }

  /** Follow the pointer: every dragged entity moves live (the documents change at `endDrag`). */
  dragTo(x: number, y: number, snap: Snap = {}): Pose {
    const d = this.#drag;
    if (d === undefined) fail('PP9635', 'dragTo() without beginDrag()');
    const view = this.#requireView('dragTo()');
    const pose = d.drag.update(view.ray(x, y), snap);
    d.last = pose;
    for (const [id, next] of this.#applyDelta(d, pose)) this.#placeLive(id, next);
    return pose;
  }

  #applyDelta(d: Drag, pose: Pose): Map<EntityId, Pose> {
    const start = d.targets[0]!.start;
    const move = pose.position.__sub__(start.position);
    const turn = pose.rotation.__mul__(start.rotation.inverse());
    const ratio = (a: number, b: number): number => (Math.abs(b) < 1e-12 ? 1 : a / b);
    const grow = new Vec3(ratio(pose.scale.x, start.scale.x), ratio(pose.scale.y, start.scale.y), ratio(pose.scale.z, start.scale.z));
    const out = new Map<EntityId, Pose>();
    for (const [i, target] of d.targets.entries()) {
      if (i === 0) { out.set(target.id, pose); continue; }
      const s = target.start;
      out.set(target.id, {
        position: d.drag.mode === 'rotate' ? start.position.__add__(turn.rotate(s.position.__sub__(start.position))) : s.position.__add__(move),
        rotation: turn.__mul__(s.rotation),
        scale: new Vec3(s.scale.x * grow.x, s.scale.y * grow.y, s.scale.z * grow.z),
      });
    }
    return out;
  }

  /** Finish the drag: the poses go to the documents as one undo step. */
  endDrag(): Edit | undefined {
    const d = this.#drag;
    if (d === undefined) return undefined;
    this.#drag = undefined;
    const label = d.drag.mode === 'translate' ? 'Move' : d.drag.mode === 'rotate' ? 'Rotate' : 'Scale';
    return this.setPoses(this.#applyDelta(d, d.last), { label });
  }

  /** Abandon the drag: every entity goes back where it was. */
  cancelDrag(): void {
    const d = this.#drag;
    if (d === undefined) return;
    this.#drag = undefined;
    for (const target of d.targets) this.#placeLive(target.id, target.start);
  }

  // ── Fields, params, entities ─────────────────────────────────────────────────

  #commit(label: string, patches: readonly FilePatch[], merge?: string): Edit | undefined {
    const real = patches.filter((p) => p.ops.length > 0);
    if (real.length === 0) return undefined;
    const edit = this.history.commit(label, real, merge === undefined ? {} : { merge });
    this.refresh();
    return edit;
  }

  /** Set a component field (JSON, as the files hold it) on the placement (`instance`) or the prefab. */
  setField(id: EntityId, componentId: string, field: string, value: Json, target: EditTarget = 'instance', options: { readonly merge?: string } = {}): Edit | undefined {
    this.#requireEdit('Setting a field');
    const source = this.#sourceFor(id, 'Setting a field');
    const patch = fieldPatch(this.documents, this.documents.project(), this.#runtime.kernel.registry, source, componentId, field, value, target);
    return this.#commit(`Set ${componentId}.${field}`, [patch], options.merge);
  }

  /** Set a behavior param on the placement (`instance`) or the prefab. */
  setParam(id: EntityId, behavior: string, param: string, value: Json, target: EditTarget = 'instance', options: { readonly merge?: string } = {}): Edit | undefined {
    this.#requireEdit('Setting a param');
    const source = this.#sourceFor(id, 'Setting a param');
    const patch = paramPatch(this.documents, this.documents.project(), this.#runtime.kernel.registry, source, behavior, param, value, target);
    return this.#commit(`Set ${behavior}.${param}`, [patch], options.merge);
  }

  /** Drop the placement's override of a field (back to the prefab's value). */
  revertField(id: EntityId, componentId: string, field: string): Edit | undefined {
    this.#requireEdit('Reverting a field');
    return this.#commit(`Revert ${componentId}.${field}`, [revertPatch(this.documents, this.#sourceFor(id, 'Reverting a field'), componentId, field)]);
  }

  /** Place a prefab in the scene file; returns the new entity. */
  addEntity(placement: JsonObject): EntityId {
    this.#requireEdit('Adding an entity');
    const scene = this.#runtime.kernel.scene!;
    const before = new Set(this.#sources.byKey.keys());
    this.#commit(`Add ${String(placement['prefab'])}`, [addPlacementPatch(this.documents, scene.path, placement)]);
    for (const [key, id] of this.#sources.byKey) {
      const source = this.#sources.sources.get(id)!;
      if (!before.has(key) && source.kind === 'placement' && source.path === scene.path) return id;
    }
    return fail('PP9636', 'The new placement did not appear in the world', { fix: 'Check the documents\' diagnostics (documents.project().diagnostics).' });
  }

  /** Remove placements from the scene (children are removed from their prefab instead: PP9627). */
  removeEntities(ids: readonly EntityId[]): Edit | undefined {
    this.#requireEdit('Removing an entity');
    // Highest pointer first, so removing one doesn't shift the next.
    const ctx = this.#ops();
    if (ids.some((id) => inheritedFrom(ctx.scene, this.#sourceFor(id, 'Removing it')) !== undefined)) {
      // Inherited from a base scene: excluded here, kept in the base (entity_ops.ts).
      const plan = deletePlan(ctx, ids);
      const gone = new Set(ids.map((id) => this.#sourceFor(id, 'Removing it').key));
      this.#selection = this.#selection.filter((key) => !gone.has(key)).map((key) => plan.remap(key)).filter((key): key is string => key !== undefined);
      return this.#commit(plan.label.replace('Delete', 'Remove'), plan.patches);
    }
    const sources = ids.map((id) => this.#sourceFor(id, 'Removing it'))
      .sort((a, b) => (a.path === b.path ? b.pointer.localeCompare(a.pointer, undefined, { numeric: true }) : 0));
    this.#selection = shiftKeys(this.#selection.filter((key) => !sources.some((s) => s.key === key)), sources);
    return this.#commit(ids.length === 1 ? 'Remove' : `Remove ${ids.length}`, sources.map(removePlacementPatch));
  }

  // ── Hierarchy: entities (entity_ops.ts) ─────────────────────────────────────

  #ops(): OpsContext {
    const world = this.#runtime.kernel.world;
    const project = this.documents.project();
    return {
      documents: this.documents,
      project,
      scene: project.scenes.get(this.#scene) ?? this.#runtime.kernel.scene!,
      dimension: this.dimension,
      source: (id, what) => this.#sourceFor(id, what),
      parentOf: (id) => world.get(id)?.parent ?? null,
      relativeTo: (id, parent) => {
        const pose = this.poseOf(id);
        if (parent === null) return pose;
        const t = world.require(parent).transform;
        const ps = t.worldScale();
        return {
          position: t.toLocal(pose.position),
          rotation: t.worldRotation().inverse().__mul__(pose.rotation),
          scale: new Vec3(pose.scale.x / ps.x, pose.scale.y / ps.y, pose.scale.z / ps.z),
        };
      },
    };
  }

  /** Commit a plan (checked: refused edits leave nothing); the selection follows it, or becomes what it created. */
  #applyPlan(plan: OpsPlan, selectCreated: boolean): EntityId[] {
    const before = { selection: this.#selection, hidden: this.#editorHidden };
    const kept = (keys: Iterable<string>): string[] => [...keys].map((key) => plan.remap(key)).filter((key): key is string => key !== undefined);
    this.#selection = selectCreated ? [...plan.created] : kept(this.#selection);
    this.#editorHidden = new Set(kept(this.#editorHidden));
    try {
      this.#commitChecked(plan.label, plan.patches);
    } catch (error) {
      this.#selection = before.selection;
      this.#editorHidden = before.hidden;
      throw error;
    }
    return plan.created.map((key) => this.#sources.byKey.get(key)).filter((id): id is EntityId => id !== undefined);
  }

  /** Place a primitive (empty, cube, sphere, plane, lights, camera) at `at`; its prefab is made the first time. Selects it. */
  addPrimitive(kind: PrimitiveKind, at: readonly number[]): EntityId {
    this.#requireEdit('Adding an entity');
    const label = `Add ${kind.replace(/_/g, ' ')}`;
    const [id] = this.#applyPlan(primitivePlan(this.#ops(), kind, at, label), true);
    return id ?? fail('PP9636', 'The new placement did not appear in the world', { fix: 'Check the documents\' diagnostics (documents.project().diagnostics).' });
  }

  /** The prefab a primitive kind would place, and what it holds (for menus and previews). */
  primitive(kind: PrimitiveKind): ReturnType<typeof primitive> {
    return primitive(kind, this.dimension);
  }

  /** A new empty child under `parent`, written into its prefab (every instance gets it). Selects it. */
  createChild(parent: EntityId): EntityId | undefined {
    this.#requireEdit('Creating a child');
    return this.#applyPlan(createChildPlan(this.#ops(), parent), true)[0];
  }

  /** Copy each entity next to itself (a fresh id or name). Selects the copies. */
  duplicateEntities(ids: readonly EntityId[]): EntityId[] {
    this.#requireEdit('Duplicating');
    return this.#applyPlan(duplicatePlan(this.#ops(), ids), true);
  }

  /** Delete entities: placements from the scene, prefab children from their prefab (every instance). */
  deleteEntities(ids: readonly EntityId[]): void {
    this.#requireEdit('Deleting');
    this.#applyPlan(deletePlan(this.#ops(), ids), false);
  }

  /**
   * Reorder or reparent entities: under `parent` (null: the scene's root), before `before`
   * (null: last). A new parent keeps them where they are in the world; a parent's children
   * live in its prefab, so every instance of it changes. Selects the moved entities.
   */
  moveEntities(ids: readonly EntityId[], parent: EntityId | null, before: EntityId | null = null): EntityId[] {
    this.#requireEdit('Moving in the hierarchy');
    return this.#applyPlan(movePlan(this.#ops(), ids, parent, before), true);
  }

  /** The entities' entries as their files hold them (a clipboard), outermost only. */
  copyEntities(ids: readonly EntityId[]): EntryCopy[] {
    return copyEntries(this.#ops(), ids);
  }

  /** Add copied entries under `parent` (null: the scene's root). Selects them. */
  pasteEntities(copies: readonly EntryCopy[], parent: EntityId | null = null): EntityId[] {
    this.#requireEdit('Pasting');
    if (copies.length === 0) return [];
    return this.#applyPlan(insertPlan(this.#ops(), copies, parent, copies.length === 1 ? 'Paste' : `Paste ${copies.length}`), true);
  }

  /** Show or hide entities in the game (their entry's "visible"). */
  setVisible(ids: readonly EntityId[], visible: boolean): Edit | undefined {
    this.#requireEdit('Showing or hiding');
    return this.#commitChecked(visible ? 'Show' : 'Hide', visiblePatches(this.#ops(), ids, visible));
  }

  // ── Hidden in the editor (never saved) ───────────────────────────────────────

  /** Hide entities in the edit view only: not drawn, not picked. The documents and the game are untouched. */
  setEditorHidden(ids: readonly EntityId[], hidden: boolean): void {
    if (this.#mode !== 'edit') return;
    const world = this.#runtime.kernel.world;
    for (const id of ids) {
      const key = this.#keyOf(id);
      if (hidden) {
        this.#editorHidden.add(key);
      } else {
        this.#editorHidden.delete(key);
        const record = world.get(id);
        if (record !== undefined && this.#hiddenWas.has(id)) record.visible = this.#hiddenWas.get(id)!;
        this.#hiddenWas.delete(id);
      }
    }
    this.#applyEditorHidden();
  }

  /** Whether the eye toggle hid this entity (not its parent). */
  isEditorHidden(id: EntityId): boolean {
    return this.#mode === 'edit' && this.#editorHidden.has(this.#keyOf(id));
  }

  #applyEditorHidden(): void {
    const world = this.#runtime.kernel.world;
    for (const key of this.#editorHidden) {
      const id = this.#sources.byKey.get(key);
      const record = id === undefined ? undefined : world.get(id);
      if (record === undefined || this.#hiddenWas.has(record.id)) continue;
      this.#hiddenWas.set(record.id, record.visible);
      record.visible = false;
    }
  }

  #underHidden(id: EntityId): boolean {
    if (this.#hiddenWas.size === 0 || this.#mode !== 'edit') return false;
    const world = this.#runtime.kernel.world;
    for (let at: EntityId | null | undefined = id; at !== null && at !== undefined; at = world.get(at)?.parent) {
      if (this.#hiddenWas.has(at)) return true;
    }
    return false;
  }

  // ── Scenes ───────────────────────────────────────────────────────────────────

  /** The project's scenes, sorted. */
  get scenes(): string[] {
    return [...this.documents.project().scenes.keys()].sort();
  }

  #commitScene(label: string, patches: readonly FilePatch[], after: string, fromSceneCamera: boolean): Edit | undefined {
    const before = this.#scene;
    const edit = this.history.commit(label, patches);
    this.#sceneSteps.set(edit, { before, after });
    if (after !== before) {
      this.#scene = after;
      this.#selection = [];
      this.#editorHidden.clear();
      this.#poseFromScene = fromSceneCamera;
    }
    this.refresh();
    return edit;
  }

  #followScene(edit: Edit, side: 'before' | 'after'): void {
    const step = this.#sceneSteps.get(edit);
    if (step === undefined || this.#scene === step[side]) return;
    this.#scene = step[side];
    this.#selection = [];
    this.#editorHidden.clear();
    this.#poseFromScene = true;
  }

  #requireNotStart(id: string, what: string): void {
    if (id === this.startScene) {
      fail('PP9644', `"${id}" is the scene the game starts in, so it can't be ${what} here`, {
        fix: 'Point Game(start_scene=...) in the game\'s code at another scene first.',
      });
    }
  }

  /** Create an empty scene and open it. */
  createScene(id: string): Edit | undefined {
    this.#requireEdit('Creating a scene');
    return this.#commitScene(`New scene ${id}`, [createScenePatch(this.documents, this.documents.project(), id)], id, true);
  }

  /** Rename a scene: every file of its folder moves (code that names it must follow). */
  renameScene(from: string, to: string): Edit | undefined {
    this.#requireEdit('Renaming a scene');
    this.#requireNotStart(from, 'renamed');
    const patches = renameScenePatches(this.documents, this.documents.project(), from, to);
    return this.#commitScene(`Rename scene ${from}`, patches, this.#scene === from ? to : this.#scene, false);
  }

  /** Delete a scene's files; the open scene moves to the start scene. */
  deleteScene(id: string): Edit | undefined {
    this.#requireEdit('Deleting a scene');
    this.#requireNotStart(id, 'deleted');
    const patches = deleteScenePatches(this.documents, this.documents.project(), id);
    return this.#commitScene(`Delete scene ${id}`, patches, this.#scene === id ? this.startScene : this.#scene, true);
  }

  // ── Components, names, the scene's environment (inspector) ──────────────────

  /**
   * Commit, then rebuild the world; an edit the game can't load (a new error in the
   * documents, or the spawner refusing it, e.g. a behavior's required component removed)
   * is taken back without a trace and its problem raised.
   */
  #commitChecked(label: string, patches: readonly FilePatch[], merge?: string): Edit | undefined {
    const seen = new Set<string>();
    const real = patches.filter((p) => {
      const key = `${p.path}\n${JSON.stringify(p.ops)}`;
      if (p.ops.length === 0 || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (real.length === 0) return undefined;
    const errorKey = (d: Diagnostic): string => `${d.code} ${d.path ?? ''}${d.pointer ?? ''} ${d.message}`;
    const before = new Set(this.documents.project().diagnostics.filter((d) => d.severity === 'error').map(errorKey));
    const edit = this.history.commit(label, real, merge === undefined ? {} : { merge });
    let problem: unknown;
    try {
      const fresh = this.documents.project().diagnostics.filter((d) => d.severity === 'error' && !before.has(errorKey(d)));
      if (fresh.length > 0) problem = fresh[0];
      else this.refresh();
    } catch (error) {
      problem = error;
    }
    if (problem === undefined) return edit;
    this.history.rollback();
    this.refresh();
    if (problem instanceof Error) throw problem;
    const d = problem as Diagnostic;
    return fail(d.code, `${label}: ${d.message}`, { fix: d.fix ?? 'Undo the change in the files.', ...(d.path !== undefined && { path: d.path }), ...(d.pointer !== undefined && { pointer: d.pointer }) });
  }

  #sourcesFor(ids: readonly EntityId[], what: string): EntitySource[] {
    this.#requireEdit(what);
    if (ids.length === 0) fail('PP9635', `${what} needs a selection`, { fix: 'Select an entity first.' });
    return ids.map((id) => this.#sourceFor(id, what));
  }

  /** Rename an entity: its placement's "id" or prefab child's "name" ("" removes it). */
  rename(id: EntityId, name: string): Edit | undefined {
    const [source] = this.#sourcesFor([id], 'Renaming an entity');
    return this.#commitChecked('Rename', [renamePatch(this.documents, this.documents.project(), source!, name)]);
  }

  /**
   * Add a component to entities (one undo step), on their placements or prefabs. Required
   * fields start at a neutral value unless `values` gives them; entities that already have
   * the component are left alone.
   */
  addComponent(ids: readonly EntityId[], componentId: string, target: EditTarget = 'instance', values: JsonObject = {}): Edit | undefined {
    const sources = this.#sourcesFor(ids, 'Adding a component');
    const kernel = this.#runtime.kernel;
    const def = kernel.registry.component(componentId, 'the editor');
    const start = { ...requiredFields(def.schema).values, ...values };
    const project = this.documents.project();
    const patches = ids.flatMap((id, i) => (kernel.world.get(id)?.components.has(componentId) === true ? []
      : [addComponentPatch(this.documents, project, kernel.registry, sources[i]!, componentId, start, target)]));
    return this.#commitChecked(`Add ${componentId}`, patches);
  }

  /** Remove a component from entities (one undo step), from the documents that declare it (PP9638 when that's elsewhere). */
  removeComponent(ids: readonly EntityId[], componentId: string, target: EditTarget = 'instance'): Edit | undefined {
    const sources = this.#sourcesFor(ids, 'Removing a component');
    const project = this.documents.project();
    const patches = sources.map((source) => removeComponentPatch(this.documents, project, source, componentId, target));
    return this.#commitChecked(`Remove ${componentId}`, patches);
  }

  /** Set several fields of a component on entities at once (reset, paste): one undo step. */
  setComponentValues(ids: readonly EntityId[], componentId: string, values: JsonObject, target: EditTarget = 'instance', label = `Set ${componentId}`): Edit | undefined {
    const sources = this.#sourcesFor(ids, 'Setting a component');
    const kernel = this.#runtime.kernel;
    const project = this.documents.project();
    const patches = sources.map((source) => componentValuesPatch(this.documents, project, kernel.registry, source, componentId, values, target));
    return this.#commitChecked(label, patches);
  }

  /** `setField` on several entities as one undo step (a multi-selection's shared field). */
  setFields(ids: readonly EntityId[], componentId: string, field: string, value: Json, target: EditTarget = 'instance', options: { readonly merge?: string } = {}): Edit | undefined {
    const sources = this.#sourcesFor(ids, 'Setting a field');
    const project = this.documents.project();
    const patches = sources.map((source) => fieldPatch(this.documents, project, this.#runtime.kernel.registry, source, componentId, field, value, target));
    return this.#commitChecked(`Set ${componentId}.${field}`, patches, options.merge);
  }

  /** `setParam` on several entities as one undo step. */
  setParams(ids: readonly EntityId[], behavior: string, param: string, value: Json, target: EditTarget = 'instance', options: { readonly merge?: string } = {}): Edit | undefined {
    const sources = this.#sourcesFor(ids, 'Setting a param');
    const project = this.documents.project();
    const patches = sources.map((source) => paramPatch(this.documents, project, this.#runtime.kernel.registry, source, behavior, param, value, target));
    return this.#commitChecked(`Set ${behavior}.${param}`, patches, options.merge);
  }

  /** The scene file of the open scene. */
  get scenePath(): string {
    return this.documents.project().scenes.get(this.#scene)?.path ?? this.#runtime.kernel.scene!.path;
  }

  /**
   * The file holding the open scene's "environment": its own scene.json, or for a derived
   * scene that doesn't set one, the base scene's file it inherits it from (edits go there).
   */
  get environmentPath(): string {
    return this.documents.project().scenes.get(this.#scene)?.keyPaths?.['environment'] ?? this.scenePath;
  }

  /** The open scene's "environment" block as written (an empty object when it has none). */
  environment(): JsonObject {
    const value = this.documents.get(this.environmentPath, '/environment');
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : {};
  }

  /** Set (or, with undefined, remove) a key of the scene's environment: `["fog", "density"]`. Undoable; refused when the scene can't load with it. */
  setEnvironment(keys: readonly string[], value: Json | undefined, options: { readonly merge?: string } = {}): Edit | undefined {
    this.#requireEdit('Changing the scene environment');
    return this.#commitChecked(`Set environment.${keys.join('.')}`, [environmentPatch(this.documents, this.environmentPath, keys, value)], options.merge);
  }

  // ── Live tweaks while playing (never saved) ────────────────────────────────────

  #requirePlay(what: string): void {
    if (this.#mode === 'edit') {
      fail('PP9639', `${what} changes the running game, which only exists while playing`, { fix: 'In edit mode use setField / setParam / setPoses, which change the documents.' });
    }
  }

  #liveValue(type: Parameters<typeof decode>[0], value: Json, where: string): unknown {
    if (type.kind === 'entity' && typeof value === 'string') {
      for (const record of this.#runtime.kernel.world.live()) if (record.placedId === value) return this.#runtime.wrap(record.id);
    }
    return decode(type, value, where);
  }

  /**
   * Set a component field on the running game's entities (playing or paused). Nothing is
   * written to the documents: Stop brings back the edit world as it was.
   */
  setLiveField(ids: readonly EntityId[], componentId: string, field: string, value: Json): void {
    this.#requirePlay('setLiveField()');
    const kernel = this.#runtime.kernel;
    const spec = kernel.registry.component(componentId, 'the editor').schema[field];
    if (spec === undefined) fail('PP4104', `component "${componentId}" has no field "${field}"`);
    for (const id of ids) {
      const fields = kernel.world.require(id).components.get(componentId);
      if (fields === undefined) fail('PP9629', `Entity ${id} has no "${componentId}" component`);
      fields[field] = this.#liveValue(spec.type, value, `${componentId}.${field}`);
    }
  }

  /** Set a behavior param on the running game's entities (not saved). */
  setLiveParam(ids: readonly EntityId[], behavior: string, param: string, value: Json): void {
    this.#requirePlay('setLiveParam()');
    const kernel = this.#runtime.kernel;
    const spec = kernel.registry.behavior(behavior, 'the editor').params[param];
    if (spec === undefined) fail('PP4104', `behavior "${behavior}" has no param "${param}"`);
    for (const id of ids) {
      const slot = kernel.world.require(id).behaviors.find((b) => b.def.id === behavior);
      if (slot === undefined) fail('PP9629', `Entity ${id} has no "${behavior}" behavior`);
      (slot.instance as unknown as Record<string, unknown>)[param] = this.#liveValue(spec.type, value, `${behavior}.${param}`);
    }
  }

  /** Move the running game's entities to world poses (not saved). */
  setLivePoses(poses: ReadonlyMap<EntityId, Pose>): void {
    this.#requirePlay('setLivePoses()');
    for (const [id, pose] of poses) this.#placeLive(id, pose);
  }

  undo(): Edit | undefined {
    this.#requireEdit('Undo');
    const edit = this.history.undo();
    if (edit !== undefined) {
      this.#followScene(edit, 'before');
      this.refresh();
    }
    return edit;
  }

  redo(): Edit | undefined {
    this.#requireEdit('Redo');
    const edit = this.history.redo();
    if (edit !== undefined) {
      this.#followScene(edit, 'after');
      this.refresh();
    }
    return edit;
  }

  /**
   * Rebuild the edit world from the documents (after edits that touch more than one
   * entity, undo, redo, or files changed outside). Refused while the documents have
   * errors (returned; the world stays as it was).
   */
  refresh(): readonly Diagnostic[] {
    this.#requireEdit('refresh()');
    const project = this.documents.project();
    const errors = project.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0) return errors;
    if (!project.scenes.has(this.#scene)) {
      return [diagnostic('PP2045', `The scene "${this.#scene}" is no longer in the documents`, { fix: 'Open another scene (session.openScene).' })];
    }
    if (!this.#poseFromScene) this.#capturePose();
    const kernel = this.#runtime.kernel;
    kernel.replaceProject(project);
    kernel.loadScene(this.#scene, { seed: this.#seed });
    this.#enterEditWorld();
    return [];
  }

  /**
   * Files changed outside the editor (`ProjectDocuments.replaceFiles`): the documents take
   * them, the undo history is cleared (its patches were made against the old text), and the
   * edit world is rebuilt. Answers `refresh`'s errors, or throws the kernel's coded error
   * when it refuses the new data; the documents hold the files either way, so the next
   * change (a fix) rebuilds the world.
   */
  replaceFiles(files: ReadonlyMap<string, string | null>): readonly Diagnostic[] {
    this.#requireEdit('replaceFiles()');
    this.cancelDrag();
    this.documents.replaceFiles(files);
    this.history.clear();
    // The selection is kept by document keys: it follows its entities where they still exist.
    return this.refresh();
  }

  /** Edit another scene of the project (the view starts from its own camera). */
  openScene(scene: string): void {
    this.#requireEdit('openScene()');
    if (!this.documents.project().scenes.has(scene)) {
      fail('PP2045', `Unknown scene "${scene}"`, { fix: `Scenes: ${[...this.documents.project().scenes.keys()].join(', ')}.` });
    }
    this.#scene = scene;
    this.#selection = [];
    this.#poseFromScene = true;
    const errors = this.refresh();
    if (errors.length > 0) fail(errors[0]!.code, errors[0]!.message, { fix: errors[0]!.fix ?? 'Fix the documents first.' });
  }

  #capturePose(): void {
    if (this.#camera === undefined) return;
    const record = this.#runtime.kernel.world.get(this.#camera);
    if (record === undefined) return;
    const fields = record.components.get(CAMERA);
    this.#pose = {
      position: record.transform.position, rotation: record.transform.rotation,
      ...(fields !== undefined && { fov: fields['fov'] as number, size: fields['size'] as number }),
    };
  }

  // ── Play ─────────────────────────────────────────────────────────────────────

  /**
   * Play a scene from its documents, in place: `scene` (default the edited one). Stop comes
   * back to the edited scene either way.
   */
  play(options: { readonly scene?: string } = {}): void {
    if (this.#mode !== 'edit') return;
    const project = this.documents.project();
    const scene = options.scene ?? this.#scene;
    if (!project.scenes.has(scene)) {
      fail('PP2045', `Unknown scene "${scene}"`, { fix: `Scenes: ${[...project.scenes.keys()].join(', ')}.` });
    }
    const errors = project.diagnostics.filter((d) => d.severity === 'error');
    if (errors.length > 0) {
      fail('PP9633', `The documents have ${errors.length} error${errors.length === 1 ? '' : 's'}; the game can't play`, {
        fix: `First: ${errors[0]!.code} ${errors[0]!.message}`,
      });
    }
    this.cancelDrag();
    this.history.seal();
    this.#capturePose();
    const kernel = this.#runtime.kernel;
    kernel.settle();
    this.#editSnapshot = kernel.snapshot();
    kernel.replaceProject(project);
    kernel.setLogic(true);
    this.#mode = 'playing';
    this.#playScene = scene;
    kernel.loadScene(scene, { seed: this.#seed });
  }

  /** Back to edit mode: the edit world exactly as play found it. */
  stop(): readonly Diagnostic[] {
    if (this.#mode === 'edit') return [];
    const kernel = this.#runtime.kernel;
    kernel.setLogic(false);
    kernel.time.scale = 1;
    this.#mode = 'edit';
    const snapshot = this.#editSnapshot;
    this.#editSnapshot = undefined;
    try {
      kernel.restore(snapshot!);
      this.#useCamera();
      this.#sources = mapSources(kernel.world, this.documents.project(), kernel.scene!, (id) => id === this.#camera);
      return [];
    } catch (error) {
      // The snapshot no longer fits this game (new code after a hot reload): rebuild from the documents.
      const problems = diagnosticsOf(error).map((d) => ({ ...d, severity: 'warning' as const }));
      return [...problems, ...this.refresh()];
    }
  }

  pause(): void {
    if (this.#mode !== 'playing') return;
    this.#runtime.kernel.setLogic(false);
    this.#mode = 'paused';
  }

  resume(): void {
    if (this.#mode !== 'paused') return;
    this.#runtime.kernel.setLogic(true);
    this.#mode = 'playing';
  }

  /** While paused: run `frames` frames of one fixed step each, then pause again. */
  step(frames = 1): void {
    if (this.#mode !== 'paused') fail('PP9637', 'step() runs frames of a paused game', { fix: 'Pause first (session.pause()).' });
    const kernel = this.#runtime.kernel;
    kernel.setLogic(true);
    try {
      for (let i = 0; i < frames; i++) this.#runtime.step(kernel.time.fixedStep);
    } finally {
      kernel.setLogic(false);
    }
  }

  /** Game time per real second while playing (1 normal; 0.25 slow motion; 0 frozen). */
  setTimeScale(scale: number): void {
    if (!(Number.isFinite(scale) && scale >= 0)) fail('PP9637', `Time scale must be a number of 0 or more, got ${scale}`);
    this.#runtime.kernel.time.scale = scale;
  }

  // ── Hot reload ───────────────────────────────────────────────────────────────

  /**
   * Swap in a new build of the game (changed code or data), keeping the editor's state.
   * Playing: the game's snapshot is restored into the new code (restored: true), or its
   * scene restarts when the snapshot no longer fits (restored: false, with why). Edit mode:
   * the edit world is rebuilt from the documents in the new runtime.
   */
  async reload(): Promise<ReloadResult> {
    const rebuild = this.#host.rebuild;
    if (rebuild === undefined) fail('PP9632', 'This session has no host to rebuild the game', { fix: 'Pass host.rebuild when creating the session.' });
    this.cancelDrag();
    const old = this.#runtime;
    const mode = this.#mode;
    if (mode === 'edit') this.#capturePose();
    // Hold the game still while the new build loads (the page keeps drawing it).
    if (mode === 'playing') old.kernel.setLogic(false);
    let next: GameRuntime;
    try {
      next = await rebuild(this.documents);
    } catch (error) {
      if (mode === 'playing') old.kernel.setLogic(true);
      throw error;
    }
    const diagnostics: Diagnostic[] = [];
    let restored = true;
    this.#runtime = next;
    if (mode === 'edit') {
      next.kernel.loadScene(this.#scene, { seed: this.#seed });
      this.#enterEditWorld();
    } else {
      const snapshot = old.kernel.snapshot();
      try {
        next.kernel.restore(snapshot);
        next.kernel.setLogic(mode === 'playing');
      } catch (error) {
        diagnostics.push(...diagnosticsOf(error));
        restored = false;
        next.kernel.setLogic(true);
        next.kernel.loadScene(this.#playScene, { seed: this.#seed });
        if (mode === 'paused') next.kernel.setLogic(false);
      }
    }
    if (this.#profiling) this.profiler.attach(next.kernel);
    if (this.#host.replace !== undefined) this.#host.replace(next);
    else old.kernel.dispose();
    return { restored, diagnostics };
  }

  // ── Profiling and observation ────────────────────────────────────────────────

  /** Start (or stop) feeding the profiler from the game's frames. */
  setProfiling(on: boolean): void {
    this.#profiling = on;
    if (on) this.profiler.attach(this.#runtime.kernel);
    else this.profiler.detach();
  }

  /** What the game shows (observe.ts), the editor camera and its helpers left out. */
  observe(options: ObserveOptions = {}): Observation {
    const camera = this.cameraEntity;
    return observe(this.#runtime, {
      ...options,
      camera: options.camera ?? camera ?? null,
      exclude: (id) => id === camera || options.exclude?.(id) === true,
    });
  }

  /** Stop profiling and forget the selection outline (the game itself is the host's). */
  dispose(): void {
    this.profiler.detach();
    this.#unoutline([...this.#outlined.keys()]);
  }
}
