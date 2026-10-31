/**
 * The inspector's field editors. Each takes the field's JSON value (as the files hold it)
 * and an environment that commits a new value; a value the selection doesn't share shows
 * as "—". Number labels (and vector axis letters) scrub the value when dragged, previewing
 * every step and settling into one undo step when the drag ends.
 */

import { placeholderJson } from './session/index.js';
import type { EntityId } from '@parallax/runtime/core';
import type { FieldSpec, FieldType } from '@parallax/runtime/kernel';
import type { Json } from '@parallax/runtime/resource';
import { h, icon } from './dom.js';
import { t } from './i18n.js';
import {
  assetName, clampNumber, colorHex, colorParts, fieldWidget, parseHexColor, parseInput, rangeFraction, rangeText, scrubValue, shortNumber,
} from './fields.js';
import type { AssetFolder, FieldWidget } from './fields.js';
import { FOLDER_ICONS, openAssetPicker, openEntityPicker, openMenu } from './inspector_pickers.js';
import type { AssetPickerSource, EntityChoice } from './inspector_pickers.js';

/** The data type an entity row carries when dragged from the hierarchy. */
export const ENTITY_DRAG_TYPE = 'application/x-parallax-entity';

export interface WidgetServices {
  readonly assets: AssetPickerSource;
  readonly prefabs: () => readonly string[];
  /** The scene's entities to pick from; each choice sets the field when picked. */
  readonly entities: (set: (placedId: string) => void) => readonly EntityChoice[];
  /** What the hierarchy calls the entity with this placed id (undefined: none in the scene). */
  readonly entityLabel: (placedId: string) => string | undefined;
  /** The placed id an entity dropped from the hierarchy is referenced by (giving it one if needed). */
  readonly referenceTo: (id: EntityId) => string | undefined;
}

export interface FieldEnv {
  readonly editable: boolean;
  /** The selection doesn't share one value: show "—". */
  readonly mixed: boolean;
  readonly commit: (value: Json) => void;
  /** One step of a drag (merged into one undo step); defaults to commit. */
  readonly preview?: (value: Json) => void;
  /** The drag ended. */
  readonly settle?: () => void;
  readonly services: WidgetServices;
}

const MIXED = '—';

// ── Numbers ──────────────────────────────────────────────────────────────────────────────

type Range = Pick<FieldSpec, 'min' | 'max'>;

/** Drag `handle` left/right to change a number; `apply` gets every step, `done` the end. */
export function scrubber(handle: HTMLElement, start: () => number, range: Range, int: boolean, apply: (n: number) => void, done: () => void): void {
  handle.classList.add('scrub');
  handle.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const x0 = event.clientX;
    const from = start();
    let moved = false;
    let last = from;
    let frame = 0;
    handle.setPointerCapture?.(event.pointerId);
    document.body.classList.add('insp-scrubbing');
    const move = (e: PointerEvent): void => {
      const dx = e.clientX - x0;
      if (!moved && Math.abs(dx) < 3) return;
      moved = true;
      last = scrubValue(from, dx, range, int, { fast: e.shiftKey, fine: e.altKey });
      if (frame === 0) frame = requestAnimationFrame(() => { frame = 0; apply(last); });
    };
    const up = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('insp-scrubbing');
      if (frame !== 0) { cancelAnimationFrame(frame); frame = 0; }
      if (moved) { apply(last); done(); }
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
}

/** A number box clamped to the field's range (shown as a fill and in its tooltip). */
export function numberInput(value: number | undefined, range: Range, int: boolean, editable: boolean, commit: (n: number) => void): HTMLInputElement {
  const input = h('input.field-input.number', {
    type: 'text', inputmode: 'decimal', value: value === undefined ? '' : shortNumber(value), placeholder: value === undefined ? MIXED : '',
    disabled: !editable, spellcheck: 'false',
  });
  const text = rangeText(range);
  if (text !== '') input.title = t('widgets.range', { range: text });
  const fill = (n: number | undefined): void => {
    const f = n === undefined ? undefined : rangeFraction(n, range);
    if (f === undefined) return;
    input.classList.add('ranged');
    input.style.setProperty('--fill', `${Math.round(f * 1000) / 10}%`);
  };
  fill(value);
  input.addEventListener('change', () => {
    const parsed = parseInput('number', input.value);
    if (!parsed.ok) { input.classList.add('invalid'); input.title = parsed.error; return; }
    input.classList.remove('invalid');
    const n = clampNumber(parsed.value as number, range, int);
    input.value = shortNumber(n);
    fill(n);
    commit(n);
  });
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur(); });
  return input;
}

