/**
 * The Model component's methods (SDK `Model`): pose joints, open and close apertures, pick
 * options, show parts, recolor materials, and read sockets. Each writes the component's
 * own fields (`joints`, `joint_motion`, `options`, `parts`, `colors`), so a model's pose
 * and look are saved, replicated and replayed with the entity; the renderer draws them.
 *
 * Names are checked against the model through the `model_rig` service (render3d loads the
 * models): PP2121 joint, PP2122 socket, PP2123 option or choice, PP2124 part, PP2125
 * material — the codes `parallax check` reports for the same names in data. `joint_names`,
 * `limits`, `option_names` and `choices` read the model's declarations. When a run has
 * no file for the model (data-only runs of a game whose model files aren't present) there
 * is nothing to check against: values are stored as given, a joint reads back what was set
 * (else 0), `open`/`close` have no limits to move to and change nothing, and a socket is
 * the entity's origin — as the model itself draws nothing there; the name lists are empty
 * and `limits` is None.
 */

import { Color, easing, fail } from '../../../core/index.js';
import type { Quat, Vec3 } from '../../../core/index.js';
import { checkChoice, clampJoint, JOINT_EASE, jointNamed, jointValue, optionNamed } from '../../../resource/index.js';
import type { JointMotion, ModelDocument, ModelJoint } from '../../../resource/index.js';
import { componentEntity } from '../../kernel/index.js';
import type { Fields, Kernel } from '../../kernel/index.js';
import { MODEL_RIG_SERVICE } from '../../services/index.js';
import type { ModelRig, SocketFrame } from '../../services/index.js';
import { bind, describe, finite, nonNegative, storedRef } from './args.js';

function name(value: unknown, what: string): string {
  if (typeof value === 'string' && value !== '') return value;
  return fail('PP3700', `${what} must be a name (a non-empty string), got ${describe(value)}`);
}

/** A dict field as a plain object: data and these methods store one; a dict game code assigned gives its entries through `toJSON`. */
function dict<T>(fields: Fields, key: string): Readonly<Record<string, T>> {
  const value = fields[key];
  if (value === undefined || value === null) return {};
  if (Object.getPrototypeOf(value) !== Object.prototype && typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return (value as { toJSON(): Record<string, T> }).toJSON();
  }
  return value as Readonly<Record<string, T>>;
}

function unknown(code: `PP${number}`, what: string, wanted: string, known: readonly string[], where: string): never {
  return fail(code, `${where}: the model has no ${what} "${wanted}"`, {
    fix: known.length === 0 ? `It has no ${what}s.` : `Its ${what}s: ${known.slice(0, 16).join(', ')}${known.length > 16 ? ', …' : ''}.`,
  });
}

