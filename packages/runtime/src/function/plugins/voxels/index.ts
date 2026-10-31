/**
 * voxels — block worlds (sdk/parallax/voxels.pyi). A scene with a `"voxels"` block (see
 * spec.ts) gets a chunked block world: generated on demand from its generator, edited
 * with `set`, meshed for render3d and physics3d through the `voxels` service
 * (function/services/voxels.ts).
 *
 * Block entities. A block whose entry names a `prefab` gets that prefab spawned when it is
 * set, at the bottom center of its cell (x + 0.5, y, z + 0.5), carrying
 * `voxel_block(cell=...)`; changing or clearing the block destroys it. Any entity with a
 * `voxel_block` component is the block entity of its cell (that is how a save's entity
 * diff brings them back). When a scene with edits is loaded again, the block entities of
 * its edited prefab blocks are spawned fresh at the start of its first frame.
 *
 * Smooth worlds (`"mode": "smooth"`, smooth.ts) hold a density lattice instead of cubes:
 * marched into smooth chunk meshes (same service shape: render3d and physics3d draw and
 * collide them unchanged), dug and filled with sphere brushes (`dig`, `fill`); `get`/`set`
 * read and write single lattice points as fully solid or air.
 *
 * Meshing runs on the platform's job runner (`JOBS_SERVICE`) when it has worker threads:
 * a chunk keeps its previous mesh until the job's result arrives (the next frames), and a
 * result for data that changed meanwhile is dropped. Inline runners and no runner mesh on
 * the spot, so headless runs see every edit's mesh in the same frame; both produce the
 * same meshes (the job is the same pure function).
 *
 * Edits are a run-level diff against the generated world, per scene: they survive scene
 * changes and are cleared by `new_run=True`. They are this plugin's snapshot state; with
 * `save_edits` the save plugin stores them through the service. `block_changed` is
 * emitted for every `set` that changes a block; restores and loaded saves emit nothing.
 */

import { fail, jobKey } from '../../../core/index.js';
import type { JobKey } from '../../../core/index.js';
import type { EntityId, Vec3 } from '../../../core/index.js';
import type { Json, JsonObject, SceneDoc } from '../../../resource/index.js';
import { t } from '../../kernel/index.js';
import type { ComponentDef, EventDef, Fields, Kernel, KernelPlugin } from '../../kernel/index.js';
import type { EntityRecord } from '../../kernel/index.js';
import { JOBS_SERVICE, SAVE_SERVICE, STREAMING_SERVICE, VOXELS_SERVICE } from '../../services/index.js';
import type { VoxelChunkMesh, VoxelWorldView } from '../../services/index.js';
import { AIR, BlockTable } from './blocks.js';
import { Cell3 } from '../../../core/index.js';
import { Landscape, SmoothLandscape } from './generate.js';
import { chunkIsAir, meshChunk, neighbourhoodOf } from './mesh.js';
import type { ChunkGeometry, ChunkNeighbourhood } from './mesh.js';
import { brush, densityAtPoint, ISO, marchChunk, pack } from './smooth.js';
import { readVoxelSpec } from './spec.js';
import type { VoxelSceneSpec } from './spec.js';
import { addEdit, chunkKey, exportEdits, VoxelStore } from './store.js';
import type { RayHit, SceneEdits } from './store.js';

export { Cell3 } from '../../../core/index.js';
export { BlockTable, readBlockTexture } from './blocks.js';
export type { BlockFaces } from './blocks.js';
export { hash4, Landscape } from './generate.js';
export { meshChunk, neighbourhoodOf, padded } from './mesh.js';
export type { ChunkGeometry, ChunkNeighbourhood, ChunkSource } from './mesh.js';
export { brush, densityFromDistance, ISO, marchChunk, pack } from './smooth.js';
export { SmoothLandscape } from './generate.js';
export { readVoxelSpec } from './spec.js';
export type { LandscapeSpec, VoxelSceneSpec } from './spec.js';
export type { RayHit } from './store.js';

export const VOXEL_BLOCK = 'voxel_block';
export const VOXEL_BLOCK_SCHEMA = { cell: t.cell3() } as const;
export const BLOCK_CHANGED: EventDef = { id: 'block_changed' };

