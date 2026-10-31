/**
 * Vehicle and combat data that names other things by string or depends on another
 * component, which a field schema can't check (sdk/parallax/vehicles.pyi, combat.pyi).
 * Checked on every prefab with what it extends merged in:
 *
 *   PP2700  a vehicle depth component (drivetrain, vehicle_damage, vehicle_effects,
 *           vehicle_rig) on an entity without a `vehicle`
 *   PP2701  a component that doesn't fit the vehicle's kind: drivetrain on anything but
 *           car/tracked
 *   PP2702  vehicle_effects names a child the prefab doesn't have
 *   PP2703  vehicle_rig / vehicle_damage name a joint or part the vehicle's model
 *           document doesn't declare (glTF models: parts only, by node name — not checked)
 *   PP2704  vehicle_damage parts: duplicate names; a wheel index outside 0..3
 *   PP2706  a boat without `buoyancy` (boats float on the water plugin's Buoyancy)
 *   PP2750  strike content: only one of start_event / end_event; active end before start
 */

import { closestMatch } from '@parallax/runtime/core';
import { MODEL_DOCUMENT, parseModelDocument, resolvePrefab } from '@parallax/runtime/resource';
import type { JsonObject, ModelDocument } from '@parallax/runtime/resource';
import type { CheckContext } from './context.js';
import { pointerTo } from './values.js';

const DEPTH = ['drivetrain', 'vehicle_damage', 'vehicle_effects', 'vehicle_rig'] as const;
const WHEELED = new Set(['car', 'tracked']);
const EFFECT_CHILDREN = ['exhaust', 'engine_sound', 'tire_smoke', 'skid_sound', 'damage_smoke'] as const;

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function object(value: unknown): JsonObject | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function suggest(name: string, known: readonly string[]): string {
  const guess = closestMatch(name, known);
  return guess !== undefined ? `Did you mean "${guess}"?` : `Known: ${known.slice(0, 12).join(', ') || '(none)'}.`;
}

