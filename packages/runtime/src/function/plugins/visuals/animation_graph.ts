/**
 * Animator graphs: the prefab data an Animator carries (`params`, `layers`, `events`,
 * `ik`), read into a checked, immutable `AnimatorGraph`. One parser for the runtime (an
 * entity arriving) and `parallax check` (every prefab), so both report the same problems
 * with the same codes, at the same JSON pointers.
 *
 *   "params":  {"speed": 0, "grounded": true, "jump": "trigger"}
 *   "layers":  [{"name": "base", "states": {...}, "entry": "move", "transitions": [...]},
 *               {"name": "upper", "mask": ["Spine2"]},                         ← an action layer
 *               {"name": "breathe", "blend": "additive", "states": {"b": {"clip": "breathe"}}}]
 *   state:     {"clip": "idle"} | {"blend": {"param": "speed", "clips": [{"at": 0, "clip": "idle"}, ...]}}
 *              | {"blend": {"params": ["x", "y"], "clips": [{"at": [0, 1], "clip": "walk_f"}, ...]}}
 *              + "loop" (default true), "speed" (default 1), "speed_param" (a number param)
 *   transition: {"from": "move" | "*", "to": "air", "when": ["not grounded"], "fade": 0.15, "exit": 0.9}
 *   "events":  {"walk": [{"time": 0.25, "name": "footstep"}]}
 *   "ik":      {"limbs": {...}, "feet": {...}, "look": {...}}
 *
 * Conditions are short strings: `speed > 0.5`, `grounded`, `not grounded`, `jump` (a
 * trigger), `health <= 0`, `aiming == true`. Every condition of a transition must hold.
 */

import { closestMatch } from '../../../core/index.js';
import type { DiagnosticCode } from '../../../core/index.js';
import type { ClipMarker } from '../../services/index.js';

// ── The compiled graph ────────────────────────────────────────────────────────

export type ParamKind = 'number' | 'bool' | 'trigger';

export interface ParamDef {
  readonly name: string;
  readonly kind: ParamKind;
  /** A trigger starts (and resets to) false. */
  readonly initial: number | boolean;
}

export type CompareOp = '>' | '>=' | '<' | '<=' | '==' | '!=';

export interface Condition {
  readonly param: string;
  readonly op: CompareOp;
  readonly value: number | boolean;
  /** As authored, for messages. */
  readonly text: string;
}

export interface BlendPoint {
  /** One coordinate per blend parameter. */
  readonly at: readonly number[];
  readonly clip: string;
  readonly speed: number;
}

export type Motion =
  | { readonly kind: 'clip'; readonly clip: string }
  | { readonly kind: 'blend'; readonly params: readonly string[]; readonly points: readonly BlendPoint[] };

export interface StateDef {
  readonly name: string;
  readonly motion: Motion;
  readonly loop: boolean;
  readonly speed: number;
  /** A number param that multiplies the state's rate (e.g. "move_speed"). */
  readonly speedParam: string | null;
}

export interface TransitionDef {
  /** null: from any state ("*"). */
  readonly from: string | null;
  readonly to: string;
  readonly when: readonly Condition[];
  readonly fade: number;
  /** Normalized time (0–1) of the current state the transition waits for; null: none. */
  readonly exit: number | null;
}

export interface LayerDef {
  readonly name: string;
  readonly additive: boolean;
  readonly weight: number;
  /** Bone names whose subtrees the layer drives; null: every bone. */
  readonly mask: readonly string[] | null;
  /** Empty: an action layer, driven by play() / play_once() only. */
  readonly states: ReadonlyMap<string, StateDef>;
  readonly entry: string | null;
  readonly transitions: readonly TransitionDef[];
}

export interface LimbDef {
  readonly name: string;
  /** Upper, middle and end bone (shoulder/hip, elbow/knee, hand/foot). */
  readonly bones: readonly [string, string, string];
  /** Model-space direction the middle joint bends toward (knees forward, elbows back). */
  readonly pole: readonly [number, number, number];
}

export interface FeetDef {
  readonly limbs: readonly string[];
  /** Most the hips lower (meters) to keep a low foot planted. */
  readonly maxDrop: number;
  /** Most one foot moves up or down (meters) to meet the ground. */
  readonly maxStep: number;
  /** A number param (planar speed) that fades planting out between `fade[0]` and `fade[1]`. */
  readonly speedParam: string | null;
  readonly fade: readonly [number, number];
  /** A bool param: planting only while it is true. */
  readonly groundedParam: string | null;
  /** Collision layers that count as ground (empty: every layer). */
  readonly ground: readonly string[];
}

export interface LookDef {
  readonly bones: readonly string[];
  /** Degrees the look may turn the bones away from the animated pose. */
  readonly maxAngle: number;
}

export interface IkDef {
  readonly limbs: ReadonlyMap<string, LimbDef>;
  readonly feet: FeetDef | null;
  readonly look: LookDef | null;
}

