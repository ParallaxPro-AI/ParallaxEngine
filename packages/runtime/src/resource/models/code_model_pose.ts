/**
 * One entity's look of a model: its Model fields applied on top of the asset.
 *
 *   joints        a model document's joints at their values now (`joints`, `joint_motion`;
 *                 rules in resource/models/rig.ts): a hinge turns its part about the axis
 *                 (parent frame) around the part's origin, a slider moves it, a scale joint
 *                 scales it; children follow. Applied after the animator's pose, so a joint
 *                 on a part an animation also moves adds to it.
 *   parts         shown and hidden parts (a document's `hidden`, its part-set options, then
 *                 `parts`); a hidden part hides everything under it. For a glTF model,
 *                 parts are its named nodes.
 *   materials     option choices and `colors` (material name → base color).
 *   sockets       a socket's frame in model space, posed: a document's declared sockets,
 *                 or any part, bone or (glTF) node by name — its origin.
 *
 * Names are checked when used (PP2121–PP2125, the codes `parallax check` reports for the
 * same mistakes in data). Everything here is a pure function of the asset, the fields and
 * game time, so the look snapshots and replays with the entity.
 */

import { closestMatch, Color, fail, Quat, Vec3 } from '../../core/index.js';
import type { Material3d, Rgba } from '../../core/index.js';
import {
  checkChoice, chosenMaterial, clampJoint, jointValue, materialNamed, optionNamed, partNamed, shownParts,
} from './rig.js';
import type { JointMotion } from './rig.js';
import type { ModelDocument, ModelJoint } from './format.js';

/** A component's fields (the kernel's `Fields`), as read here. */
type Fields = Readonly<Record<string, unknown>>;
import { codeMaterial } from './code_model.js';
import type { ModelAsset, ModelPrimitive } from './gltf.js';
import { compose, invert, multiply } from './matrix.js';
import type { M4 } from './matrix.js';

const IDENTITY: M4 = compose(0, 0, 0, 0, 0, 0, 1, 1, 1, 1);

function describe(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') return value.constructor?.name ?? 'object';
  return JSON.stringify(value);
}

/**
 * A dict field's entries, each checked by `read`. The field holds a plain object (data, the
 * Model methods) or the dict game code assigned (its `toJSON` gives the str-keyed entries).
 */
function entries<T>(fields: Fields, key: string, where: string, read: (value: unknown, at: string) => T): [string, T][] {
  let dict = fields[key];
  if (dict === undefined || dict === null) return [];
  if (typeof dict === 'object' && Object.getPrototypeOf(dict) !== Object.prototype && typeof (dict as { toJSON?: unknown }).toJSON === 'function') {
    dict = (dict as { toJSON(): unknown }).toJSON();
  }
  if (typeof dict !== 'object' || dict === null || Array.isArray(dict)) fail('PP3800', `${where}.${key} must be a dict, got ${describe(fields[key])}`);
  return Object.entries(dict as Record<string, unknown>).map(([name, value]) => [name, read(value, `${where}.${key}["${name}"]`)]);
}

function finiteNumber(value: unknown, at: string): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fail('PP3800', `${at} must be a finite number, got ${describe(value)}`);
}

function motion(value: unknown, at: string): JointMotion {
  const m = value as Partial<JointMotion> | null;
  if (typeof m !== 'object' || m === null) return fail('PP3800', `${at} must be a joint motion record, got ${describe(value)}`);
  return {
    start_value: finiteNumber(m.start_value, `${at}.start_value`), start_time: finiteNumber(m.start_time, `${at}.start_time`),
    seconds: finiteNumber(m.seconds, `${at}.seconds`),
    ...(m.ease !== undefined && { ease: str(m.ease, `${at}.ease`) }),
  };
}

function str(value: unknown, at: string): string {
  if (typeof value === 'string') return value;
  return fail('PP3800', `${at} must be a string, got ${describe(value)}`);
}

function flag(value: unknown, at: string): boolean {
  if (typeof value === 'boolean') return value;
  return fail('PP3800', `${at} must be True or False, got ${describe(value)}`);
}

function color(value: unknown, at: string): Color {
  if (value instanceof Color) return value;
  return fail('PP3800', `${at} must be a Color, got ${describe(value)}`, { fix: 'Use Color(r, g, b) or Color.hex("#rrggbb").' });
}

/** Each node's place in `order` and the end of its subtree there (`order` is depth-first, parents first). */
const subtrees = new WeakMap<ModelAsset, { readonly at: Int32Array; readonly end: Int32Array }>();

