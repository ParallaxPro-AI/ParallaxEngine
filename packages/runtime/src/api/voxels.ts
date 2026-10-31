/**
 * `parallax.voxels` (sdk/parallax/voxels.pyi): the built-in `block` content kind
 * (`BlockDef`), `BlockHit`, the `VoxelBlock` component and `BlockChanged` event handles,
 * `VoxelsApi` (the type of `ctx.voxels`), `Cell3`, and the `voxels()` plugin factory
 * (`parallax.plugins.voxels`). The block world lives in the voxels plugin; this module
 * binds Python arguments and turns cells and block ids into game-facing values.
 */

import { fail, Vec3 } from '../core/index.js';
import type { Kernel, KernelPlugin } from '../function/kernel/index.js';
import {
  BLOCK_CHANGED, Cell3, VOXEL_BLOCK, VOXEL_BLOCK_SCHEMA, voxels as voxelsPlugin,
} from '../function/plugins/voxels/index.js';
import type { VoxelsEngine } from '../function/plugins/voxels/index.js';
import { ContentRef } from './content.js';
import type { Context } from './context.js';
import { content, declareBuiltIns, record } from './declarations.js';
import { Entity } from './entity.js';
import { eventHandle } from './events.js';
import { componentHandle } from './handles.js';
import { bindArgs, kw } from './kwargs.js';
import { PyDict } from './pyrt/collections.js';
import { field, Localized, PrefabRef, rt } from './types.js';

export { Cell3 } from '../function/plugins/voxels/index.js';

class BlockTexturesFields {
  static readonly __annotations__ = { side: () => rt.str, top: () => rt.optional(rt.str), bottom: () => rt.optional(rt.str) };
  static readonly top = field(null);
  static readonly bottom = field(null);
}
/** A block's textures per face (`BlockDef.texture`): `side`, plus `top` and `bottom` (default: `side`). */
export const BlockTextures = record(BlockTexturesFields);

class BlockDefFields {
  static readonly __annotations__ = {
    name: () => Localized,
    texture: () => rt.union(rt.str, BlockTextures),
    hardness: () => rt.float,
    solid: () => rt.bool,
    transparent: () => rt.bool,
    light: () => rt.float,
    prefab: () => rt.optional(PrefabRef),
    prefab_renders: () => rt.bool,
  };
  static readonly texture = field('', kw({ doc: 'One image path for every face, or per-face textures (top, side, bottom); "" is untextured.' }));
  static readonly hardness = field(1, kw({ doc: 'Relative toughness; break time = hardness / tool power.' }));
  static readonly solid = field(true);
  static readonly transparent = field(false);
  static readonly light = field(0);
  static readonly prefab = field(null);
  static readonly prefab_renders = field(false, kw({ doc: 'The prefab draws the block (no voxel face).' }));
}

/** Built-in content kind: games add content/block/*.json and may extend it (`class Block(BlockDef)`). */
export const BlockDef = declareBuiltIns(() => content('block')(BlockDefFields), 'voxels');

/** `entity.get(VoxelBlock).cell`: on entities spawned for blocks with a prefab. */
export const VoxelBlock = componentHandle({ id: VOXEL_BLOCK, schema: VOXEL_BLOCK_SCHEMA }, 'VoxelBlock');

/** `@on(BlockChanged)`: cell, old, new (ContentRef[BlockDef] or None) and source (Entity or None: `set(..., by=)`). */
export const BlockChanged = eventHandle(BLOCK_CHANGED, 'BlockChanged');

/** What `ctx.voxels.raycast` hit. */
export class BlockHit {
  readonly cell: Cell3;
  /** Unit normal of the face hit. */
  readonly face: Cell3;
  readonly block: ContentRef<unknown>;

  constructor(cell: Cell3, face: Cell3, block: ContentRef<unknown>) {
    this.cell = cell;
    this.face = face;
    this.block = block;
  }

  /** `cell + face` — where a placed block goes. */
  get place_cell(): Cell3 { return this.cell.__add__(this.face); }