export interface AnimatorGraph {
  readonly params: ReadonlyMap<string, ParamDef>;
  readonly layers: readonly LayerDef[];
  /** clip ref → markers (sorted by time). */
  readonly events: ReadonlyMap<string, readonly ClipMarker[]>;
  readonly ik: IkDef;
  readonly defaultClip: string | null;
}

/** A problem in animator data: a coded diagnostic's parts, located by JSON pointer under the animator. */
export interface GraphProblem {
  readonly code: DiagnosticCode;
  readonly message: string;
  readonly pointer: string;
  readonly fix?: string;
}

/** Humanoid limbs every animator knows by name (the canonical humanoid rig's bones). */
export const BUILT_IN_LIMBS: ReadonlyMap<string, LimbDef> = new Map<string, LimbDef>([
  ['left_hand', { name: 'left_hand', bones: ['LeftArm', 'LeftForeArm', 'LeftHand'], pole: [0, 0, -1] }],
  ['right_hand', { name: 'right_hand', bones: ['RightArm', 'RightForeArm', 'RightHand'], pole: [0, 0, -1] }],
  ['left_foot', { name: 'left_foot', bones: ['LeftUpLeg', 'LeftLeg', 'LeftFoot'], pole: [0, 0, 1] }],
  ['right_foot', { name: 'right_foot', bones: ['RightUpLeg', 'RightLeg', 'RightFoot'], pole: [0, 0, 1] }],
]);

export const BASE_LAYER = 'base';

// ── Parsing ───────────────────────────────────────────────────────────────────

type Raw = unknown;
type RawObject = Readonly<Record<string, unknown>>;

const isObject = (v: Raw): v is RawObject => typeof v === 'object' && v !== null && !Array.isArray(v);
const pointerTo = (base: string, key: string | number): string => `${base}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;

class Reader {
  readonly problems: GraphProblem[] = [];

  report(code: DiagnosticCode, pointer: string, message: string, fix?: string): void {
    this.problems.push({ code, message, pointer, ...(fix !== undefined && { fix }) });
  }

  /** Unknown keys of an object (PP3760), with the closest known one. */
  keys(value: RawObject, known: readonly string[], pointer: string, what: string): void {
    for (const key of Object.keys(value)) {
      if (known.includes(key)) continue;
      const guess = closestMatch(key, known);
      this.report('PP3760', pointerTo(pointer, key), `${what} has no key "${key}"`,
        guess !== undefined ? `Did you mean "${guess}"?` : `Keys: ${known.join(', ')}.`);
    }
  }

  object(value: Raw, pointer: string, what: string): RawObject | undefined {
    if (isObject(value)) return value;
    this.report('PP3760', pointer, `${what} must be an object, got ${describe(value)}`);
    return undefined;
  }

  list(value: Raw, pointer: string, what: string): readonly Raw[] | undefined {
    if (Array.isArray(value)) return value;
    this.report('PP3760', pointer, `${what} must be a list, got ${describe(value)}`);
    return undefined;
  }

  string(value: Raw, pointer: string, what: string): string | undefined {
    if (typeof value === 'string' && value !== '') return value;
    this.report('PP3760', pointer, `${what} must be a non-empty string, got ${describe(value)}`);
    return undefined;
  }

  number(value: Raw, pointer: string, what: string, min = -Infinity, max = Infinity): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) return value;
    const range = min > -Infinity && max < Infinity ? ` from ${min} to ${max}` : min > -Infinity ? ` of at least ${min}` : '';
    this.report('PP3760', pointer, `${what} must be a number${range}, got ${describe(value)}`);
    return undefined;
  }

  bool(value: Raw, pointer: string, what: string): boolean | undefined {
    if (typeof value === 'boolean') return value;
    this.report('PP3760', pointer, `${what} must be true or false, got ${describe(value)}`);
    return undefined;
  }

  vec3(value: Raw, pointer: string, what: string): [number, number, number] | undefined {
    if (Array.isArray(value) && value.length === 3 && value.every((n) => typeof n === 'number' && Number.isFinite(n))) {
      return [value[0] as number, value[1] as number, value[2] as number];
    }
    this.report('PP3760', pointer, `${what} must be [x, y, z], got ${describe(value)}`);
    return undefined;
  }
}

function describe(value: Raw): string {
  if (value === undefined) return 'nothing';
  return JSON.stringify(value);
}

/** The graph fields of an Animator, as decoded (refs as strings, graph data as JSON). */
export interface AnimatorData {
  readonly default_clip?: unknown;
  readonly params?: unknown;
  readonly layers?: unknown;
  readonly events?: unknown;
  readonly ik?: unknown;
}

/** Read an animator's data. Problems are collected; `graph` is undefined when there are any. */
export function readAnimatorGraph(data: AnimatorData): { readonly graph?: AnimatorGraph; readonly problems: readonly GraphProblem[] } {
  const r = new Reader();
  const params = readParams(r, data.params ?? {});
  const defaultClip = data.default_clip === null || data.default_clip === undefined ? null : r.string(data.default_clip, '/default_clip', 'default_clip') ?? null;
  const layers = readLayers(r, data.layers ?? [], params, defaultClip);
  const events = readEvents(r, data.events ?? {});
  const ik = readIk(r, data.ik ?? {}, params);
  if (r.problems.length > 0) return { problems: r.problems };
  return { graph: { params, layers, events, ik, defaultClip }, problems: [] };
}

function readParams(r: Reader, raw: Raw): Map<string, ParamDef> {
  const params = new Map<string, ParamDef>();
  const obj = r.object(raw, '/params', 'params');
  if (obj === undefined) return params;
  for (const [name, value] of Object.entries(obj)) {
    const at = pointerTo('/params', name);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      r.report('PP3760', at, `The param name "${name}" isn't an identifier`, 'Use letters, digits and underscores (e.g. "move_speed").');
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) params.set(name, { name, kind: 'number', initial: value });
    else if (typeof value === 'boolean') params.set(name, { name, kind: 'bool', initial: value });
    else if (value === 'trigger') params.set(name, { name, kind: 'trigger', initial: false });
    else r.report('PP3760', at, `params.${name} must be a number, true/false or "trigger", got ${describe(value)}`);
  }
  return params;
}