const EDITS_FORMAT = 1;

/** The chunk meshing jobs (boot/jobs.ts serves them; the plugin runs them through JOBS_SERVICE). */
export const VOXELS_MESH: JobKey<ChunkNeighbourhood, ChunkGeometry> = jobKey('voxels.mesh');
export const VOXELS_MARCH: JobKey<ChunkNeighbourhood, ChunkGeometry> = jobKey('voxels.march');

export interface VoxelsHost {
  /** The game-facing ref for block `id` (a `ContentRef[BlockDef]`). */
  block(kernel: Kernel, id: string): unknown;
}

export interface VoxelsOptions {
  readonly chunkSize: number;
  readonly saveEdits: boolean;
  readonly host: VoxelsHost;
}

/** What `ctx.voxels` is built on: integer cells and block ids. */
export interface VoxelsEngine {
  /** The block id at a cell, or null for air. */
  get(x: number, y: number, z: number): string | null;
  /** Set a block (null: air); `by` is a game-facing entity handle or null. */
  set(x: number, y: number, z: number, block: string | null, by: unknown): void;
  blockEntity(x: number, y: number, z: number): EntityId | undefined;
  surfaceHeight(x: number, z: number): number;
  raycast(origin: Vec3, direction: Vec3, maxDistance: number): RayHit | undefined;
  /** The block id of a block index. */
  blockId(index: number): string;
  /** Smooth worlds: dig / fill a sphere; the solid amount changed per block id. */
  carve(mode: 'dig' | 'fill', center: Vec3, radius: number, strength: number, block: string | null): Map<string, number>;
  /** 0..1 at a world point (trilinear in smooth worlds; 0 or 1 per cell in block worlds). */
  densityAt(point: Vec3): number;
  /** The ground's height at (x, z): the top of the highest solid there (continuous in smooth worlds). */
  heightAt(x: number, z: number): number;
  mode(): 'blocks' | 'smooth';
}

export interface VoxelsPlugin extends KernelPlugin {
  readonly engine: VoxelsEngine;
}

const cellKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** A `voxel_block` cell as integers. */
function cellOf(value: unknown, where: string): [number, number, number] {
  if (value instanceof Cell3) return [value.x, value.y, value.z];
  const cell = Cell3.fromJSON(value, where);
  return [cell.x, cell.y, cell.z];
}

class World implements VoxelWorldView {
  readonly version: number;
  readonly scene: string;
  readonly chunkSize: number;
  readonly yMin: number;
  readonly yMax: number;
  readonly renderDistance: number;
  readonly saveEdits: boolean;
  readonly mode: 'blocks' | 'smooth';
  readonly store: VoxelStore;
  /** Chunk key → the ticket of its meshing job in flight. */
  readonly #pending = new Map<string, number>();
  #ticket = 0;
  readonly #kernel: Kernel;
  readonly #meshes = new Map<string, VoxelChunkMesh | null>();
  readonly #dirty = new Set<string>();
  #meshVersion = 0;
  #active: { readonly frame: number; readonly radius: number; readonly columns: string; readonly list: VoxelChunkMesh[] } | undefined;
  readonly #plugin: VoxelsPluginState;

  constructor(plugin: VoxelsPluginState, kernel: Kernel, scene: SceneDoc, spec: VoxelSceneSpec, version: number) {
    this.#plugin = plugin;
    this.#kernel = kernel;
    this.version = version;
    this.scene = scene.id;
    this.chunkSize = plugin.chunkSize;
    this.yMin = spec.yMin;
    this.yMax = spec.yMax;
    this.renderDistance = spec.renderDistance;
    this.saveEdits = plugin.saveEdits;
    this.mode = spec.mode;
    const generator = spec.generator === undefined ? undefined
      : spec.mode === 'smooth' ? new SmoothLandscape(spec.generator, spec.yMin, spec.yMax) : new Landscape(spec.generator, spec.yMin, spec.yMax);
    this.store = new VoxelStore({
      size: plugin.chunkSize,
      yMin: spec.yMin,
      yMax: spec.yMax,
      blocks: plugin.blocks(kernel),
      generator,
      edits: plugin.sceneEdits(scene.id),
      changed: (x, y, z) => this.#changed(x, y, z),
    });
  }