function subtreeOf(model: ModelAsset): { readonly at: Int32Array; readonly end: Int32Array } {
  let known = subtrees.get(model);
  if (known === undefined) {
    const at = new Int32Array(model.nodes.length).fill(-1);
    model.order.forEach((n, i) => { at[n] = i; });
    const size = new Int32Array(model.nodes.length);
    for (let i = model.order.length - 1; i >= 0; i--) {
      const n = model.order[i]!;
      size[n] = 1 + model.nodes[n]!.children.reduce((sum, c) => sum + size[c]!, 0);
    }
    const end = new Int32Array(model.order.length);
    model.order.forEach((n, i) => { end[i] = i + size[n]!; });
    known = { at, end };
    subtrees.set(model, known);
  }
  return known;
}

/** The joint values the fields give now (joint name → value), every name checked. */
export function jointValues(doc: ModelDocument, fields: Fields, now: number, where: string): Map<ModelJoint, number> {
  const targets = new Map(entries(fields, 'joints', where, finiteNumber));
  const motions = new Map(entries(fields, 'joint_motion', where, motion));
  for (const name of [...targets.keys(), ...motions.keys()]) {
    if (!doc.joints.has(name)) {
      const known = [...doc.joints.keys()];
      const guess = closestMatch(name, known);
      fail('PP2121', `${where}: the model ${doc.path} has no joint "${name}"`, {
        fix: guess !== undefined ? `Did you mean "${guess}"?` : known.length === 0 ? 'It has no joints.' : `Its joints: ${known.join(', ')}.`,
      });
    }
  }
  const values = new Map<ModelJoint, number>();
  for (const joint of doc.joints.values()) {
    const target = clampJoint(joint, targets.get(joint.name) ?? joint.default);
    values.set(joint, jointValue(target, motions.get(joint.name), now));
  }
  return values;
}

/** The joint's change to its part's local transform: L' = before · L · after. */
function jointDelta(joint: ModelJoint, value: number, local: ArrayLike<number>): { before: M4; after: M4 } | null {
  const [ax, ay, az] = joint.axis;
  if (joint.type === 'slider') {
    if (value === 0) return null;
    return { before: compose(ax * value, ay * value, az * value, 0, 0, 0, 1, 1, 1, 1), after: IDENTITY };
  }
  if (joint.type === 'scale') {
    if (value === 1) return null;
    const s = (c: number): number => (Math.abs(c) > 1e-6 ? value : 1);
    return { before: IDENTITY, after: compose(0, 0, 0, 0, 0, 0, 1, s(ax), s(ay), s(az)) };
  }
  if (value === 0) return null;
  const half = (value * Math.PI) / 360;
  const sin = Math.sin(half);
  // About the part's own origin: T(origin) · R · T(-origin), the origin in the parent's frame.
  const ox = local[12]!; const oy = local[13]!; const oz = local[14]!;
  const r = compose(0, 0, 0, ax * sin, ay * sin, az * sin, Math.cos(half), 1, 1, 1);
  const before = multiply(multiply(compose(ox, oy, oz, 0, 0, 0, 1, 1, 1, 1), r), compose(-ox, -oy, -oz, 0, 0, 0, 1, 1, 1, 1));
  return { before, after: IDENTITY };
}

/**
 * Node matrices with a document's joints applied (a new array; `worlds`, which may be a
 * shared rest pose, is not changed). Returns `worlds` itself when no joint moves anything.
 */
export function applyJoints(model: ModelAsset, worlds: Float32Array, values: ReadonlyMap<ModelJoint, number>): Float32Array {
  const code = model.code;
  if (code === null) return worlds;
  const { at, end } = subtreeOf(model);
  const moving = [...values].filter(([joint, value]) => value !== (joint.type === 'scale' ? 1 : 0))
    .sort((a, b) => at[code.partNode[a[0].part]!]! - at[code.partNode[b[0].part]!]!);
  if (moving.length === 0) return worlds;
  const out = Float32Array.from(worlds);
  for (const [joint, value] of moving) {
    const node = code.partNode[joint.part]!;
    const own = out.subarray(node * 16, node * 16 + 16);
    const parent = model.nodes[node]!.parent;
    const parentWorld = parent === -1 ? IDENTITY : out.subarray(parent * 16, parent * 16 + 16);
    const parentInverse = invert(parentWorld);
    if (parentInverse === null) fail('PP3820', `${model.path}: the parent of part "${model.nodes[node]!.name}" has a zero scale`);
    const local = multiply(parentInverse, own);
    const delta = jointDelta(joint, value, local);
    if (delta === null) continue;
    const moved = multiply(parentWorld, multiply(delta.before, multiply(local, delta.after)));
    const ownInverse = invert(own);
    if (ownInverse === null) fail('PP3820', `${model.path}: part "${model.nodes[node]!.name}" has a zero scale`);
    const change = multiply(moved, ownInverse);
    const first = at[node]!;
    for (let i = first; i < end[first]!; i++) {
      const n = model.order[i]!;
      const m = out.subarray(n * 16, n * 16 + 16);
      multiply(change, m, m);
    }
  }
  return out;
}