const LAYER_KEYS = ['name', 'blend', 'weight', 'mask', 'states', 'entry', 'transitions'];
const STATE_KEYS = ['clip', 'blend', 'loop', 'speed', 'speed_param'];
const TRANSITION_KEYS = ['from', 'to', 'when', 'fade', 'exit'];

function readLayers(r: Reader, raw: Raw, params: ReadonlyMap<string, ParamDef>, defaultClip: string | null): LayerDef[] {
  const list = r.list(raw, '/layers', 'layers');
  if (list === undefined) return [];
  if (list.length === 0) {
    return [{ name: BASE_LAYER, additive: false, weight: 1, mask: null, states: new Map(), entry: null, transitions: [] }];
  }
  const layers: LayerDef[] = [];
  const names = new Set<string>();
  list.forEach((item, i) => {
    const at = pointerTo('/layers', i);
    const obj = r.object(item, at, `layers[${i}]`);
    if (obj === undefined) return;
    r.keys(obj, LAYER_KEYS, at, `layers[${i}]`);
    const name = r.string(obj['name'], pointerTo(at, 'name'), `layers[${i}].name`);
    if (name === undefined) return;
    if (names.has(name)) r.report('PP3765', pointerTo(at, 'name'), `Two layers are named "${name}"`, 'Give every layer its own name.');
    names.add(name);
    const blend = obj['blend'] ?? 'override';
    if (blend !== 'override' && blend !== 'additive') {
      r.report('PP3760', pointerTo(at, 'blend'), `layers[${i}].blend must be "override" or "additive", got ${describe(blend)}`);
    }
    const weight = r.number(obj['weight'] ?? 1, pointerTo(at, 'weight'), `layers[${i}].weight`, 0, 1) ?? 1;
    let mask: string[] | null = null;
    if (obj['mask'] !== undefined) {
      const bones = r.list(obj['mask'], pointerTo(at, 'mask'), `layers[${i}].mask`) ?? [];
      mask = bones.flatMap((b, k) => r.string(b, pointerTo(pointerTo(at, 'mask'), k), `layers[${i}].mask[${k}]`) ?? []);
      if (bones.length === 0) r.report('PP3765', pointerTo(at, 'mask'), `layers[${i}].mask is empty, so the layer drives no bones`, 'Name the bones whose subtrees it drives (e.g. ["Spine2"]), or remove "mask".');
    }
    const states = readStates(r, obj['states'] ?? {}, pointerTo(at, 'states'), params);
    let entry: string | null = null;
    if (obj['entry'] !== undefined) {
      const e = r.string(obj['entry'], pointerTo(at, 'entry'), `layers[${i}].entry`);
      if (e !== undefined && !states.has(e)) unknownState(r, pointerTo(at, 'entry'), e, states);
      entry = e ?? null;
    } else if (states.size > 0) {
      entry = [...states.keys()][0]!;
    }
    const transitions = readTransitions(r, obj['transitions'] ?? [], pointerTo(at, 'transitions'), states, params);
    if (i === 0) {
      if (blend === 'additive') r.report('PP3765', pointerTo(at, 'blend'), 'The base layer (the first) can\'t be additive: there is nothing under it to add to', 'Make the first layer "override".');
      if (mask !== null) r.report('PP3765', pointerTo(at, 'mask'), 'The base layer (the first) drives every bone; it has no mask', 'Remove "mask", or put a full-body layer first.');
      if (defaultClip !== null && states.size > 0) {
        r.report('PP3765', '/default_clip', 'default_clip and a base layer with states both say what plays first', 'Remove default_clip; the base layer starts in its "entry" state.');
      }
    }
    if (states.size === 0 && Array.isArray(obj['transitions']) && obj['transitions'].length > 0) {
      r.report('PP3765', pointerTo(at, 'transitions'), `layers[${i}] has transitions but no states`, 'Add "states", or remove "transitions".');
    }
    layers.push({ name, additive: blend === 'additive', weight, mask, states, entry, transitions });
  });
  return layers;
}

