/**
 * Model documents (`assets/models/<name>.model.json`) and the data that names their
 * controls:
 *
 *   - every model document parses (its own codes: runtime resource/models/parse.ts), and
 *     the project images its texture maps name exist (PP2063; hosted image URLs are
 *     checked for form by the parser and never fetched);
 *   - a `model` component's `joints` / `joint_motion` name the model's joints (PP2121) with
 *     values inside their limits (a warning: the engine clamps), `options` its options
 *     and choices (PP2123), `parts` its parts (PP2124), `colors` its materials (PP2125) —
 *     in prefabs, their children and scene placements, after variants are merged;
 *   - a glTF model has no joints or options (PP2121, PP2123);
 *   - a prefab child's `socket` names a socket of the prefab's model (PP2122): a declared
 *     socket, or a part or bone;
 *   - an entity whose model document has a skeleton has an `animator` (PP2130, a warning:
 *     documents carry no clips, so without one the model stands in its bind pose, a T-pose);
 *   - a dynamic body with a sphere or capsule collider has its model centred on the
 *     collider (PP2131, a warning: a model grounded at y=0 orbits its centre as it rolls).
 *
 * The same codes the runtime raises for the same names (render3d, the Model methods).
 */

import { closestMatch, isAssetUrl, Quat, Vec3 } from '@parallax/runtime/core';
import { buildCodeModel, MODEL_DOCUMENT, nodeMatrices, parseModelDocument, resolvePrefab, restPose, transformPoint } from '@parallax/runtime/resource';
import type { JsonObject, ModelDocument, Origin } from '@parallax/runtime/resource';
import type { CheckContext } from './context.js';
import { pointerTo } from './values.js';

function suggest(name: string, known: readonly string[], what: string): string {
  const guess = closestMatch(name, known);
  if (guess !== undefined) return `Did you mean "${guess}"?`;
  return known.length === 0 ? `The model has no ${what}s.` : `Its ${what}s: ${known.slice(0, 12).join(', ')}${known.length > 12 ? ', …' : ''}.`;
}

function numbersAt(value: unknown, length: number): number[] | undefined {
  return Array.isArray(value) && value.length === length && value.every((n) => typeof n === 'number') ? value as number[] : undefined;
}

/** The centre and size of a model document's rest-pose bounds (shown parts only), in model space. */
function restBounds(doc: ModelDocument): { readonly centre: [number, number, number]; readonly size: number } | undefined {
  const asset = buildCodeModel(doc);
  const worlds = nodeMatrices(asset, restPose(asset));
  const bones = doc.skeleton?.bones.length ?? 0;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  asset.nodes.forEach((node, n) => {
    if (node.mesh === null) return;
    // A drawn node hangs from its part's node (code_model.ts); skinned meshes are in model space.
    const part = doc.parts[node.parent - bones];
    if (part === undefined || part.hidden) return;
    const matrix = node.skin === null ? worlds.subarray(n * 16, n * 16 + 16) : undefined;
    for (const primitive of asset.meshes[node.mesh]!) {
      const at = primitive.geometry.positions;
      for (let i = 0; i < at.length; i += 3) {
        const p = matrix === undefined ? [at[i]!, at[i + 1]!, at[i + 2]!] : transformPoint(matrix, at[i]!, at[i + 1]!, at[i + 2]!);
        for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c]!, p[c]!); hi[c] = Math.max(hi[c]!, p[c]!); }
      }
    }
  });
  if (!(lo[0]! <= hi[0]!)) return undefined;
  return { centre: [0, 1, 2].map((c) => (lo[c]! + hi[c]!) / 2) as [number, number, number], size: Math.max(...[0, 1, 2].map((c) => hi[c]! - lo[c]!)) };
}

