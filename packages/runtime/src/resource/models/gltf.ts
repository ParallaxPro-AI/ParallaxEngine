/**
 * glTF 2.0 → a `ModelAsset` the renderer draws and animates. Reads .glb (binary
 * container) and .gltf (JSON) with embedded (`data:`) or external buffers and images;
 * meshes (triangles, strips and fans), metallic-roughness materials (base color,
 * metal/rough, normal map with its scale, occlusion with its strength, emissive; + unlit and
 * emissive-strength extensions, and the factors of clearcoat, transmission and
 * anisotropy as `Material3d.layers`), textures and samplers, the node hierarchy, skins and
 * TRS animations (LINEAR, STEP, CUBICSPLINE).
 *
 * Handedness and facing: glTF is right-handed with assets facing +z; the engine is
 * left-handed with +z forward. Everything is mirrored across x on load (positions, normals,
 * morph deltas, node and animation transforms, inverse bind matrices) and triangle winding
 * is reversed, so an asset faces +z with its right side at +x and front faces stay front
 * faces. One kind of file faces -z instead: a ParallaxPro asset-store model, whose root is a
 * wrapper node marked `extras.parallaxproBakedFacing` (its rotation turns the model to the
 * earlier engine's -z forward). That wrapper is turned a further 180° about y, which
 * makes the whole file mirrored across z rather than x: it faces +z too, with its right side
 * at +x, statics and skinned meshes alike (joints hang below the wrapper). Nothing else is
 * read for facing; a file authored another way is turned with `Model.rotation_offset`.
 *
 * Colors: glTF factors are linear; the port's colors are sRGB as authored, so material
 * factors are converted to sRGB here and back to linear by the surface.
 *
 * Morph targets are read (POSITION and NORMAL deltas, `extras.targetNames`, default
 * `weights`, `weights` animation channels, sparse accessors) and exposed for the animation
 * layer to blend: `ModelPrimitive.morphs`, `ModelNode.weights`, `Clip.morphChannels`.
 *
 * Textures: PNG, JPEG and WebP images (EXT_texture_webp: its source is preferred when
 * present; the browser decodes it, headless runs draw no textures), each material's UV set
 * and KHR_texture_transform baked into its primitives' uvs (the surface samples every map at
 * one uv), vertex colors (COLOR_0), any TEXCOORD_n set a material samples.
 *
 * Metal and roughness: a factor the file sets is used; an absent one reads as metallic 0 and
 * roughness 0.5 (the earlier engine's look), not glTF's default of 1 — a deliberate
 * deviation, so exporter defaults don't turn plain props into polished metal.
 *
 * Alpha follows the earlier engine: OPAQUE and MASK materials draw with the base
 * color factor's alpha taken as 1 (exporters often leave it at 0 and keep coverage in the
 * texture), so MASK tests the texture's alpha against `alphaCutoff`; only BLEND uses the
 * factor's alpha.
 *
 * Not read (a warning each, the rest of the model still loads): material maps that use
 * different UV sets or transforms (all are sampled like the base color map), KTX2/Basis
 * textures without a PNG/JPEG/WebP fallback, points and lines. A required extension this
 * loader doesn't know (Draco, meshopt, Basis) is PP3802.
 */

import { diagnostic, fail, isAssetUrl } from '../../core/index.js';
import type { BinaryFiles, Diagnostic, Geometry3d, Material3d, MaterialLayers3d, Texture3d, TextureSource, Wrap } from '../../core/index.js';
import type { ModelDocument } from './format.js';

// ── The loaded model ─────────────────────────────────────────────────────────

export interface ModelNode {
  readonly name: string;
  readonly parent: number;
  readonly children: readonly number[];
  /** Rest pose, engine handedness. */
  readonly translation: readonly [number, number, number];
  readonly rotation: readonly [number, number, number, number];
  readonly scale: readonly [number, number, number];
  readonly mesh: number | null;
  readonly skin: number | null;
  /**
   * Default morph target weights of the node's mesh (glTF `node.weights`, else
   * `mesh.weights`, else zeros), one per target. Absent or null: its mesh has no targets.
   */
  readonly weights?: readonly number[] | null;
}

/**
 * A primitive's morph targets. Deltas are in engine handedness and in the primitive's
 * `geometry` vertex order (one entry per geometry vertex, flat-shaded expansion included):
 * a posed vertex is `positions + Σ weight[t] · targets.positions[t]`. Every primitive of a
 * mesh has the same targets, in the same order, as glTF requires.
 */
export interface MorphTargets {
  /** Target names (`mesh.extras.targetNames`), else "target0", "target1", … */
  readonly names: readonly string[];
  /** Per target: x, y, z delta per vertex. */
  readonly positions: readonly Float32Array[];
  /** Per target: normal deltas per vertex, or null when the target has none. */
  readonly normals: readonly (Float32Array | null)[];
}

/** A clip's channel that drives a node's morph target weights. */
export interface MorphChannel {
  readonly node: number;
  readonly interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
  readonly times: Float32Array;
  /** Targets per key. */
  readonly count: number;
  /** `count` weights per key (CUBICSPLINE: in-tangents, values, out-tangents per key). */
  readonly values: Float32Array;
}

export interface ModelPrimitive {
  readonly geometry: Geometry3d;
  readonly material: Material3d;
  /** The material's name (a model document's material, a glTF material's `name`); null when unnamed. */
  readonly materialName: string | null;
  /** Its morph targets; absent or null: none. */
  readonly morphs?: MorphTargets | null;
}

export interface ModelSkin {
  /** Node index of each joint. */
  readonly joints: readonly number[];
  /** 16 numbers per joint. */
  readonly inverseBind: Float32Array;
}

export type ChannelPath = 'translation' | 'rotation' | 'scale';

export interface ClipChannel {
  readonly node: number;
  readonly path: ChannelPath;
  readonly interpolation: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
  readonly times: Float32Array;
  /** 3 or 4 numbers per key (CUBICSPLINE: in-tangent, value, out-tangent per key). */
  readonly values: Float32Array;
}

export interface Clip {
  readonly name: string;
  /** Seconds (the last key). */
  readonly duration: number;
  readonly channels: readonly ClipChannel[];
  /** Morph target weight channels; absent: none. */
  readonly morphChannels?: readonly MorphChannel[];
}

export interface ModelAsset {
  readonly path: string;
  readonly nodes: readonly ModelNode[];
  /** The default scene's root nodes. */
  readonly roots: readonly number[];
  /** Every node reachable from the roots, parents before children. */
  readonly order: readonly number[];
  readonly meshes: readonly (readonly ModelPrimitive[])[];
  readonly skins: readonly ModelSkin[];
  readonly clips: ReadonlyMap<string, Clip>;
  readonly nodeByName: ReadonlyMap<string, number>;
  /** Parts of the file that were not read. */
  readonly warnings: readonly Diagnostic[];
  /** A model document's parts and controls (`code_model.ts`); null for a glTF file. */
  readonly code: CodeModelNodes | null;
}