/** A number field; `label` (the row's label) scrubs it. */
function numberControl(json: Json | undefined, spec: Range, int: boolean, env: FieldEnv, label?: HTMLElement): HTMLElement {
  const value = env.mixed || typeof json !== 'number' ? undefined : json;
  const input = numberInput(value, spec, int, env.editable, (n) => env.commit(n));
  if (label !== undefined && env.editable) {
    scrubber(label, () => (value ?? (Number(input.value) || 0)), spec, int, (n) => {
      input.value = shortNumber(n);
      (env.preview ?? env.commit)(n);
    }, () => env.settle?.());
  }
  const text = rangeText(spec);
  return text === '' ? input : h('div.number-row', {}, input, h('span.field-range', { text }));
}

/**
 * X / Y / Z boxes; each axis letter scrubs its part. `values[i]` undefined: mixed. With
 * `label`, the row label scrubs every part together.
 */
export function vectorControl(values: readonly (number | undefined)[], env: FieldEnv, range: Range = {}): HTMLElement {
  const current = values.map((v) => v ?? 0);
  const axes = ['x', 'y', 'z', 'w'];
  const parts = values.map((v, i) => {
    const input = numberInput(env.mixed ? undefined : v, range, false, env.editable, (n) => { current[i] = n; env.commit([...current]); });
    const axis = values.length > 1 ? h('span.axis', { text: axes[i]! }) : null;
    if (axis !== null && env.editable) {
      scrubber(axis, () => current[i]!, range, false, (n) => {
        current[i] = n;
        input.value = shortNumber(n);
        (env.preview ?? env.commit)([...current]);
      }, () => env.settle?.());
    }
    return h('label.vector-part', {}, axis, input);
  });
  return h('div.vector', {}, ...parts);
}

// ── Colors ───────────────────────────────────────────────────────────────────────────────

/**
 * A swatch (on a checkerboard, so alpha shows), a hex box and — when the value has alpha —
 * an alpha box. `hex`: the value is written as a "#rrggbb" string (scene settings).
 */
