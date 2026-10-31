/**
 * streaming — open worlds: placements from `regions/` stream in and out
 * around the streaming sources by cell, and world layers (`world.json` `"layers"`) gate
 * them by meaning, declaratively (`active_when`) or through `ctx.world.layer(...)`. The
 * rules are documented on the service (function/services/streaming.ts). A core plugin:
 * the runtime includes it; scenes without a world.json are untouched.
 *
 * Determinism: every pass walks placements in scene order and sources in spawn order,
 * and runs at a fixed point of the frame (the `input` hook, before game code), so a
 * replay streams the same entities on the same frames.
 */

import { closestMatch, fail, Quat, Vec3 } from '../../../core/index.js';
import type { EntityId } from '../../../core/index.js';
import type { Json, JsonObject, Placement, SceneDoc } from '../../../resource/index.js';
import { copy, decodeFields, encodeFields, KERNEL_EVENTS } from '../../kernel/index.js';
import type { EntityCodec, EntityRecord, Fields, Kernel, KernelPlugin, SpawnRequest } from '../../kernel/index.js';
import { SAVE_SERVICE, STORY_SERVICE, STREAMING_SERVICE } from '../../services/index.js';
import type { HeldEntity, LayerState, StreamedWorld, WorldLayerInfo } from '../../services/index.js';

const LAYER_STATES: readonly LayerState[] = ['unloaded', 'loaded', 'active'];
const CONDITIONS = ['quest_active', 'quest_completed', 'quest_failed', 'fact'] as const;
const STREAMING_KEYS = ['radius'] as const;

interface LayerDef {
  readonly id: string;
  readonly activeWhen: JsonObject | undefined;
}

interface Streamed {
  readonly id: string;
  readonly placement: Placement;
  readonly layer: string | undefined;
  readonly alwaysLoaded: boolean;
  /** Authored ground position (x, z). */
  readonly x: number;
  readonly z: number;
}

/** Where the world is looked at from, in spawn order. */
export function streamingSources(kernel: Kernel): Array<{ entity: EntityId; position: Vec3 }> {
  const out: Array<{ entity: EntityId; position: Vec3 }> = [];
  const seen = new Set<EntityId>();
  const add = (record: EntityRecord): void => {
    if (seen.has(record.id)) return;
    seen.add(record.id);
    out.push({ entity: record.id, position: record.transform.worldPosition() });
  };
  for (const record of kernel.world.live()) {
    const camera = record.components.get('camera');
    if (camera !== undefined) {
      add(record);
      const follow = camera['follow'];
      for (const target of Array.isArray(follow) ? follow : [follow]) {
        const id = target === null || target === undefined || typeof target === 'string' ? undefined : kernel.handles.unwrap(target);
        const followed = id === undefined ? undefined : kernel.world.get(id);
        if (followed !== undefined) add(followed);
      }
    } else if (record.owner !== undefined && record.parent === null) {
      add(record);
    }
  }
  return out;
}

class OpenWorld implements StreamedWorld {
  readonly scene: string;
  readonly cellSize: number;
  readonly radius: number;
  readonly layerDefs: ReadonlyMap<string, LayerDef>;
  readonly streamed: readonly Streamed[];
  readonly byId: ReadonlyMap<string, Streamed>;
  readonly loaded = new Map<string, EntityId>();
  readonly heldState = new Map<string, HeldEntity>();
  readonly gone = new Set<string>();
  /** Entities this plugin is unloading (their teardown isn't a game destroy). */
  readonly unloading = new Set<EntityId>();
  /** Current states of the declarative layers (the others live in the run-level map). */
  readonly declared = new Map<string, LayerState>();
  readonly #plugin: StreamingState;
  readonly #kernel: Kernel;