/** Where a model document's parts and bones are among a `ModelAsset`'s nodes. */
export interface CodeModelNodes {
  readonly document: ModelDocument;
  /** Part index → its node (its transform; its mesh, if any, is on a child node). */
  readonly partNode: readonly number[];
  /** Bone index → its node. */
  readonly boneNode: readonly number[];
  /** Mesh index → the part that draws it. */
  readonly meshPart: readonly number[];
}

// ── glTF JSON (the parts read) ──────────────────────────────────────────────

export interface GltfJson {
  asset?: { version?: string };
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { primitives: GltfPrimitive[]; weights?: number[]; extras?: { targetNames?: unknown } }[];
  materials?: GltfMaterial[];
  textures?: { source?: number; sampler?: number; extensions?: Record<string, { source?: number } | undefined> }[];
  images?: { uri?: string; bufferView?: number; mimeType?: string }[];
  samplers?: { magFilter?: number; wrapS?: number; wrapT?: number }[];
  accessors?: GltfAccessor[];
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[];
  buffers?: { uri?: string; byteLength: number }[];
  skins?: { joints: number[]; inverseBindMatrices?: number }[];
  animations?: { name?: string; channels: GltfChannel[]; samplers: GltfSampler[] }[];
  extensionsRequired?: string[];
}

interface GltfNode {
  name?: string;
  children?: number[];
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  mesh?: number;
  skin?: number;
  weights?: number[];
  extras?: { parallaxproBakedFacing?: unknown };
}

interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: Record<string, number>[];
}

interface GltfTextureInfo { index: number; texCoord?: number; extensions?: Record<string, unknown> }

interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    baseColorTexture?: GltfTextureInfo;
    metallicFactor?: number;
    roughnessFactor?: number;
    metallicRoughnessTexture?: GltfTextureInfo;
  };
  emissiveFactor?: number[];
  emissiveTexture?: GltfTextureInfo;
  normalTexture?: GltfTextureInfo & { scale?: number };
  occlusionTexture?: GltfTextureInfo & { strength?: number };
  alphaMode?: string;
  alphaCutoff?: number;
  doubleSided?: boolean;
  extensions?: Record<string, GltfMaterialExtension | undefined>;
}

/** The material extensions read: emissive strength, and the layers `MaterialLayers3d` carries (their factors; their textures are not read). */
interface GltfMaterialExtension {
  emissiveStrength?: number;
  clearcoatFactor?: number;
  clearcoatRoughnessFactor?: number;
  transmissionFactor?: number;
  anisotropyStrength?: number;
  anisotropyRotation?: number;
}

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  sparse?: {
    count: number;
    indices: { bufferView: number; byteOffset?: number; componentType: number };
    values: { bufferView: number; byteOffset?: number };
  };
}

interface GltfChannel { sampler: number; target: { node?: number; path: string } }
interface GltfSampler { input: number; output: number; interpolation?: string }

const SUPPORTED_EXTENSIONS = new Set([
  'KHR_materials_unlit', 'KHR_materials_emissive_strength', 'KHR_mesh_quantization', 'KHR_materials_clearcoat', 'KHR_materials_transmission',
  'KHR_materials_anisotropy', 'EXT_texture_webp', 'KHR_texture_transform',
  // Read as the core model (their factors refine it; leaving them out is the glTF fallback).
  'KHR_materials_specular', 'KHR_materials_ior',
]);

/** Where a material's maps are sampled: a TEXCOORD set and a KHR_texture_transform. */
interface UvMap {
  readonly set: number;
  /** u' = m0·u + m1·v + m2, v' = m3·u + m4·v + m5; null: identity. */
  readonly m: readonly number[] | null;
}

const PLAIN_UV: UvMap = { set: 0, m: null };

/** What an absent `metallicFactor` / `roughnessFactor` reads as (not glTF's 1 and 1; see `#material`). */
export const MISSING_METALLIC = 0;
export const MISSING_ROUGHNESS = 0.5;

interface TextureTransform { offset?: number[]; rotation?: number; scale?: number[]; texCoord?: number }

/** A texture reference's UV set and transform (KHR_texture_transform's `texCoord` overrides the reference's). */
export function uvMapOf(info: GltfTextureInfo): UvMap {
  const t = info.extensions?.['KHR_texture_transform'] as TextureTransform | undefined;
  const set = t?.texCoord ?? info.texCoord ?? 0;
  if (t === undefined) return { set, m: null };
  const r = t.rotation ?? 0;
  const [sx, sy] = [t.scale?.[0] ?? 1, t.scale?.[1] ?? 1];
  const [ox, oy] = [t.offset?.[0] ?? 0, t.offset?.[1] ?? 0];
  const c = Math.cos(r);
  const s = Math.sin(r);
  // glTF: uv' = T · R · S · uv, R = [cos, sin; -sin, cos].
  const m = [c * sx, s * sy, ox, -s * sx, c * sy, oy];
  const identity = m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 0 && m[4] === 1 && m[5] === 0;
  return { set, m: identity ? null : m };
}

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

function bad(path: string, message: string, fix?: string): never {
  return fail('PP3801', `${path}: ${message}`, { path, fix: fix ?? 'Re-export the model as glTF 2.0 (.glb) from your modelling tool.' });
}

// ── Container ────────────────────────────────────────────────────────────────

/** Split a .glb or .gltf file into its JSON and (GLB) binary chunk. */
export function readContainer(path: string, bytes: Uint8Array): { readonly json: GltfJson; readonly bin: Uint8Array | null } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let text: string;
  let bin: Uint8Array | null = null;
  if (bytes.byteLength >= 12 && view.getUint32(0, true) === GLB_MAGIC) {
    const version = view.getUint32(4, true);
    if (version !== 2) bad(path, `is a version ${version} GLB; only glTF 2.0 is read`);
    const length = Math.min(view.getUint32(8, true), bytes.byteLength);
    let at = 12;
    let json: string | null = null;
    while (at + 8 <= length) {
      const chunkLength = view.getUint32(at, true);
      const type = view.getUint32(at + 4, true);
      const start = at + 8;
      if (start + chunkLength > length) bad(path, 'has a chunk that runs past the end of the file (truncated download?)');
      if (type === CHUNK_JSON && json === null) json = new TextDecoder().decode(bytes.subarray(start, start + chunkLength));
      else if (type === CHUNK_BIN && bin === null) bin = bytes.subarray(start, start + chunkLength);
      at = start + chunkLength + ((4 - (chunkLength % 4)) % 4);
    }
    if (json === null) bad(path, 'is a GLB without a JSON chunk');
    text = json;
  } else {
    text = new TextDecoder().decode(bytes);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    bad(path, `is neither a GLB nor glTF JSON (${(error as Error).message})`);
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) bad(path, 'is not a glTF JSON object');
  const gltf = json as GltfJson;
  const version = gltf.asset?.version;
  if (typeof version !== 'string' || !version.startsWith('2.')) bad(path, `declares glTF version ${String(version)}; only 2.x is read`);
  for (const ext of gltf.extensionsRequired ?? []) {
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      fail('PP3802', `${path} requires the glTF extension ${ext}, which this loader doesn't read`, {
        path, fix: 'Export without mesh/texture compression (no Draco, meshopt or Basis/KTX2; WebP is read), or decompress the file with gltf-transform.',
      });
    }
  }
  return { json: gltf, bin };
}

