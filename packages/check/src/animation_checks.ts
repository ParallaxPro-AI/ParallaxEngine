/**
 * Animation data against the engine and the project's files, with the engine's own
 * parsers (so check and runtime agree, code for code):
 *
 *   - every authored clip, `assets/clips/<name>.clip.json` (render3d's `readClipFile`);
 *   - every Animator in a prefab, prefab child or scene placement (visuals'
 *     `readAnimatorGraph`): params, layers, states, blends, transitions and their
 *     conditions, events, IK;
 *   - with the asset files present, what the graph names against the files: authored
 *     clips exist, model clips exist in the entity's model (or the model a
 *     "<model>#<clip>" names), and mask, limb and look bones exist in the model.
 */

import { closestMatch, isAssetUrl } from '@parallax/runtime/core';
import { authoredClipPath, canonicalBone, isAuthoredClip, readClipFile } from '@parallax/runtime/plugins/models';
import { BUILT_IN_LIMBS, graphBones, readAnimatorGraph } from '@parallax/runtime/plugins/visuals';
import type { AnimatorGraph } from '@parallax/runtime/plugins/visuals';
import { handleFormProblem, resolvePrefab } from '@parallax/runtime/resource';
import type { JsonObject } from '@parallax/runtime/resource';
import { assetHandle } from './context.js';
import type { CheckContext } from './context.js';
import { pointerTo } from './values.js';

const CLIP_FILE = /^assets\/clips\/[^/]+\.clip\.json$/;
const MODEL_DOC = '.model.json';

export function checkAnimation(ctx: CheckContext): void {
  for (const path of ctx.files.all()) {
    if (!path.startsWith('assets/clips/')) continue;
    if (!CLIP_FILE.test(path)) {
      ctx.report('PP3781', `${path} is in assets/clips/ but isn't a clip file`, { path, fix: 'Clip files are named <name>.clip.json.' });
      continue;
    }
    for (const p of readClipFile(path, ctx.files.read(path)).problems) {
      ctx.report(p.code, p.message, { path, pointer: p.pointer, ...(p.fix !== undefined && { fix: p.fix }) });
    }
  }
  const models = new ModelFacts(ctx);
  for (const prefab of ctx.project.prefabs.values()) {
    let resolved;
    try {
      resolved = resolvePrefab(ctx.project, prefab.id);
    } catch {
      continue; // an unknown base or a cycle: data_checks reports it
    }
    if (prefab.components['animator'] !== undefined) {
      animator(ctx, models, resolved.components, prefab.path, '/components/animator');
    }
    prefab.children.forEach((child, i) => {
      if (child.components['animator'] === undefined) return;
      const base = child.prefab === undefined ? {} : safeComponents(ctx, child.prefab);
      animator(ctx, models, merge(base, child.components), prefab.path, `/children/${i}/components/animator`);
    });
  }
  for (const scene of ctx.project.scenes.values()) {
    scene.entities.forEach((placed, i) => {
      if (placed.components['animator'] === undefined) return;
      animator(ctx, models, merge(safeComponents(ctx, placed.prefab), placed.components), placed.origin.path, `${placed.origin.pointer ?? `/entities/${i}`}/components/animator`);
    });
  }
}

function safeComponents(ctx: CheckContext, id: string): Readonly<Record<string, JsonObject>> {
  try {
    return resolvePrefab(ctx.project, id).components;
  } catch {
    return {};
  }
}

function merge(base: Readonly<Record<string, JsonObject>>, over: Readonly<Record<string, JsonObject>>): Record<string, JsonObject> {
  const out: Record<string, JsonObject> = { ...base };
  for (const [id, fields] of Object.entries(over)) out[id] = { ...(base[id] ?? {}), ...fields };
  return out;
}