function colorControl(json: Json | undefined, env: FieldEnv, options: { readonly alpha: boolean; readonly hex?: boolean }): HTMLElement {
  const [r, g, b, a] = colorParts(json);
  let alpha = a;
  const out = (rgba: readonly number[]): Json => (options.hex === true ? colorHex(rgba as Json) : [rgba[0]!, rgba[1]!, rgba[2]!, options.alpha ? alpha : 1]);
  const swatchFill = h('span.color-swatch-fill');
  const paint = (rgba: readonly number[]): void => {
    swatchFill.style.background = env.mixed ? 'transparent' : `rgba(${Math.round(rgba[0]! * 255)}, ${Math.round(rgba[1]! * 255)}, ${Math.round(rgba[2]! * 255)}, ${options.alpha ? alpha : 1})`;
  };
  paint([r, g, b]);
  const native = h('input.color-native', { type: 'color', value: colorHex([r, g, b, 1]), disabled: !env.editable, tabindex: -1 });
  const swatch = h('label.color-swatch', { title: env.editable ? t('widgets.pickColor') : '' }, swatchFill, native);
  const hexBox = h('input.field-input.color-hex', {
    type: 'text', value: env.mixed ? '' : colorHex([r, g, b, 1]), placeholder: env.mixed ? MIXED : '#rrggbb', disabled: !env.editable, spellcheck: 'false', maxlength: 9,
  });
  native.addEventListener('input', () => {
    const rgba = parseHexColor(native.value, alpha)!;
    hexBox.value = native.value;
    paint(rgba);
    (env.preview ?? env.commit)(out(rgba));
  });
  native.addEventListener('change', () => {
    if (env.preview === undefined) return;
    env.settle?.();
  });
  hexBox.addEventListener('change', () => {
    const rgba = parseHexColor(hexBox.value, alpha);
    if (rgba === null) { hexBox.classList.add('invalid'); return; }
    hexBox.classList.remove('invalid');
    if (options.alpha && /^#?[0-9a-f]{8}$/i.test(hexBox.value.trim())) alpha = rgba[3];
    hexBox.value = colorHex(rgba);
    native.value = colorHex(rgba);
    paint(rgba);
    env.commit(out(rgba));
  });
  hexBox.addEventListener('keydown', (event) => { if (event.key === 'Enter') hexBox.blur(); });
  const row = h('div.color-row', {}, swatch, hexBox);
  if (options.alpha) {
    const alphaLabel = h('span.axis-label', { text: 'A' });
    const alphaBox = numberInput(env.mixed ? undefined : alpha, { min: 0, max: 1 }, false, env.editable, (n) => {
      alpha = n;
      const rgba = parseHexColor(hexBox.value || native.value, n) ?? [r, g, b, n];
      paint(rgba);
      env.commit(out(rgba));
    });
    alphaBox.classList.add('color-alpha');
    if (env.editable) {
      scrubber(alphaLabel, () => alpha, { min: 0, max: 1 }, false, (n) => {
        alpha = n;
        alphaBox.value = shortNumber(n);
        const rgba = parseHexColor(hexBox.value || native.value, n) ?? [r, g, b, n];
        paint(rgba);
        (env.preview ?? env.commit)(out(rgba));
      }, () => env.settle?.());
    }
    row.append(h('label.alpha-part', { title: t('widgets.alpha') }, alphaLabel, alphaBox));
  }
  return row;
}

// ── Pickers ──────────────────────────────────────────────────────────────────────────────

function clearButton(env: FieldEnv, onClear: () => void): HTMLButtonElement | null {
  if (!env.editable) return null;
  return h('button.picker-clear', {
    type: 'button', title: t('widgets.clear'), 'aria-label': t('widgets.clear'),
    onclick: (event: Event) => { event.stopPropagation(); onClear(); },
  }, icon('x', 11));
}

function assetControl(json: Json | undefined, folder: AssetFolder, env: FieldEnv, optional: boolean): HTMLElement {
  const ref = typeof json === 'string' ? json : '';
  const thumb = ref === '' ? null : env.services.assets.thumb(ref, folder);
  const button = h('button.picker-field.asset-field', { type: 'button', disabled: !env.editable, title: ref === '' ? t('widgets.chooseAsset') : ref },
    h('span.picker-icon', {}, thumb ?? icon(FOLDER_ICONS[folder], 13)),
    h('span.picker-name', { text: env.mixed ? MIXED : ref === '' ? t('inspector.none') : assetName(ref) }));
  button.addEventListener('click', () => openAssetPicker(button, folder, ref, env.services.assets, (next) => env.commit(next === '' && optional ? null : next)));
  if (ref === '' || env.mixed) button.classList.add('empty');
  return h('div.picker-row', {}, button, ref !== '' ? clearButton(env, () => env.commit(optional ? null : '')) : null);
}

function prefabControl(json: Json | undefined, env: FieldEnv, optional: boolean): HTMLElement {
  const id = typeof json === 'string' ? json : '';
  const button = h('button.picker-field', { type: 'button', disabled: !env.editable, title: id === '' ? t('widgets.choosePrefab') : `prefabs/${id}` },
    h('span.picker-icon', {}, icon('package', 13)), h('span.picker-name', { text: env.mixed ? MIXED : id === '' ? t('inspector.none') : id }));
  button.addEventListener('click', () => openMenu(button, env.services.prefabs().map((p) => ({ label: p, icon: 'package' as const, disabled: p === id, run: () => env.commit(p) })),
    { search: t('widgets.searchPrefabs'), empty: t('widgets.noPrefabMatches'), width: 240 }));
  if (id === '' || env.mixed) button.classList.add('empty');
  return h('div.picker-row', {}, button, id !== '' ? clearButton(env, () => env.commit(optional ? null : '')) : null);
}

/** An entity reference: pick from the scene, or drop a hierarchy row on it. */
function entityControl(json: Json | undefined, env: FieldEnv): HTMLElement {
  const id = typeof json === 'string' ? json : null;
  const name = env.mixed ? MIXED : id === null ? t('inspector.none') : id === 'local_player' ? t('widgets.localPlayer') : env.services.entityLabel(id) ?? t('widgets.missing', { name: id });
  const button = h('button.picker-field.entity-field', { type: 'button', disabled: !env.editable, title: env.editable ? t('widgets.pickEntity') : '' },
    h('span.picker-icon', {}, icon('box', 13)), h('span.picker-name', { text: name }));
  if (id === null || env.mixed) button.classList.add('empty');
  if (id !== null && id !== 'local_player' && env.services.entityLabel(id) === undefined) button.classList.add('missing');
  button.addEventListener('click', () => openEntityPicker(button, id, env.services.entities((placed) => env.commit(placed)), () => env.commit(null)));
  const accept = (entity: EntityId): void => {
    const placed = env.services.referenceTo(entity);
    if (placed !== undefined) env.commit(placed);
  };
  if (env.editable) {
    button.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types.includes(ENTITY_DRAG_TYPE) !== true) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'link';
      button.classList.add('drop-target');
    });
    button.addEventListener('dragleave', () => button.classList.remove('drop-target'));
    button.addEventListener('drop', (event) => {
      button.classList.remove('drop-target');
      const raw = event.dataTransfer?.getData(ENTITY_DRAG_TYPE);
      if (raw === undefined || raw === '') return;
      event.preventDefault();
      accept(Number(raw) as EntityId);
    });
    // A hierarchy row dragged with the pointer (rows that aren't draggable): see installEntityDrag.
    button.addEventListener('parallax-entity-drop', (event) => accept((event as CustomEvent<EntityId>).detail));
  }
  return h('div.picker-row', {}, button, id !== null && !env.mixed ? clearButton(env, () => env.commit(null)) : null);
}