function unknownState(r: Reader, pointer: string, name: string, states: ReadonlyMap<string, StateDef>): void {
  const guess = closestMatch(name, [...states.keys()]);
  r.report('PP3762', pointer, `There is no state "${name}" in this layer`,
    guess !== undefined ? `Did you mean "${guess}"?` : states.size > 0 ? `States: ${[...states.keys()].join(', ')}.` : 'Add it to the layer\'s "states".');
}

function paramOf(r: Reader, pointer: string, name: string, params: ReadonlyMap<string, ParamDef>, kinds: readonly ParamKind[], use: string): ParamDef | undefined {
  const param = params.get(name);
  if (param === undefined) {
    const guess = closestMatch(name, [...params.keys()]);
    r.report('PP3761', pointer, `${use} names the param "${name}", which "params" doesn't declare`,
      guess !== undefined ? `Did you mean "${guess}"?` : `Declare it: "params": {"${name}": ${kinds[0] === 'bool' ? 'false' : kinds[0] === 'trigger' ? '"trigger"' : '0'}}.`);
    return undefined;
  }
  if (!kinds.includes(param.kind)) {
    r.report('PP3763', pointer, `${use} needs a ${kinds.join(' or ')} param, but "${name}" is a ${param.kind}`);
    return undefined;
  }
  return param;
}

function readStates(r: Reader, raw: Raw, pointer: string, params: ReadonlyMap<string, ParamDef>): Map<string, StateDef> {
  const states = new Map<string, StateDef>();
  const obj = r.object(raw, pointer, 'states');
  if (obj === undefined) return states;
  for (const [name, value] of Object.entries(obj)) {
    const at = pointerTo(pointer, name);
    if (name === '*') {
      r.report('PP3760', at, '"*" means "any state" in transitions; it can\'t name a state');
      continue;
    }
    const state = r.object(value, at, `state "${name}"`);
    if (state === undefined) continue;
    r.keys(state, STATE_KEYS, at, `state "${name}"`);
    const hasClip = state['clip'] !== undefined;
    const hasBlend = state['blend'] !== undefined;
    if (hasClip === hasBlend) {
      r.report('PP3760', at, `state "${name}" needs exactly one of "clip" or "blend"`, 'A state plays one clip ("clip": "run") or blends several ("blend": {...}).');
      continue;
    }
    const motion: Motion | undefined = hasClip
      ? ((clip) => (clip === undefined ? undefined : { kind: 'clip' as const, clip }))(r.string(state['clip'], pointerTo(at, 'clip'), `state "${name}".clip`))
      : readBlend(r, state['blend'], pointerTo(at, 'blend'), params, name);
    const loop = r.bool(state['loop'] ?? true, pointerTo(at, 'loop'), `state "${name}".loop`) ?? true;
    const speed = r.number(state['speed'] ?? 1, pointerTo(at, 'speed'), `state "${name}".speed`, 0) ?? 1;
    let speedParam: string | null = null;
    if (state['speed_param'] !== undefined) {
      const p = r.string(state['speed_param'], pointerTo(at, 'speed_param'), `state "${name}".speed_param`);
      if (p !== undefined && paramOf(r, pointerTo(at, 'speed_param'), p, params, ['number'], `state "${name}".speed_param`) !== undefined) speedParam = p;
    }
    if (motion !== undefined) states.set(name, { name, motion, loop, speed, speedParam });
  }
  return states;
}