export interface ModelLookChoices {
  /** Option name → choice (validated). */
  readonly choices: Readonly<Record<string, string>>;
  /** Nodes not drawn (1), by node index; null: every node is drawn. */
  readonly hidden: Uint8Array | null;
  /** Material name → base color. */
  readonly colors: ReadonlyMap<string, Rgba>;
}

/** The fields' option choices, shown parts and colors, checked against the model. */
export function lookOf(model: ModelAsset, fields: Fields, where: string): ModelLookChoices {
  const doc = model.code?.document ?? null;
  const options = entries(fields, 'options', where, str);
  const parts = entries(fields, 'parts', where, flag);
  const colors = new Map(entries(fields, 'colors', where, color).map(([k, c]) => [k, [c.r, c.g, c.b, c.a] as Rgba]));
  const choices: Record<string, string> = {};
  for (const [name, choice] of options) {
    if (doc === null) fail('PP2123', `${where}.options names "${name}", but ${model.path} is a glTF model, which has no options`);
    choices[name] = checkChoice(optionNamed(doc, name, `${where}.options`), choice, `${where}.options["${name}"]`);
  }
  for (const name of colors.keys()) {
    if (doc !== null) materialNamed(doc, name, `${where}.colors`);
    else if (!model.meshes.some((m) => m.some((p) => p.materialName === name))) {
      const known = [...new Set(model.meshes.flatMap((m) => m.flatMap((p) => (p.materialName === null ? [] : [p.materialName]))))];
      const guess = closestMatch(name, known);
      fail('PP2125', `${where}.colors: ${model.path} has no material "${name}"`, {
        fix: guess !== undefined ? `Did you mean "${guess}"?` : known.length === 0 ? 'Its materials are unnamed.' : `Its materials: ${known.join(', ')}.`,
      });
    }
  }
  let hidden: Uint8Array | null = null;
  const hide = (node: number): void => {
    const { at, end } = subtreeOf(model);
    hidden ??= new Uint8Array(model.nodes.length);
    for (let i = at[node]!; i < end[at[node]!]!; i++) hidden[model.order[i]!] = 1;
  };
  if (doc !== null) {
    for (const [name] of parts) partNamed(doc, name, `${where}.parts`);
    const shown = shownParts(doc, choices, Object.fromEntries(parts));
    // Parents first, so a shown part under a hidden one stays hidden with it.
    shown.forEach((on, p) => { if (!on) hide(model.code!.partNode[p]!); });
  } else {
    for (const [name, on] of parts) {
      const node = model.nodeByName.get(name);
      if (node === undefined) {
        const known = [...model.nodeByName.keys()];
        const guess = closestMatch(name, known);
        fail('PP2124', `${where}.parts: ${model.path} has no node "${name}"`, {
          fix: guess !== undefined ? `Did you mean "${guess}"?` : `Its nodes: ${known.slice(0, 12).join(', ')}${known.length > 12 ? ', …' : ''}.`,
        });
      }
      if (!on) hide(node);
    }
  }
  return { choices, hidden, colors };
}

/** Per-entity materials: identity-stable across frames for the same look (surfaces key their GPU copies on them). */
export class LookMaterials {
  readonly #made = new Map<string, Material3d>();

  /** The primitive's material for this look: option choices and a recolor applied. */
  of(model: ModelAsset, primitive: ModelPrimitive, look: ModelLookChoices): Material3d {
    const name = primitive.materialName;
    if (name === null) return primitive.material;
    const doc = model.code?.document ?? null;
    let choiceKey = '';
    if (doc !== null) {
      for (const option of doc.options.values()) {
        const choice = look.choices[option.name];
        if (option.kind === 'material' && option.materials.includes(name) && choice !== undefined && choice !== option.default) {
          choiceKey += `|${option.name}=${choice}`;
        }
      }
    }
    const recolor = look.colors.get(name);
    if (choiceKey === '' && recolor === undefined) return primitive.material;
    const key = `${primitive.material.id}${choiceKey}${recolor === undefined ? '' : `|color=${recolor.join(',')}`}`;
    let made = this.#made.get(key);
    if (made === undefined) {
      const base = doc === null ? primitive.material : codeMaterial(key, chosenMaterial(doc, name, look.choices));
      made = { ...base, id: key, ...(recolor !== undefined && { baseColor: recolor }) };
      this.#made.set(key, made);
    }
    return made;
  }
}

