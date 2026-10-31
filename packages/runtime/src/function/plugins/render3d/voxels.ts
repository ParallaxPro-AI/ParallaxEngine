/**
 * The scene's block world (voxels service) as mesh draws. Every chunk `active()` returns
 * is drawn: its opaque surface as opaque meshes (in the shadow map), its transparent
 * surface as blended meshes the surface draws after every opaque one, sorted far to
 * near by chunk. One geometry per (chunk, block type, surface), placed by an instance
 * matrix at the chunk's center so blended chunks sort by where they are. Geometry is
 * rebuilt only when a chunk's mesh `version` changes, dropped when the chunk leaves the
 * active set, and all of it when the world is rebuilt (scene load, restore, loaded edits).
 *
 * Faces are the service's: counter-clockwise front faces, back faces culled.
 *
 * Texturing. A block type with a `texture` draws it repeating once per block (REPEAT
 * wrapping, nearest filtering for crisp block art). Texture coordinates are taken from
 * the world position on the face's plane — side faces upright (v runs down the block,
 * glTF's v-down convention) and u to the right as seen from outside — rather than the
 * service's `uvs`, whose axes follow the mesher's sweep and would turn some side textures
 * on their sides; both repeat once per block. A block type with per-face textures
 * (`textureTop` / `textureBottom`) draws its faces as up to three meshes per chunk: those
 * facing up (normal y > 0.5, averaged over the triangle: smooth worlds' slopes too) with
 * the top texture, those facing down with the bottom one, the rest with `texture`.
 *
 * Colors. The SDK's BlockDef has no color field, so an untextured block type is drawn in
 * a fallback color derived from its content id alone (`blockColor`): stable across runs,
 * machines and the order blocks are declared in. A transparent untextured block is drawn
 * at alpha 0.6 in that color.
 */

import type { Geometry3d, Material3d, MeshBatch, Rgba, Texture3d } from '../../../core/index.js';
import type { VoxelBlockType, VoxelChunkMesh, VoxelSurface, VoxelWorldView } from '../../services/index.js';

/** Alpha of a transparent block type drawn without a texture. */
export const UNTEXTURED_TRANSPARENT_ALPHA = 0.6;

/**
 * The fallback color of an untextured block type: a hue from the FNV-1a hash of its id,
 * at fixed saturation 0.45 and lightness 0.55 (sRGB, as authored colors are).
 */
export function blockColor(id: string): readonly [number, number, number] {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  const h = (hash % 360) / 60;
  const s = 0.45;
  const l = 0.55;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
  return [r + m, g + m, b + m];
}

/** u, v of a world point on a face with this (axis-aligned) normal: once per block, side faces upright. */
function faceUv(nx: number, ny: number, nz: number, x: number, y: number, z: number): [number, number] {
  if (ny > 0.5) return [x, z];
  if (ny < -0.5) return [x, -z];
  if (nx > 0.5) return [z, -y];
  if (nx < -0.5) return [-z, -y];
  if (nz > 0.5) return [-x, -y];
  return [x, -y];
}

interface ChunkDraws {
  readonly version: number;
  readonly draws: readonly MeshBatch[];
}

export class VoxelDraws {
  #world: { readonly version: number; readonly scene: string } | null = null;
  readonly #chunks = new Map<string, ChunkDraws>();
  readonly #materials = new Map<string, Material3d>();

  /** This frame's chunk draws (an empty list without a block world). */
  draws(view: VoxelWorldView | null, texture: (path: string) => Texture3d): MeshBatch[] {
    if (view === null || this.#world?.version !== view.version || this.#world.scene !== view.scene) {
      this.#chunks.clear();
      this.#materials.clear();
      this.#world = view === null ? null : { version: view.version, scene: view.scene };
    }
    if (view === null) return [];
    const blocks = view.blocks();
    const seen = new Set<string>();
    const out: MeshBatch[] = [];
    for (const chunk of view.active()) {
      seen.add(chunk.key);
      let built = this.#chunks.get(chunk.key);
      if (built?.version !== chunk.version) {
        built = { version: chunk.version, draws: this.#build(view, chunk, blocks, texture) };
        this.#chunks.set(chunk.key, built);
      }
      out.push(...built.draws);
    }
    for (const key of [...this.#chunks.keys()]) if (!seen.has(key)) this.#chunks.delete(key);
    return out;
  }

  #build(view: VoxelWorldView, chunk: VoxelChunkMesh, blocks: readonly (VoxelBlockType | undefined)[], texture: (path: string) => Texture3d): MeshBatch[] {
    const half = view.chunkSize / 2;
    const center: [number, number, number] = [chunk.cx * view.chunkSize + half, chunk.cy * view.chunkSize + half, chunk.cz * view.chunkSize + half];
    const instances = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, center[0], center[1], center[2], 1, 1, 1, 1, 1]);
    const out: MeshBatch[] = [];
    for (const [pass, surface] of [['opaque', chunk.opaque], ['transparent', chunk.transparent]] as const) {
      for (const [block, all] of byBlock(surface)) {
        const type = blocks[block];
        if (type === undefined) continue;
        for (const [face, triangles] of byFace(type, surface, all)) {
          const geometry = surfaceGeometry(`voxels:${view.scene}:${view.version}:${chunk.key}:${chunk.version}:${type.id}:${pass}${face === 'all' ? '' : `:${face}`}`, surface, triangles, center);
          out.push({
            geometry,
            material: this.#material(type, faceTexture(type, face), pass === 'transparent', texture),
            count: 1,
            instances,
            entities: [null],
            castShadows: pass === 'opaque',
          });
        }
      }
    }
    return out;
  }