function readBlend(r: Reader, raw: Raw, pointer: string, params: ReadonlyMap<string, ParamDef>, state: string): Motion | undefined {
  const obj = r.object(raw, pointer, `state "${state}".blend`);
  if (obj === undefined) return undefined;
  r.keys(obj, ['param', 'params', 'clips'], pointer, `state "${state}".blend`);
  let names: string[];
  if (obj['param'] !== undefined && obj['params'] === undefined) {
    const p = r.string(obj['param'], pointerTo(pointer, 'param'), 'blend.param');
    names = p === undefined ? [] : [p];
  } else if (obj['params'] !== undefined && obj['param'] === undefined) {
    const list = r.list(obj['params'], pointerTo(pointer, 'params'), 'blend.params') ?? [];
    names = list.flatMap((p, k) => r.string(p, pointerTo(pointerTo(pointer, 'params'), k), `blend.params[${k}]`) ?? []);
    if (list.length !== 2) {
      r.report('PP3766', pointerTo(pointer, 'params'), `A 2D blend has two params, got ${list.length}`, 'Use "param" for a 1D blend, or "params": ["x", "y"] for 2D.');
      return undefined;
    }
  } else {
    r.report('PP3766', pointer, `state "${state}".blend needs "param" (1D) or "params" (2D)`);
    return undefined;
  }
  names.forEach((name, k) => paramOf(r, pointerTo(pointer, names.length === 1 ? 'param' : `params/${k}`), name, params, ['number'], `state "${state}" blend`));
  const dims = names.length;
  const clips = r.list(obj['clips'], pointerTo(pointer, 'clips'), 'blend.clips') ?? [];
  const points: BlendPoint[] = [];
  clips.forEach((item, k) => {
    const at = pointerTo(pointerTo(pointer, 'clips'), k);
    const point = r.object(item, at, `blend.clips[${k}]`);
    if (point === undefined) return;
    r.keys(point, ['at', 'clip', 'speed'], at, `blend.clips[${k}]`);
    const clip = r.string(point['clip'], pointerTo(at, 'clip'), `blend.clips[${k}].clip`);
    const speed = r.number(point['speed'] ?? 1, pointerTo(at, 'speed'), `blend.clips[${k}].speed`, 0) ?? 1;
    const rawAt = point['at'];
    let coords: number[] | undefined;
    if (dims === 1 && typeof rawAt === 'number' && Number.isFinite(rawAt)) coords = [rawAt];
    else if (dims === 2 && Array.isArray(rawAt) && rawAt.length === 2 && rawAt.every((n) => typeof n === 'number' && Number.isFinite(n))) coords = rawAt as number[];
    else r.report('PP3766', pointerTo(at, 'at'), `blend.clips[${k}].at must be ${dims === 1 ? 'a number' : '[x, y]'}, got ${describe(rawAt)}`);
    if (clip !== undefined && coords !== undefined) points.push({ at: coords, clip, speed });
  });
  const min = dims === 1 ? 2 : 3;
  if (clips.length < min) {
    r.report('PP3766', pointerTo(pointer, 'clips'), `A ${dims}D blend needs at least ${min} clips, got ${clips.length}`,
      dims === 1 ? 'A state with one clip is {"clip": ...}.' : 'Place at least three clips around the blend space.');
  }
  const seen = new Set<string>();
  for (const p of points) {
    const key = p.at.join(',');
    if (seen.has(key)) r.report('PP3766', pointerTo(pointer, 'clips'), `Two blend clips sit at the same point (${key})`, 'Give each clip its own "at".');
    seen.add(key);
  }
  if (dims === 1) points.sort((a, b) => a.at[0]! - b.at[0]!);
  return { kind: 'blend', params: names, points };
}