function objectAt(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

class Models {
  readonly #ctx: CheckContext;
  /** Model document path → its document (undefined: it has errors, already reported). */
  readonly #docs = new Map<string, ModelDocument | undefined>();

  constructor(ctx: CheckContext) {
    this.#ctx = ctx;
    for (const path of ctx.files.all()) {
      if (!path.startsWith('assets/models/') || !MODEL_DOCUMENT.test(path)) continue;
      const parsed = parseModelDocument(path, ctx.files.read(path));
      ctx.out.push(...parsed.diagnostics);
      this.#docs.set(path, parsed.document);
      if (parsed.document !== undefined && ctx.options.assetFiles) this.#maps(parsed.document);
    }
  }

  /** Texture maps that name project images: the files must exist. */
  #maps(doc: ModelDocument): void {
    const check = (map: string | null | undefined, pointer: string): void => {
      if (typeof map !== 'string' || !map.startsWith('assets/') || this.#ctx.files.exists(map)) return;
      this.#ctx.report('PP2063', `The texture map "${map}" is not a file of the project`, {
        path: doc.path, pointer, fix: 'Add the image under assets/, or use a hosted image URL (https://r2.parallaxpro.ai/assets/…).',
      });
    };
    for (const [name, material] of doc.materials) {
      check(material.texture, pointerTo(pointerTo('/materials', name), 'texture'));
      check(material.normalMap, pointerTo(pointerTo('/materials', name), 'normal_map'));
    }
    for (const option of doc.options.values()) {
      if (option.kind !== 'material') continue;
      const at = [...doc.options.keys()].indexOf(option.name);
      for (const [choice, keys] of option.choices) {
        const pointer = pointerTo(pointerTo(`/options/${at}`, 'choices'), choice);
        check(keys.texture, pointerTo(pointer, 'texture'));
        check(keys.normalMap, pointerTo(pointer, 'normal_map'));
      }
    }
  }

  /** The model file a `model` field names, if it is in the project. */
  path(ref: string): string | undefined {
    if (isAssetUrl(ref)) return undefined;
    if (ref.startsWith('assets/')) return this.#ctx.files.exists(ref) ? ref : undefined;
    return this.#ctx.assets.get(ref.includes('/') ? ref : `models/${ref}`);
  }

  /** null: the reference is to a glTF file (or a file this run doesn't have). */
  document(ref: string): ModelDocument | null | undefined {
    // A hosted model document isn't read (nothing is fetched): its names can't be checked here.
    if (isAssetUrl(ref)) return MODEL_DOCUMENT.test(ref) ? undefined : null;
    const path = this.path(ref);
    if (path === undefined || !MODEL_DOCUMENT.test(path)) return null;
    return this.#docs.get(path);
  }

  /** A `model` component's data: names and values checked against its model. */
  component(model: JsonObject, at: Origin): void {
    const ref = model['model'];
    if (typeof ref !== 'string') return;
    const doc = this.document(ref);
    if (doc === undefined) return;
    const where = pointerTo(at.pointer, 'components');
    const pointer = (field: string, key?: string): string => {
      const p = pointerTo(pointerTo(where, 'model'), field);
      return key === undefined ? p : pointerTo(p, key);
    };
    const report = (code: `PP${number}`, message: string, field: string, key: string, fix?: string, severity?: 'warning'): void => {
      this.#ctx.report(code, message, { path: at.path, pointer: pointer(field, key), ...(fix !== undefined && { fix }), ...(severity !== undefined && { severity }) });
    };
    const joints = [...(doc === null ? [] : doc.joints.keys())];
    for (const field of ['joints', 'joint_motion']) {
      for (const [name, value] of Object.entries(objectAt(model[field]) ?? {})) {
        if (doc === null) {
          report('PP2121', `The model "${ref}" is a glTF file, which has no joints; "${name}" is not one`, field, name,
            'Joints come from model documents (assets/models/<name>.model.json).');
          continue;
        }
        const joint = doc.joints.get(name);
        if (joint === undefined) {
          report('PP2121', `The model "${ref}" has no joint "${name}"`, field, name, suggest(name, joints, 'joint'));
          continue;
        }
        if (field === 'joints' && typeof value === 'number' && joint.limits !== null && (value < joint.limits[0] || value > joint.limits[1])) {
          report('PP2129', `Joint "${name}" is set to ${value}, outside its limits [${joint.limits.join(', ')}]: it stops at ${value < joint.limits[0] ? joint.limits[0] : joint.limits[1]}`,
            field, name, `Use a value from ${joint.limits[0]} to ${joint.limits[1]}.`, 'warning');
        }
      }
    }
    for (const [name, choice] of Object.entries(objectAt(model['options']) ?? {})) {
      if (doc === null) {
        report('PP2123', `The model "${ref}" is a glTF file, which has no options; "${name}" is not one`, 'options', name);
        continue;
      }
      const option = doc.options.get(name);
      if (option === undefined) {
        report('PP2123', `The model "${ref}" has no option "${name}"`, 'options', name, suggest(name, [...doc.options.keys()], 'option'));
      } else if (typeof choice === 'string' && !option.choices.has(choice)) {
        report('PP2123', `Option "${name}" has no choice "${choice}"`, 'options', name, suggest(choice, [...option.choices.keys()], 'choice'));
      }
    }
    if (doc === null) return;
    for (const name of Object.keys(objectAt(model['parts']) ?? {})) {
      if (!doc.partByName.has(name)) report('PP2124', `The model "${ref}" has no part "${name}"`, 'parts', name, suggest(name, [...doc.partByName.keys()], 'part'));
    }
    for (const name of Object.keys(objectAt(model['colors']) ?? {})) {
      if (!doc.materials.has(name)) report('PP2125', `The model "${ref}" has no material "${name}"`, 'colors', name, suggest(name, [...doc.materials.keys()], 'material'));
    }
  }

  /**
   * One entity's merged components (prefab, child or placement), checked where its own data
   * writes `model`, `animator`, `rigidbody` or `collider` (so a variant or placement that
   * changes none of them doesn't repeat its base's warning).
   */
  entity(components: Readonly<Record<string, JsonObject>>, own: Readonly<Record<string, JsonObject>>, at: Origin): void {
    const model = components['model'];
    const ref = model?.['model'];
    if (model === undefined || typeof ref !== 'string') return;
    const doc = this.document(ref);
    if (doc === null || doc === undefined) return;
    const pointer = pointerTo(pointerTo(at.pointer, 'components'), 'model');
    // A garment is posed by the body it is worn on (models/garments.ts), not by an animator.
    if (doc.skeleton !== null && components['animator'] === undefined && components['garment'] === undefined
      && (own['model'] !== undefined || own['animator'] !== undefined)) {
      // The library's clip pieces: quadruped_20 rigs ("quad:Hips", "quad:FL_Paw") or humanoid ones.
      const quadruped = doc.skeleton.bones.some((b) => /(^|:)(quad|[FB][LR]_)/.test(b.name));
      const [piece, idle] = quadruped ? ['quadruped_basics', 'quadruped_idle'] : ['humanoid_locomotion', 'stand_idle'];
      this.#ctx.report('PP2130', `The model "${ref}" is rigged (a skeleton of ${doc.skeleton.bones.length} bones) but this entity has no animator, so it stands frozen in its bind pose${quadruped ? '' : ' (a T-pose)'}`, {
        severity: 'warning', path: at.path, pointer,
        fix: `Install clips (parallax library add ${piece}) and give it an animator that plays one: "animator": {"default_clip": "clips/${idle}"}, then animator.play(...) as it moves.`,
      });
    }
    this.#rolling(components, own, doc, ref, model, at, pointer);
  }

  /** A dynamic body that rolls on a sphere or capsule: its model must be centred on that collider. */
  #rolling(components: Readonly<Record<string, JsonObject>>, own: Readonly<Record<string, JsonObject>>, doc: ModelDocument,
    ref: string, model: JsonObject, at: Origin, pointer: string): void {
    const body = components['rigidbody'];
    const collider = components['collider'];
    if (body === undefined || collider === undefined || (body['kind'] ?? 'dynamic') !== 'dynamic') return;
    if (body['lock_rotation'] === true || collider['trigger'] === true) return;
    const locked = Array.isArray(body['lock_rotation_axes']) ? body['lock_rotation_axes'] : [];
    const free = [0, 1, 2].filter((c) => !locked.includes('xyz'[c]!));
    if (free.length === 0) return;
    const shape = collider['shape'];
    if (shape !== 'sphere' && shape !== 'capsule') return;
    if (own['model'] === undefined && own['rigidbody'] === undefined && own['collider'] === undefined) return;
    const bounds = restBounds(doc);
    if (bounds === undefined) return;
    const radius = typeof collider['radius'] === 'number' ? collider['radius'] : 0.5;
    const centreOf = numbersAt(collider['offset'], 3) ?? [0, 0, 0];
    // The model → entity transform (code_model_pose.ts modelPointToEntity): scale, rotation_offset, offset.
    const scale = typeof model['scale'] === 'number' ? model['scale'] : 1;
    const turn = numbersAt(model['rotation_offset'], 3);
    const offset = numbersAt(model['offset'], 3) ?? [0, 0, 0];
    let v = new Vec3(bounds.centre[0] * scale, bounds.centre[1] * scale, bounds.centre[2] * scale);
    if (turn !== undefined) v = Quat.from_euler(new Vec3(turn[0]!, turn[1]!, turn[2]!)).rotate(v);
    const centre = [v.x + offset[0]!, v.y + offset[1]!, v.z + offset[2]!];
    // Turning about one free axis (a top-down body spinning only about y) never moves an
    // offset along that axis: only the rest of the offset makes the model orbit.
    const delta = [0, 1, 2].map((c) => (free.length === 1 && free[0] === c ? 0 : centre[c]! - centreOf[c]!));
    const off = Math.hypot(delta[0]!, delta[1]!, delta[2]!);
    if (!(off > 0.25 * radius)) return;
    const round = (n: number): number => Math.round(n * 1000) / 1000;
    this.#ctx.report('PP2131', `This body rolls on a ${shape} collider centred at [${centreOf.join(', ')}], but its model "${ref}" is centred at [${centre.map(round).join(', ')}] (${round(off)} m off, radius ${radius}): the model orbits the collider as it rolls`, {
      severity: 'warning', path: at.path, pointer,
      fix: `Rolling bodies must be modelled around their centre: rebuild the model centred on its origin (not standing on y=0), or set the model's "offset" to [${centreOf.map((c, i) => round(c - (centre[i]! - offset[i]!))).join(', ')}].`,
    });
  }

  /** A prefab child's `socket` component, against the prefab's model. */
  socket(parentModel: JsonObject | undefined, socket: JsonObject, at: Origin): void {
    const name = socket['name'];
    if (typeof name !== 'string') return;
    const pointer = pointerTo(pointerTo(pointerTo(at.pointer, 'components'), 'socket'), 'name');
    const ref = parentModel?.['model'];
    if (typeof ref !== 'string') {
      this.#ctx.report('PP3821', `This child sits on the socket "${name}", but its prefab has no Model`, {
        path: at.path, pointer, fix: 'Give the prefab a model, or remove the child\'s socket component.',
      });
      return;
    }
    const doc = this.document(ref);
    if (doc === null || doc === undefined) return;
    if (doc.sockets.has(name) || doc.partByName.has(name) || doc.boneByName.has(name)) return;
    const declared = [...doc.sockets.keys()];
    this.#ctx.report('PP2122', `The model "${ref}" has no socket "${name}"`, {
      path: at.path, pointer,
      fix: closestMatch(name, [...declared, ...doc.partByName.keys(), ...doc.boneByName.keys()]) !== undefined
        ? `Did you mean "${closestMatch(name, [...declared, ...doc.partByName.keys(), ...doc.boneByName.keys()])}"?`
        : declared.length > 0 ? `Its sockets: ${declared.join(', ')}.` : 'Name a part or bone of the model.',
    });
  }
}