  constructor(plugin: StreamingState, kernel: Kernel, scene: SceneDoc) {
    this.#plugin = plugin;
    this.#kernel = kernel;
    const world = scene.world!;
    this.scene = scene.id;
    const bad = (pointer: string, message: string, fix: string, code: 'PP3632' | 'PP3633' | 'PP3634' = 'PP3634'): never =>
      fail(code, `scenes/${scene.id}/world.json: ${message}`, { path: world.path, pointer, fix });
    if (!(world.cellSize > 0)) bad('/cell_size', 'cell_size must be greater than 0', 'Write "cell_size": 256 (meters).');
    this.cellSize = world.cellSize;
    let radius = Infinity;
    if (world.streaming !== undefined) {
      for (const key of Object.keys(world.streaming)) {
        if ((STREAMING_KEYS as readonly string[]).includes(key)) continue;
        bad(`/streaming/${key}`, `unknown streaming key "${key}"`, 'Streaming takes "radius" (meters).');
      }
      const r = world.streaming['radius'];
      if (r !== undefined) {
        if (typeof r !== 'number' || !(r > 0)) bad('/streaming/radius', 'streaming radius must be a number greater than 0', 'Write "radius": 400 (meters).');
        radius = r as number;
      }
    }
    this.radius = radius;

    const layers = new Map<string, LayerDef>();
    for (const [id, doc] of world.layers) {
      const activeWhen = doc.activeWhen;
      if (activeWhen !== undefined) {
        const keys = Object.keys(activeWhen);
        if (keys.length === 0) bad(`/layers/${id}/active_when`, `layer "${id}": active_when is empty`, 'Name a condition, e.g. {"quest_active": "<quest id>"}.', 'PP3632');
        for (const key of keys) {
          if (!(CONDITIONS as readonly string[]).includes(key)) {
            const guess = closestMatch(key, CONDITIONS);
            bad(`/layers/${id}/active_when/${key}`, `layer "${id}": unknown condition "${key}"`,
              guess === undefined ? `Conditions: ${CONDITIONS.join(', ')}.` : `Did you mean "${guess}"?`, 'PP3632');
          }
          if (typeof activeWhen[key] !== 'string') {
            bad(`/layers/${id}/active_when/${key}`, `layer "${id}": "${key}" must name a ${key === 'fact' ? 'fact' : 'quest'} id`, 'Write a string id.', 'PP3632');
          }
        }
      }
      layers.set(id, { id, activeWhen });
    }
    this.layerDefs = layers;

    const streamed: Streamed[] = [];
    for (const placement of scene.entities) {
      if (placement.layer !== undefined && !layers.has(placement.layer)) {
        const guess = closestMatch(placement.layer, layers.keys());
        fail('PP3633', `Placement "${placement.id ?? placement.prefab}" names layer "${placement.layer}", which world.json doesn't declare`, {
          path: world.path, fix: guess !== undefined ? `Did you mean "${guess}"?` : `Declare it in world.json "layers", or remove "layer".`,
        });
      }
      // Grids and placements outside regions don't stream (they have no single stable id or position).
      if (placement.region === undefined || placement.id === undefined || placement.grid !== undefined) continue;
      const at = placement.at ?? [0, 0, 0];
      streamed.push({
        id: placement.id, placement, layer: placement.layer, alwaysLoaded: placement.alwaysLoaded === true,
        x: at[0] ?? 0, z: at.length === 3 ? at[2]! : 0,
      });
    }
    this.streamed = streamed;
    this.byId = new Map(streamed.map((s) => [s.id, s]));
  }

  // ── StreamedWorld ────────────────────────────────────────────────────────────

  layers(): WorldLayerInfo[] {
    return [...this.layerDefs.values()].map((l) => ({ id: l.id, state: this.layerState(l.id), declarative: l.activeWhen !== undefined }));
  }

