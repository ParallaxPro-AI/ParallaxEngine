/**
 * The inspector (Properties): the selection's name, transform, components and behavior
 * params, or — with nothing selected (the scene row) — the scene's settings.
 *
 * Edits go to the documents through the session (undoable) — to the placement
 * ("Instance"), or to its prefab so every instance changes ("Prefab"; a prefab child is
 * always edited in its prefab). A field the placement overrides is marked, with a revert
 * button. Several selected entities show the components they share; an edit applies to all
 * of them and a value they don't share shows "—". While the game plays, edits change the
 * running game only (never the documents) and the values refresh as it runs.
 *
 * Components can be added (a searchable menu of the engine's and the game's own) and, from
 * a component's menu, reset, copied, pasted and removed. Sections remember whether they are
 * collapsed, per component kind.
 */

import { defaultFields, requiredFields } from './session/index.js';
import type { EditTarget, Pose } from './session/index.js';
import { asObject } from './session/index.js';
import { Quat, Vec3, BUILTIN_EFFECT_PREFIX, BUILTIN_EFFECTS } from '@parallax/runtime/core';
import type { EntityId } from '@parallax/runtime/core';
import { encode } from '@parallax/runtime/kernel';
import type { EntityRecord, FieldSpec } from '@parallax/runtime/kernel';
import { SYNTH_PRESET_NAMES } from '@parallax/runtime/plugins/audio';
import { resolvePrefab } from '@parallax/runtime/resource';
import type { Json, JsonObject } from '@parallax/runtime/resource';
import { addPiece, fetchLibrary } from './asset_library_panel.js';
import { assetUrl, portrait } from './asset_previews.js';
import { clear, h, icon, panelFrame } from './dom.js';
import type { Editor } from './editor.js';
import {
  assetChoices, assetFile, assetHandle, categoryLabel, categoryName, CollapsedSections, enableField, fieldLabel, fieldVisible, fieldWidget, filterComponents, sharedIds, sharedValue, valueJson,
} from './fields.js';
import type { AssetFolder, ComponentChoice } from './fields.js';
import { entityLabel } from './hierarchy.js';
import { onLanguageChange, t } from './i18n.js';
import { closePopup, openAssetPicker, openMenu, popupOpen } from './inspector_pickers.js';
import type { AssetPickerSource, EntityChoice, MenuItem } from './inspector_pickers.js';
import { fieldControl, installEntityDrag, vectorControl } from './inspector_widgets.js';
import type { FieldEnv, WidgetServices } from './inspector_widgets.js';
import { sceneSettings } from './scene_settings.js';
import { scanUsedAssets } from './used_assets.js';
import './inspector.css';

/** Components the editor itself puts on the selection (the 3D outline), left out while editing. */
const EDITOR_COMPONENTS = new Set(['outline']);

/** Copied component values (Copy Values → Paste Values), shared by every inspector. */
let clipboard: { readonly componentId: string; readonly values: JsonObject } | undefined;

function storage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

type Kind = 'component' | 'behavior';

export class InspectorPanel {
  readonly el: HTMLElement;
  readonly #editor: Editor;
  readonly #body: HTMLElement;
  readonly #collapsed = new CollapsedSections(storage());
  readonly #services: WidgetServices;
  #target: EditTarget = 'instance';
  #timer: ReturnType<typeof setInterval> | undefined;
  /** A label drag is changing a value: hold re-renders (they would drop the pointer). */
  #scrubbing = false;
  /** The undo merge key of the drag in progress. */
  #merge: string | undefined;
  #mergeSeq = 0;
  /** A render was held back while a field had focus. */
  #pending = false;