export function modelMethods(kernel: () => Kernel): object {
  const rigOf = (fields: Fields): ModelRig | null => {
    const ref = storedRef(fields['model'], 'model.model');
    return kernel().service(MODEL_RIG_SERVICE).rig(ref) ?? null;
  };
  /** The document a joint or option call needs; null when the run has no file for the model. */
  const documentOf = (fields: Fields, what: 'joint' | 'option', where: string): ModelDocument | null => {
    const rig = rigOf(fields);
    if (rig === null) return null;
    if (rig.document === null) {
      fail(what === 'joint' ? 'PP2121' : 'PP2123', `${where}: ${rig.path} is a glTF model, which has no ${what}s`, {
        fix: 'Joints and options come from model documents (assets/models/<name>.model.json).',
      });
    }
    return rig.document;
  };
  const current = (fields: Fields, joint: string, spec: ModelJoint | null, now: number): number => {
    const target = dict<number>(fields, 'joints')[joint] ?? spec?.default ?? 0;
    return jointValue(spec === null ? target : clampJoint(spec, target), dict<JointMotion>(fields, 'joint_motion')[joint], now);
  };
  const easeOf = (value: unknown, where: string): string => {
    if (value === undefined || value === null) return JOINT_EASE;
    easing(value);
    if (typeof value !== 'string') fail('PP3033', `${where} ease must be an ease name`);
    return value;
  };
  const move = (fields: Fields, joint: string, spec: ModelJoint | null, target: number, seconds: number, ease = JOINT_EASE): void => {
    const now = kernel().time.now;
    const from = current(fields, joint, spec, now);
    const motions = { ...dict<JointMotion>(fields, 'joint_motion') };
    if (seconds > 0) motions[joint] = { start_value: from, start_time: now, seconds, ease };
    else delete motions[joint];
    fields['joint_motion'] = motions;
    fields['joints'] = { ...dict<number>(fields, 'joints'), [joint]: spec === null ? target : clampJoint(spec, target) };
  };
  const socket = (fields: Fields, wanted: string): SocketFrame => {
    const entity = componentEntity(fields);
    const frame = kernel().service(MODEL_RIG_SERVICE).socket(entity, wanted, 'world');
    if (frame === undefined) {
      fail('PP3822', `The socket "${wanted}" is needed before the model ${String(fields['model'])} has loaded`, {
        fix: 'Boot loads the models a project\'s data names before the first frame; name the model in a prefab.',
      });
    }
    if (frame !== null) return frame;
    const record = kernel().world.require(entity);
    return { position: record.transform.worldPosition(), rotation: record.transform.worldRotation() };
  };

  return {
    pose(this: Fields, ...args: unknown[]): void {
      const a = bind('pose', args, ['joint', 'value'], ['seconds', 'ease'], ['joint', 'value']);
      const joint = name(a['joint'], 'pose() joint');
      const doc = documentOf(this, 'joint', `pose("${joint}")`);
      const spec = doc === null ? null : jointNamed(doc, joint, `pose("${joint}")`);
      move(this, joint, spec, finite(a['value'], `pose("${joint}") value`), nonNegative(a['seconds'] ?? 0, `pose("${joint}") seconds`),
        easeOf(a['ease'], `pose("${joint}")`));
    },
    joint(this: Fields, ...args: unknown[]): number {
      const a = bind('joint', args, ['joint'], [], ['joint']);
      const joint = name(a['joint'], 'joint() joint');
      const doc = documentOf(this, 'joint', `joint("${joint}")`);
      return current(this, joint, doc === null ? null : jointNamed(doc, joint, `joint("${joint}")`), kernel().time.now);
    },
    open(this: Fields, ...args: unknown[]): void {
      openOrClose(this, args, 'open');
    },
    close(this: Fields, ...args: unknown[]): void {
      openOrClose(this, args, 'close');
    },
    set_option(this: Fields, ...args: unknown[]): void {
      const a = bind('set_option', args, ['option', 'choice'], [], ['option', 'choice']);
      const option = name(a['option'], 'set_option() option');
      const choice = name(a['choice'], `set_option("${option}") choice`);
      const doc = documentOf(this, 'option', `set_option("${option}")`);
      if (doc !== null) checkChoice(optionNamed(doc, option, `set_option("${option}")`), choice, `set_option("${option}")`);
      this['options'] = { ...dict<string>(this, 'options'), [option]: choice };
    },
    option(this: Fields, ...args: unknown[]): string | null {
      const a = bind('option', args, ['option'], [], ['option']);
      const option = name(a['option'], 'option() option');
      const doc = documentOf(this, 'option', `option("${option}")`);
      const chosen = dict<string>(this, 'options')[option];
      if (doc === null) return chosen ?? null;
      return chosen ?? optionNamed(doc, option, `option("${option}")`).default;
    },
    show_part(this: Fields, ...args: unknown[]): void {
      const a = bind('show_part', args, ['part', 'shown'], [], ['part']);
      const part = name(a['part'], 'show_part() part');
      const shown = a['shown'] ?? true;
      if (typeof shown !== 'boolean') fail('PP3700', `show_part("${part}") shown must be True or False, got ${describe(shown)}`);
      const rig = rigOf(this);
      if (rig !== null && !rig.parts.includes(part)) unknown('PP2124', 'part', part, rig.parts, `show_part("${part}")`);
      this['parts'] = { ...dict<boolean>(this, 'parts'), [part]: shown };
    },
    set_color(this: Fields, ...args: unknown[]): void {
      const a = bind('set_color', args, ['material', 'color'], [], ['material', 'color']);
      const material = name(a['material'], 'set_color() material');
      const color = a['color'];
      if (!(color instanceof Color)) fail('PP3700', `set_color("${material}") color must be a Color, got ${describe(color)}`);
      const rig = rigOf(this);
      if (rig !== null && !rig.materials.includes(material)) unknown('PP2125', 'material', material, rig.materials, `set_color("${material}")`);
      this['colors'] = { ...dict<Color>(this, 'colors'), [material]: color };
    },
    socket_position(this: Fields, ...args: unknown[]): Vec3 {
      const a = bind('socket_position', args, ['socket'], [], ['socket']);
      return socket(this, name(a['socket'], 'socket_position() socket')).position;
    },
    socket_rotation(this: Fields, ...args: unknown[]): Quat {
      const a = bind('socket_rotation', args, ['socket'], [], ['socket']);
      return socket(this, name(a['socket'], 'socket_rotation() socket')).rotation;
    },
    joint_names(this: Fields, ...args: unknown[]): string[] {
      bind('joint_names', args, [], []);
      return [...(rigOf(this)?.document?.joints.keys() ?? [])];
    },
    limits(this: Fields, ...args: unknown[]): readonly [number, number] | null {
      const a = bind('limits', args, ['joint'], [], ['joint']);
      const joint = name(a['joint'], 'limits() joint');
      const doc = documentOf(this, 'joint', `limits("${joint}")`);
      if (doc === null) return null;
      const spec = jointNamed(doc, joint, `limits("${joint}")`);
      // A frozen array is a Python tuple.
      return spec.limits === null ? null : Object.freeze([spec.limits[0], spec.limits[1]] as const);
    },
    option_names(this: Fields, ...args: unknown[]): string[] {
      bind('option_names', args, [], []);
      return [...(rigOf(this)?.document?.options.keys() ?? [])];
    },
    choices(this: Fields, ...args: unknown[]): string[] {
      const a = bind('choices', args, ['option'], [], ['option']);
      const option = name(a['option'], 'choices() option');
      const doc = documentOf(this, 'option', `choices("${option}")`);
      return doc === null ? [] : [...optionNamed(doc, option, `choices("${option}")`).choices.keys()];
    },
    sockets(this: Fields, ...args: unknown[]): string[] {
      const a = bind('sockets', args, [], ['kind']);
      const kind = a['kind'] ?? null;
      if (kind !== null && typeof kind !== 'string') fail('PP3700', `sockets() kind must be a string or None, got ${describe(kind)}`);
      const rig = rigOf(this);
      if (rig === null) return [];
      if (kind === null) return [...rig.sockets];
      return [...(rig.document?.sockets.values() ?? [])].filter((s) => s.kind === kind).map((s) => s.name);
    },
  };

  function openOrClose(fields: Fields, args: readonly unknown[], verb: 'open' | 'close'): void {
    const a = bind(verb, args, ['joint'], ['seconds', 'ease'], ['joint']);
    const joint = name(a['joint'], `${verb}() joint`);
    const where = `${verb}("${joint}")`;
    const doc = documentOf(fields, 'joint', where);
    if (doc === null) return;
    const spec = jointNamed(doc, joint, where);
    if (spec.limits === null) {
      fail('PP3823', `${where}: "${joint}" turns freely; it has no limits to ${verb} to`, { fix: `Turn it with pose("${joint}", degrees).` });
    }
    const seconds = a['seconds'] === undefined || a['seconds'] === null ? spec.duration : nonNegative(a['seconds'], `${where} seconds`);
    move(fields, joint, spec, verb === 'open' ? spec.limits[1] : spec.limits[0], seconds, easeOf(a['ease'], where));
  }
}
