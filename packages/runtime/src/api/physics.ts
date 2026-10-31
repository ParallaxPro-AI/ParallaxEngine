/**
 * `parallax.physics` (sdk/parallax/physics.pyi): the Rigidbody and Collider handles, the
 * collision-layer declarations, and the types of `ctx.physics`. The behavior lives in the
 * physics2d plugin; this module is the Python-facing names for it.
 */

import { fail } from '../core/index.js';
import {
  COLLIDER, DEFAULT_LAYER, FORCE_FIELD, IMPACT, JOINT, JOINT_BROKEN, RIGIDBODY, physics2d as physics2dPlugin,
} from '../function/plugins/physics2d/index.js';
import type { MaterialSpec } from '../function/plugins/physics2d/index.js';
import type { KernelPlugin } from '../function/kernel/index.js';
import { eventHandle } from './events.js';
import { bindArgs } from './kwargs.js';

export type { Hit as RayHit, PhysicsNamespace as PhysicsApi } from '../function/plugins/physics2d/index.js';

/** `entity.get(Rigidbody)` returns the component itself, with its methods (velocity, impulse, …). */
export class Rigidbody {
  static readonly __component_id__ = RIGIDBODY;
}

/** `entity.get(Collider)`: shape, size, layer, trigger, … */
export class Collider {
  static readonly __component_id__ = COLLIDER;
}

/** `entity.get(Joint)`: kind, anchors, limits, motor, break_force… and angle / position / distance / load / detach(). */
export class Joint {
  static readonly __component_id__ = JOINT;
}

/** `entity.get(ForceField)`: kind, strength, direction, radius, falloff, layers, enabled. */
export class ForceField {
  static readonly __component_id__ = FORCE_FIELD;
}

/** `entity.get(Ragdoll)` (physics3d): mode, weight, go_limp / activate / recover. */
export class Ragdoll {
  static readonly __component_id__ = 'ragdoll';
}

/** `@on(JointBroken)`: entity (the joint's), body, connected (Entity | None), force (N). */
export const JointBroken = eventHandle(JOINT_BROKEN, 'JointBroken');
/** `@on(Impact)`: entity, target (the other side), point, normal, speed, material, target_material, sound. */
export const Impact = eventHandle(IMPACT, 'Impact');

/** One collision layer. Named after the `Layers` attribute it is assigned to. */
export class Layer {
  name: string;

  constructor(name = '') {
    this.name = name;
  }

  toString(): string {
    return `Layer(${this.name || '?'})`;
  }
}

/** `player = layer()` inside a `Layers` subclass. */
export function layer(...args: unknown[]): Layer {
  bindArgs('layer', args, {});
  return new Layer();
}

/**
 * Base of a game's layer declaration:
 *
 *     class Layers(physics.Layers):
 *         player = layer()
 *         enemy = layer()
 */
export class Layers {
  static readonly default = new Layer(DEFAULT_LAYER);
}

/**
 * The layer names a `Layers` subclass declares, in declaration order; names each `Layer`
 * after its attribute. Called when the plugin is built (`physics2d(layers=Layers)`).
 */
export function layerNames(cls: unknown): string[] {
  if (typeof cls !== 'function' || !(cls === Layers || cls.prototype instanceof Layers)) {
    fail('PP3107', 'layers= takes a class derived from physics.Layers', {
      fix: 'Declare `class Layers(physics.Layers): player = layer()` and pass the class itself.',
    });
  }
  const names: string[] = [];
  const chain: Function[] = [];
  for (let c: Function = cls; c !== Layers; c = Object.getPrototypeOf(c) as Function) chain.unshift(c);
  for (const c of chain) {
    for (const key of Object.keys(c)) {
      const value = (c as unknown as Record<string, unknown>)[key];
      if (!(value instanceof Layer)) continue;
      if (value.name !== '' && value.name !== key) {
        fail('PP3107', `Layer "${value.name}" is also assigned to "${key}"`, { fix: 'Give every layer its own layer() call.' });
      }
      value.name = key;
      if (!names.includes(key)) names.push(key);
    }
  }
  return names;
}