  #material(type: VoxelBlockType, path: string | null, blend: boolean, texture: (path: string) => Texture3d): Material3d {
    const key = `voxel|${type.id}|${blend ? 'blend' : 'opaque'}${path === type.texture ? '' : `|${path}`}`;
    let material = this.#materials.get(key);
    if (material === undefined) {
      const [r, g, b] = blockColor(type.id);
      const color: Rgba = path !== null ? [1, 1, 1, 1] : [r, g, b, blend ? UNTEXTURED_TRANSPARENT_ALPHA : 1];
      material = {
        id: key,
        baseColor: color,
        baseColorTexture: path === null ? null : texture(path),
        metallic: 0,
        roughness: 0.9,
        metallicRoughnessTexture: null,
        emissive: [0, 0, 0],
        emissiveTexture: null,
        alphaMode: blend ? 'blend' : 'opaque',
        alphaCutoff: 0.5,
        doubleSided: false,
        unlit: false,
      };
      this.#materials.set(key, material);
    }
    return material;
  }
}

type Face = 'all' | 'side' | 'top' | 'bottom';

/** The texture a face group draws (`all` and `side`: the block's `texture`). */
function faceTexture(type: VoxelBlockType, face: Face): string | null {
  if (face === 'top') return type.textureTop ?? type.texture;
  if (face === 'bottom') return type.textureBottom ?? type.texture;
  return type.texture;
}

/**
 * A block's triangles by face: one `all` group for a block with one texture; else side,
 * top and bottom groups (each only when it has triangles), by the triangle's mean normal y.
 */
function byFace(type: VoxelBlockType, surface: VoxelSurface, triangles: readonly number[]): [Face, readonly number[]][] {
  if (type.textureTop === undefined && type.textureBottom === undefined) return [['all', triangles]];
  const groups: Record<'side' | 'top' | 'bottom', number[]> = { side: [], top: [], bottom: [] };
  for (const t of triangles) {
    const ny = (surface.normals[surface.indices[t]! * 3 + 1]! + surface.normals[surface.indices[t + 1]! * 3 + 1]!
      + surface.normals[surface.indices[t + 2]! * 3 + 1]!) / 3;
    groups[ny > 0.5 ? 'top' : ny < -0.5 ? 'bottom' : 'side'].push(t);
  }
  return (['side', 'top', 'bottom'] as const).filter((f) => groups[f].length > 0).map((f) => [f, groups[f]]);
}

/** Triangle indices (into `indices`, step 3) grouped by the block of their first vertex, in first-seen order. */
function byBlock(surface: VoxelSurface): Map<number, number[]> {
  const groups = new Map<number, number[]>();
  for (let t = 0; t < surface.indices.length; t += 3) {
    const block = surface.blocks[surface.indices[t]!]!;
    let list = groups.get(block);
    if (list === undefined) {
      list = [];
      groups.set(block, list);
    }
    list.push(t);
  }
  return groups;
}

function surfaceGeometry(id: string, surface: VoxelSurface, triangles: readonly number[], center: readonly number[]): Geometry3d {
  const remap = new Map<number, number>();
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const t of triangles) {
    for (let c = 0; c < 3; c++) {
      const v = surface.indices[t + c]!;
      let at = remap.get(v);
      if (at === undefined) {
        at = positions.length / 3;
        remap.set(v, at);
        const x = surface.positions[v * 3]!;
        const y = surface.positions[v * 3 + 1]!;
        const z = surface.positions[v * 3 + 2]!;
        const nx = surface.normals[v * 3]!;
        const ny = surface.normals[v * 3 + 1]!;
        const nz = surface.normals[v * 3 + 2]!;
        const local = [x - center[0]!, y - center[1]!, z - center[2]!];
        positions.push(local[0]!, local[1]!, local[2]!);
        normals.push(nx, ny, nz);
        uvs.push(...faceUv(nx, ny, nz, x, y, z));
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k]!, local[k]!);
          max[k] = Math.max(max[k]!, local[k]!);
        }
      }
      indices.push(at);
    }
  }
  return {
    id,
    positions: new Float32Array(positions),
    normals: new Float32Array(normals),
    uvs: new Float32Array(uvs),
    indices: positions.length / 3 <= 0xffff ? new Uint16Array(indices) : new Uint32Array(indices),
    joints: null,
    weights: null,
    colors: null,
    min: [min[0]!, min[1]!, min[2]!],
    max: [max[0]!, max[1]!, max[2]!],
  };
}