function animator(ctx: CheckContext, models: ModelFacts, components: Readonly<Record<string, JsonObject>>, path: string, at: string): void {
  const data = components['animator']!;
  const { graph, problems } = readAnimatorGraph(data);
  for (const p of problems) ctx.report(p.code, p.message, { path, pointer: `${at}${p.pointer}`, ...(p.fix !== undefined && { fix: p.fix }) });
  if (graph === undefined) return;
  const modelRef = components['model']?.['model'];
  const own = typeof modelRef === 'string' ? models.path(modelRef) : undefined;
  if (!ctx.options.assetFiles) {
    // Model documents are project data, checked even without the asset files: they have no clips.
    if (own !== undefined && own.endsWith(MODEL_DOC)) {
      for (const { ref, pointer } of clipRefs(data)) if (!isAuthoredClip(ref) && !ref.includes('#')) clip(ctx, models, ref, own, path, `${at}${pointer}`);
    }
    // Clips of hosted models are checked for form either way (nothing is fetched).
    for (const { ref, pointer } of clipRefs(data)) if (ref.includes('#') && isAssetUrl(ref)) clip(ctx, models, ref, own, path, `${at}${pointer}`);
    return;
  }
  for (const { ref, pointer } of clipRefs(data)) clip(ctx, models, ref, own, path, `${at}${pointer}`);
  bones(ctx, models, graph, own, path, at);
}

/** Every clip reference in an animator's data, with its pointer under the animator. */
function clipRefs(data: JsonObject): { ref: string; pointer: string }[] {
  const out: { ref: string; pointer: string }[] = [];
  if (typeof data['default_clip'] === 'string') out.push({ ref: data['default_clip'], pointer: '/default_clip' });
  const walk = (value: unknown, pointer: string): void => {
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, pointerTo(pointer, i)));
    else if (typeof value === 'object' && value !== null) {
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'clip' && typeof inner === 'string') out.push({ ref: inner, pointer: pointerTo(pointer, key) });
        else walk(inner, pointerTo(pointer, key));
      }
    }
  };
  walk(data['layers'], '/layers');
  const events = data['events'];
  if (typeof events === 'object' && events !== null && !Array.isArray(events)) {
    for (const key of Object.keys(events)) out.push({ ref: key, pointer: pointerTo('/events', key) });
  }
  return out;
}

function clip(ctx: CheckContext, models: ModelFacts, ref: string, own: string | undefined, path: string, pointer: string): void {
  if (isAuthoredClip(ref)) {
    // One spelling per clip file: its handle ("clips/wave"), never the path written out.
    const form = handleFormProblem(ref, 'clips');
    if (form !== undefined) {
      ctx.report('PP2063', `The clip ${form.message}`, { path, pointer, fix: `Write "${form.handle}" (no "assets/", no extension).` });
      return;
    }
    const file = authoredClipPath(ref);
    if (!ctx.files.exists(file)) {
      const known = ctx.files.all().filter((p) => CLIP_FILE.test(p)).map((p) => assetHandle(p));
      const guess = closestMatch(assetHandle(file), known);
      ctx.report('PP2063', `The clip "${ref}" has no file ${file}`, { path, pointer, fix: guess !== undefined ? `Did you mean "${guess}"?` : 'Add the clip file to assets/clips/.' });
    }
    return;
  }
  const hash = ref.lastIndexOf('#');
  if (hash !== -1 && isAssetUrl(ref.slice(0, hash))) {
    // A hosted model: its form is checked; its clips aren't known without fetching it.
    const problem = ctx.missingAsset('asset/models', ref.slice(0, hash));
    if (problem !== undefined) ctx.report('PP2063', `The clip "${ref}": ${problem.message!}`, { path, pointer, fix: problem.fix! });
    return;
  }
  if (hash !== -1) {
    const form = handleFormProblem(ref.slice(0, hash), 'models');
    if (form !== undefined) {
      ctx.report('PP2063', `The clip "${ref}": ${form.message}`, { path, pointer, fix: `Write "${form.handle}${ref.slice(hash)}".` });
      return;
    }
  }
  const model = hash === -1 ? own : models.path(ref.slice(0, hash));
  const name = hash === -1 ? ref : ref.slice(hash + 1);
  if (model === undefined) {
    if (hash === -1) return; // no Model (or one this check can't read): the runtime reports a bare clip without one
    ctx.report('PP2063', `The clip "${ref}" names a model that isn't in assets/models/`, { path, pointer });
    return;
  }
  const facts = models.facts(model);
  if (facts === undefined || facts.clips.includes(name)) return;
  const guess = closestMatch(name, facts.clips);
  const none = model.endsWith(MODEL_DOC)
    ? `${model} is a model document, which has no animations: play an authored clip ("clips/<name>", assets/clips/<name>.clip.json) or a glTF's ("<model>#<clip>").`
    : `${model} has no animations.`;
  ctx.report('PP3805', `${model} has no clip "${name}"`, {
    path, pointer, fix: guess !== undefined ? `Did you mean "${guess}"?` : facts.clips.length > 0 ? `Its clips: ${facts.clips.join(', ')}.` : none,
  });
}