  #layer(id: string, where: string): LayerDef {
    const layer = this.layerDefs.get(id);
    if (layer === undefined) {
      const guess = closestMatch(id, this.layerDefs.keys());
      fail('PP3630', `${where}: scene "${this.scene}" has no world layer "${id}"`, {
        fix: guess !== undefined ? `Did you mean "${guess}"?` : `Declare it in scenes/${this.scene}/world.json "layers".`,
      });
    }
    return layer;
  }

  layerState(id: string): LayerState {
    const layer = this.#layer(id, 'layer state');
    if (layer.activeWhen !== undefined) return this.declared.get(id) ?? 'loaded';
    return this.#plugin.imperative(this.scene).get(id) ?? 'active';
  }

  setLayerState(id: string, state: LayerState): void {
    const layer = this.#layer(id, 'set layer state');
    if (!LAYER_STATES.includes(state)) fail('PP3630', `"${String(state)}" is not a layer state`, { fix: 'Use unloaded, loaded or active.' });
    if (layer.activeWhen !== undefined) {
      fail('PP3631', `World layer "${id}" follows its active_when (${JSON.stringify(layer.activeWhen)}); it can't be switched from code`, {
        fix: 'Change the condition (start or finish the quest, set the fact), or remove active_when from world.json to control it from code.',
      });
    }
    this.#plugin.imperative(this.scene).set(id, state);
    this.update();
    this.#settleLayer(id, state);
  }

  isLoaded(placedId: string): boolean | undefined {
    return this.byId.has(placedId) ? this.loaded.has(placedId) : undefined;
  }

  held(): ReadonlyMap<string, HeldEntity> { return this.heldState; }
  destroyed(): ReadonlySet<string> { return this.gone; }

  // ── Streaming ────────────────────────────────────────────────────────────────

  /** A layer that became `unloaded` forgets its placements' held state. */
  #settleLayer(id: string, state: LayerState): void {
    if (state !== 'unloaded') return;
    for (const s of this.streamed) if (s.layer === id) this.heldState.delete(s.id);
  }

  /** Re-evaluate `active_when` layers. */
  evaluateLayers(): void {
    for (const layer of this.layerDefs.values()) {
      if (layer.activeWhen === undefined) continue;
      const conditions = this.#kernel.service(STORY_SERVICE);
      let holds = true;
      for (const [key, value] of Object.entries(layer.activeWhen)) {
        const id = value as string;
        if (key === 'fact') holds &&= Boolean(conditions.fact(id));
        else holds &&= conditions.questStatus(id) === key.slice('quest_'.length);
      }
      this.declared.set(layer.id, holds ? 'active' : 'loaded');
    }
  }

  #layerActive(layer: string | undefined): boolean {
    return layer === undefined || this.layerState(layer) === 'active';
  }

  /** Distance on the ground from the nearest source to a cell's square (Infinity without sources). */
  #cellDistance(x: number, z: number, sources: readonly Vec3[]): number {
    const cs = this.cellSize;
    const minX = Math.floor(x / cs) * cs;
    const minZ = Math.floor(z / cs) * cs;
    let best = Infinity;
    for (const s of sources) {
      const dx = Math.max(minX - s.x, 0, s.x - (minX + cs));
      const dz = Math.max(minZ - s.z, 0, s.z - (minZ + cs));
      best = Math.min(best, Math.hypot(dx, dz));
    }
    return best;
  }

  /** Initial pass over the scene's own batch: authored entities that shouldn't be in the world never start. */
  admit(batch: readonly EntityRecord[]): void {
    for (const record of batch) {
      if (record.placedId !== undefined && this.byId.has(record.placedId)) this.loaded.set(record.placedId, record.id);
    }
    this.evaluateLayers();
    const sources = streamingSources(this.#kernel);
    const isSource = new Set(sources.map((s) => s.entity));
    const points = sources.map((s) => s.position);
    for (const s of this.streamed) {
      const id = this.loaded.get(s.id);
      if (id === undefined) continue;
      const record = this.#kernel.world.get(id)!;
      const pinned = s.alwaysLoaded || isSource.has(id) || record.owner !== undefined;
      if (this.#layerActive(s.layer) && (pinned || this.#cellDistance(s.x, s.z, points) <= this.radius)) continue;
      this.loaded.delete(s.id);
      this.#kernel.world.destroy(id);
    }
  }

  /** One streaming pass: unload what left, load what came into range. */
  update(): void {
    const kernel = this.#kernel;
    this.evaluateLayers();
    const sources = streamingSources(kernel);
    const isSource = new Set(sources.map((s) => s.entity));
    const points = sources.map((s) => s.position);
    for (const s of this.streamed) {
      if (this.gone.has(s.id)) continue;
      const layerActive = this.#layerActive(s.layer);
      const id = this.loaded.get(s.id);
      if (id !== undefined) {
        const record = kernel.world.get(id);
        if (record === undefined) continue;
        const pinned = s.alwaysLoaded || isSource.has(id) || record.owner !== undefined;
        const p = record.transform.worldPosition();
        if (layerActive && (pinned || this.#cellDistance(p.x, p.z, points) <= this.radius + this.cellSize / 2)) continue;
        this.#unload(s, record);
      } else if (layerActive) {
        const held = this.heldState.get(s.id);
        const x = held?.position.x ?? s.x;
        const z = held?.position.z ?? s.z;
        if (s.alwaysLoaded || this.#cellDistance(x, z, points) <= this.radius) this.#load(s, held);
      }
    }
  }

  #unload(s: Streamed, record: EntityRecord): void {
    const kernel = this.#kernel;
    const components: Record<string, Fields> = {};
    for (const componentId of record.components.keys()) {
      const schema = kernel.registry.components.get(componentId)!.schema;
      components[componentId] = Object.fromEntries(Object.keys(schema).map((name) => [name, copy(kernel.base(record.id, componentId, name))]));
    }
    const behaviors = record.behaviors.map((slot) => ({
      use: slot.def.id,
      state: Object.fromEntries(Object.keys(slot.def.state).map((name) => [name, copy(slot.instance[name])])),
    }));
    this.heldState.set(s.id, {
      position: record.transform.position,
      rotation: record.transform.rotation,
      scale: record.transform.scale,
      visible: record.visible,
      tags: [...record.tags],
      components,
      behaviors,
    });
    this.loaded.delete(s.id);
    const killed = kernel.world.destroy(record.id);
    for (const dead of killed) {
      this.unloading.add(dead.id);
      kernel.emit(KERNEL_EVENTS.destroyed, { entity: kernel.handles.wrap(dead.id), unloaded: true });
    }
  }

  #load(s: Streamed, held: HeldEntity | undefined): void {
    const kernel = this.#kernel;
    const p = s.placement;
    const over = held === undefined ? p : {
      ...p,
      at: [held.position.x, held.position.y, held.position.z],
      rotation: (() => { const e = held.rotation.to_euler(); return [e.x, e.y, e.z]; })(),
      scale: [held.scale.x, held.scale.y, held.scale.z],
      visible: held.visible,
    };
    const request: SpawnRequest = { placedId: s.id, ...(held !== undefined && { components: held.components }) };
    const record = kernel.spawn(p.prefab, over, request);
    this.loaded.set(s.id, record.id);
    if (held === undefined) return;
    record.transform.rotation = held.rotation;
    record.tags.clear();
    for (const tag of held.tags) record.tags.add(tag);
    for (const componentId of [...record.components.keys()]) {
      if (!(componentId in held.components)) kernel.removeComponent(record.id, componentId);
    }
    record.behaviors.forEach((slot, i) => {
      const saved = held.behaviors[i];
      if (saved !== undefined && saved.use === slot.def.id) Object.assign(slot.instance, copy(saved.state));
    });
    this.heldState.delete(s.id);
  }

  /** An entity left the world: a game destroy of a streamed entity keeps it gone. */
  removed(record: EntityRecord): void {
    if (this.unloading.delete(record.id)) return;
    const placed = record.placedId;
    if (placed === undefined || this.loaded.get(placed) !== record.id) return;
    this.loaded.delete(placed);
    this.gone.add(placed);
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────────

  snapshot(codec: EntityCodec): JsonObject {
    const kernel = this.#kernel;
    const held: Record<string, Json> = {};
    for (const [id, h] of this.heldState) {
      held[id] = {
        position: [h.position.x, h.position.y, h.position.z],
        rotation: [h.rotation.x, h.rotation.y, h.rotation.z, h.rotation.w],
        scale: [h.scale.x, h.scale.y, h.scale.z],
        visible: h.visible,
        tags: [...h.tags],
        components: Object.fromEntries(Object.entries(h.components).map(([c, fields]) =>
          [c, encodeFields(kernel.registry.component(c, 'streaming snapshot').schema, fields, `held ${id}.${c}`, codec)])),
        behaviors: h.behaviors.map((b) => ({
          use: b.use, state: encodeFields(kernel.registry.behavior(b.use, 'streaming snapshot').state, b.state, `held ${id} ${b.use}`, codec),
        })),
      };
    }
    return {
      scene: this.scene,
      loaded: Object.fromEntries([...this.loaded].map(([k, v]) => [k, v as number])),
      held,
      gone: [...this.gone],
      declared: Object.fromEntries(this.declared),
    };
  }

  restore(data: JsonObject, codec: EntityCodec): void {
    const kernel = this.#kernel;
    this.loaded.clear();
    for (const [k, v] of Object.entries(data['loaded'] as JsonObject)) this.loaded.set(k, v as number as EntityId);
    this.heldState.clear();
    for (const [id, raw] of Object.entries(data['held'] as JsonObject)) {
      const h = raw as JsonObject;
      const n = (key: string): number[] => h[key] as number[];
      const [px, py, pz] = n('position');
      const [rx, ry, rz, rw] = n('rotation');
      const [sx, sy, sz] = n('scale');
      this.heldState.set(id, {
        position: new Vec3(px!, py!, pz!),
        rotation: new Quat(rx!, ry!, rz!, rw!),
        scale: new Vec3(sx!, sy!, sz!),
        visible: h['visible'] as boolean,
        tags: h['tags'] as string[],
        components: Object.fromEntries(Object.entries(h['components'] as JsonObject).map(([c, fields]) =>
          [c, decodeFields(kernel.registry.component(c, 'streaming restore').schema, fields as JsonObject, `held ${id}.${c}`, codec)])),
        behaviors: (h['behaviors'] as JsonObject[]).map((b) => ({
          use: b['use'] as string,
          state: decodeFields(kernel.registry.behavior(b['use'] as string, 'streaming restore').state, b['state'] as JsonObject, `held ${id}`, codec),
        })),
      });
    }
    this.gone.clear();
    for (const id of data['gone'] as string[]) this.gone.add(id);
    this.declared.clear();
    for (const [k, v] of Object.entries(data['declared'] as JsonObject)) this.declared.set(k, v as LayerState);
    this.unloading.clear();
  }
}

class StreamingState {
  /** Run-level states of layers without active_when, by scene. */
  readonly layers = new Map<string, Map<string, LayerState>>();
  world: OpenWorld | null = null;
  /** The next `added` batch is the loading scene's own. */
  sceneBatch = false;

  imperative(scene: string): Map<string, LayerState> {
    let states = this.layers.get(scene);
    if (states === undefined) this.layers.set(scene, states = new Map());
    return states;
  }

  exportLayers(): JsonObject {
    const out: Record<string, Json> = {};
    for (const [scene, states] of [...this.layers].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (states.size > 0) out[scene] = Object.fromEntries(states);
    }
    return out;
  }

  importLayers(data: Json | undefined, where: string): void {
    const bad = (message: string): never => fail('PP3635', `${where}: ${message}`, {
      fix: 'Saved layer states look like {"<scene>": {"<layer>": "unloaded" | "loaded" | "active"}}.',
    });
    const parsed = new Map<string, Map<string, LayerState>>();
    if (data !== undefined) {
      if (typeof data !== 'object' || data === null || Array.isArray(data)) return bad('not an object');
      for (const [scene, states] of Object.entries(data as JsonObject)) {
        if (typeof states !== 'object' || states === null || Array.isArray(states)) return bad(`scene "${scene}" is not an object`);
        const map = new Map<string, LayerState>();
        for (const [layer, state] of Object.entries(states as JsonObject)) {
          if (!LAYER_STATES.includes(state as LayerState)) return bad(`layer "${layer}" has state ${JSON.stringify(state)}`);
          map.set(layer, state as LayerState);
        }
        parsed.set(scene, map);
      }
    }
    this.layers.clear();
    for (const [scene, map] of parsed) this.layers.set(scene, map);
  }
}

/** Snapshot ids: entity handles as their ids (as the kernel's snapshot does). */
function idCodec(kernel: Kernel): EntityCodec {
  return {
    encode: (handle) => {
      if (handle === null) return null;
      const id = kernel.handles.unwrap(handle);
      return id === undefined ? null : id;
    },
    decode: (value) => (typeof value === 'number' ? kernel.handles.wrap(value as EntityId) : value),
  };
}

export function streaming(): KernelPlugin {
  const state = new StreamingState();
  let installed: Kernel | undefined;
  let sectionRegistered = false;
  return {
    id: 'streaming',
    install(kernel) {
      if (installed !== undefined) fail('PP3636', 'This streaming plugin is already installed in another kernel', { fix: 'Create one per kernel.' });
      installed = kernel;
      kernel.provide(STREAMING_SERVICE, {
        current: () => state.world,
        sources: () => streamingSources(kernel),
      });
      kernel.observeScenes({
        loading: (scene, request) => {
          if (!sectionRegistered) {
            sectionRegistered = true;
            kernel.tryService(SAVE_SERVICE)?.register({
              key: 'world_layers',
              save: () => state.exportLayers(),
              load: (data) => {
                state.importLayers(data, 'Saved world layers');
                state.world?.update();
              },
            });
          }
          if (request.newRun === true) state.layers.clear();
          state.world = scene.world === undefined ? null : new OpenWorld(state, kernel, scene);
          state.sceneBatch = state.world !== null;
        },
      });
      kernel.observeEntities({
        added: (records) => {
          if (!state.sceneBatch) return;
          state.sceneBatch = false;
          state.world?.admit(records);
        },
        removed: (records) => { for (const record of records) state.world?.removed(record); },
      });
      kernel.addHook('input', () => state.world?.update());
    },
    snapshot: (kernel): Json => ({
      layers: state.exportLayers(),
      world: state.world === null ? null : state.world.snapshot(idCodec(kernel)),
    }),
    restore(kernel, saved) {
      const obj = saved as JsonObject;
      state.importLayers(obj['layers'] ?? undefined, 'Streaming snapshot');
      const scene = kernel.scene;
      state.world = scene?.world === undefined ? null : new OpenWorld(state, kernel, scene);
      state.sceneBatch = false;
      const world = obj['world'];
      if (state.world !== null && typeof world === 'object' && world !== null) state.world.restore(world as JsonObject, idCodec(kernel));
    },
  };
}