  constructor(editor: Editor) {
    this.#editor = editor;
    const frame = panelFrame(t('properties.title'));
    onLanguageChange(() => { frame.header.querySelector('.panel-title')!.textContent = t('properties.title'); this.render(); });
    frame.root.classList.add('inspector-panel');
    this.#body = frame.body;
    this.el = frame.root;
    this.#services = this.#makeServices();
    installEntityDrag();
    this.el.addEventListener('focusout', () => setTimeout(() => { if (this.#pending) this.render(); }, 0));
    editor.on((changes) => {
      if (changes.has('mode')) {
        clearInterval(this.#timer);
        closePopup();
        this.#timer = editor.editing ? undefined : setInterval(() => this.#tick(), 250);
      }
      if (changes.has('selection') || changes.has('world') || changes.has('mode') || changes.has('documents')) this.render();
    });
    this.render();
  }

  /** While playing: refresh the live values, unless the user is in the middle of an edit. */
  #tick(): void {
    if (popupOpen()) return;
    this.render();
  }

  render(): void {
    if (this.#scrubbing) return;
    // Typing in a field: don't rebuild under the cursor (it renders once the field loses focus).
    const active = document.activeElement;
    const typing = (active instanceof HTMLInputElement && !['checkbox', 'color', 'radio'].includes(active.type)) || active instanceof HTMLTextAreaElement;
    if (typing && this.el.contains(active)) {
      this.#pending = true;
      return;
    }
    this.#pending = false;
    const session = this.#editor.session;
    const scroll = this.#body.scrollTop;
    clear(this.#body);
    const world = session.runtime.kernel.world;
    const records = session.selection.map((id) => world.get(id)).filter((r): r is EntityRecord => r !== undefined);
    if (!this.#editor.editing) this.#body.append(h('div.inspector-live', { title: t('inspector.liveTitle') }, icon('play', 11), h('span', { text: t('inspector.live') })));
    if (records.length === 0 && this.#editor.sceneSelected) {
      this.#body.append(this.#sceneSettings());
    } else if (records.length === 0) {
      this.#body.append(h('div.panel-empty', { text: t('properties.noSelection') }));
    } else if (records.length === 1) {
      this.#single(records[0]!);
    } else {
      this.#multi(records);
    }
    this.#body.scrollTop = scroll;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────────────

  /**
   * The selection as a function of now: in edit mode every edit rebuilds the world (new
   * entity ids), so ids are found again from their document keys at the moment of use.
   */
  #idsNow(records: readonly EntityRecord[]): () => EntityId[] {
    const session = this.#editor.session;
    if (!this.#editor.editing) {
      const ids = records.map((r) => r.id);
      return () => ids;
    }
    const keys = records.map((r) => session.sourceOf(r.id)?.key);
    return () => keys.map((k, i) => (k === undefined ? records[i]!.id : session.sources.byKey.get(k) ?? records[i]!.id));
  }

  #editable(records: readonly EntityRecord[]): boolean {
    if (!this.#editor.editing) return true;
    return records.every((r) => this.#editor.session.sourceOf(r.id) !== undefined);
  }

  #targetFor(ids: readonly EntityId[]): EditTarget {
    return ids.some((id) => this.#editor.session.sourceOf(id)?.kind === 'child') ? 'prefab' : this.#target;
  }

  /** The placement or prefab-child JSON an entity came from. */
  #sourceJson(id: EntityId): JsonObject | undefined {
    const source = this.#editor.session.sourceOf(id);
    return source === undefined ? undefined : asObject(this.#editor.documents.get(source.path, source.pointer));
  }

  /**
   * A field's value as written (the entry's override, else its prefab's, else the default):
   * what an entity reference is in the files (a placed id), which the live world holds as a handle.
   */
  #authored(id: EntityId, kind: Kind, owner: string, field: string, spec: FieldSpec): Json | undefined {
    const session = this.#editor.session;
    const source = session.sourceOf(id);
    if (source === undefined) return undefined;
    const own = asObject(asObject(this.#sourceJson(id)?.[kind === 'component' ? 'components' : 'params'])?.[owner])?.[field];
    if (own !== undefined) return own;
    const project = this.#editor.documents.project();
    const prefab = source.prefab;
    if (prefab !== undefined && project.prefabs.has(prefab)) {
      const resolved = resolvePrefab(project, prefab);
      const value = kind === 'component' ? resolved.components[owner]?.[field] : resolved.behaviors.find((b) => b.use === owner)?.params[field];
      if (value !== undefined) return value;
    }
    try {
      return spec.default === undefined ? undefined : encode(spec.type, spec.default, field);
    } catch {
      return null;
    }
  }

  /** A field's value on one entity, as JSON. */
  #fieldJson(record: EntityRecord, kind: Kind, owner: string, field: string, spec: FieldSpec, live: unknown): Json | undefined {
    const json = valueJson(spec, live, `${owner}.${field}`);
    if (json !== undefined) return json;
    return this.#editor.editing ? this.#authored(record.id, kind, owner, field, spec) : undefined;
  }

  /** Run a document edit (edit mode) or a live one (playing); a drag's steps share one undo step. */
  #apply(label: string, edit: (merge: string | undefined) => void, drag = false): void {
    if (drag) {
      this.#scrubbing = true;
      this.#merge ??= `inspector-drag-${++this.#mergeSeq}`;
    }
    this.#editor.run(label, () => edit(drag ? this.#merge : undefined), 'world');
  }

  #settle(): void {
    this.#editor.session.history.seal();
    this.#merge = undefined;
    this.#scrubbing = false;
    this.render();
  }

  #section(key: string, title: string, tag: string, rows: readonly HTMLElement[], extras: { readonly toggle?: HTMLElement; readonly menu?: () => MenuItem[] } = {}): HTMLElement {
    const fields = h('div.fields', {}, ...rows);
    const menuButton = extras.menu === undefined ? null : h('button.section-menu', { type: 'button', title: t('inspector.componentMenu'), 'aria-label': t('inspector.componentMenu') }, icon('more', 13));
    const header = h('div.section-header', { role: 'button', tabindex: 0, 'aria-expanded': 'true' },
      h('span.section-chevron', {}, icon('chevron', 11)),
      extras.toggle ?? null,
      h('span.section-title', { text: title }),
      tag !== '' ? h('span.section-kind', { text: tag }) : null,
      menuButton);
    const section = h('div.inspector-section', {}, header, fields);
    const show = (open: boolean): void => {
      section.classList.toggle('collapsed', !open);
      header.setAttribute('aria-expanded', String(open));
    };
    show(!this.#collapsed.has(key));
    const toggle = (): void => {
      const open = section.classList.contains('collapsed');
      this.#collapsed.set(key, !open);
      show(open);
    };
    header.addEventListener('click', (event) => {
      if ((event.target as Element).closest('input, button.section-menu') !== null) return;
      toggle();
    });
    header.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle(); } });
    if (menuButton !== null) menuButton.addEventListener('click', (event) => { event.stopPropagation(); openMenu(menuButton, extras.menu!(), { width: 200 }); });
    return section;
  }

  // ── Scene settings ───────────────────────────────────────────────────────────────────

  #sceneSettings(): HTMLElement {
    const session = this.#editor.session;
    let gravity: number | undefined;
    try {
      const physics = (session.runtime.ctx as unknown as Record<string, unknown>)['physics'] as { gravity?: unknown } | undefined;
      gravity = typeof physics?.gravity === 'number' ? physics.gravity : undefined;
    } catch {
      gravity = undefined;
    }
    return sceneSettings(session.scene, {
      editable: this.#editor.editing,
      environment: session.environment(),
      set: (keys, value, merge) => this.#apply(`Set environment.${keys.join('.')}`, (m) => session.setEnvironment(keys, value, m === undefined ? {} : { merge: m }), merge === true),
      settle: () => this.#settle(),
      collapsed: this.#collapsed,
      services: this.#services,
      gravity,
      dimension: session.dimension,
    });
  }

  // ── One entity ───────────────────────────────────────────────────────────────────────

  #single(record: EntityRecord): void {
    this.#body.append(this.#header(record));
    this.#body.append(this.#transform(record));
    this.#components([record]);
  }

  #header(record: EntityRecord): HTMLElement {
    const editor = this.#editor;
    const session = editor.session;
    const source = session.sourceOf(record.id);
    const where = source === undefined ? (editor.editing ? t('inspector.notInDocuments') : t('inspector.liveEntity')) : `${source.path}${source.pointer}`;
    let name: HTMLElement;
    if (editor.editing && source !== undefined && source.cell === undefined) {
      const placement = source.kind === 'placement';
      const current = placement ? record.placedId ?? '' : record.childName ?? '';
      const input = h('input.inspector-name-input', {
        type: 'text', value: current, placeholder: record.prefab ?? t('inspector.unnamed'), spellcheck: 'false', 'aria-label': t('inspector.name'),
        title: placement
          ? t('inspector.placementIdTitle')
          : t('inspector.childNameTitle'),
      });
      const ids = this.#idsNow([record]);
      input.addEventListener('change', () => editor.renameEntity(ids()[0]!, input.value));
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') input.blur();
        if (event.key === 'Escape') { input.value = current; input.blur(); }
      });
      name = input;
    } else {
      name = h('div.inspector-name', { text: entityLabel(record) });
    }
    const header = h('div.inspector-header', {}, name,
      h('div.inspector-meta', {}, record.prefab !== undefined ? h('span.badge', { text: record.prefab }) : null, h('span.inspector-source', { text: where, title: where })));
    if (editor.editing && source !== undefined) header.append(...this.#targetSwitch(source.kind === 'child'));
    if (editor.editing && source?.kind === 'placement') {
      header.append(h('button.inspector-remove', { type: 'button', text: t('inspector.removeFromScene'), onclick: () => editor.removeSelected() }));
    }
    return header;
  }

  #targetSwitch(childOnly: boolean): HTMLElement[] {
    const seg = (target: EditTarget, text: string, title: string): HTMLButtonElement => h('button.seg', {
      type: 'button', text, title, onclick: () => { this.#target = target; this.render(); },
    });
    const instance = seg('instance', t('inspector.instance'), t('inspector.instanceTitle'));
    const prefab = seg('prefab', t('inspector.prefab'), t('inspector.prefabTitle'));
    const target = childOnly ? 'prefab' : this.#target;
    instance.classList.toggle('active', target === 'instance');
    prefab.classList.toggle('active', target === 'prefab');
    if (childOnly) instance.disabled = true;
    return [h('div.inspector-target', {}, h('span.field-label', { text: t('inspector.editTarget') }), h('div.segmented', {}, instance, prefab))];
  }

  #transform(record: EntityRecord): HTMLElement {
    const editor = this.#editor;
    const session = editor.session;
    const pose = session.poseOf(record.id);
    const two = session.dimension === '2d';
    const editable = editor.editing ? session.sourceOf(record.id) !== undefined : true;
    const ids = this.#idsNow([record]);
    const setPose = (next: (p: Pose) => Pose, drag: boolean): void => {
      this.#apply('Move', (merge) => {
        const id = ids()[0]!;
        const poses = new Map([[id, next(session.poseOf(id))]]);
        if (editor.editing) session.setPoses(poses, merge === undefined ? {} : { merge }); else session.setLivePoses(poses);
      }, drag);
    };
    const row = (name: string, values: number[], apply: (v: number[], p: Pose) => Pose): HTMLElement => {
      const env: FieldEnv = {
        editable, mixed: false, services: this.#services,
        commit: (v) => setPose((p) => apply(v as number[], p), false),
        preview: (v) => setPose((p) => apply(v as number[], p), true),
        settle: () => this.#settle(),
      };
      return h('div.field-row', {}, h('span.field-label', { text: name }), vectorControl(values, env));
    };
    const p = pose.position;
    const rows: HTMLElement[] = [];
    if (two) {
      rows.push(row(t('inspector.position'), [p.x, p.y], (v, q) => ({ ...q, position: new Vec3(v[0]!, v[1]!, q.position.z) })));
      rows.push(row(t('inspector.drawOrder'), [p.z], (v, q) => ({ ...q, position: new Vec3(q.position.x, q.position.y, v[0]!) })));
      rows.push(row(t('inspector.rotation'), [pose.rotation.angle()], (v, q) => ({ ...q, rotation: Quat.from_angle(v[0]!) })));
      rows.push(row(t('inspector.scale'), [pose.scale.x, pose.scale.y], (v, q) => ({ ...q, scale: new Vec3(v[0]!, v[1]!, q.scale.z) })));
    } else {
      const e = pose.rotation.to_euler();
      rows.push(row(t('inspector.position'), [p.x, p.y, p.z], (v, q) => ({ ...q, position: new Vec3(v[0]!, v[1]!, v[2]!) })));
      rows.push(row(t('inspector.rotation'), [e.x, e.y, e.z], (v, q) => ({ ...q, rotation: Quat.from_euler(new Vec3(v[0]!, v[1]!, v[2]!)) })));
      rows.push(row(t('inspector.scale'), [pose.scale.x, pose.scale.y, pose.scale.z], (v, q) => ({ ...q, scale: new Vec3(v[0]!, v[1]!, v[2]!) })));
    }
    return this.#section('transform', t('inspector.transform'), t('inspector.worldTag'), rows);
  }

  // ── Several entities ─────────────────────────────────────────────────────────────────

  #multi(records: readonly EntityRecord[]): void {
    const editing = this.#editor.editing;
    const header = h('div.inspector-header', {},
      h('div.inspector-name', { text: t('properties.entitiesSelected', { count: records.length }) }),
      h('div.inspector-meta', {}, h('span.inspector-source', { text: t('inspector.multiNote') })));
    const sources = records.map((r) => this.#editor.session.sourceOf(r.id));
    if (editing && sources.every((s) => s !== undefined)) header.append(...this.#targetSwitch(sources.some((s) => s!.kind === 'child')));
    this.#body.append(header);
    this.#components(records);
  }

  // ── Components and behaviors ─────────────────────────────────────────────────────────

  #components(records: readonly EntityRecord[]): void {
    const editing = this.#editor.editing;
    const registry = this.#editor.session.runtime.kernel.registry;
    const shared = sharedIds(records.map((r) => [...r.components.keys()]));
    for (const componentId of shared) {
      if (editing && EDITOR_COMPONENTS.has(componentId)) continue;
      const def = registry.components.get(componentId);
      if (def === undefined) continue;
      this.#body.append(this.#componentSection(componentId, def.schema, records));
    }
    const behaviors = sharedIds(records.map((r) => r.behaviors.map((b) => b.def.id)));
    for (const behaviorId of behaviors) {
      const def = registry.behaviors.get(behaviorId);
      if (def === undefined) continue;
      this.#body.append(this.#behaviorSection(behaviorId, def.params, records));
    }
    if (shared.length === 0 && behaviors.length === 0) this.#body.append(h('p.panel-note', { text: records.length > 1 ? t('inspector.noSharedComponents') : t('inspector.noComponents') }));
    if (editing && this.#editable(records)) {
      const label = records.length > 1 ? t('properties.addComponentToAll') : t('properties.addComponent');
      const add = h('button.inspector-add', { type: 'button' }, icon('plus', 13), h('span', { text: label }));
      add.addEventListener('click', () => this.#openAddComponent(add, records));
      this.#body.append(h('div.inspector-add-row', {}, add));
    }
  }

  /** Each field of a section as rows; `commit` writes one field on every entity. */
  #rows(kind: Kind, owner: string, schema: Readonly<Record<string, FieldSpec>>, records: readonly EntityRecord[], skip: ReadonlySet<string>,
    write: (field: string, value: Json, merge: string | undefined) => void): HTMLElement[] {
    const editor = this.#editor;
    const single = records.length === 1 ? records[0]! : undefined;
    const editable = this.#editable(records);
    const source = single === undefined ? undefined : this.#sourceJson(single.id);
    const overrides = asObject(asObject(source?.[kind === 'component' ? 'components' : 'params'])?.[owner]);
    const values = (record: EntityRecord): Record<string, unknown> => (kind === 'component'
      ? record.components.get(owner) ?? {}
      : record.behaviors.find((b) => b.def.id === owner)?.instance as unknown as Record<string, unknown> ?? {});
    const jsonOf = new Map<string, { mixed: boolean; value: Json | undefined }>();
    for (const [name, spec] of Object.entries(schema)) {
      jsonOf.set(name, sharedValue(records.map((r) => this.#fieldJson(r, kind, owner, name, spec, values(r)[name]))));
    }
    const current = Object.fromEntries([...jsonOf].map(([k, v]) => [k, v.value]));
    const rows: HTMLElement[] = [];
    for (const [name, spec] of Object.entries(schema)) {
      if (skip.has(name)) continue;
      if (kind === 'component' && !fieldVisible(owner, name, current)) continue;
      const { mixed, value } = jsonOf.get(name)!;
      const overridden = single !== undefined && overrides !== undefined && name in overrides && this.#targetFor([single.id]) === 'instance';
      const label = h('span.field-label', { text: kind === 'component' ? fieldLabel(owner, name) : fieldLabel('', name), title: `${owner}.${name}${overridden ? ` — ${t('inspector.overridden')}` : ''}` });
      let control: HTMLElement;
      const widget = fieldWidget(spec.type);
      if (value === undefined && !mixed) {
        control = h('span.field-readonly', { text: t('inspector.setAtRunTime'), title: t('inspector.setAtRunTimeTitle') });
      } else if (!editor.editing && widget.kind === 'entity') {
        control = h('span.field-readonly', { text: typeof value === 'string' ? value : value === null ? t('inspector.none') : t('inspector.setAtRunTime') });
      } else {
        const env: FieldEnv = {
          editable, mixed, services: this.#services,
          commit: (v) => this.#apply(`Set ${owner}.${name}`, () => write(name, v, undefined)),
          preview: (v) => this.#apply(`Set ${owner}.${name}`, (merge) => write(name, v, merge), true),
          settle: () => this.#settle(),
        };
        control = fieldControl(spec, value, env, label);
      }
      const revert = overridden && kind === 'component' && editor.editing && editor.session.sourceOf(single.id)?.kind === 'placement'
        ? () => this.#editor.run(`Revert ${owner}.${name}`, () => editor.session.revertField(this.#idsNow([single])()[0]!, owner, name), 'world')
        : undefined;
      const row = h('div.field-row', {}, label, control,
        revert !== undefined ? h('button.field-revert', { type: 'button', title: t('inspector.revertToPrefab'), onclick: () => revert() }, icon('reload', 11)) : null);
      if (overridden) row.classList.add('overridden');
      rows.push(row);
    }
    if (rows.length === 0) rows.push(h('p.panel-note', { text: kind === 'component' ? t('inspector.noFields') : t('inspector.noParams') }));
    return rows;
  }

  #componentSection(componentId: string, schema: Readonly<Record<string, FieldSpec>>, records: readonly EntityRecord[]): HTMLElement {
    const editor = this.#editor;
    const session = editor.session;
    const ids = this.#idsNow(records);
    const editable = this.#editable(records);
    const write = (field: string, value: Json, merge: string | undefined): void => {
      const now = ids();
      if (editor.editing) session.setFields(now, componentId, field, value, this.#targetFor(now), merge === undefined ? {} : { merge });
      else session.setLiveField(now, componentId, field, value);
    };
    const enable = enableField(schema);
    const rows = this.#rows('component', componentId, schema, records, new Set(enable === undefined ? [] : [enable]), write);
    let toggle: HTMLElement | undefined;
    if (enable !== undefined) {
      const states = sharedValue(records.map((r) => (r.components.get(componentId)?.[enable] === false ? false : true)));
      const box = h('input.section-enable', { type: 'checkbox', title: t('properties.enabled'), 'aria-label': t('properties.enabled'), disabled: !editable });
      box.checked = states.value !== false;
      box.indeterminate = states.mixed;
      box.addEventListener('change', () => this.#apply(`Set ${componentId}.${enable}`, () => write(enable, box.checked, undefined)));
      toggle = box;
      if (states.value === false) rows.forEach((r) => r.classList.add('disabled-component'));
    }
    const section = this.#section(`component:${componentId}`, fieldLabel('', componentId), t('inspector.componentTag'), rows, {
      ...(toggle !== undefined && { toggle }),
      menu: () => this.#componentMenu(componentId, schema, records, ids, editable),
    });
    if (enable !== undefined && records.every((r) => r.components.get(componentId)?.[enable] === false)) section.classList.add('component-off');
    return section;
  }

  #componentMenu(componentId: string, schema: Readonly<Record<string, FieldSpec>>, records: readonly EntityRecord[], ids: () => EntityId[], editable: boolean): MenuItem[] {
    const editor = this.#editor;
    const session = editor.session;
    const setAll = (label: string, values: JsonObject): void => {
      editor.run(label, () => {
        const now = ids();
        if (editor.editing) session.setComponentValues(now, componentId, values, this.#targetFor(now), label);
        else for (const [field, value] of Object.entries(values)) session.setLiveField(now, componentId, field, value);
      }, 'world');
    };
    const first = records[0]!;
    const copy = (): void => {
      const fields = first.components.get(componentId) ?? {};
      const values: Record<string, Json> = {};
      for (const [name, spec] of Object.entries(schema)) {
        const json = this.#fieldJson(first, 'component', componentId, name, spec, fields[name]);
        if (json !== undefined) values[name] = json;
      }
      clipboard = { componentId, values };
      void navigator.clipboard?.writeText(JSON.stringify({ [componentId]: values }, null, 2)).catch(() => undefined);
      editor.write('info', `Copied ${componentId}'s values`);
    };
    const canPaste = clipboard?.componentId === componentId;
    return [
      { label: t('properties.reset'), icon: 'reload', disabled: !editable, run: () => setAll(`Reset ${componentId}`, defaultFields(schema, componentId)) },
      { label: t('properties.copyValues'), icon: 'package', run: copy },
      {
        label: t('properties.pasteValues'), icon: 'package', disabled: !editable || !canPaste,
        ...(clipboard !== undefined && !canPaste && { detail: t('inspector.clipboardHolds', { name: clipboard.componentId }) }),
        run: () => { if (clipboard?.componentId === componentId) setAll(`Paste ${componentId}`, clipboard.values); },
      },
      {
        label: t('properties.removeComponent'), icon: 'trash', danger: true, disabled: !editable || !editor.editing,
        run: () => editor.run(`Remove ${componentId}`, () => { const now = ids(); session.removeComponent(now, componentId, this.#targetFor(now)); }, 'world'),
      },
    ];
  }

  #behaviorSection(behaviorId: string, params: Readonly<Record<string, FieldSpec>>, records: readonly EntityRecord[]): HTMLElement {
    const editor = this.#editor;
    const session = editor.session;
    const ids = this.#idsNow(records);
    const write = (param: string, value: Json, merge: string | undefined): void => {
      const now = ids();
      if (editor.editing) session.setParams(now, behaviorId, param, value, this.#targetFor(now), merge === undefined ? {} : { merge });
      else session.setLiveParam(now, behaviorId, param, value);
    };
    return this.#section(`behavior:${behaviorId}`, fieldLabel('', behaviorId), t('inspector.behaviorTag'), this.#rows('behavior', behaviorId, params, records, new Set(), write));
  }

  // ── Add Component ────────────────────────────────────────────────────────────────────

  /** Every component a game can add: the engine's (by the plugin that provides it) and the game's own. */
  #componentChoices(): ComponentChoice[] {
    const runtime = this.#editor.session.runtime;
    const owner = new Map<string, string>();
    const plugins = [runtime.visuals, ...runtime.game.plugins];
    for (const plugin of plugins) for (const def of plugin.components ?? []) if (!owner.has(def.id)) owner.set(def.id, plugin.id);
    return [...runtime.kernel.registry.components.keys()]
      .filter((id) => !EDITOR_COMPONENTS.has(id))
      .map((id) => ({ id, category: owner.has(id) ? categoryName(owner.get(id)!) : 'Game' }));
  }

  #openAddComponent(anchor: HTMLElement, records: readonly EntityRecord[]): void {
    const editor = this.#editor;
    const session = editor.session;
    const ids = this.#idsNow(records);
    const registry = session.runtime.kernel.registry;
    const choices = filterComponents(this.#componentChoices().filter((c) => !records.every((r) => r.components.has(c.id))), '');
    const add = (componentId: string, values: JsonObject = {}): void => {
      this.#collapsed.set(`component:${componentId}`, false);
      editor.run(`Add ${componentId}`, () => { const now = ids(); session.addComponent(now, componentId, this.#targetFor(now), values); }, 'world');
    };
    const items = choices.map((c): MenuItem => ({
      label: fieldLabel('', c.id), detail: c.id, group: categoryLabel(c.category), keywords: `${c.id} ${c.category}`,
      run: () => {
        const def = registry.components.get(c.id)!;
        const { missing } = requiredFields(def.schema);
        // A required asset (a model's model): choose it first, then add the component with it.
        const asset = missing.length === 1 ? fieldWidget(def.schema[missing[0]!]!.type) : undefined;
        if (asset?.kind === 'asset') {
          openAssetPicker(anchor, asset.folder, '', this.#services.assets, (ref) => { if (ref !== '') add(c.id, { [missing[0]!]: ref }); });
          return;
        }
        add(c.id);
      },
    }));
    openMenu(anchor, items, { search: t('inspector.searchComponents'), empty: t('inspector.noComponentMatches'), width: Math.max(anchor.getBoundingClientRect().width, 260) });
  }

  // ── Pickers' data ────────────────────────────────────────────────────────────────────

  #makeServices(): WidgetServices {
    const editor = this.#editor;
    const thumb = (ref: string, folder: AssetFolder): Node | null => {
      if (ref === '' || ref.startsWith('effect/') || ref.startsWith('synth/')) return null;
      if (folder === 'images') {
        // A project image is named by its handle; the preview fetches its file.
        const file = /^[a-z][a-z0-9+.-]*:\/\//i.test(ref) ? ref : assetFile(ref, editor.documents.list());
        return file === undefined ? null : h('img.thumb-img', { src: assetUrl(file), alt: '', loading: 'lazy', draggable: 'false' });
      }
      if (folder === 'models' && editor.session.dimension === '3d') {
        const slot = h('span.thumb-slot', {}, icon('box', 14));
        void portrait(editor, ref, 64).then((url) => { if (url !== null) slot.replaceChildren(h('img.thumb-img', { src: url, alt: '' })); });
        return slot;
      }
      return null;
    };
    const builtins = (folder: AssetFolder): string[] => (folder === 'vfx' ? BUILTIN_EFFECTS.map((n) => `${BUILTIN_EFFECT_PREFIX}${n}`)
      : folder === 'sfx' ? SYNTH_PRESET_NAMES.map((n) => `synth/${n}`) : []);
    const assets: AssetPickerSource = {
      choices: (folder) => {
        let used: ReturnType<typeof scanUsedAssets> = [];
        try { used = scanUsedAssets(editor.documents); } catch { used = []; }
        return assetChoices(folder, editor.documents.list(), used, builtins(folder));
      },
      library: (folder) => (folder !== 'models' ? undefined
        : fetchLibrary().then((pieces) => pieces.filter((p) => p.category === 'models').map((p) => ({ id: p.id, summary: p.summary })))),
      addFromLibrary: async (piece) => {
        try {
          const result = await addPiece(piece);
          editor.write('info', `Added ${piece} from the library${result.added.length > 0 ? `: ${result.added.join(', ')}` : ''}`);
          const file = result.added.find((p) => p.endsWith('.model.json'));
          return file === undefined ? `models/${piece}` : assetHandle(file);
        } catch (error) {
          editor.fail(`Library add ${piece}`, error);
          return undefined;
        }
      },
      thumb,
    };
    const placedIds = (): Set<string> => {
      const scene = editor.documents.project().scenes.get(editor.session.scene);
      return new Set(scene?.entities.flatMap((p) => (p.id === undefined ? [] : [p.id])) ?? []);
    };
    /** The placed id code would use for an entity, giving its placement one when it has none. */
    const referenceTo = (id: EntityId): string | undefined => {
      const session = editor.session;
      const record = session.runtime.kernel.world.get(id);
      if (record === undefined) return undefined;
      if (record.placedId !== undefined) return record.placedId;
      const source = session.sourceOf(id);
      if (source?.kind !== 'placement' || source.cell !== undefined) {
        editor.write('warning', 'Only a scene placement can be referenced (a prefab child or grid cell has no placed id).');
        return undefined;
      }
      const taken = placedIds();
      const base = (record.prefab ?? 'entity').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^(?=\d)/, '_');
      let name = base;
      for (let n = 2; taken.has(name); n++) name = `${base}_${n}`;
      const ok = editor.run('Name the referenced entity', () => { session.rename(id, name); return true; }, 'world');
      return ok === true ? name : undefined;
    };
    return {
      assets,
      prefabs: () => [...editor.documents.project().prefabs.keys()].sort(),
      entities: (set) => {
        const session = editor.session;
        const out: EntityChoice[] = [];
        for (const record of session.runtime.kernel.world.live()) {
          const source = session.sourceOf(record.id);
          if (source?.kind !== 'placement' || source.cell !== undefined) continue;
          const key = source.key;
          out.push({
            placedId: record.placedId, label: entityLabel(record), prefab: record.prefab,
            pick: () => {
              const now = session.sources.byKey.get(key);
              const placed = now === undefined ? undefined : referenceTo(now);
              if (placed !== undefined) set(placed);
            },
          });
        }
        return out;
      },
      entityLabel: (placedId) => {
        for (const record of editor.session.runtime.kernel.world.live()) if (record.placedId === placedId) return entityLabel(record);
        return undefined;
      },
      referenceTo,
    };
  }
}

