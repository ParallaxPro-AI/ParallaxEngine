/**
 * The block registry: the project's `block` content entries (sdk/parallax/voxels.pyi
 * `BlockDef`), read once per kernel. Blocks are numbered 1..n in id order; 0 is air. Only
 * the SDK's BlockDef fields are read — games extend the kind with their own fields, which
 * the engine never interprets.
 */

import { closestMatch, fail } from '../../../core/index.js';
import { handleFormProblem } from '../../../resource/index.js';
import type { ContentEntry, Json, JsonObject, Project } from '../../../resource/index.js';
import type { VoxelBlockType } from '../../services/index.js';

export const AIR = 0;

export class BlockTable {
  /** Index 0 is air (undefined); 1..n the entries in id order. */
  readonly types: readonly (VoxelBlockType | undefined)[];
  readonly #byId: ReadonlyMap<string, number>;

  constructor(project: Project) {
    const entries = [...(project.content.get('block')?.values() ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const types: (VoxelBlockType | undefined)[] = [undefined];
    const byId = new Map<string, number>();
    for (const entry of entries) {
      const index = types.length;
      types.push(readBlock(entry, index, project));
      byId.set(entry.id, index);
    }
    this.types = types;
    this.#byId = byId;
  }

  get count(): number { return this.types.length - 1; }

  /** The index of block `id`, or undefined. */
  lookup(id: string): number | undefined { return this.#byId.get(id); }

  ids(): IterableIterator<string> { return this.#byId.keys(); }

  /** The index of block `id`; PP3624 naming the nearest id when there is none. */
  index(id: string, where: string): number {
    const index = this.#byId.get(id);
    if (index === undefined) {
      const guess = closestMatch(id, this.#byId.keys());
      fail('PP3624', `${where}: there is no block "${id}"`, {
        fix: guess !== undefined ? `Did you mean "${guess}"?` : 'Add content/block/<id>.json, or name one of the project\'s blocks.',
      });
    }
    return index;
  }

  type(index: number): VoxelBlockType {
    const type = this.types[index];
    if (type === undefined) fail('PP3624', `Block index ${index} is not a block`);
    return type;
  }

  /** Solid blocks stop bodies and the block raycast. */
  solid(index: number): boolean { return index !== AIR && this.types[index]!.solid; }
}

/** A block's textures per face: `side` (every face unless `top`/`bottom` differ); null: untextured. */
export interface BlockFaces {
  readonly side: string | null;
  readonly top: string | null;
  readonly bottom: string | null;
}

const FACE_KEYS = ['side', 'top', 'bottom'] as const;

/**
 * A BlockDef `texture`: an image handle ("images/<name>") or hosted URL for every face, or `{"side": ..., "top": ..., "bottom": ...}`
 * (`side` required; `top` and `bottom` default to it). Absent or "": untextured. Returns
 * what it must be written as when it is neither (the checker reports the same).
 */
export function readBlockTexture(value: Json | undefined): BlockFaces | string {
  if (value === undefined || value === '') return { side: null, top: null, bottom: null };
  // An image is named by its handle ("images/grass_side"), as every asset is.
  const form = (ref: string): string | undefined => {
    const problem = ref.startsWith('assets/') ? handleFormProblem(ref, 'images') : undefined;
    return problem === undefined ? undefined : `an image handle ("images/<name>"), not the file path "${ref}": write "${problem.handle}"`;
  };
  if (typeof value === 'string') return form(value) ?? { side: value, top: value, bottom: value };
  const expected = 'an image handle string ("images/<name>"), or {"side": image, "top": image, "bottom": image} ("top" and "bottom" optional)';
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return expected;
  const faces = value as JsonObject;
  const unknown = Object.keys(faces).find((k) => !(FACE_KEYS as readonly string[]).includes(k));
  if (unknown !== undefined) return `${expected}; "${unknown}" is not a face (faces: side, top, bottom)`;
  for (const key of FACE_KEYS) {
    const path = faces[key];
    if (path !== undefined && (typeof path !== 'string' || path === '')) return `${expected}; "${key}" must be a non-empty image handle`;
    const problem = typeof path === 'string' ? form(path) : undefined;
    if (problem !== undefined) return `${problem} (the "${key}" face)`;
  }
  const side = faces['side'];
  if (typeof side !== 'string') return `${expected}; "side" is required`;
  const top = faces['top'];
  const bottom = faces['bottom'];
  return { side, top: typeof top === 'string' ? top : side, bottom: typeof bottom === 'string' ? bottom : side };
}

function readBlock(entry: ContentEntry, index: number, project: Project): VoxelBlockType {
  const v = entry.values;
  const bad = (field: string, expected: string): never => fail('PP3622', `content/block/${entry.id}.json: "${field}" must be ${expected}`, {
    path: entry.path, pointer: `/${field}`, fix: `Write "${field}" as ${expected} (sdk/parallax/voxels.pyi BlockDef).`,
  });
  const bool = (field: string, fallback: boolean): boolean => {
    const value: Json | undefined = v[field];
    if (value === undefined) return fallback;
    return typeof value === 'boolean' ? value : bad(field, 'true or false');
  };
  const number = (field: string, fallback: number): number => {
    const value: Json | undefined = v[field];
    if (value === undefined) return fallback;
    return typeof value === 'number' && Number.isFinite(value) ? value : bad(field, 'a number');
  };
  const read = readBlockTexture(v['texture']);
  const faces = typeof read === 'string' ? bad('texture', read) : read;
  const prefab = v['prefab'];
  if (prefab !== undefined && prefab !== null && typeof prefab !== 'string') bad('prefab', 'a prefab id or null');
  if (typeof prefab === 'string' && !project.prefabs.has(prefab)) {
    const guess = closestMatch(prefab, project.prefabs.keys());
    fail('PP3622', `content/block/${entry.id}.json: there is no prefab "${prefab}"`, {
      path: entry.path, pointer: '/prefab', fix: guess !== undefined ? `Did you mean "${guess}"?` : 'Create prefabs/<id>.prefab.json, or remove "prefab".',
    });
  }
  return {
    index,
    id: entry.id,
    texture: faces.side,
    ...(faces.top !== faces.side && faces.top !== null && { textureTop: faces.top }),
    ...(faces.bottom !== faces.side && faces.bottom !== null && { textureBottom: faces.bottom }),
    hardness: number('hardness', 1),
    solid: bool('solid', true),
    transparent: bool('transparent', false),
    light: number('light', 0),
    prefab: typeof prefab === 'string' ? prefab : null,
    prefabRenders: bool('prefab_renders', false),
  };
}