  toString(): string { return `BlockHit(${String(this.cell)}, face=${String(this.face)}, ${String(this.block)})`; }
}

function blockRef(kernel: Kernel, id: string): ContentRef<unknown> {
  return (kernel.context as Context).content(BlockDef).get(id);
}

function cellArg(value: unknown, where: string): Cell3 {
  if (value instanceof Cell3) return value;
  return fail('PP3624', `${where} must be a Cell3, got ${value === null || value === undefined ? 'None' : String(value)}`, {
    fix: 'Pass a block cell: Cell3(x, y, z), or ctx.voxels.cell_at(point).',
  });
}

function vec3Arg(value: unknown, where: string): Vec3 {
  if (value instanceof Vec3) return value;
  return fail('PP3624', `${where} must be a Vec3, got ${value === null || value === undefined ? 'None' : String(value)}`);
}

/** `ctx.voxels`: get/set blocks, block entities and the block raycast. */
export class VoxelsApi {
  readonly #kernel: Kernel;
  readonly #engine: VoxelsEngine;

  constructor(kernel: Kernel, engine: VoxelsEngine) {
    this.#kernel = kernel;
    this.#engine = engine;
  }

  /** The block at a cell (a ContentRef of the game's block kind), or None for air. */
  get(...args: unknown[]): ContentRef<unknown> | null {
    const cell = cellArg(bindArgs('get', args, { positional: ['cell'], required: ['cell'] }).args['cell'], 'get() cell');
    const id = this.#engine.get(cell.x, cell.y, cell.z);
    return id === null ? null : blockRef(this.#kernel, id);
  }

  /** `set(cell, block, *, by=None)`; None = air. Emits BlockChanged; spawns/destroys the block entity if any. */
  set(...args: unknown[]): void {
    const a = bindArgs('set', args, { positional: ['cell', 'block'], keyword: ['by'], required: ['cell', 'block'] }).args;
    const cell = cellArg(a['cell'], 'set() cell');
    const block = a['block'];
    let id: string | null = null;
    if (block !== null && block !== undefined) {
      if (!(block instanceof ContentRef) || block.kind !== 'block') {
        fail('PP3624', `set() block must be a block (Content.block.<id>) or None, got ${String(block)}`, {
          fix: 'Pass Content.block.stone, a ContentRef from ctx.content(Block), or None for air.',
        });
      }
      id = block.id;
    }
    const by = a['by'] ?? null;
    if (by !== null && !(by instanceof Entity)) fail('PP3624', `set() by= must be an Entity or None, got ${String(by)}`);
    this.#engine.set(cell.x, cell.y, cell.z, id, by);
  }

  block_entity(...args: unknown[]): Entity | null {
    const cell = cellArg(bindArgs('block_entity', args, { positional: ['cell'], required: ['cell'] }).args['cell'], 'block_entity() cell');
    const id = this.#engine.blockEntity(cell.x, cell.y, cell.z);
    return id === undefined ? null : this.#kernel.handles.wrap(id) as Entity;
  }

  cell_at(...args: unknown[]): Cell3 {
    const point = vec3Arg(bindArgs('cell_at', args, { positional: ['point'], required: ['point'] }).args['point'], 'cell_at() point');
    return new Cell3(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z));
  }