/** One surface material (`ice = material(friction=0.02)`), named after its `Materials` attribute. */
export class Material {
  name = '';
  readonly spec: MaterialSpec;

  constructor(spec: MaterialSpec) {
    this.spec = spec;
  }

  toString(): string {
    return `Material(${this.name || '?'})`;
  }
}

function stored(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  const json = typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function' ? (value as { toJSON(): unknown }).toJSON() : value;
  if (typeof json === 'string') return json;
  return fail('PP3190', 'material(sound=) takes a sound asset reference', { fix: 'Pass an asset ref, e.g. sound=Assets.sfx.thud.' });
}

/** `material(*, friction=0.5, bounce=0, sound=None, impact_speed=1)` inside a `Materials` subclass. */
export function material(...args: unknown[]): Material {
  const a = bindArgs('material', args, { keyword: ['friction', 'bounce', 'sound', 'impact_speed'] }).args;
  const num = (name: string, fallback: number): number => {
    const v = a[name] ?? fallback;
    if (typeof v !== 'number') fail('PP3190', `material(${name}=) must be a number, got ${String(v)}`);
    return v;
  };
  return new Material({ friction: num('friction', 0.5), bounce: num('bounce', 0), sound: stored(a['sound']), impact_speed: num('impact_speed', 1) });
}

/**
 * Base of a game's surface materials:
 *
 *     class Materials(physics.Materials):
 *         ice = material(friction=0.02)
 *         rubber = material(friction=1, bounce=0.8, sound=Assets.sfx.boing)
 */
export class Materials {}

/** The materials a `Materials` subclass declares, by name (each `Material` named after its attribute). */
export function materialSpecs(cls: unknown): Record<string, MaterialSpec> {
  if (typeof cls !== 'function' || !(cls === Materials || cls.prototype instanceof Materials)) {
    fail('PP3107', 'materials= takes a class derived from physics.Materials', {
      fix: 'Declare `class Materials(physics.Materials): ice = material(friction=0.02)` and pass the class itself.',
    });
  }
  const specs: Record<string, MaterialSpec> = {};
  const chain: Function[] = [];
  for (let c: Function = cls; c !== Materials; c = Object.getPrototypeOf(c) as Function) chain.unshift(c);
  for (const c of chain) {
    for (const key of Object.keys(c)) {
      const value = (c as unknown as Record<string, unknown>)[key];
      if (!(value instanceof Material)) continue;
      if (value.name !== '' && value.name !== key) fail('PP3107', `Material "${value.name}" is also assigned to "${key}"`, { fix: 'Give every material its own material() call.' });
      value.name = key;
      specs[key] = value.spec;
    }
  }
  return specs;
}

/** The keyword options both physics factories share. */
export function physicsOptions(name: string, args: readonly unknown[], code: 'PP3300' | 'PP3153'): {
  gravity: number; layers: string[]; materials: Record<string, MaterialSpec>; interpolate: boolean;
} {
  const bound = bindArgs(name, args, { keyword: ['gravity', 'layers', 'materials', 'interpolate'] }).args;
  const gravity = bound['gravity'] ?? -9.8;
  if (typeof gravity !== 'number') fail(code, `${name} gravity must be a number, got ${String(gravity)}`);
  const interpolate = bound['interpolate'] ?? true;
  if (typeof interpolate !== 'boolean') fail(code, `${name} interpolate must be True or False`);
  return {
    gravity,
    layers: bound['layers'] === undefined || bound['layers'] === null ? [] : layerNames(bound['layers']),
    materials: bound['materials'] === undefined || bound['materials'] === null ? {} : materialSpecs(bound['materials']),
    interpolate,
  };
}

/**
 * `parallax.plugins.physics2d(*, gravity=-9.8, layers=None, materials=None, interpolate=True)`:
 * binds Python arguments and builds the kernel plugin. The plugins module re-exports this as `physics2d`.
 */
export function physics2d(...args: unknown[]): KernelPlugin {
  return physics2dPlugin(physicsOptions('physics2d', args, 'PP3300'));
}