class ModelDocs {
  readonly #ctx: CheckContext;
  readonly #docs = new Map<string, ModelDocument | undefined>();
  constructor(ctx: CheckContext) {
    this.#ctx = ctx;
  }
  /** The model document a `model.model` reference names; null for glTF / absent files. */
  doc(ref: unknown): ModelDocument | null | undefined {
    if (typeof ref !== 'string') return null;
    const path = ref.startsWith('assets/') ? (this.#ctx.files.exists(ref) ? ref : undefined) : this.#ctx.assets.get(ref.includes('/') ? ref : `models/${ref}`);
    if (path === undefined || !MODEL_DOCUMENT.test(path)) return null;
    if (!this.#docs.has(path)) this.#docs.set(path, parseModelDocument(path, this.#ctx.files.read(path)).document);
    return this.#docs.get(path);
  }
}

export function checkVehiclesCombat(ctx: CheckContext): void {
  const models = new ModelDocs(ctx);
  if (ctx.plugins.has('vehicles')) {
    for (const prefab of ctx.project.prefabs.values()) {
      let components: Readonly<Record<string, JsonObject>>;
      try {
        components = resolvePrefab(ctx.project, prefab.id).components;
      } catch {
        continue; // Unknown bases and cycles are the data checks' to report.
      }
      // Variants inherit their base's data: report only what this file itself writes.
      const own = new Set(Object.keys(prefab.components));
      const scoped = Object.create(ctx, {
        report: { value: (code: never, message: string, init: { pointer?: string }) => {
          const component = init.pointer?.split('/')[2];
          if (component !== undefined && own.has(component)) ctx.report(code, message, init as never);
        } },
      }) as CheckContext;
      checkVehicle(scoped, models, prefab.path, prefab.children.map((c) => c.name).filter((n): n is string => n !== undefined), components);
    }
  }
  if (ctx.plugins.has('combat')) checkStrikes(ctx);
}

function checkVehicle(ctx: CheckContext, models: ModelDocs, path: string, children: readonly string[],
  components: Readonly<Record<string, JsonObject>>): void {
  const vehicle = components['vehicle'];
  const at = (component: string, ...rest: (string | number)[]): string => rest.reduce<string>((p, k) => pointerTo(p, k), pointerTo('/components', component));
  for (const c of DEPTH) {
    if (components[c] !== undefined && vehicle === undefined) {
      ctx.report('PP2700', `"${c}" deepens a vehicle, but this prefab has no "vehicle"`, { path, pointer: at(c), fix: 'Add "vehicle": {"kind": ...} or remove it.' });
    }
  }
  if (vehicle === undefined) return;
  const kind = typeof vehicle['kind'] === 'string' ? vehicle['kind'] : 'car';
  if (components['drivetrain'] !== undefined && !WHEELED.has(kind)) {
    ctx.report('PP2701', `"drivetrain" works on cars and tracked vehicles; this vehicle is a ${kind}`, { path, pointer: at('drivetrain'), fix: 'Remove "drivetrain".' });
  }
  if (kind === 'boat' && components['buoyancy'] === undefined) {
    ctx.report('PP2706', 'A boat floats on Buoyancy, but this prefab has no "buoyancy"', {
      path, pointer: at('vehicle', 'kind'), fix: 'Add "buoyancy": {} (and water() with a water_body under it), or change the kind.',
    });
  }
  const effects = components['vehicle_effects'];
  if (effects !== undefined) {
    for (const key of EFFECT_CHILDREN) {
      const name = effects[key];
      if (typeof name === 'string' && !children.includes(name)) {
        ctx.report('PP2702', `vehicle_effects.${key} names no child "${name}"`, { path, pointer: at('vehicle_effects', key), fix: suggest(name, children) });
      }
    }
  }
  const doc = models.doc(components['model']?.['model']);
  const rig = components['vehicle_rig'];
  if (rig !== undefined && doc !== null && doc !== undefined) {
    const joints = [...doc.joints.keys()];
    const names: Array<[unknown, (string | number)[]]> = [
      ...(['wheels', 'steer', 'propellers'] as const).flatMap((key) => list(rig[key]).map((j, i): [unknown, (string | number)[]] => [j, [key, i]])),
      ...Object.keys(object(rig['controls']) ?? {}).map((j): [unknown, (string | number)[]] => [j, ['controls', j]]),
    ];
    for (const [joint, where] of names) {
      if (typeof joint === 'string' && !joints.includes(joint)) {
        ctx.report('PP2703', `vehicle_rig names a joint "${joint}" the model doesn't have`, { path, pointer: at('vehicle_rig', ...where), fix: suggest(joint, joints) });
      }
    }
  }
  const damage = components['vehicle_damage'];
  if (damage !== undefined) {
    const seen = new Set<string>();
    list(damage['parts']).forEach((raw, i) => {
      const part = object(raw);
      if (part === undefined) return;
      const name = part['name'];
      if (typeof name === 'string') {
        if (seen.has(name)) ctx.report('PP2704', `Two vehicle parts are named "${name}"`, { path, pointer: at('vehicle_damage', 'parts', i, 'name') });
        seen.add(name);
      }
      const index = typeof part['index'] === 'number' ? part['index'] : -1;
      if (part['role'] === 'wheel' && (index < 0 || index > 3)) {
        ctx.report('PP2704', `Wheel part "${String(name)}" needs an index 0..3 (front left, front right, rear left, rear right)`, { path, pointer: at('vehicle_damage', 'parts', i, 'index') });
      }
      if (doc !== null && doc !== undefined) {
        const parts = [...doc.partByName.keys()];
        for (const key of ['model_part', 'damaged_part'] as const) {
          const value = part[key];
          if (typeof value === 'string' && !parts.includes(value)) {
            ctx.report('PP2703', `Vehicle part "${String(name)}" ${key} "${value}" isn't a part of the model`, { path, pointer: at('vehicle_damage', 'parts', i, key), fix: suggest(value, parts) });
          }
        }
      }
    });
  }
}

function checkStrikes(ctx: CheckContext): void {
  for (const entry of ctx.project.content.get('strike')?.values() ?? []) {
    const v = entry.values;
    if ((v['start_event'] === undefined || v['start_event'] === null) !== (v['end_event'] === undefined || v['end_event'] === null)) {
      ctx.report('PP2750', `Strike "${entry.id}" names only one of start_event / end_event`, {
        path: entry.path, pointer: '/start_event', fix: 'Give both markers, or neither (then "active" times it).',
      });
    }
    const active = list(v['active']);
    if (active.length === 2 && typeof active[0] === 'number' && typeof active[1] === 'number' && active[1] < active[0]) {
      ctx.report('PP2750', `Strike "${entry.id}" active window ends before it starts`, { path: entry.path, pointer: '/active', fix: 'Write [start, end] seconds.' });
    }
  }
}