function bones(ctx: CheckContext, models: ModelFacts, graph: AnimatorGraph, own: string | undefined, path: string, at: string): void {
  if (own === undefined) return;
  const facts = models.facts(own);
  if (facts === undefined || facts.nodes.length === 0) return;
  const exact = new Set(facts.nodes);
  const canonical = new Set(facts.nodes.map(canonicalBone));
  for (const { bone, pointer } of graphBones(graph)) {
    if (exact.has(bone) || canonical.has(canonicalBone(bone))) continue;
    const guess = closestMatch(bone, facts.nodes);
    const builtIn = pointer === '/ik/feet' ? ` (the built-in limbs ${[...BUILT_IN_LIMBS.keys()].join(', ')} use the humanoid rig's names; declare "limbs" with this model's)` : '';
    ctx.report('PP3780', `${own} has no bone "${bone}"${builtIn}`, {
      path, pointer: `${at}${pointer}`, fix: guess !== undefined ? `Did you mean "${guess}"?` : `Its bones: ${facts.nodes.slice(0, 30).join(', ')}.`,
    });
  }
}

/** Node and clip names of the project's glTF models (the JSON chunk; nothing else is read). */
class ModelFacts {
  readonly #ctx: CheckContext;
  readonly #cache = new Map<string, { nodes: string[]; clips: string[] } | undefined>();

  constructor(ctx: CheckContext) {
    this.#ctx = ctx;
  }

  /** The model file a Model reference names, if the project has it. */
  path(ref: string): string | undefined {
    const handle = ref.startsWith('assets/') ? assetHandle(ref) : ref.includes('/') ? ref : `models/${ref}`;
    return this.#ctx.assets.get(handle);
  }

  facts(path: string): { readonly nodes: readonly string[]; readonly clips: readonly string[] } | undefined {
    if (this.#cache.has(path)) return this.#cache.get(path);
    let facts: { nodes: string[]; clips: string[] } | undefined;
    if (path.endsWith(MODEL_DOC)) {
      // A model document (code model) has parts but no skeleton bones or clips (resource/models/code_model.ts).
      facts = { nodes: [], clips: [] };
      this.#cache.set(path, facts);
      return facts;
    }
    try {
      const json = gltfJson(this.#ctx, path);
      if (json !== undefined) {
        const doc = JSON.parse(json) as { nodes?: { name?: string }[]; animations?: { name?: string }[] };
        facts = {
          nodes: (doc.nodes ?? []).flatMap((n) => (typeof n.name === 'string' && n.name !== '' ? [n.name] : [])),
          clips: (doc.animations ?? []).flatMap((a) => (typeof a.name === 'string' ? [a.name] : [])),
        };
      }
    } catch {
      facts = undefined; // codegen reports an unreadable model
    }
    this.#cache.set(path, facts);
    return facts;
  }
}

function gltfJson(ctx: CheckContext, path: string): string | undefined {
  if (path.endsWith('.gltf')) return ctx.files.read(path);
  if (!path.endsWith('.glb')) return undefined;
  const bytes = ctx.files.bytes(path);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67 || view.getUint32(16, true) !== 0x4e4f534a) return undefined;
  return new TextDecoder().decode(bytes.subarray(20, 20 + view.getUint32(12, true)));
}