const CONDITION = /^\s*(?:(not)\s+([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*)(?:\s*(>=|<=|==|!=|>|<)\s*(\S+))?)\s*$/;

/** One condition string → a Condition, checked against the declared params. */
export function parseCondition(text: string, params: ReadonlyMap<string, ParamDef>): Condition | GraphProblem {
  const problem = (code: DiagnosticCode, message: string, fix?: string): GraphProblem => ({ code, message, pointer: '', ...(fix !== undefined && { fix }) });
  const m = CONDITION.exec(text);
  if (m === null) {
    return problem('PP3763', `The condition "${text}" can't be read`, 'Write "speed > 0.5", "grounded", "not grounded", "jump" (a trigger) or "aiming == true".');
  }
  const name = (m[2] ?? m[3])!;
  const param = params.get(name);
  if (param === undefined) {
    const guess = closestMatch(name, [...params.keys()]);
    return problem('PP3761', `The condition "${text}" names the param "${name}", which "params" doesn't declare`,
      guess !== undefined ? `Did you mean "${guess}"?` : `Declare it in "params".`);
  }
  if (m[1] !== undefined) {
    if (param.kind !== 'bool') return problem('PP3763', `"not ${name}": "${name}" is a ${param.kind} param, not true/false`);
    return { param: name, op: '==', value: false, text };
  }
  if (m[4] === undefined) {
    if (param.kind === 'number') return problem('PP3763', `"${text}": "${name}" is a number; compare it`, `Write e.g. "${name} > 0".`);
    return { param: name, op: '==', value: true, text };
  }
  const op = m[4] as CompareOp;
  const rawValue = m[5]!;
  if (param.kind === 'trigger') return problem('PP3763', `"${text}": the trigger "${name}" is a bare condition`, `Write "${name}".`);
  if (param.kind === 'bool') {
    if ((op !== '==' && op !== '!=') || (rawValue !== 'true' && rawValue !== 'false')) {
      return problem('PP3763', `"${text}": "${name}" is true/false`, `Write "${name}", "not ${name}" or "${name} == true".`);
    }
    return { param: name, op: '==', value: (rawValue === 'true') === (op === '=='), text };
  }
  const value = Number(rawValue);
  if (!Number.isFinite(value)) return problem('PP3763', `"${text}": "${rawValue}" isn't a number`);
  return { param: name, op, value, text };
}

function readTransitions(r: Reader, raw: Raw, pointer: string, states: ReadonlyMap<string, StateDef>, params: ReadonlyMap<string, ParamDef>): TransitionDef[] {
  const list = r.list(raw, pointer, 'transitions');
  if (list === undefined) return [];
  const out: TransitionDef[] = [];
  list.forEach((item, i) => {
    const at = pointerTo(pointer, i);
    const obj = r.object(item, at, `transitions[${i}]`);
    if (obj === undefined) return;
    r.keys(obj, TRANSITION_KEYS, at, `transitions[${i}]`);
    const fromName = r.string(obj['from'], pointerTo(at, 'from'), `transitions[${i}].from`);
    const to = r.string(obj['to'], pointerTo(at, 'to'), `transitions[${i}].to`);
    if (fromName !== undefined && fromName !== '*' && !states.has(fromName)) unknownState(r, pointerTo(at, 'from'), fromName, states);
    if (to !== undefined && !states.has(to)) unknownState(r, pointerTo(at, 'to'), to, states);
    if (fromName !== undefined && fromName === to) {
      r.report('PP3764', at, `transitions[${i}] goes from "${to}" to itself`, 'A state already loops; remove the transition.');
    }
    const rawWhen = obj['when'] ?? [];
    const whenList = typeof rawWhen === 'string' ? [rawWhen] : r.list(rawWhen, pointerTo(at, 'when'), `transitions[${i}].when`) ?? [];
    const when: Condition[] = [];
    whenList.forEach((c, k) => {
      const cp = typeof rawWhen === 'string' ? pointerTo(at, 'when') : pointerTo(pointerTo(at, 'when'), k);
      const text = r.string(c, cp, `transitions[${i}].when[${k}]`);
      if (text === undefined) return;
      const parsed = parseCondition(text, params);
      if ('code' in parsed) r.report(parsed.code, cp, parsed.message, parsed.fix);
      else when.push(parsed);
    });
    const fade = r.number(obj['fade'] ?? 0.2, pointerTo(at, 'fade'), `transitions[${i}].fade`, 0) ?? 0.2;
    const exit = obj['exit'] === undefined ? null : r.number(obj['exit'], pointerTo(at, 'exit'), `transitions[${i}].exit`, 0, 1) ?? null;
    if (whenList.length === 0 && obj['exit'] === undefined) {
      r.report('PP3764', at, `transitions[${i}] has no "when" and no "exit", so it would fire at once`,
        'Add conditions ("when": ["speed > 0.5"]) or an exit time ("exit": 1 waits for the state to finish).');
    }
    if (fromName === '*' && whenList.length === 0) {
      r.report('PP3764', at, `transitions[${i}] is from any state with no "when": it would fire from every state`, 'Add conditions.');
    }
    if (fromName !== undefined && to !== undefined) out.push({ from: fromName === '*' ? null : fromName, to, when, fade, exit });
  });
  return out;
}

function readEvents(r: Reader, raw: Raw): Map<string, ClipMarker[]> {
  const events = new Map<string, ClipMarker[]>();
  const obj = r.object(raw, '/events', 'events');
  if (obj === undefined) return events;
  for (const [clip, list] of Object.entries(obj)) {
    const at = pointerTo('/events', clip);
    const items = r.list(list, at, `events["${clip}"]`) ?? [];
    const markers: ClipMarker[] = [];
    items.forEach((item, i) => {
      const ip = pointerTo(at, i);
      const marker = r.object(item, ip, `events["${clip}"][${i}]`);
      if (marker === undefined) return;
      r.keys(marker, ['time', 'name'], ip, `events["${clip}"][${i}]`);
      const time = r.number(marker['time'], pointerTo(ip, 'time'), `events["${clip}"][${i}].time`, 0);
      const name = r.string(marker['name'], pointerTo(ip, 'name'), `events["${clip}"][${i}].name`);
      if (time !== undefined && name !== undefined) markers.push({ time, name });
    });
    markers.sort((a, b) => a.time - b.time);
    events.set(clip, markers);
  }
  return events;
}

function readIk(r: Reader, raw: Raw, params: ReadonlyMap<string, ParamDef>): IkDef {
  const limbs = new Map<string, LimbDef>();
  const obj = r.object(raw, '/ik', 'ik');
  if (obj === undefined) return { limbs, feet: null, look: null };
  r.keys(obj, ['limbs', 'feet', 'look'], '/ik', 'ik');
  if (obj['limbs'] !== undefined) {
    const declared = r.object(obj['limbs'], '/ik/limbs', 'ik.limbs') ?? {};
    for (const [name, value] of Object.entries(declared)) {
      const at = pointerTo('/ik/limbs', name);
      const limb = r.object(value, at, `ik.limbs.${name}`);
      if (limb === undefined) continue;
      r.keys(limb, ['bones', 'pole'], at, `ik.limbs.${name}`);
      const bones = r.list(limb['bones'], pointerTo(at, 'bones'), `ik.limbs.${name}.bones`) ?? [];
      const names = bones.flatMap((b, k) => r.string(b, pointerTo(pointerTo(at, 'bones'), k), `ik.limbs.${name}.bones[${k}]`) ?? []);
      if (bones.length !== 3) {
        r.report('PP3768', pointerTo(at, 'bones'), `ik.limbs.${name}.bones names ${bones.length} bones; a limb is three`, 'List the upper, middle and end bone: ["RightArm", "RightForeArm", "RightHand"].');
      }
      const pole = limb['pole'] === undefined ? BUILT_IN_LIMBS.get(name)?.pole ?? [0, 0, 1] : r.vec3(limb['pole'], pointerTo(at, 'pole'), `ik.limbs.${name}.pole`);
      if (names.length === 3 && pole !== undefined) limbs.set(name, { name, bones: [names[0]!, names[1]!, names[2]!], pole });
    }
  }
  const limbNamed = (name: string, pointer: string): boolean => {
    if (limbs.has(name) || BUILT_IN_LIMBS.has(name)) return true;
    const known = [...new Set([...limbs.keys(), ...BUILT_IN_LIMBS.keys()])];
    const guess = closestMatch(name, known);
    r.report('PP3768', pointer, `There is no limb "${name}"`, guess !== undefined ? `Did you mean "${guess}"?` : `Limbs: ${known.join(', ')} (declare others in "ik": {"limbs": {...}}).`);
    return false;
  };
  let feet: FeetDef | null = null;
  if (obj['feet'] !== undefined) {
    const f = r.object(obj['feet'], '/ik/feet', 'ik.feet') ?? {};
    r.keys(f, ['limbs', 'max_drop', 'max_step', 'speed_param', 'fade', 'grounded_param', 'ground'], '/ik/feet', 'ik.feet');
    const footLimbs = f['limbs'] === undefined ? ['left_foot', 'right_foot']
      : (r.list(f['limbs'], '/ik/feet/limbs', 'ik.feet.limbs') ?? []).flatMap((l, k) => r.string(l, `/ik/feet/limbs/${k}`, `ik.feet.limbs[${k}]`) ?? []);
    footLimbs.forEach((l, k) => limbNamed(l, f['limbs'] === undefined ? '/ik/feet' : `/ik/feet/limbs/${k}`));
    const maxDrop = r.number(f['max_drop'] ?? 0.4, '/ik/feet/max_drop', 'ik.feet.max_drop', 0) ?? 0.4;
    const maxStep = r.number(f['max_step'] ?? 0.4, '/ik/feet/max_step', 'ik.feet.max_step', 0) ?? 0.4;
    let speedParam: string | null = null;
    if (f['speed_param'] !== undefined) {
      const p = r.string(f['speed_param'], '/ik/feet/speed_param', 'ik.feet.speed_param');
      if (p !== undefined && paramOf(r, '/ik/feet/speed_param', p, params, ['number'], 'ik.feet.speed_param') !== undefined) speedParam = p;
    }
    let fade: [number, number] = [2, 4.5];
    if (f['fade'] !== undefined) {
      const list = r.list(f['fade'], '/ik/feet/fade', 'ik.feet.fade') ?? [];
      if (list.length === 2 && list.every((n) => typeof n === 'number') && (list[0] as number) < (list[1] as number)) fade = [list[0] as number, list[1] as number];
      else r.report('PP3768', '/ik/feet/fade', `ik.feet.fade must be [full, off] speeds with full < off, got ${describe(f['fade'])}`);
    }
    let groundedParam: string | null = null;
    if (f['grounded_param'] !== undefined) {
      const p = r.string(f['grounded_param'], '/ik/feet/grounded_param', 'ik.feet.grounded_param');
      if (p !== undefined && paramOf(r, '/ik/feet/grounded_param', p, params, ['bool'], 'ik.feet.grounded_param') !== undefined) groundedParam = p;
    }
    const ground = f['ground'] === undefined ? [] : (r.list(f['ground'], '/ik/feet/ground', 'ik.feet.ground') ?? [])
      .flatMap((g, k) => r.string(g, `/ik/feet/ground/${k}`, `ik.feet.ground[${k}]`) ?? []);
    feet = { limbs: footLimbs, maxDrop, maxStep, speedParam, fade, groundedParam, ground };
  }
  let look: LookDef | null = null;
  if (obj['look'] !== undefined) {
    const l = r.object(obj['look'], '/ik/look', 'ik.look') ?? {};
    r.keys(l, ['bones', 'max_angle'], '/ik/look', 'ik.look');
    const bones = l['bones'] === undefined ? ['Head'] : (r.list(l['bones'], '/ik/look/bones', 'ik.look.bones') ?? [])
      .flatMap((b, k) => r.string(b, `/ik/look/bones/${k}`, `ik.look.bones[${k}]`) ?? []);
    if (bones.length === 0) r.report('PP3768', '/ik/look/bones', 'ik.look.bones is empty', 'Name the bones that turn to look (e.g. ["Neck", "Head"]).');
    const maxAngle = r.number(l['max_angle'] ?? 70, '/ik/look/max_angle', 'ik.look.max_angle', 0, 180) ?? 70;
    look = { bones, maxAngle };
  }
  return { limbs, feet, look };
}

/** A limb by name: declared in `ik.limbs`, else built in. */
export function limbOf(graph: AnimatorGraph, name: string): LimbDef | undefined {
  return graph.ik.limbs.get(name) ?? BUILT_IN_LIMBS.get(name);
}

/** Every clip reference an animator's graph names (for check and preloading). */
export function graphClips(graph: AnimatorGraph): string[] {
  const clips = new Set<string>();
  if (graph.defaultClip !== null) clips.add(graph.defaultClip);
  for (const layer of graph.layers) {
    for (const state of layer.states.values()) {
      if (state.motion.kind === 'clip') clips.add(state.motion.clip);
      else for (const p of state.motion.points) clips.add(p.clip);
    }
  }
  for (const clip of graph.events.keys()) clips.add(clip);
  return [...clips];
}

/** Every bone name an animator's graph names: masks, limbs it uses, look bones. */
export function graphBones(graph: AnimatorGraph): { readonly bone: string; readonly pointer: string }[] {
  const bones: { bone: string; pointer: string }[] = [];
  graph.layers.forEach((layer, i) => layer.mask?.forEach((bone, k) => bones.push({ bone, pointer: `/layers/${i}/mask/${k}` })));
  for (const limb of graph.ik.limbs.values()) limb.bones.forEach((bone, k) => bones.push({ bone, pointer: pointerTo(`/ik/limbs`, limb.name) + `/bones/${k}` }));
  for (const name of graph.ik.feet?.limbs ?? []) {
    if (graph.ik.limbs.has(name)) continue;
    for (const bone of BUILT_IN_LIMBS.get(name)?.bones ?? []) bones.push({ bone, pointer: '/ik/feet' });
  }
  graph.ik.look?.bones.forEach((bone, k) => bones.push({ bone, pointer: `/ik/look/bones/${k}` }));
  return bones;
}

// ── Evaluation helpers (pure) ─────────────────────────────────────────────────

export function conditionHolds(c: Condition, value: number | boolean): boolean {
  switch (c.op) {
    case '==': return value === c.value;
    case '!=': return value !== c.value;
    case '>': return (value as number) > (c.value as number);
    case '>=': return (value as number) >= (c.value as number);
    case '<': return (value as number) < (c.value as number);
    case '<=': return (value as number) <= (c.value as number);
  }
}

/**
 * Blend weights of a blend state's clips at the param values `at` (one per param), summing
 * to 1. 1D: piecewise linear between the two neighbouring clips, clamped at the ends.
 * 2D: gradient-band interpolation (exact at every clip's point, smooth between).
 */
export function blendWeights(points: readonly BlendPoint[], at: readonly number[]): number[] {
  const n = points.length;
  const w = new Array<number>(n).fill(0);
  if (n === 0) return w;
  if (n === 1) { w[0] = 1; return w; }
  if (at.length === 1) {
    const x = at[0]!;
    if (x <= points[0]!.at[0]!) { w[0] = 1; return w; }
    if (x >= points[n - 1]!.at[0]!) { w[n - 1] = 1; return w; }
    for (let i = 0; i < n - 1; i++) {
      const a = points[i]!.at[0]!;
      const b = points[i + 1]!.at[0]!;
      if (x >= a && x <= b) {
        const u = (x - a) / (b - a);
        w[i] = 1 - u;
        w[i + 1] = u;
        return w;
      }
    }
    return w;
  }
  const [px, py] = [at[0]!, at[1]!];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const [ix, iy] = [points[i]!.at[0]!, points[i]!.at[1]!];
    let weight = 1;
    for (let j = 0; j < n && weight > 0; j++) {
      if (j === i) continue;
      const [jx, jy] = [points[j]!.at[0]!, points[j]!.at[1]!];
      const ex = jx - ix;
      const ey = jy - iy;
      const h = 1 - ((px - ix) * ex + (py - iy) * ey) / (ex * ex + ey * ey);
      weight = Math.min(weight, Math.max(0, h));
    }
    w[i] = weight;
    total += weight;
  }
  if (total <= 0) {
    // Far outside every band: the nearest clip.
    let best = 0;
    let bestD = Infinity;
    points.forEach((p, i) => {
      const d = (p.at[0]! - px) ** 2 + (p.at[1]! - py) ** 2;
      if (d < bestD) { bestD = d; best = i; }
    });
    w[best] = 1;
    return w;
  }
  return w.map((x) => x / total);
}
