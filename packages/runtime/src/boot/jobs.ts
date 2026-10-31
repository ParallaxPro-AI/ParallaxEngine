/**
 * The engine's jobs: the pure functions that already exist in the resource layer and the
 * plugins, wrapped as `JobDef`s over structured-cloneable inputs. Boot builds the runner
 * (workers in a browser, inline headless) over this table and provides it to the kernel as
 * `JOBS_SERVICE`; the worker entry (`job_worker.ts`) serves the same table, so a job gives
 * the same result wherever it runs.
 *
 *   model.parse    a model document (`*.model.json`) → `ParsedModel`
 *   gltf.build     a glTF's JSON and its buffers → `ModelAsset` (accessors, skins, clips)
 *   voxels.mesh    one chunk and its 26 neighbours → greedy-meshed `ChunkGeometry` (block worlds)
 *   voxels.march   the same neighbourhood of a smooth world → its marched surface
 *   terrain.bake   a scene's `TerrainSpec` → its `TerrainBake` (heights, normals, splats: data
 *                  only); the main thread wraps it with `fieldOf(bake, scene, version)`
 *   terrain.tile   one streamed CDLOD tile: the authored relief and splat at its vertices
 *   nav.paths      a nav `bake` (one area, one agent radius) and path requests → each path,
 *                  in request order (the same search the main thread runs: nav `findPath`)
 *   city.chunk     a city spec, its street level, a chunk and a level of detail → that chunk's
 *                  surfaces (the plan is rebuilt from the spec once per worker and cached)
 *
 * Every output's typed arrays are transferred back, never copied.
 */

import { jobKey } from '../core/index.js';
import type { JobDef, JobKey } from '../core/index.js';
import type { ParsedModel } from '../resource/index.js';
import { parseModelDocument } from '../resource/index.js';
import { buildModel } from '../resource/index.js';
import type { ModelAsset } from '../resource/index.js';
import { GLTF_BUILD, MODEL_PARSE } from '../function/plugins/models/index.js';
import type { GltfBuildInput } from '../function/plugins/models/index.js';
import { marchChunk, meshChunk, VOXELS_MARCH, VOXELS_MESH } from '../function/plugins/voxels/index.js';
import type { ChunkGeometry, ChunkNeighbourhood } from '../function/plugins/voxels/index.js';
import { bakeSplatMap, bakeTerrain, bakeTileRelief, TERRAIN_BAKE, TERRAIN_SPLAT_MAP, TERRAIN_TILE } from '../function/plugins/terrain/index.js';
import type { SplatMap, SplatMapInput, TerrainBake, TerrainSpec, TileJobInput, TileJobOutput } from '../function/plugins/terrain/index.js';
import { findPaths, NAV_PATHS } from '../function/plugins/nav/index.js';
import { buildChunkJob, CITY_CHUNK } from '../function/plugins/city/index.js';
import type { CityChunkGeometry, CityChunkInput } from '../function/plugins/city/index.js';
import type { NavPath, NavPathsInput } from '../function/plugins/nav/index.js';
import { jobTable } from '../platform/index.js';

/** The model jobs' keys are the models plugin's (it runs them); re-exported for the job table's users. */
export { GLTF_BUILD, MODEL_PARSE };
export type { GltfBuildInput };

/** One chunk to mesh: the store's shape, the block table, and the 27 chunks around it (the voxels plugin's `ChunkNeighbourhood`). */
export type VoxelMeshInput = ChunkNeighbourhood;
export type VoxelMeshOutput = ChunkGeometry;
export { VOXELS_MARCH, VOXELS_MESH };

export { NAV_PATHS };
export type { NavPath, NavPathsInput };

export { TERRAIN_BAKE, TERRAIN_SPLAT_MAP, TERRAIN_TILE };

/** Every typed array's buffer in a value (outputs move back without a copy). */
export function buffersOf(value: unknown, out: ArrayBufferLike[] = [], seen = new Set<object>()): ArrayBufferLike[] {
  if (typeof value !== 'object' || value === null || seen.has(value)) return out;
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    out.push(value.buffer);
    return out;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) buffersOf(child, out, seen);
  return out;
}

const movedBack = (output: unknown): ArrayBuffer[] => buffersOf(output).filter((b): b is ArrayBuffer => b instanceof ArrayBuffer);

export const ENGINE_JOB_DEFS: readonly JobDef<never, unknown>[] = [
  { key: MODEL_PARSE, run: ({ path, text }) => parseModelDocument(path, text), transfer: movedBack } satisfies JobDef<{ path: string; text: string }, ParsedModel>,
  { key: GLTF_BUILD, run: ({ path, json, buffers }) => buildModel(path, json, buffers), transfer: movedBack } satisfies JobDef<GltfBuildInput, ModelAsset>,
  { key: VOXELS_MESH, run: meshChunk, transfer: movedBack } satisfies JobDef<VoxelMeshInput, VoxelMeshOutput>,
  { key: VOXELS_MARCH, run: marchChunk, transfer: movedBack } satisfies JobDef<VoxelMeshInput, VoxelMeshOutput>,
  { key: NAV_PATHS, run: findPaths } satisfies JobDef<NavPathsInput, NavPath[]>,
  { key: TERRAIN_BAKE, run: (spec) => bakeTerrain(spec), transfer: movedBack } satisfies JobDef<TerrainSpec, TerrainBake>,
  { key: TERRAIN_TILE, run: (input) => bakeTileRelief(input), transfer: movedBack } satisfies JobDef<TileJobInput, TileJobOutput>,
  { key: TERRAIN_SPLAT_MAP, run: (input) => bakeSplatMap(input), transfer: movedBack } satisfies JobDef<SplatMapInput, SplatMap>,
  { key: CITY_CHUNK, run: buildChunkJob, transfer: movedBack } satisfies JobDef<CityChunkInput, CityChunkGeometry>,
] as unknown as readonly JobDef<never, unknown>[];

export const ENGINE_JOBS = jobTable(ENGINE_JOB_DEFS);