function directory(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash + 1);
}

/** A relative URI inside a .gltf, as a project path (or, beside a hosted model, as a URL on its host). */
export function resolveUri(modelPath: string, uri: string): string {
  if (isAssetUrl(modelPath)) return new URL(uri, modelPath).href;
  const parts = (directory(modelPath) + decodeURIComponent(uri)).split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

function dataUri(uri: string): { readonly bytes: Uint8Array; readonly mimeType: string } | null {
  const match = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri);
  if (match === null) return null;
  const payload = match[3]!;
  if (match[2] === undefined) return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), mimeType: match[1]! };
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { bytes, mimeType: match[1]! };
}

/** Read a model file and every external buffer it names, then build it. */
/**
 * Read a .glb or .gltf and its buffers, then build it. `build` is `buildModel` or the same
 * function behind a job runner (the `gltf.build` job): the file reading stays here.
 */
export async function loadModel(
  path: string, files: BinaryFiles,
  build: (path: string, json: GltfJson, buffers: readonly Uint8Array[]) => ModelAsset | Promise<ModelAsset> = buildModel,
): Promise<ModelAsset> {
  const { json, bin } = readContainer(path, await files.read(path));
  const buffers = await Promise.all((json.buffers ?? []).map(async (buffer, i) => {
    if (buffer.uri === undefined) {
      if (bin === null) bad(path, `buffer ${i} has no uri and there is no GLB binary chunk`);
      return bin;
    }
    const inline = dataUri(buffer.uri);
    if (inline !== null) return inline.bytes;
    return files.read(resolveUri(path, buffer.uri));
  }));
  return build(path, json, buffers);
}

// ── Accessors ────────────────────────────────────────────────────────────────

const COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const SIZES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

class Reader {
  readonly #path: string;
  readonly #json: GltfJson;
  readonly #buffers: readonly Uint8Array[];

  constructor(path: string, json: GltfJson, buffers: readonly Uint8Array[]) {
    this.#path = path;
    this.#json = json;
    this.#buffers = buffers;
  }