/** Components with per-component field overrides (variants.ts's merge). */
function merged(base: Readonly<Record<string, JsonObject>>, over: Readonly<Record<string, JsonObject>>): Record<string, JsonObject> {
  const out: Record<string, JsonObject> = { ...base };
  for (const [id, fields] of Object.entries(over)) out[id] = { ...base[id], ...fields };
  return out;
}

/**
 * Prefab ids something names: a data file's string (a placement, child, variant, content or
 * param), a `Prefabs.<id>` handle in code, or a spawn site. A prefab nothing names (a library
 * copy the game doesn't use) never appears, so only these get the look warnings.
 */
function namedPrefabs(ctx: CheckContext): Set<string> {
  const named = new Set<string>();
  const walk = (value: unknown, own: string): void => {
    if (typeof value === 'string') { if (value !== own) named.add(value); } else if (Array.isArray(value)) value.forEach((v) => walk(v, own));
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach((v) => walk(v, own));
  };
  const ownId = new Map([...ctx.project.prefabs.values()].map((p) => [p.path, p.id]));
  for (const path of ctx.files.all()) {
    if (!path.endsWith('.json') || !/(^|\/)(prefabs|scenes|content|config)\//.test(path)) continue;
    try {
      walk(JSON.parse(ctx.files.read(path)) as unknown, ownId.get(path) ?? '');
    } catch {
      // Malformed data files are reported by the loader.
    }
  }
  for (const use of ctx.decl.project_refs) if (use.ref[0] === 'Prefabs' && use.ref[1] !== undefined) named.add(use.ref[1]);
  for (const site of ctx.decl.spawns) if (site.prefab !== null) named.add(site.prefab);
  return named;
}

export function checkModels(ctx: CheckContext): void {
  const models = new Models(ctx);
  const named = namedPrefabs(ctx);
  const resolved = (id: string): ReturnType<typeof resolvePrefab> | undefined => {
    try {
      return resolvePrefab(ctx.project, id);
    } catch {
      return undefined; // Unknown prefabs and cycles are reported by the data checks.
    }
  };
  for (const prefab of ctx.project.prefabs.values()) {
    // Each file's own data, with what it extends merged in (so a variant's joints check against its base's model).
    const components = resolved(prefab.id)?.components;
    const model = components?.['model'];
    if (prefab.components['model'] !== undefined && model !== undefined) models.component(model, { path: prefab.path, pointer: '' });
    const used = named.has(prefab.id);
    if (components !== undefined && used) models.entity(components, prefab.components, { path: prefab.path, pointer: '' });
    prefab.children.forEach((child, i) => {
      const at = { path: prefab.path, pointer: pointerTo('/children', i) };
      const childBase = child.prefab === undefined ? {} : resolved(child.prefab)?.components ?? {};
      const base = childBase['model'];
      if (child.components['model'] !== undefined) models.component({ ...base, ...child.components['model'] }, at);
      if (used) models.entity(merged(childBase, child.components), child.components, at);
      const socket = child.components['socket'];
      if (socket !== undefined) models.socket(model, socket, at);
    });
  }
  for (const scene of ctx.project.scenes.values()) {
    for (const placement of scene.entities) {
      const prefab = resolved(placement.prefab)?.components ?? {};
      models.entity(merged(prefab, placement.components), placement.components, placement.origin);
      const override = placement.components['model'];
      if (override === undefined) continue;
      models.component({ ...prefab['model'], ...override }, placement.origin);
    }
  }
}