  /** The first block along the ray (solid, or drawn by a prefab) within max_distance, or None. */
  raycast(...args: unknown[]): BlockHit | null {
    const a = bindArgs('raycast', args, { positional: ['origin', 'direction', 'max_distance'], required: ['origin', 'direction'] }).args;
    const origin = vec3Arg(a['origin'], 'raycast() origin');
    const direction = vec3Arg(a['direction'], 'raycast() direction');
    const maxDistance = a['max_distance'] ?? 8;
    if (typeof maxDistance !== 'number') fail('PP3629', `raycast() max_distance must be a number, got ${String(maxDistance)}`);
    const hit = this.#engine.raycast(origin, direction, maxDistance);
    if (hit === undefined) return null;
    return new BlockHit(new Cell3(hit.x, hit.y, hit.z), new Cell3(...hit.face), blockRef(this.#kernel, this.#engine.blockId(hit.block)));
  }

  /** `dig(center, radius, *, strength=1)`: smooth worlds — carve a sphere of air; returns {block id: m³ removed}. */
  dig(...args: unknown[]): PyDict {
    const a = bindArgs('dig', args, { positional: ['center', 'radius'], keyword: ['strength'], required: ['center', 'radius'] }).args;
    return this.#carve('dig', a, null);
  }

  /** `fill(center, radius, block, *, strength=1)`: smooth worlds — add a sphere of `block`; returns {block id: m³ added}. */
  fill(...args: unknown[]): PyDict {
    const a = bindArgs('fill', args, { positional: ['center', 'radius', 'block'], keyword: ['strength'], required: ['center', 'radius', 'block'] }).args;
    const block = a['block'];
    if (!(block instanceof ContentRef) || block.kind !== 'block') {
      fail('PP3624', `fill() block must be a block (Content.block.<id>), got ${String(block)}`, { fix: 'Pass Content.block.stone or a ContentRef from ctx.content(Block).' });
    }
    return this.#carve('fill', a, block.id);
  }

  #carve(mode: 'dig' | 'fill', a: Record<string, unknown>, block: string | null): PyDict {
    const center = vec3Arg(a['center'], `${mode}() center`);
    const radius = a['radius'];
    if (typeof radius !== 'number') fail('PP3629', `${mode}() radius must be a number, got ${String(radius)}`);
    const strength = a['strength'] ?? 1;
    if (typeof strength !== 'number') fail('PP3629', `${mode}() strength must be a number, got ${String(strength)}`);
    return PyDict.from([...this.#engine.carve(mode, center, radius, strength, block)]);
  }

  /** 0..1 at a point: the smooth world's density (blocks: 1 inside a solid block). */
  density_at(...args: unknown[]): number {
    const point = vec3Arg(bindArgs('density_at', args, { positional: ['point'], required: ['point'] }).args['point'], 'density_at() point');
    return this.#engine.densityAt(point);
  }

  /** The ground's height under a point (its y ignored): continuous in smooth worlds, the top of the highest solid block otherwise. */
  height_at(...args: unknown[]): number {
    const point = vec3Arg(bindArgs('height_at', args, { positional: ['point'], required: ['point'] }).args['point'], 'height_at() point');
    return this.#engine.heightAt(point.x, point.z);
  }

  /** "blocks" or "smooth": the current scene's world. */
  get mode(): string { return this.#engine.mode(); }

  /** One above the highest solid block of the column holding a point (its y ignored): where something standing there has its feet. */
  surface_height(...args: unknown[]): number {
    const point = vec3Arg(bindArgs('surface_height', args, { positional: ['point'], required: ['point'] }).args['point'], 'surface_height() point');
    return this.#engine.surfaceHeight(Math.floor(point.x), Math.floor(point.z));
  }
}

/** `parallax.plugins.voxels(*, chunk_size=16, save_edits=True)`. */
export function voxels(...args: unknown[]): KernelPlugin {
  const a = bindArgs('voxels', args, { keyword: ['chunk_size', 'save_edits'] }).args;
  const chunkSize = a['chunk_size'] ?? 16;
  if (typeof chunkSize !== 'number') fail('PP3629', `voxels(chunk_size=...) must be an int, got ${String(chunkSize)}`);
  const saveEdits = a['save_edits'] ?? true;
  if (typeof saveEdits !== 'boolean') fail('PP3629', `voxels(save_edits=...) must be True or False, got ${String(saveEdits)}`);
  const plugin = voxelsPlugin({ chunkSize, saveEdits, host: { block: blockRef } });
  return { ...plugin, namespace: { name: 'voxels', create: (kernel) => new VoxelsApi(kernel, plugin.engine) } };
}