  bufferView(index: number): Uint8Array {
    const view = this.#json.bufferViews?.[index];
    if (view === undefined) bad(this.#path, `names bufferView ${index}, which doesn't exist`);
    const buffer = this.#buffers[view.buffer];
    if (buffer === undefined) bad(this.#path, `bufferView ${index} names buffer ${view.buffer}, which doesn't exist`);
    const start = view.byteOffset ?? 0;
    if (start + view.byteLength > buffer.byteLength) bad(this.#path, `bufferView ${index} runs past the end of its buffer`);
    return buffer.subarray(start, start + view.byteLength);
  }

  /** An accessor as plain numbers (normalized integers mapped to 0..1 / -1..1 when `normalized`). */
  read(index: number): { readonly values: Float64Array; readonly components: number; readonly count: number; readonly componentType: number } {
    const accessor = this.#json.accessors?.[index];
    if (accessor === undefined) bad(this.#path, `names accessor ${index}, which doesn't exist`);
    const components = COMPONENTS[accessor.type];
    const size = SIZES[accessor.componentType];
    if (components === undefined || size === undefined) bad(this.#path, `accessor ${index} has type ${accessor.type}/${accessor.componentType}`);
    const values = new Float64Array(accessor.count * components);
    const norm = accessor.normalized === true;
    if (accessor.bufferView !== undefined) {
      const stride = this.#json.bufferViews![accessor.bufferView]!.byteStride ?? components * size;
      this.#elements(accessor.bufferView, accessor.byteOffset ?? 0, stride, accessor.count, components, accessor.componentType, norm, values,
        (i) => i, `accessor ${index}`);
    }
    // Sparse: the listed elements replace the base (zeros without a bufferView).
    const sparse = accessor.sparse;
    if (sparse !== undefined) {
      if (typeof sparse.count !== 'number' || sparse.indices?.bufferView === undefined || sparse.values?.bufferView === undefined) {
        bad(this.#path, `accessor ${index} has a sparse block without count, indices or values`);
      }
      if (![5121, 5123, 5125].includes(sparse.indices.componentType)) bad(this.#path, `accessor ${index} has sparse indices of type ${sparse.indices.componentType}`);
      const at = new Float64Array(sparse.count);
      this.#elements(sparse.indices.bufferView, sparse.indices.byteOffset ?? 0, SIZES[sparse.indices.componentType]!, sparse.count, 1,
        sparse.indices.componentType, false, at, (i) => i, `accessor ${index} sparse indices`);
      for (const i of at) if (i >= accessor.count) bad(this.#path, `accessor ${index} has a sparse index ${i} past its ${accessor.count} elements`);
      this.#elements(sparse.values.bufferView, sparse.values.byteOffset ?? 0, components * size, sparse.count, components, accessor.componentType,
        norm, values, (i) => at[i]!, `accessor ${index} sparse values`);
    }
    return { values, components, count: accessor.count, componentType: accessor.componentType };
  }

  /** Read `count` elements of a bufferView into `out`, element i at element `place(i)`. */
  #elements(bufferView: number, base: number, stride: number, count: number, components: number, componentType: number, norm: boolean,
    out: Float64Array, place: (i: number) => number, what: string): void {
    const size = SIZES[componentType]!;
    const bytes = this.bufferView(bufferView);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const last = base + (count - 1) * stride + components * size;
    if (count > 0 && last > bytes.byteLength) bad(this.#path, `${what} runs past the end of its bufferView`);
    for (let i = 0; i < count; i++) {
      const o = place(i) * components;
      for (let c = 0; c < components; c++) {
        const at = base + i * stride + c * size;
        let v: number;
        switch (componentType) {
          case 5120: v = view.getInt8(at); if (norm) v = Math.max(v / 127, -1); break;
          case 5121: v = view.getUint8(at); if (norm) v /= 255; break;
          case 5122: v = view.getInt16(at, true); if (norm) v = Math.max(v / 32767, -1); break;
          case 5123: v = view.getUint16(at, true); if (norm) v /= 65535; break;
          case 5125: v = view.getUint32(at, true); break;
          default: v = view.getFloat32(at, true);
        }
        out[o + c] = v;
      }
    }
  }

  /** An accessor that must hold `components` numbers per element. */
  readAs(index: number, components: number, what: string): Float64Array {
    const r = this.read(index);
    if (r.components !== components) bad(this.#path, `${what} has ${r.components} components per element; ${components} expected`);
    return r.values;
  }
}

// ── Conversions ──────────────────────────────────────────────────────────────

function linearToSrgb(c: number): number {
  const v = Math.min(1, Math.max(0, c));
  return v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
}

/** Mirror a column-major matrix across x: S · M · S with S = diag(-1, 1, 1, 1). */
export function mirrorMatrix(m: ArrayLike<number>, out: Float32Array, o: number): void {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      const flip = (r === 0) !== (c === 0);
      out[o + c * 4 + r] = flip ? -m[c * 4 + r]! : m[c * 4 + r]!;
    }
  }
}

/**
 * Whether a glTF node is a ParallaxPro facing wrapper: a root node marked
 * `extras.parallaxproBakedFacing`, which turns the file's model to face -z (that asset
 * store's convention, the earlier engine's forward) instead of glTF's +z.
 */
export function isMinusZFacingWrapper(node: { readonly extras?: { readonly parallaxproBakedFacing?: unknown } } | undefined): boolean {
  const flag = node?.extras?.parallaxproBakedFacing;
  return flag !== undefined && flag !== null && flag !== false;
}

/** A translation (engine handedness) turned 180° about y: x and z negate. */
export function turnTranslation(v: ArrayLike<number>, o: number): [number, number, number] {
  return [-v[o]!, v[o + 1]!, -v[o + 2]!];
}

/** A rotation (x, y, z, w; engine handedness) turned 180° about y first: q' = (0, 1, 0, 0) · q. */
export function turnRotation(q: ArrayLike<number>, o: number): [number, number, number, number] {
  return [q[o + 2]!, q[o + 3]!, -q[o]!, -q[o + 1]!];
}

/** Decompose a column-major TRS matrix (no shear) into translation, rotation and scale. */
export function decompose(m: readonly number[]): { t: [number, number, number]; r: [number, number, number, number]; s: [number, number, number] } {
  let sx = Math.hypot(m[0]!, m[1]!, m[2]!);
  const sy = Math.hypot(m[4]!, m[5]!, m[6]!);
  const sz = Math.hypot(m[8]!, m[9]!, m[10]!);
  const det = m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) - m[4]! * (m[1]! * m[10]! - m[2]! * m[9]!) + m[8]! * (m[1]! * m[6]! - m[2]! * m[5]!);
  if (det < 0) sx = -sx;
  const r00 = m[0]! / sx; const r10 = m[1]! / sx; const r20 = m[2]! / sx;
  const r01 = m[4]! / sy; const r11 = m[5]! / sy; const r21 = m[6]! / sy;
  const r02 = m[8]! / sz; const r12 = m[9]! / sz; const r22 = m[10]! / sz;
  const trace = r00 + r11 + r22;
  let q: [number, number, number, number];
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    q = [(r21 - r12) * s, (r02 - r20) * s, (r10 - r01) * s, 0.25 / s];
  } else if (r00 > r11 && r00 > r22) {
    const s = 2 * Math.sqrt(1 + r00 - r11 - r22);
    q = [0.25 * s, (r01 + r10) / s, (r02 + r20) / s, (r21 - r12) / s];
  } else if (r11 > r22) {
    const s = 2 * Math.sqrt(1 + r11 - r00 - r22);
    q = [(r01 + r10) / s, 0.25 * s, (r12 + r21) / s, (r02 - r20) / s];
  } else {
    const s = 2 * Math.sqrt(1 + r22 - r00 - r11);
    q = [(r02 + r20) / s, (r12 + r21) / s, 0.25 * s, (r10 - r01) / s];
  }
  return { t: [m[12]!, m[13]!, m[14]!], r: q, s: [sx, sy, sz] };
}

const WRAP: Record<number, Wrap> = { 10497: 'repeat', 33071: 'clamp', 33648: 'mirror' };

// ── Build ────────────────────────────────────────────────────────────────────

/** Build a model from parsed glTF JSON and its buffers (in `json.buffers` order). */
export function buildModel(path: string, json: GltfJson, buffers: readonly Uint8Array[]): ModelAsset {
  return new ModelBuilder(path, json, new Reader(path, json, buffers)).build();
}

class ModelBuilder {
  readonly #path: string;
  readonly #json: GltfJson;
  readonly #reader: Reader;
  readonly #warnings: Diagnostic[] = [];
  readonly #textures = new Map<string, Texture3d>();
  readonly #materials = new Map<number, Material3d>();

  constructor(path: string, json: GltfJson, reader: Reader) {
    this.#path = path;
    this.#json = json;
    this.#reader = reader;
  }

  #warn(message: string, fix: string): void {
    if (this.#warnings.some((w) => w.message.endsWith(message))) return;
    this.#warnings.push(diagnostic('PP3803', `${this.#path}: ${message}`, { severity: 'warning', path: this.#path, fix }));
  }

  build(): ModelAsset {
    const json = this.#json;
    const nodes = this.#nodes();
    const sceneIndex = json.scene ?? 0;
    const scene = json.scenes?.[sceneIndex];
    const roots = scene?.nodes ?? nodes.map((n, i) => (n.parent === -1 ? i : -1)).filter((i) => i >= 0);
    const order: number[] = [];
    const visit = (i: number): void => {
      order.push(i);
      nodes[i]!.children.forEach(visit);
    };
    roots.forEach(visit);
    const meshes = (json.meshes ?? []).map((mesh, m) => this.#mesh(mesh.primitives, m, mesh.extras?.targetNames));
    const targetCount = (m: number): number => (json.meshes?.[m]?.primitives[0]?.targets?.length ?? 0);
    const withWeights = nodes.map((node, i) => {
      if (node.mesh === null || targetCount(node.mesh) === 0) return node;
      const count = targetCount(node.mesh);
      const given = json.nodes?.[i]?.weights ?? json.meshes?.[node.mesh]?.weights;
      if (given !== undefined && given.length !== count) bad(this.#path, `node ${i} has ${given.length} morph weights for ${count} targets`);
      return { ...node, weights: given ?? new Array<number>(count).fill(0) };
    });
    const skins = (json.skins ?? []).map((skin, i) => this.#skin(skin, i, nodes.length));
    const clips = new Map<string, Clip>();
    (json.animations ?? []).forEach((animation, i) => {
      const clip = this.#clip(animation, i, withWeights);
      clips.set(clip.name, clip);
    });
    const nodeByName = new Map<string, number>();
    nodes.forEach((n, i) => { if (n.name !== '' && !nodeByName.has(n.name)) nodeByName.set(n.name, i); });
    return { path: this.#path, nodes: withWeights, roots, order, meshes, skins, clips, nodeByName, warnings: this.#warnings, code: null };
  }

  /**
   * Root nodes that are ParallaxPro facing wrappers (`isMinusZFacingWrapper`). The file faces
   * -z, so on top of the mirror across x each is turned 180° about y: the model is mirrored
   * across z instead, and faces +z. Only the wrapper's own transform (and any channel that
   * animates it) changes, so every node below it, the skins and the clips keep the same
   * numbers as in a +z file, and clips retarget between the two kinds unchanged.
   */
  readonly #turned = new Set<number>();

  #facesMinusZ(i: number, parents: readonly number[]): boolean {
    if (parents[i] !== -1 || !isMinusZFacingWrapper(this.#json.nodes?.[i])) return false;
    this.#turned.add(i);
    return true;
  }

  #nodes(): ModelNode[] {
    const raw = this.#json.nodes ?? [];
    const parents = new Array<number>(raw.length).fill(-1);
    raw.forEach((node, i) => {
      for (const child of node.children ?? []) {
        if (child < 0 || child >= raw.length) bad(this.#path, `node ${i} has child ${child}, which doesn't exist`);
        if (parents[child] !== -1) bad(this.#path, `node ${child} has two parents`);
        parents[child] = i;
      }
    });
    return raw.map((node, i) => {
      let t = node.translation ?? [0, 0, 0];
      let r = node.rotation ?? [0, 0, 0, 1];
      let s = node.scale ?? [1, 1, 1];
      if (node.matrix !== undefined) {
        if (node.matrix.length !== 16) bad(this.#path, `node ${i} has a matrix of ${node.matrix.length} numbers`);
        const d = decompose(node.matrix);
        t = d.t; r = d.r; s = d.s;
      }
      const translation: [number, number, number] = [-t[0]!, t[1]!, t[2]!];
      const rotation: [number, number, number, number] = [r[0]!, -r[1]!, -r[2]!, r[3]!];
      return {
        name: node.name ?? '',
        parent: parents[i]!,
        children: node.children ?? [],
        ...(this.#facesMinusZ(i, parents)
          ? { translation: turnTranslation(translation, 0), rotation: turnRotation(rotation, 0) }
          : { translation, rotation }),
        scale: [s[0]!, s[1]!, s[2]!],
        mesh: node.mesh ?? null,
        skin: node.skin ?? null,
      } satisfies ModelNode;
    });
  }

  #skin(skin: { joints: number[]; inverseBindMatrices?: number }, index: number, nodeCount: number): ModelSkin {
    for (const joint of skin.joints) if (joint < 0 || joint >= nodeCount) bad(this.#path, `skin ${index} names joint node ${joint}, which doesn't exist`);
    const inverseBind = new Float32Array(skin.joints.length * 16);
    if (skin.inverseBindMatrices === undefined) {
      for (let j = 0; j < skin.joints.length; j++) inverseBind[j * 16] = inverseBind[j * 16 + 5] = inverseBind[j * 16 + 10] = inverseBind[j * 16 + 15] = 1;
    } else {
      const values = this.#reader.readAs(skin.inverseBindMatrices, 16, `skin ${index} inverseBindMatrices`);
      if (values.length < skin.joints.length * 16) bad(this.#path, `skin ${index} has fewer inverse bind matrices than joints`);
      for (let j = 0; j < skin.joints.length; j++) mirrorMatrix(values.subarray(j * 16, j * 16 + 16), inverseBind, j * 16);
    }
    return { joints: skin.joints, inverseBind };
  }

  #clip(animation: { name?: string; channels: GltfChannel[]; samplers: GltfSampler[] }, index: number, nodes: readonly ModelNode[]): Clip {
    const nodeCount = nodes.length;
    const name = animation.name ?? `animation_${index}`;
    const channels: ClipChannel[] = [];
    const morphChannels: MorphChannel[] = [];
    let duration = 0;
    for (const channel of animation.channels) {
      const { node, path } = channel.target;
      if (node === undefined) continue;
      if (path === 'weights') {
        if (node < 0 || node >= nodeCount) bad(this.#path, `animation "${name}" targets node ${node}, which doesn't exist`);
        const count = nodes[node]!.weights?.length ?? 0;
        if (count === 0) bad(this.#path, `animation "${name}" drives the morph weights of node ${node}, whose mesh has no morph targets`);
        const sampler = animation.samplers[channel.sampler];
        if (sampler === undefined) bad(this.#path, `animation "${name}" names sampler ${channel.sampler}, which doesn't exist`);
        const interpolation = (sampler.interpolation ?? 'LINEAR') as MorphChannel['interpolation'];
        if (!['LINEAR', 'STEP', 'CUBICSPLINE'].includes(interpolation)) bad(this.#path, `animation "${name}" has interpolation "${interpolation}"`);
        const times = Float32Array.from(this.#reader.readAs(sampler.input, 1, `animation "${name}" times`));
        const values = Float32Array.from(this.#reader.readAs(sampler.output, 1, `animation "${name}" weights`));
        const keys = values.length / (count * (interpolation === 'CUBICSPLINE' ? 3 : 1));
        if (keys !== times.length) bad(this.#path, `animation "${name}" has ${times.length} key times but ${keys} sets of morph weights`);
        if (times.length > 0) duration = Math.max(duration, times[times.length - 1]!);
        morphChannels.push({ node, interpolation, times, count, values });
        continue;
      }
      if (node < 0 || node >= nodeCount) bad(this.#path, `animation "${name}" targets node ${node}, which doesn't exist`);
      if (path !== 'translation' && path !== 'rotation' && path !== 'scale') bad(this.#path, `animation "${name}" has a channel path "${path}"`);
      const sampler = animation.samplers[channel.sampler];
      if (sampler === undefined) bad(this.#path, `animation "${name}" names sampler ${channel.sampler}, which doesn't exist`);
      const interpolation = (sampler.interpolation ?? 'LINEAR') as ClipChannel['interpolation'];
      if (!['LINEAR', 'STEP', 'CUBICSPLINE'].includes(interpolation)) bad(this.#path, `animation "${name}" has interpolation "${interpolation}"`);
      const times = Float32Array.from(this.#reader.readAs(sampler.input, 1, `animation "${name}" times`));
      const width = path === 'rotation' ? 4 : 3;
      const raw = this.#reader.read(sampler.output);
      if (raw.components !== width) bad(this.#path, `animation "${name}" ${path} output has ${raw.components} components; ${width} expected`);
      const values = new Float32Array(raw.values.length);
      for (let i = 0; i < raw.values.length; i += width) {
        if (path === 'translation') { values[i] = -raw.values[i]!; values[i + 1] = raw.values[i + 1]!; values[i + 2] = raw.values[i + 2]!; }
        else if (path === 'rotation') { values[i] = raw.values[i]!; values[i + 1] = -raw.values[i + 1]!; values[i + 2] = -raw.values[i + 2]!; values[i + 3] = raw.values[i + 3]!; }
        else { values[i] = raw.values[i]!; values[i + 1] = raw.values[i + 1]!; values[i + 2] = raw.values[i + 2]!; }
        // A facing wrapper's keys (and CUBICSPLINE tangents, which transform the same way) turn with its rest pose.
        if (this.#turned.has(node) && path !== 'scale') values.set(path === 'translation' ? turnTranslation(values, i) : turnRotation(values, i), i);
      }
      const keys = interpolation === 'CUBICSPLINE' ? values.length / (width * 3) : values.length / width;
      if (keys !== times.length) bad(this.#path, `animation "${name}" has ${times.length} key times but ${keys} values`);
      if (times.length > 0) duration = Math.max(duration, times[times.length - 1]!);
      channels.push({ node, path, interpolation, times, values });
    }
    return { name, duration, channels, ...(morphChannels.length > 0 && { morphChannels }) };
  }

  #mesh(primitives: GltfPrimitive[], m: number, targetNames: unknown): ModelPrimitive[] {
    const out: ModelPrimitive[] = [];
    const count = primitives[0]?.targets?.length ?? 0;
    if (primitives.some((p) => (p.targets?.length ?? 0) !== count)) bad(this.#path, `mesh ${m}'s primitives have different numbers of morph targets`);
    const names = Array.isArray(targetNames) && targetNames.length === count && targetNames.every((n) => typeof n === 'string')
      ? targetNames as string[] : Array.from({ length: count }, (_, i) => `target${i}`);
    primitives.forEach((primitive, p) => {
      const built = this.#geometry(primitive, `${this.#path}#mesh${m}.${p}`, this.#uvMap(primitive.material));
      if (built !== null) {
        const name = primitive.material === undefined ? undefined : this.#json.materials?.[primitive.material]?.name;
        out.push({
          geometry: built.geometry, material: this.#material(primitive.material), materialName: name === undefined || name === '' ? null : name,
          ...(count > 0 && { morphs: this.#morphs(primitive, built.source, built.vertexCount, names, `${this.#path}#mesh${m}.${p}`) }),
        });
      }
    });
    return out;
  }

  /** A primitive's targets as deltas in its geometry's vertex order (`source`: geometry vertex → glTF vertex). */
  #morphs(primitive: GltfPrimitive, source: (v: number) => number, vertexCount: number, names: readonly string[], id: string): MorphTargets {
    const positions: Float32Array[] = [];
    const normals: (Float32Array | null)[] = [];
    (primitive.targets ?? []).forEach((target, t) => {
      const read = (attribute: string): Float32Array | null => {
        const accessor = target[attribute];
        if (accessor === undefined) return null;
        const raw = this.#reader.readAs(accessor, 3, `${id} target ${t} ${attribute}`);
        const out = new Float32Array(vertexCount * 3);
        for (let v = 0; v < vertexCount; v++) {
          const s = source(v);
          out[v * 3] = -raw[s * 3]!; out[v * 3 + 1] = raw[s * 3 + 1]!; out[v * 3 + 2] = raw[s * 3 + 2]!;
        }
        return out;
      };
      positions.push(read('POSITION') ?? new Float32Array(vertexCount * 3));
      normals.push(read('NORMAL'));
    });
    return { names, positions, normals };
  }

  /** The primitive's geometry, and which glTF vertex each of its `vertexCount` vertices came from. */
  #geometry(primitive: GltfPrimitive, id: string, uv: UvMap): { readonly geometry: Geometry3d; readonly source: (v: number) => number; readonly vertexCount: number } | null {
    const mode = primitive.mode ?? 4;
    if (mode < 4 || mode > 6) {
      this.#warn('has point or line primitives, which are not drawn', 'Convert them to triangles, or remove them.');
      return null;
    }
    let uvSet = uv.set;
    if (primitive.attributes[`TEXCOORD_${uvSet}`] === undefined && uvSet !== 0) {
      this.#warn(`samples TEXCOORD_${uvSet}, which a primitive doesn't have; TEXCOORD_0 is used`, 'Export the UV set the material samples.');
      uvSet = 0;
    }
    const position = primitive.attributes['POSITION'];
    if (position === undefined) bad(this.#path, `${id} has no POSITION attribute`);
    const positions = this.#reader.readAs(position, 3, `${id} POSITION`);
    const count = positions.length / 3;
    const normalIndex = primitive.attributes['NORMAL'];
    const uvIndex = primitive.attributes[`TEXCOORD_${uvSet}`];
    const jointIndex = primitive.attributes['JOINTS_0'];
    const weightIndex = primitive.attributes['WEIGHTS_0'];
    const normals = normalIndex === undefined ? null : this.#reader.readAs(normalIndex, 3, `${id} NORMAL`);
    const uvs = uvIndex === undefined ? null : this.#reader.readAs(uvIndex, 2, `${id} TEXCOORD_${uvSet}`);
    const t = uv.m;
    const joints = jointIndex === undefined ? null : this.#reader.readAs(jointIndex, 4, `${id} JOINTS_0`);
    const weights = weightIndex === undefined ? null : this.#reader.readAs(weightIndex, 4, `${id} WEIGHTS_0`);
    const colorIndex = primitive.attributes['COLOR_0'];
    const colorRead = colorIndex === undefined ? null : this.#reader.read(colorIndex);
    if (colorRead !== null && colorRead.components !== 3 && colorRead.components !== 4) bad(this.#path, `${id} COLOR_0 has ${colorRead.components} components`);
    const colors = colorRead === null ? null : colorRead;
    if ((joints === null) !== (weights === null)) bad(this.#path, `${id} has ${joints === null ? 'WEIGHTS_0 without JOINTS_0' : 'JOINTS_0 without WEIGHTS_0'}`);

    // Triangle list, in glTF winding.
    let list: number[];
    const source = primitive.indices === undefined ? null : this.#reader.readAs(primitive.indices, 1, `${id} indices`);
    const index = (i: number): number => (source === null ? i : source[i]!);
    const n = source === null ? count : source.length;
    for (let i = 0; i < n; i++) if (index(i) >= count) bad(this.#path, `${id} has an index ${index(i)} past its ${count} vertices`);
    if (mode === 4) {
      list = [];
      for (let i = 0; i + 2 < n; i += 3) list.push(index(i), index(i + 1), index(i + 2));
    } else if (mode === 5) {
      list = [];
      for (let i = 0; i + 2 < n; i++) {
        if (i % 2 === 0) list.push(index(i), index(i + 1), index(i + 2));
        else list.push(index(i + 1), index(i), index(i + 2));
      }
    } else {
      list = [];
      for (let i = 1; i + 1 < n; i++) list.push(index(0), index(i), index(i + 1));
    }

    // Without normals glTF asks for flat shading: give every triangle its own vertices.
    let order: number[] | null = null;
    if (normals === null) {
      order = list;
      list = list.map((_, i) => i);
    }
    const vertexCount = order === null ? count : order.length;
    const src = (v: number): number => (order === null ? v : order[v]!);

    const outPositions = new Float32Array(vertexCount * 3);
    const outNormals = new Float32Array(vertexCount * 3);
    const outUvs = new Float32Array(vertexCount * 2);
    const outJoints = joints === null ? null : new Uint16Array(vertexCount * 4);
    const outWeights = weights === null ? null : new Float32Array(vertexCount * 4);
    const outColors = colors === null ? null : new Float32Array(vertexCount * 4);
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < vertexCount; v++) {
      const s = src(v);
      const x = -positions[s * 3]!;
      const y = positions[s * 3 + 1]!;
      const z = positions[s * 3 + 2]!;
      outPositions[v * 3] = x; outPositions[v * 3 + 1] = y; outPositions[v * 3 + 2] = z;
      min[0] = Math.min(min[0]!, x); min[1] = Math.min(min[1]!, y); min[2] = Math.min(min[2]!, z);
      max[0] = Math.max(max[0]!, x); max[1] = Math.max(max[1]!, y); max[2] = Math.max(max[2]!, z);
      if (normals !== null) {
        outNormals[v * 3] = -normals[s * 3]!; outNormals[v * 3 + 1] = normals[s * 3 + 1]!; outNormals[v * 3 + 2] = normals[s * 3 + 2]!;
      }
      if (uvs !== null) {
        const u0 = uvs[s * 2]!;
        const v0 = uvs[s * 2 + 1]!;
        outUvs[v * 2] = t === null ? u0 : t[0]! * u0 + t[1]! * v0 + t[2]!;
        outUvs[v * 2 + 1] = t === null ? v0 : t[3]! * u0 + t[4]! * v0 + t[5]!;
      }
      if (colors !== null && outColors !== null) {
        const w = colors.components;
        // COLOR_0 is linear; the port's colors are sRGB.
        for (let k = 0; k < 3; k++) outColors[v * 4 + k] = linearToSrgb(colors.values[s * w + k]!);
        outColors[v * 4 + 3] = w === 4 ? colors.values[s * w + 3]! : 1;
      }
      if (outJoints !== null && outWeights !== null) {
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          outJoints[v * 4 + k] = joints![s * 4 + k]!;
          sum += weights![s * 4 + k]!;
        }
        for (let k = 0; k < 4; k++) outWeights[v * 4 + k] = sum > 0 ? weights![s * 4 + k]! / sum : k === 0 ? 1 : 0;
      }
    }
    // Reverse winding (the mirror flipped it), so cross(b - a, c - a) points outward.
    const indices = vertexCount > 65535 ? new Uint32Array(list.length) : new Uint16Array(list.length);
    for (let i = 0; i < list.length; i += 3) {
      indices[i] = list[i]!;
      indices[i + 1] = list[i + 2]!;
      indices[i + 2] = list[i + 1]!;
    }
    if (normals === null) {
      for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i]!; const b = indices[i + 1]!; const c = indices[i + 2]!;
        const e1 = [0, 1, 2].map((k) => outPositions[b * 3 + k]! - outPositions[a * 3 + k]!);
        const e2 = [0, 1, 2].map((k) => outPositions[c * 3 + k]! - outPositions[a * 3 + k]!);
        let nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
        let ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
        let nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l; ny /= l; nz /= l;
        for (const v of [a, b, c]) { outNormals[v * 3] = nx; outNormals[v * 3 + 1] = ny; outNormals[v * 3 + 2] = nz; }
      }
    }
    const geometry: Geometry3d = {
      id,
      positions: outPositions,
      normals: outNormals,
      uvs: outUvs,
      indices,
      joints: outJoints,
      weights: outWeights,
      colors: outColors,
      min: vertexCount === 0 ? [0, 0, 0] : [min[0]!, min[1]!, min[2]!],
      max: vertexCount === 0 ? [0, 0, 0] : [max[0]!, max[1]!, max[2]!],
    };
    return { geometry, source: src, vertexCount };
  }

  #texture(info: GltfTextureInfo | undefined, colorSpace: 'srgb' | 'linear'): Texture3d | null {
    if (info === undefined) return null;
    const texture = this.#json.textures?.[info.index];
    if (texture === undefined) bad(this.#path, `names texture ${info.index}, which doesn't exist`);
    // EXT_texture_webp's source when present (`source` is then an optional PNG/JPEG fallback).
    // KHR_texture_basisu's KTX2 isn't decoded: its `source` fallback is used, or no texture.
    const imageIndex = texture.extensions?.['EXT_texture_webp']?.source ?? texture.source;
    if (imageIndex === undefined) {
      if (texture.extensions?.['KHR_texture_basisu'] !== undefined) {
        this.#warn('has KTX2/Basis textures without a PNG, JPEG or WebP fallback; they are not drawn', 'Export the textures as PNG, JPEG or WebP.');
        return null;
      }
      bad(this.#path, `texture ${info.index} has no image source`);
    }
    const image = this.#json.images?.[imageIndex];
    if (image === undefined) bad(this.#path, `texture ${info.index} names image ${imageIndex}, which doesn't exist`);
    const sampler = texture.sampler === undefined ? {} : this.#json.samplers?.[texture.sampler] ?? {};
    const key = `${imageIndex}:${colorSpace}:${sampler.wrapS ?? 10497}:${sampler.wrapT ?? 10497}:${sampler.magFilter ?? 9729}`;
    const known = this.#textures.get(key);
    if (known !== undefined) return known;
    let source: TextureSource;
    if (image.bufferView !== undefined) {
      if (image.mimeType === undefined) bad(this.#path, `image ${imageIndex} is in a bufferView without a mimeType`);
      source = { kind: 'bytes', bytes: this.#reader.bufferView(image.bufferView), mimeType: image.mimeType };
    } else if (image.uri !== undefined) {
      const inline = dataUri(image.uri);
      source = inline !== null
        ? { kind: 'bytes', bytes: inline.bytes, mimeType: image.mimeType ?? inline.mimeType }
        : { kind: 'file', path: resolveUri(this.#path, image.uri) };
    } else {
      return bad(this.#path, `image ${imageIndex} has neither a uri nor a bufferView`);
    }
    const made: Texture3d = {
      id: `${this.#path}#image${imageIndex}:${colorSpace}`,
      source,
      colorSpace,
      wrapU: WRAP[sampler.wrapS ?? 10497] ?? 'repeat',
      wrapV: WRAP[sampler.wrapT ?? 10497] ?? 'repeat',
      filter: sampler.magFilter === 9728 ? 'nearest' : 'linear',
    };
    this.#textures.set(key, made);
    return made;
  }

  /**
   * The UV set and transform a material's maps are sampled with: the base color map's (else
   * the first map's). The surface samples every map at one uv, so maps that differ get a
   * warning and follow the first.
   */
  #uvMap(index: number | undefined): UvMap {
    const raw = index === undefined ? undefined : this.#json.materials?.[index];
    if (raw === undefined) return PLAIN_UV;
    const pbr = raw.pbrMetallicRoughness ?? {};
    const infos = [pbr.baseColorTexture, pbr.metallicRoughnessTexture, raw.normalTexture, raw.occlusionTexture, raw.emissiveTexture]
      .filter((i): i is GltfTextureInfo => i !== undefined);
    if (infos.length === 0) return PLAIN_UV;
    const maps = infos.map(uvMapOf);
    const first = maps[0]!;
    const same = (a: UvMap): boolean => a.set === first.set && (a.m === null ? first.m === null : first.m !== null && a.m.every((x, i) => x === first.m![i]));
    if (!maps.every(same)) {
      this.#warn('has a material whose maps use different UV sets or KHR_texture_transforms; all are sampled like its first map',
        'Give the material\'s maps one UV set and one transform.');
    }
    return first;
  }

  /** KHR_materials_clearcoat / _transmission / _anisotropy factors, when the material has any. */
  #layers(raw: GltfMaterial): { layers?: MaterialLayers3d } {
    const ext = raw.extensions ?? {};
    const clearcoat = ext['KHR_materials_clearcoat'];
    const transmission = ext['KHR_materials_transmission'];
    const anisotropy = ext['KHR_materials_anisotropy'];
    if (clearcoat === undefined && transmission === undefined && anisotropy === undefined) return {};
    for (const [name, e] of [['KHR_materials_clearcoat', clearcoat], ['KHR_materials_transmission', transmission], ['KHR_materials_anisotropy', anisotropy]] as const) {
      if (e !== undefined && Object.keys(e).some((k) => k.endsWith('Texture'))) {
        this.#warn(`uses ${name} textures, which are not read (its factors are)`, 'Bake the texture into the factor, or remove it.');
      }
    }
    return {
      layers: {
        clearcoat: clearcoat?.clearcoatFactor ?? 0,
        clearcoatRoughness: clearcoat?.clearcoatRoughnessFactor ?? 0,
        transmission: transmission?.transmissionFactor ?? 0,
        subsurface: 0,
        subsurfaceColor: [1, 1, 1],
        anisotropy: anisotropy?.anisotropyStrength ?? 0,
        // glTF gives radians, counter-clockwise in UV space; the port takes degrees.
        anisotropyRotation: ((anisotropy?.anisotropyRotation ?? 0) * 180) / Math.PI,
      },
    };
  }

  #material(index: number | undefined): Material3d {
    const key = index ?? -1;
    const known = this.#materials.get(key);
    if (known !== undefined) return known;
    const raw: GltfMaterial = index === undefined ? {} : this.#json.materials?.[index] ?? bad(this.#path, `names material ${index}, which doesn't exist`);
    const pbr = raw.pbrMetallicRoughness ?? {};
    const base = pbr.baseColorFactor ?? [1, 1, 1, 1];
    const strength = raw.extensions?.['KHR_materials_emissive_strength']?.emissiveStrength ?? 1;
    // The strength stays a separate linear multiplier: folded into the sRGB color it would clamp at 1.
    const emissive = (raw.emissiveFactor ?? [0, 0, 0]).map((c) => linearToSrgb(c));
    const alphaMode = raw.alphaMode === 'BLEND' ? 'blend' : raw.alphaMode === 'MASK' ? 'mask' : 'opaque';
    const material: Material3d = {
      id: `${this.#path}#material${key}`,
      // As the old engine: only BLEND reads the factor's alpha (see the file comment).
      baseColor: [linearToSrgb(base[0]!), linearToSrgb(base[1]!), linearToSrgb(base[2]!), alphaMode === 'blend' ? base[3]! : 1],
      baseColorTexture: this.#texture(pbr.baseColorTexture, 'srgb'),
      // A deliberate deviation from glTF (whose defaults are 1 and 1): an absent factor reads
      // as the earlier engine drew every model, metallic 0, roughness 0.5. Exporters
      // that leave the factor out (Blender writes none for its default) otherwise turn plain
      // props — the template pines' bark and needles — into polished metal. A factor the file
      // sets is used as given.
      metallic: pbr.metallicFactor ?? MISSING_METALLIC,
      roughness: pbr.roughnessFactor ?? MISSING_ROUGHNESS,
      metallicRoughnessTexture: this.#texture(pbr.metallicRoughnessTexture, 'linear'),
      emissive: [emissive[0]!, emissive[1]!, emissive[2]!],
      emissiveTexture: this.#texture(raw.emissiveTexture, 'srgb'),
      ...(strength !== 1 && { emissiveStrength: strength }),
      // Normal and occlusion maps hold linear data. A normal map's x is mirrored with the
      // geometry only through its tangent frame, which surfaces derive per pixel from the
      // (mirrored) positions, so the texels are used as authored.
      ...(raw.normalTexture !== undefined && { normalTexture: this.#texture(raw.normalTexture, 'linear'), normalScale: raw.normalTexture.scale ?? 1 }),
      ...(raw.occlusionTexture !== undefined && {
        occlusionTexture: this.#texture(raw.occlusionTexture, 'linear'), occlusionStrength: raw.occlusionTexture.strength ?? 1,
      }),
      alphaMode,
      alphaCutoff: raw.alphaCutoff ?? 0.5,
      doubleSided: raw.doubleSided === true,
      unlit: raw.extensions?.['KHR_materials_unlit'] !== undefined,
      ...this.#layers(raw),
    };
    this.#materials.set(key, material);
    return material;
  }
}