/**
 * A socket's frame in model space (before `Model.offset`), from posed node matrices:
 * a declared socket, else a part, bone or node by name. PP2122 when there is none.
 */
export function socketMatrix(model: ModelAsset, worlds: Float32Array, name: string, where: string): M4 {
  const doc = model.code?.document ?? null;
  const declared = doc?.sockets.get(name);
  if (declared !== undefined && doc !== null) {
    const local = compose(...declared.position, ...declared.rotation, 1, 1, 1);
    const parent = declared.parent;
    if (parent === null) return local;
    const node = parent.kind === 'part' ? model.code!.partNode[parent.index]! : model.code!.boneNode[parent.index]!;
    return multiply(worlds.subarray(node * 16, node * 16 + 16), local);
  }
  const node = model.nodeByName.get(name);
  if (node !== undefined) return Float32Array.from(worlds.subarray(node * 16, node * 16 + 16));
  const declaredNames = doc === null ? [] : [...doc.sockets.keys()];
  const known = declaredNames.length > 0 ? declaredNames : [...model.nodeByName.keys()];
  const guess = closestMatch(name, [...declaredNames, ...model.nodeByName.keys()]);
  return fail('PP2122', `${where}: ${model.path} has no socket "${name}"`, {
    fix: guess !== undefined ? `Did you mean "${guess}"?`
      : known.length === 0 ? 'It has no sockets, parts or named nodes.' : `Its ${declaredNames.length > 0 ? 'sockets' : 'nodes'}: ${known.slice(0, 12).join(', ')}.`,
  });
}

/** Every socket a model offers by name: declared sockets first, then parts, bones and nodes. */
export function socketNames(model: ModelAsset, kind: string | null): string[] {
  const doc = model.code?.document ?? null;
  const declared = doc === null ? [] : [...doc.sockets.values()].filter((s) => kind === null || s.kind === kind).map((s) => s.name);
  if (kind !== null) return declared;
  return [...declared, ...[...model.nodeByName.keys()].filter((n) => !declared.includes(n))];
}

/** `Model.offset` as a vector (checked). */
export function offsetOf(fields: Fields, where: string): Vec3 {
  const offset = fields['offset'];
  if (offset instanceof Vec3) return offset;
  return fail('PP3800', `${where}.offset must be a Vec3, got ${describe(offset)}`);
}

/**
 * `Model.rotation_offset` (Euler degrees, like `Transform.rotation`'s) as a rotation: it
 * turns a model authored facing another axis to face the entity's +z. Absent (an older
 * snapshot) or zero: none.
 */
export function rotationOffsetOf(fields: Fields, where: string): Quat {
  const r = fields['rotation_offset'];
  if (r === undefined || r === null) return Quat.IDENTITY;
  if (!(r instanceof Vec3)) return fail('PP3800', `${where}.rotation_offset must be a Vec3 (degrees), got ${describe(r)}`);
  return r.x === 0 && r.y === 0 && r.z === 0 ? Quat.IDENTITY : Quat.from_euler(r);
}

/**
 * `Model.scale`: the uniform size multiplier about the model's origin. Absent (an older
 * snapshot): 1. Drawing, sockets, IK, root motion and mesh/convex colliders all follow it.
 */
export function modelScaleOf(fields: Fields, where: string): number {
  const s = fields['scale'];
  if (s === undefined || s === null) return 1;
  if (typeof s !== 'number' || !(s > 0) || !Number.isFinite(s)) {
    return fail('PP3800', `${where}.scale must be a number above 0, got ${describe(s)}`, { fix: 'Use 1 for the model\'s own size, 2 for twice it, 0.5 for half.' });
  }
  return s;
}

/** The model → entity matrix: `Model.scale` and `rotation_offset` about the model's origin, then `Model.offset`. */
export function modelOffsetMatrix(fields: Fields, where: string): M4 {
  const o = offsetOf(fields, where);
  const q = rotationOffsetOf(fields, where);
  const s = modelScaleOf(fields, where);
  return compose(o.x, o.y, o.z, q.x, q.y, q.z, q.w, s, s, s);
}

/** A model-space point (a vertex) where the entity holds it: scaled by `scale`, turned by `rotation_offset`, then moved by `offset`. */
export function modelPointToEntity(fields: Fields, where: string): (x: number, y: number, z: number) => [number, number, number] {
  const o = offsetOf(fields, where);
  const q = rotationOffsetOf(fields, where);
  const s = modelScaleOf(fields, where);
  if (q === Quat.IDENTITY) return (x, y, z) => [x * s + o.x, y * s + o.y, z * s + o.z];
  return (x, y, z) => {
    const v = q.rotate(new Vec3(x * s, y * s, z * s));
    return [v.x + o.x, v.y + o.y, v.z + o.z];
  };
}