/**
 * Let hierarchy rows be dragged onto entity fields: native drags carry the row's entity
 * (ENTITY_DRAG_TYPE), and a plain pointer drag from a row (rows that aren't draggable)
 * drops on the field it is released over. Installed once.
 */
let dragInstalled = false;
export function installEntityDrag(): void {
  if (dragInstalled || typeof document === 'undefined') return;
  dragInstalled = true;
  const rowEntity = (target: EventTarget | null): string | undefined =>
    (target instanceof Element ? target.closest<HTMLElement>('.tree-row[data-entity]')?.dataset['entity'] : undefined);
  document.addEventListener('dragstart', (event) => {
    const id = rowEntity(event.target);
    if (id !== undefined) event.dataTransfer?.setData(ENTITY_DRAG_TYPE, id);
  }, true);
  let pressed: { id: string; x: number; y: number } | undefined;
  document.addEventListener('pointerdown', (event) => {
    const id = rowEntity(event.target);
    pressed = id === undefined || event.button !== 0 ? undefined : { id, x: event.clientX, y: event.clientY };
  }, true);
  document.addEventListener('pointerup', (event) => {
    const from = pressed;
    pressed = undefined;
    if (from === undefined || Math.hypot(event.clientX - from.x, event.clientY - from.y) < 6) return;
    const field = document.elementFromPoint(event.clientX, event.clientY)?.closest('.entity-field');
    field?.dispatchEvent(new CustomEvent('parallax-entity-drop', { detail: Number(from.id) as EntityId }));
  }, true);
}

// ── Any field ────────────────────────────────────────────────────────────────────────────

function flagsControl(json: Json | undefined, values: readonly string[], env: FieldEnv): HTMLElement {
  const on = new Set(Array.isArray(json) ? json.filter((v): v is string => typeof v === 'string') : []);
  return h('div.flags', {}, ...values.map((v) => {
    const b = h('button.flag', { type: 'button', text: v, disabled: !env.editable, 'aria-pressed': on.has(v) ? 'true' : 'false' });
    if (on.has(v) && !env.mixed) b.classList.add('active');
    b.addEventListener('click', () => {
      if (on.has(v)) on.delete(v); else on.add(v);
      env.commit(values.filter((x) => on.has(x)));
    });
    return b;
  }));
}

function textControl(json: Json | undefined, env: FieldEnv): HTMLElement {
  const input = h('input.field-input', { type: 'text', value: env.mixed || typeof json !== 'string' ? '' : json, placeholder: env.mixed ? MIXED : '', disabled: !env.editable, spellcheck: 'false' });
  input.addEventListener('change', () => env.commit(input.value));
  input.addEventListener('keydown', (event) => { if (event.key === 'Enter') input.blur(); });
  return input;
}