  blocks(): readonly (ReturnType<BlockTable['type']> | undefined)[] { return this.store.blocks.types; }
  blockAt(x: number, y: number, z: number): number {
    const value = this.store.blockAt(x, y, z);
    if (this.mode === 'blocks') return value;
    return (value & 0xff) >= ISO ? value >> 8 : AIR;
  }
  isSolid(x: number, y: number, z: number): boolean { return this.store.blocks.solid(this.blockAt(x, y, z)); }
  densityAt(x: number, y: number, z: number): number {
    if (this.mode === 'blocks') return this.isSolid(Math.floor(x), Math.floor(y), Math.floor(z)) ? 1 : 0;
    return densityAtPoint((a, b, c) => this.store.blockAt(a, b, c) & 0xff, x, y, z) / 255;
  }
  exportEdits(): Json { return this.#plugin.exportEdits(); }
  loadEdits(data: Json | undefined): void { this.#plugin.loadEdits(this.#kernel, data); }

  #changed(x: number, y: number, z: number): void {
    const n = this.chunkSize;
    const cx = Math.floor(x / n);
    const cy = Math.floor(y / n);
    const cz = Math.floor(z / n);
    const lx = x - cx * n;
    const ly = y - cy * n;
    const lz = z - cz * n;
    // Which neighbours read this cell: blocks a one-cell border; smooth chunks read lattice
    // points -1 … n + 1 (cubes up to n, normals one further).
    const below = this.mode === 'smooth' ? 1 : 0;
    const dirty = (dx: number, dy: number, dz: number): void => { this.#dirty.add(chunkKey(cx + dx, cy + dy, cz + dz)); };
    for (let dy = -1; dy <= 1; dy++) {
      if ((dy < 0 && ly > below) || (dy > 0 && ly !== n - 1)) continue;
      for (let dz = -1; dz <= 1; dz++) {
        if ((dz < 0 && lz > below) || (dz > 0 && lz !== n - 1)) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx < 0 && lx > below) || (dx > 0 && lx !== n - 1)) continue;
          // Block faces only look across faces; smooth normals and cubes reach diagonally.
          if (this.mode === 'blocks' && Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 1) continue;
          dirty(dx, dy, dz);
        }
      }
    }
    this.#active = undefined;
  }

  /** Chunk columns (cx, cz) around the streaming sources, sorted. */
  #columns(radius: number): Array<[number, number]> {
    const n = this.chunkSize;
    const seen = new Set<string>();
    const columns: Array<[number, number]> = [];
    for (const { position } of this.#kernel.service(STREAMING_SERVICE).sources()) {
      const scx = Math.floor(position.x / n);
      const scz = Math.floor(position.z / n);
      for (let cz = scz - radius; cz <= scz + radius; cz++) {
        for (let cx = scx - radius; cx <= scx + radius; cx++) {
          const key = `${cx},${cz}`;
          if (seen.has(key)) continue;
          seen.add(key);
          columns.push([cx, cz]);
        }
      }
    }
    return columns.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  }

  active(radius: number = this.renderDistance): readonly VoxelChunkMesh[] {
    if (!Number.isInteger(radius) || radius < 0 || radius > this.renderDistance) {
      fail('PP3629', `active(radius=${radius}): radius must be a whole number of chunks from 0 to render_distance ${this.renderDistance}`);
    }
    const frame = this.#kernel.time.frame;
    const cached = this.#active;
    if (cached !== undefined && cached.frame === frame && cached.radius === radius && this.#dirty.size === 0) return cached.list;
    const columns = this.#columns(radius);
    const columnKey = columns.map((c) => c.join(',')).join(';');
    if (cached !== undefined && cached.radius === radius && cached.columns === columnKey && this.#dirty.size === 0) {
      this.#active = { ...cached, frame };
      return cached.list;
    }
    const n = this.chunkSize;
    const cy0 = Math.floor(this.yMin / n);
    const cy1 = Math.floor((this.yMax - 1) / n);
    const list: VoxelChunkMesh[] = [];
    for (const [cx, cz] of columns) {
      for (let cy = cy0; cy <= cy1; cy++) {
        const mesh = this.#mesh(cx, cy, cz);
        if (mesh !== null) list.push(mesh);
      }
    }
    // Dirty chunks outside the area are rebuilt when they come back into it.
    for (const key of this.#dirty) this.#meshes.delete(key);
    this.#dirty.clear();
    this.#active = { frame, radius, columns: columnKey, list };
    return list;
  }

  #mesh(cx: number, cy: number, cz: number): VoxelChunkMesh | null {
    const key = chunkKey(cx, cy, cz);
    if (!this.#dirty.has(key) && this.#meshes.has(key)) return this.#meshes.get(key)!;
    this.#dirty.delete(key);
    if (chunkIsAir(this.store, cx, cy, cz)) {
      this.#pending.delete(key);
      this.#meshes.set(key, null);
      return null;
    }
    const input = neighbourhoodOf(this.store, cx, cy, cz);
    const job = this.mode === 'smooth' ? VOXELS_MARCH : VOXELS_MESH;
    const jobs = this.#kernel.tryService(JOBS_SERVICE);
    if (jobs !== undefined && jobs.mode === 'workers') {
      // Off the main thread: keep the old mesh (or none) until the result lands.
      const ticket = ++this.#ticket;
      this.#pending.set(key, ticket);
      const previous = this.#meshes.get(key) ?? null;
      this.#meshes.set(key, previous);
      void jobs.run(job, input).then((geometry) => {
        if (this.#pending.get(key) !== ticket || this.#plugin.world !== this) return;
        this.#pending.delete(key);
        this.#meshes.set(key, this.#wrap(key, cx, cy, cz, geometry));
        this.#active = undefined;
      });
      return previous;
    }
    const mesh = this.#wrap(key, cx, cy, cz, this.mode === 'smooth' ? marchChunk(input) : meshChunk(input));
    this.#meshes.set(key, mesh);
    return mesh;
  }

  #wrap(key: string, cx: number, cy: number, cz: number, geometry: ChunkGeometry): VoxelChunkMesh | null {
    const empty = geometry.opaque.indices.length === 0 && geometry.transparent.indices.length === 0 && geometry.collision.indices.length === 0;
    return empty ? null : { key, cx, cy, cz, version: ++this.#meshVersion, ...geometry };
  }

  /** The highest solid lattice point's surface at (x, z), interpolated between it and the air above. */
  smoothHeight(x: number, z: number): number {
    for (let y = this.yMax - 1; y >= this.yMin; y--) {
      const d = densityAtPoint((a, b, c) => this.store.blockAt(a, b, c) & 0xff, x, y, z);
      if (d >= ISO) {
        const above = densityAtPoint((a, b, c) => this.store.blockAt(a, b, c) & 0xff, x, y + 1, z);
        return y + (d - ISO) / Math.max(1e-9, d - above);
      }
    }
    return this.yMin;
  }
}

class VoxelsPluginState {
  readonly chunkSize: number;
  readonly saveEdits: boolean;
  readonly host: VoxelsHost;
  /** Run-level edits, by scene id. */
  readonly edits = new Map<string, SceneEdits>();
  /** Block entities by cell. */
  readonly entities = new Map<string, EntityId>();
  world: World | null = null;
  version = 0;
  /** Scenes whose edits are smooth lattice values (built smooth, or loaded as 5-tuples). */
  readonly smoothScenes = new Set<string>();
  /** Block entities to bring back on the scene's first frame. */
  pendingEntities = false;
  #blocks: BlockTable | undefined;

  constructor(options: VoxelsOptions) {
    this.chunkSize = options.chunkSize;
    this.saveEdits = options.saveEdits;
    this.host = options.host;
  }

  blocks(kernel: Kernel): BlockTable {
    this.#blocks ??= new BlockTable(kernel.project);
    return this.#blocks;
  }

  sceneEdits(scene: string): SceneEdits {
    let edits = this.edits.get(scene);
    if (edits === undefined) this.edits.set(scene, edits = new Map());
    return edits;
  }

  build(kernel: Kernel, scene: SceneDoc | undefined): void {
    const spec = scene === undefined ? undefined : readVoxelSpec(scene, this.blocks(kernel));
    this.world = spec === undefined ? null : new World(this, kernel, scene!, spec, ++this.version);
    if (spec?.mode === 'smooth') this.smoothScenes.add(scene!.id);
  }

  require(kernel: Kernel, what: string): World {
    if (this.world === null) {
      fail('PP3625', `ctx.voxels.${what}: scene "${kernel.scene?.id ?? '?'}" has no "voxels" block`, {
        fix: 'Add a "voxels" block ({"y_range": [min, max], "generator": {...}}) to the scene, or only use ctx.voxels in scenes that have one.',
      });
    }
    return this.world;
  }

  exportEdits(): JsonObject {
    const scenes: Record<string, Json> = {};
    const blocks = this.#blocks;
    for (const [scene, edits] of [...this.edits].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      const cells = exportEdits(edits, this.chunkSize);
      if (cells.length === 0) continue;
      const id = (block: number): string | null => (block === AIR ? null : blocks!.type(block).id);
      // Smooth scenes: [x, y, z, material | null, density].
      scenes[scene] = this.smoothScenes.has(scene)
        ? cells.map(([x, y, z, value]) => [x, y, z, id(value >> 8), value & 0xff])
        : cells.map(([x, y, z, block]) => [x, y, z, id(block)]);
    }
    return { format: EDITS_FORMAT, scenes };
  }

  /** Decode exported edits (all or nothing). */
  decodeEdits(kernel: Kernel, data: Json): Map<string, SceneEdits> {
    const bad = (message: string): never => fail('PP3628', `Saved voxel edits: ${message}`, {
      fix: 'Saved edits come from exportEdits(): {"format": 1, "scenes": {"<scene>": [[x, y, z, "<block>" | null], ...]}} (smooth scenes add a density: [x, y, z, "<block>" | null, 0..255]).',
    });
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return bad('not an object');
    const obj = data as JsonObject;
    if (obj['format'] !== EDITS_FORMAT) return bad(`format ${JSON.stringify(obj['format'] ?? null)} is not ${EDITS_FORMAT}`);
    const scenes = obj['scenes'];
    if (typeof scenes !== 'object' || scenes === null || Array.isArray(scenes)) return bad('"scenes" is not an object');
    const table = this.blocks(kernel);
    const out = new Map<string, SceneEdits>();
    const smoothScenes = new Set<string>();
    for (const [scene, cells] of Object.entries(scenes)) {
      if (!Array.isArray(cells)) return bad(`scene "${scene}" is not a list`);
      const edits: SceneEdits = new Map();
      for (const cell of cells) {
        // Block worlds: [x, y, z, block | null]; smooth worlds: [x, y, z, material | null, density 0..255].
        const smooth = Array.isArray(cell) && cell.length === 5;
        if (!Array.isArray(cell) || (cell.length !== 4 && !smooth) || !cell.slice(0, 3).every((n) => Number.isInteger(n))) {
          return bad(`${JSON.stringify(cell)} in scene "${scene}" is not [x, y, z, block] or [x, y, z, material, density]`);
        }
        const id = cell[3];
        if (id !== null && typeof id !== 'string') return bad(`block ${JSON.stringify(id)} is not a block id or null`);
        const block = id === null ? AIR : table.lookup(id);
        if (block === undefined) return bad(`scene "${scene}" names block "${id}", which this project doesn't have`);
        let value = block;
        if (smooth) {
          const density = cell[4];
          if (typeof density !== 'number' || !Number.isInteger(density) || density < 0 || density > 255 || block > 255) {
            return bad(`${JSON.stringify(cell)} in scene "${scene}": density must be a whole number 0..255 (and the material one of the first 255 blocks)`);
          }
          value = pack(block, density);
          smoothScenes.add(scene);
        }
        addEdit(edits, this.chunkSize, cell[0] as number, cell[1] as number, cell[2] as number, value);
      }
      out.set(scene, edits);
    }
    for (const scene of smoothScenes) this.smoothScenes.add(scene);
    return out;
  }

  /**
   * Replace every scene's edits (a loaded save; undefined: the save has none). Block
   * entities whose cell no longer holds their block are destroyed; edited prefab blocks
   * without an entity get a fresh one at the start of the next frame.
   */
  loadEdits(kernel: Kernel, data: Json | undefined): void {
    const decoded = data === undefined ? new Map<string, SceneEdits>() : this.decodeEdits(kernel, data);
    this.edits.clear();
    for (const [scene, edits] of decoded) this.edits.set(scene, edits);
    this.build(kernel, kernel.scene);
    const world = this.world;
    for (const [key, id] of [...this.entities]) {
      const [x, y, z] = key.split(',').map(Number) as [number, number, number];
      const block = world === null ? AIR : world.store.blockAt(x, y, z);
      const prefab = block === AIR ? null : this.blocks(kernel).type(block).prefab;
      if (prefab !== kernel.world.get(id)?.prefab) {
        this.entities.delete(key);
        kernel.destroy(id);
      }
    }
    this.pendingEntities = world !== null;
  }

  index(record: EntityRecord): void {
    const fields = record.components.get(VOXEL_BLOCK);
    if (fields === undefined) return;
    const [x, y, z] = cellOf(fields['cell'], `entity ${record.id} voxel_block.cell`);
    this.entities.set(cellKey(x, y, z), record.id);
  }

  unindex(record: EntityRecord): void {
    for (const [key, id] of this.entities) if (id === record.id) this.entities.delete(key);
  }
}

export function voxels(options: VoxelsOptions): VoxelsPlugin {
  if (!Number.isInteger(options.chunkSize) || options.chunkSize < 4 || options.chunkSize > 64) {
    fail('PP3629', `voxels(chunk_size=${options.chunkSize}): chunk_size must be a whole number from 4 to 64`, { fix: 'Use the default, 16.' });
  }
  const state = new VoxelsPluginState(options);
  let installed: Kernel | undefined;
  let sectionRegistered = false;
  const kernelOf = (): Kernel => installed!;

  const spawnBlockEntity = (kernel: Kernel, x: number, y: number, z: number, block: number): void => {
    const prefab = state.blocks(kernel).type(block).prefab;
    if (prefab === null) return;
    // `observeEntities.added` indexes it under its cell.
    kernel.spawn(prefab, { at: [x + 0.5, y, z + 0.5] }, { components: { [VOXEL_BLOCK]: { cell: new Cell3(x, y, z) } } });
  };

  const engine: VoxelsEngine = {
    get(x, y, z) {
      const block = state.require(kernelOf(), 'get').blockAt(x, y, z);
      return block === AIR ? null : state.blocks(kernelOf()).type(block).id;
    },
    set(x, y, z, id, by) {
      const kernel = kernelOf();
      const world = state.require(kernel, 'set');
      const block = id === null ? AIR : state.blocks(kernel).index(id, 'ctx.voxels.set');
      if (world.mode === 'smooth') {
        const before = world.blockAt(x, y, z);
        world.store.setBlock(x, y, z, block === AIR ? pack(world.store.blockAt(x, y, z) >> 8, 0) : pack(block, 255));
        if (before === block) return;
        const ref = (b: number): unknown => (b === AIR ? null : state.host.block(kernel, state.blocks(kernel).type(b).id));
        kernel.emit(BLOCK_CHANGED, { cell: new Cell3(x, y, z), old: ref(before), new: ref(block), source: by ?? null });
        return;
      }
      const old = world.store.setBlock(x, y, z, block);
      if (old === block) return;
      const key = cellKey(x, y, z);
      const holder = state.entities.get(key);
      if (holder !== undefined) {
        state.entities.delete(key);
        kernel.destroy(holder);
      }
      if (block !== AIR) spawnBlockEntity(kernel, x, y, z, block);
      const ref = (b: number): unknown => (b === AIR ? null : state.host.block(kernel, state.blocks(kernel).type(b).id));
      kernel.emit(BLOCK_CHANGED, { cell: new Cell3(x, y, z), old: ref(old), new: ref(block), source: by ?? null });
    },
    blockEntity(x, y, z) {
      const kernel = kernelOf();
      state.require(kernel, 'block_entity');
      const id = state.entities.get(cellKey(x, y, z));
      return id !== undefined && kernel.world.isAlive(id) ? id : undefined;
    },
    surfaceHeight(x, z) {
      const world = state.require(kernelOf(), 'surface_height');
      if (world.mode === 'blocks') return world.store.surfaceHeight(x, z);
      for (let y = world.yMax - 1; y >= world.yMin; y--) if (world.blockAt(x, y, z) !== AIR) return y + 1;
      return world.yMin;
    },
    raycast(origin, direction, maxDistance) {
      const world = state.require(kernelOf(), 'raycast');
      const length = direction.length();
      if (!(length > 0) || !Number.isFinite(length)) {
        fail('PP3629', 'ctx.voxels.raycast(): direction must be a non-zero vector', { fix: 'Pass a direction such as (target - origin).normalized().' });
      }
      if (!(maxDistance >= 0) || !Number.isFinite(maxDistance)) {
        fail('PP3629', `ctx.voxels.raycast(): max_distance must be a finite number >= 0, got ${maxDistance}`);
      }
      const dx = direction.x / length;
      const dy = direction.y / length;
      const dz = direction.z / length;
      if (world.mode === 'blocks') return world.store.raycast(origin.x, origin.y, origin.z, dx, dy, dz, maxDistance);
      return smoothRaycast(world, origin, [dx, dy, dz], maxDistance);
    },
    blockId(index) {
      return state.blocks(kernelOf()).type(index).id;
    },
    carve(mode, center, radius, strength, id) {
      const kernel = kernelOf();
      const world = state.require(kernel, mode);
      if (world.mode !== 'smooth') {
        fail('PP3629', `ctx.voxels.${mode}(): scene "${world.scene}" is a block world; dig and fill shape smooth worlds`, {
          fix: 'Set "mode": "smooth" in the scene\'s "voxels" block, or edit blocks with ctx.voxels.set.',
        });
      }
      if (!(radius > 0) || !Number.isFinite(radius) || radius > 64) fail('PP3629', `ctx.voxels.${mode}(): radius must be above 0 and at most 64, got ${radius}`);
      if (!(strength > 0 && strength <= 1)) fail('PP3629', `ctx.voxels.${mode}(): strength must be in (0, 1], got ${strength}`);
      const material = id === null ? AIR : state.blocks(kernel).index(id, `ctx.voxels.${mode}`);
      const changed = brush(
        (x, y, z) => world.store.blockAt(x, y, z), (x, y, z, v) => { world.store.setBlock(x, y, z, v); },
        [center.x, center.y, center.z], radius, strength, mode, material, world.yMin, world.yMax,
      );
      const out = new Map<string, number>();
      for (const [block, amount] of [...changed].sort((a, b) => a[0] - b[0])) if (block !== AIR) out.set(state.blocks(kernel).type(block).id, amount);
      return out;
    },
    densityAt(point) {
      return state.require(kernelOf(), 'density_at').densityAt(point.x, point.y, point.z);
    },
    heightAt(x, z) {
      const world = state.require(kernelOf(), 'height_at');
      return world.mode === 'smooth' ? world.smoothHeight(x, z) : world.store.surfaceHeight(Math.floor(x), Math.floor(z));
    },
    mode() { return state.require(kernelOf(), 'mode').mode; },
  };

  const voxelBlock: ComponentDef = { id: VOXEL_BLOCK, schema: VOXEL_BLOCK_SCHEMA };

  return {
    id: 'voxels',
    engine,
    components: [voxelBlock],
    events: [BLOCK_CHANGED],
    install(kernel) {
      if (installed !== undefined) {
        fail('PP3621', 'This voxels plugin is already installed in another kernel', { fix: 'Call voxels() once per game.' });
      }
      installed = kernel;
      kernel.provide(VOXELS_SERVICE, { current: () => state.world });
      kernel.observeScenes({
        loading: (scene, request) => {
          // The save service may install after this plugin: register at first use.
          if (state.saveEdits && !sectionRegistered) {
            sectionRegistered = true;
            kernel.tryService(SAVE_SERVICE)?.register({
              key: 'voxels',
              save: () => state.exportEdits(),
              load: (data) => state.loadEdits(kernel, data),
            });
          }
          if (request.newRun === true) state.edits.clear();
          state.entities.clear();
          state.build(kernel, scene);
          state.pendingEntities = state.world !== null && (state.edits.get(scene.id)?.size ?? 0) > 0;
        },
      });
      kernel.observeEntities({
        added: (records) => { for (const record of records) state.index(record); },
        removed: (records) => { for (const record of records) state.unindex(record); },
        changed: (record) => { state.unindex(record); state.index(record); },
      });
      kernel.addHook('input', () => {
        if (!state.pendingEntities || state.world === null) return;
        state.pendingEntities = false;
        const world = state.world;
        for (const [x, y, z, block] of world.store.edits()) {
          if (block !== AIR && !state.entities.has(cellKey(x, y, z))) spawnBlockEntity(kernel, x, y, z, block);
        }
      });
    },
    snapshot: (): Json => ({ edits: state.exportEdits(), pending: state.pendingEntities }),
    restore(kernel, saved) {
      const obj = saved as JsonObject;
      const decoded = state.decodeEdits(kernel, obj['edits'] ?? null);
      state.edits.clear();
      for (const [scene, edits] of decoded) state.edits.set(scene, edits);
      state.pendingEntities = obj['pending'] === true;
      state.entities.clear();
      for (const record of kernel.world.live()) if (record.components.has(VOXEL_BLOCK)) state.index(record);
      state.build(kernel, kernel.scene);
    },
  };
}

/**
 * The first solid crossing along a ray in a smooth world: march in quarter-meter steps on
 * the trilinear density, then bisect to the surface. The hit `cell` is the nearest solid
 * lattice point, `face` the axis of the surface normal closest to it, `block` its material.
 */
function smoothRaycast(world: World, origin: Vec3, dir: readonly [number, number, number], maxDistance: number): RayHit | undefined {
  const sample = (t: number): number => world.densityAt(origin.x + dir[0] * t, origin.y + dir[1] * t, origin.z + dir[2] * t);
  const step = 0.25;
  const solid = ISO / 255;
  let prev = 0;
  if (sample(0) < solid) {
    let t = step;
    for (; t <= maxDistance + 1e-9; t += step) {
      if (sample(Math.min(t, maxDistance)) >= solid) break;
      prev = t;
    }
    if (t > maxDistance + 1e-9) return undefined;
    let lo = prev;
    let hi = Math.min(t, maxDistance);
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (sample(mid) >= solid) hi = mid;
      else lo = mid;
    }
    prev = hi;
  }
  const t = prev;
  const p: [number, number, number] = [origin.x + dir[0] * t, origin.y + dir[1] * t, origin.z + dir[2] * t];
  // Normal: the negated density gradient at the hit.
  const e = 0.25;
  const g = [0, 1, 2].map((k) => {
    const a = [...p];
    const b = [...p];
    a[k]! += e;
    b[k]! -= e;
    return world.densityAt(b[0]!, b[1]!, b[2]!) - world.densityAt(a[0]!, a[1]!, a[2]!);
  });
  const axis = Math.abs(g[0]!) >= Math.abs(g[1]!) && Math.abs(g[0]!) >= Math.abs(g[2]!) ? 0 : Math.abs(g[1]!) >= Math.abs(g[2]!) ? 1 : 2;
  const face: [number, number, number] = [0, 0, 0];
  face[axis] = Math.sign(g[axis]!) || 1;
  // The nearest solid lattice point to the hit.
  let best: [number, number, number] | undefined;
  let bestD = Infinity;
  for (let c = 0; c < 8; c++) {
    const q: [number, number, number] = [Math.floor(p[0]) + (c & 1), Math.floor(p[1]) + ((c >> 1) & 1), Math.floor(p[2]) + ((c >> 2) & 1)];
    if (world.blockAt(q[0], q[1], q[2]) === AIR) continue;
    const d = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    if (d < bestD) {
      bestD = d;
      best = q;
    }
  }
  if (best === undefined) return undefined;
  return { x: best[0], y: best[1], z: best[2], face, block: world.blockAt(best[0], best[1], best[2]), distance: t };
}
