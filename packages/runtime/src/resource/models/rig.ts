/**
 * The rules a model's controls follow, shared by everything that reads them — the Model
 * component's methods (visuals), the renderer (render3d) and `parallax check` — so a joint
 * value, a motion or an option means the same thing everywhere:
 *
 *   - A joint's value is in its own units (degrees, meters, a scale factor), clamped to its
 *     limits; a hinge without limits takes any angle.
 *   - A timed move (`Model.pose(..., seconds=)`) is the joint's `joints` value (where it
 *     goes) plus a `joint_motion` entry {start_value, start_time, seconds}, eased
 *     in and out. The value at any time is a pure function of those, so it snapshots,
 *     replicates and replays exactly.
 *   - A part is shown when `Model.parts` says so; else as the option that switches it
 *     chooses; else as the document says (`hidden`).
 */

import { closestMatch, easing, fail } from '../../core/index.js';
import type { ModelDocument, ModelJoint, ModelMaterial, ModelOption, ModelSocket } from './format.js';

/** A timed move of one joint: from `start_value` to the joint's target, over `seconds` from game time `start_time`. */
export interface JointMotion {
  readonly start_value: number;
  readonly start_time: number;
  readonly seconds: number;
  /** The ease (core `EASE_KINDS`); absent: "in_out_quad". */
  readonly ease?: string;
}

/** The ease of a joint move that names none. */
export const JOINT_EASE = 'in_out_quad';

function unknownName(code: `PP${number}`, what: string, name: string, known: readonly string[], where: string): never {
  const guess = closestMatch(name, known);
  return fail(code, `${where}: the model has no ${what} "${name}"`, {
    fix: guess !== undefined ? `Did you mean "${guess}"?` : known.length === 0 ? `It has no ${what}s.` : `Its ${what}s: ${known.join(', ')}.`,
  });
}

export function jointNamed(doc: ModelDocument, name: string, where: string): ModelJoint {
  const joint = doc.joints.get(name);
  return joint ?? unknownName('PP2121', 'joint', name, [...doc.joints.keys()], where);
}

export function optionNamed(doc: ModelDocument, name: string, where: string): ModelOption {
  const option = doc.options.get(name);
  return option ?? unknownName('PP2123', 'option', name, [...doc.options.keys()], where);
}

/** The choice's name, checked against the option. */
export function checkChoice(option: ModelOption, choice: string, where: string): string {
  if (option.choices.has(choice)) return choice;
  return unknownName('PP2123', `choice for "${option.name}"`, choice, [...option.choices.keys()], where);
}

export function partNamed(doc: ModelDocument, name: string, where: string): number {
  const part = doc.partByName.get(name);
  return part ?? unknownName('PP2124', 'part', name, [...doc.partByName.keys()], where);
}

export function materialNamed(doc: ModelDocument, name: string, where: string): ModelMaterial {
  const material = doc.materials.get(name);
  return material ?? unknownName('PP2125', 'material', name, [...doc.materials.keys()], where);
}

export function declaredSocket(doc: ModelDocument, name: string): ModelSocket | undefined {
  return doc.sockets.get(name);
}

/** A value for the joint: clamped to its limits (a hinge without limits takes any angle). */
export function clampJoint(joint: ModelJoint, value: number): number {
  if (joint.limits === null) return value;
  return Math.min(joint.limits[1], Math.max(joint.limits[0], value));
}

/** The in-out ease timed moves follow (quadratic). */
export function easeJoint(t: number, kind: string = JOINT_EASE): number {
  return easing(kind)(t);
}

/** The joint's value at game time `now`: its target, or partway there during a motion. */
export function jointValue(target: number, motion: JointMotion | undefined, now: number): number {
  if (motion === undefined || !(motion.seconds > 0)) return target;
  const t = (now - motion.start_time) / motion.seconds;
  if (t >= 1) return target;
  if (t <= 0) return motion.start_value;
  return motion.start_value + (target - motion.start_value) * easeJoint(t, motion.ease ?? JOINT_EASE);
}

/**
 * Whether each part is shown, by part index: the document's `hidden`, then each option's
 * choice (`choices`: option name → choice; absent: its default), then `overrides`
 * (part name → shown). Names must be valid (callers check them).
 */
export function shownParts(doc: ModelDocument, choices: Readonly<Record<string, string>>,
  overrides: Readonly<Record<string, boolean>>): boolean[] {
  const shown = doc.parts.map((p) => !p.hidden);
  for (const option of doc.options.values()) {
    if (option.kind !== 'parts') continue;
    const picked = option.choices.get(choices[option.name] ?? option.default) ?? [];
    for (const i of option.parts) shown[i] = false;
    for (const i of picked) shown[i] = true;
  }
  for (const [name, on] of Object.entries(overrides)) {
    const i = doc.partByName.get(name);
    if (i !== undefined) shown[i] = on;
  }
  return shown;
}

/** The definition a material has with these option choices (option name → choice). */
export function chosenMaterial(doc: ModelDocument, name: string, choices: Readonly<Record<string, string>>): ModelMaterial {
  let made = doc.materials.get(name)!;
  // Every option that changes the material, in document order: a later one's keys win.
  for (const option of doc.options.values()) {
    if (option.kind === 'material' && option.materials.includes(name)) {
      const picked = option.choices.get(choices[option.name] ?? option.default);
      if (picked !== undefined) made = { ...made, ...picked };
    }
  }
  return made;
}