function jsonControl(json: Json | undefined, env: FieldEnv): HTMLElement {
  const area = h('textarea.field-input.json', { rows: 1, disabled: !env.editable, spellcheck: 'false', placeholder: env.mixed ? MIXED : '' });
  area.value = env.mixed || json === undefined ? '' : JSON.stringify(json);
  area.addEventListener('change', () => {
    const parsed = parseInput('json', area.value);
    if (parsed.ok) env.commit(parsed.value); else { area.classList.add('invalid'); area.title = parsed.error; }
  });
  return area;
}

/** The control for `widget` (no optional handling). */
function control(widget: FieldWidget, json: Json | undefined, spec: FieldSpec, env: FieldEnv, label?: HTMLElement): HTMLElement {
  switch (widget.kind) {
    case 'bool': {
      const box = h('input.field-check', { type: 'checkbox', disabled: !env.editable });
      box.checked = !env.mixed && json === true;
      box.indeterminate = env.mixed;
      box.addEventListener('change', () => env.commit(box.checked));
      return box;
    }
    case 'enum': {
      const select = h('select.field-input', { disabled: !env.editable },
        env.mixed ? h('option', { value: '', text: MIXED, selected: true, disabled: true }) : null,
        ...widget.values.map((v) => h('option', { value: v, text: v, selected: !env.mixed && v === json })));
      select.addEventListener('change', () => env.commit(select.value));
      return select;
    }
    case 'number': case 'int':
      return numberControl(json, spec, widget.kind === 'int', env, label);
    case 'vec2': case 'vec3': {
      const n = widget.kind === 'vec2' ? 2 : 3;
      const values = Array.from({ length: n }, (_, i) => (Array.isArray(json) && typeof json[i] === 'number' ? json[i] as number : undefined));
      return vectorControl(values, env);
    }
    case 'color':
      return colorControl(json, env, { alpha: true });
    case 'asset':
      return assetControl(json, widget.folder, env, widget.optional);
    case 'prefab':
      return prefabControl(json, env, widget.optional);
    case 'entity':
      return entityControl(json, env);
    case 'flags':
      return flagsControl(json, widget.values, env);
    case 'string': case 'ref':
      return typeof json === 'string' || env.mixed ? textControl(json, env) : jsonControl(json, env);
    default:
      return jsonControl(json, env);
  }
}

function innerType(type: FieldType): FieldType {
  return type.kind === 'optional' ? innerType(type.of) : type;
}

/**
 * The control for a declared field. An optional value that is None shows "None" and a
 * button to set it; a set one a button to clear it back to None.
 */
export function fieldControl(spec: FieldSpec, json: Json | undefined, env: FieldEnv, label?: HTMLElement): HTMLElement {
  const widget = fieldWidget(spec.type);
  // Pickers have their own clear button, which writes None for an optional field.
  const picker = widget.kind === 'asset' || widget.kind === 'prefab' || widget.kind === 'entity';
  if (!widget.optional || picker) return control(widget, json, spec, env, label);
  if (json === null && !env.mixed) {
    const start = placeholderJson(innerType(spec.type));
    return h('div.optional-row', {}, h('span.field-none', { text: t('inspector.none') }),
      env.editable && start !== undefined ? h('button.optional-set', { type: 'button', text: t('widgets.set'), title: t('widgets.setTitle'), onclick: () => env.commit(start) }) : null);
  }
  return h('div.optional-row', {}, control(widget, json, spec, env, label),
    env.editable ? h('button.picker-clear', { type: 'button', title: t('widgets.backToNone'), 'aria-label': t('widgets.clear'), onclick: () => env.commit(null) }, icon('x', 11)) : null);
}

/** A color control for scene settings: "#rrggbb" strings, no alpha. */
export function hexColorControl(json: Json | undefined, env: FieldEnv): HTMLElement {
  return colorControl(json, env, { alpha: false, hex: true });
}

/** A number control for scene settings (a plain range, no schema). */
export function plainNumberControl(json: Json | undefined, range: Range, env: FieldEnv, label?: HTMLElement, int = false): HTMLElement {
  return numberControl(json, range, int, env, label);
}
