/**
 * The `voxels` service: the current scene's block world as other plugins use it, provided
 * by the voxels plugin (`kernel.service(VOXELS_SERVICE).current()`). Consumers: render3d
 * draws the chunk meshes, physics3d builds a fixed collider per chunk from their collision
 * triangles; slot saves hold the player's edits (the plugin registers a "voxels" section
 * with the save service).
 *
 * Coordinates. Block (x, y, z) fills [x, x+1) × [y, y+1) × [z, z+1) in world meters. The
 * world is chunked in cubes of `chunkSize` blocks; chunk (cx, cy, cz) holds blocks
 * [cx·size, (cx+1)·size) on each axis. Only y in [yMin, yMax) holds blocks; everything
 * outside is air. Columns extend without bound along x and z (generated on demand).
 *
 * Meshes. `active()` returns the chunks around the streaming sources (the core streaming
 * service's `sources()`: each camera, the entities cameras follow, and player-owned
 * entities), within the scene's
 * `render_distance` (in chunks, a square in x/z, every y) or a smaller `radius` the caller
 * asks for, in (cx, cz, cy) order. A chunk with no visible faces and no collision faces
 * is left out. Each mesh is rebuilt only when a block in or next to it changes; `version`
 * increases with every rebuild, so a consumer keeps its GPU buffers or collider while
 * `key` and `version` are unchanged. The same mesh object is returned until then.
 *
 * Surfaces are greedy-meshed quads in world space, two triangles each, counter-clockwise
 * seen from outside (front faces follow the normal). Faces between two drawn opaque blocks
 * and between two blocks of the same transparent type are not emitted. Blocks with
 * `prefabRenders` are drawn by their prefab's entity, never as faces. `uvs` are in block
 * units across the merged quad (0..width, 0..height): a texture repeats once per block
 * with REPEAT wrapping. `blocks` gives each vertex's block index into `blocks()` (all four
 * vertices of a quad share it) to pick the texture.
 *
 * Collision is a separate set of greedy quads: every face of a solid block whose
 * neighbour is not solid, merged regardless of block type, as an indexed triangle list
 * in world space — suitable for a fixed trimesh collider.
 *
 * Smooth worlds (`mode` "smooth"): the world is a density lattice, and chunk meshes are its
 * marched surface — smooth triangles with interpolated normals, no transparent surface,
 * `collision` the same triangles as `opaque`. Lattice point (x, y, z) is the sample at that
 * integer point (not a cube); `blockAt` is its material when solid (density >= 128/255),
 * else 0; `densityAt` interpolates. `uvs` are world (x, z); renderers project textures by
 * the normal (render3d's planar projection per vertex).
 *
 * Lifetime. A world is built when a scene with a `"voxels"` block loads, and again after
 * a snapshot restore or `loadEdits` (`version` increases; every mesh key is rebuilt).
 * `current()` is null in scenes without one.
 */

import type { Json } from '../../resource/index.js';
import { serviceKey } from '../kernel/index.js';
import type { ServiceKey } from '../kernel/index.js';

/** A block type: a `block` content entry's engine-facing fields (sdk/parallax/voxels.pyi BlockDef). */
export interface VoxelBlockType {
  /** 1..n, in content id order (0 is air). */
  readonly index: number;
  readonly id: string;
  /** Project-relative texture path (every face, or the side faces when `top`/`bottom` are given), or null when the entry names none. */
  readonly texture: string | null;
  /** Per-face textures (`"texture": {"side": ..., "top": ..., "bottom": ...}`): the +y and -y faces'. Absent: `texture`. */
  readonly textureTop?: string;
  readonly textureBottom?: string;
  readonly hardness: number;
  readonly solid: boolean;
  readonly transparent: boolean;
  /** Emitted light, 0 for none. */
  readonly light: number;
  /** Prefab spawned for every placed block of this type (it carries `voxel_block`). */
  readonly prefab: string | null;
  /** Drawn by its prefab: no voxel faces. */
  readonly prefabRenders: boolean;
}

export interface VoxelSurface {
  /** x, y, z per vertex, world space. */
  readonly positions: Float32Array;
  /** Unit face normal per vertex. */
  readonly normals: Float32Array;
  /** u, v per vertex in block units (texture repeats per block). */
  readonly uvs: Float32Array;
  /** Block index per vertex (see `VoxelWorldView.blocks`). */
  readonly blocks: Uint16Array;
  /** Three vertex indices per triangle. */
  readonly indices: Uint32Array;
}

export interface VoxelChunkMesh {
  /** `"cx,cy,cz"`. */
  readonly key: string;
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  /** Increases with every rebuild of this chunk's mesh. */
  readonly version: number;
  /** Faces of opaque blocks. */
  readonly opaque: VoxelSurface;
  /** Faces of transparent blocks (draw after the opaque pass, blended). */
  readonly transparent: VoxelSurface;
  /** Solid faces next to non-solid blocks, world space. */
  readonly collision: { readonly vertices: Float32Array; readonly indices: Uint32Array };
}

export interface VoxelWorldView {
  /** Increases with every build (scene load, restore, loadEdits). */
  readonly version: number;
  /** The scene the world belongs to. */
  readonly scene: string;
  readonly chunkSize: number;
  /** Blocks exist for yMin <= y < yMax. */
  readonly yMin: number;
  readonly yMax: number;
  /** In chunks (the scene's `render_distance`). */
  readonly renderDistance: number;
  readonly mode: 'blocks' | 'smooth';
  /** Index 0 is air (undefined); see `VoxelBlockType.index`. */
  blocks(): readonly (VoxelBlockType | undefined)[];
  /** Block index at a cell (0: air). */
  blockAt(x: number, y: number, z: number): number;
  /** Whether the block at a cell stops bodies. */
  isSolid(x: number, y: number, z: number): boolean;
  /** 0..1 at a world point: trilinear over the lattice (smooth), 0 or 1 by cell (blocks). */
  densityAt(x: number, y: number, z: number): number;
  /** Meshes of the chunks around the streaming sources; `radius` (chunks) at most `renderDistance`. */
  active(radius?: number): readonly VoxelChunkMesh[];

  /** Whether the game asked for edits to be saved (`voxels(save_edits=True)`). */
  readonly saveEdits: boolean;
  /**
   * The player's edits in every scene this run, as a diff against the generated worlds:
   * `{"format": 1, "scenes": {"<scene>": [[x, y, z, "<block id>" | null], ...]}}`, sorted.
   */
  exportEdits(): Json;
  /**
   * Replace the edits with saved ones (between frames; undefined: none). `block_changed`
   * is not emitted. Block entities whose cell no longer holds their block are destroyed;
   * edited prefab blocks without an entity get a fresh one at the start of the next frame.
   * Bad data is PP3628 and changes nothing. With `saveEdits` the voxels plugin registers
   * this pair as the save service's "voxels" section itself.
   */
  loadEdits(data: Json | undefined): void;
}

export interface VoxelsService {
  /** The current scene's block world, or null when it declares no `"voxels"` block. */
  current(): VoxelWorldView | null;
}

export const VOXELS_SERVICE: ServiceKey<VoxelsService> = serviceKey<VoxelsService>(
  'voxels', 'Add voxels() to Game(plugins=[...]) and a "voxels" block to the scene.',
);
