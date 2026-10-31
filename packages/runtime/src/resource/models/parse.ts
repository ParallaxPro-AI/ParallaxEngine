/**
 * Reading a model document (`format.ts` is the format): JSON → a validated
 * `ModelDocument`, every problem a diagnostic with the file and a JSON pointer.
 *
 * Codes: PP1001–PP1003 for the JSON's shape (as every data file), and
 *   PP2120  not a model document (format, version)
 *   PP2123  an option's default that isn't one of its choices
 *   PP2124  a name that is no part or bone
 *   PP2125  a material that isn't in "materials"
 *   PP2126  a mesh that isn't in "meshes"
 *   PP2127  a name used twice
 *   PP2128  a mesh buffer that doesn't decode, or doesn't fit its mesh
 *   PP2129  a part, joint, socket or option that breaks the format's rules
 *   PP2063  a texture map that is neither an image under assets/ nor a hosted image URL
 * — the same codes `parallax check` and the runtime use for the same mistakes (plus, for
 * names game code and data use: PP2121 unknown joint, PP2122 unknown socket, PP2123
 * unknown option or choice).
 */

import { closestMatch, COLOR_FORMS, isAssetUrl, parseColor, Quat, REMOTE_EXTENSIONS, remoteAssetProblem, remoteAssetUrl, Vec3 } from '../../core/index.js';
import type { Diagnostic, Rgb, Rgba } from '../../core/index.js';
import type { Json, JsonObject } from '../model.js';
import { childPointer, DocReader, isObject } from '../reader.js';
import { MATERIAL_DEFAULTS, MODEL_FORMAT, MODEL_SHAPES, MODEL_VERSION, RENAMED_MATERIAL_KEYS } from './format.js';
import type {
  JointType, MaterialOverride, ModelBone, ModelDocument, ModelJoint, ModelMaterial, ModelMesh, ModelOption, ModelParent, ModelPart,
  ModelShape, ModelSkeleton, ModelSocket, QuatTuple, Vec3Tuple,
} from './format.js';

export interface ParsedModel {
  /** Undefined when the document has errors. */
  readonly document: ModelDocument | undefined;
  readonly diagnostics: readonly Diagnostic[];
}

const ROOT_KEYS = ['format', 'version', 'source', 'provides', 'materials', 'meshes', 'skeleton', 'parts', 'joints', 'sockets', 'options'];
const MATERIAL_KEYS = [
  'color', 'metallic', 'roughness', 'emissive', 'emissive_strength', 'texture', 'normal_map', 'normal_strength', 'alpha', 'alpha_cutoff',
  'double_sided', 'unlit', 'clearcoat', 'clearcoat_roughness', 'transmission', 'subsurface', 'subsurface_color', 'anisotropy', 'anisotropy_rotation',
];
/** Old material key → the fix (the `shape` component's name for it). */
const MATERIAL_RENAMES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(RENAMED_MATERIAL_KEYS).map(([old, now]) => [old, `"${old}" is now "${now}" (the shape component's name): rename the key.`]),
);
const MESH_KEYS = ['positions', 'normals', 'uvs', 'indices', 'joints', 'weights'];
const BONE_KEYS = ['name', 'parent', 'position', 'rotation', 'scale'];
const PART_KEYS = ['name', 'parent', 'position', 'rotation', 'scale', 'mesh', 'shape', 'size', 'material', 'uv_scale', 'cast_shadows', 'hidden'];
const JOINT_KEYS = ['name', 'part', 'type', 'kind', 'axis', 'limits', 'default', 'duration'];
const SOCKET_KEYS = ['name', 'parent', 'position', 'rotation', 'kind', 'accepts', 'limit'];
const JOINT_TYPES: readonly JointType[] = ['hinge', 'slider', 'scale'];
const ALPHA_MODES = ['opaque', 'blend', 'mask'] as const;

const ZERO: Vec3Tuple = [0, 0, 0];
const ONE: Vec3Tuple = [1, 1, 1];
const NO_ROTATION: QuatTuple = [0, 0, 0, 1];

type ElementType = 'f32' | 'u16' | 'u32';

/** Decode a "f32:…" / "u16:…" / "u32:…" buffer; undefined when it isn't one. */
export function decodeBuffer(text: string): { readonly type: ElementType; readonly values: Float32Array | Uint16Array | Uint32Array } | undefined {
  const m = /^(f32|u16|u32):([A-Za-z0-9+/]*={0,2})$/.exec(text);
  if (m === null) return undefined;
  const type = m[1] as ElementType;
  let binary: string;
  try {
    binary = atob(m[2]!);
  } catch {
    return undefined;
  }
  const size = type === 'u16' ? 2 : 4;
  if (binary.length % size !== 0) return undefined;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const view = new DataView(bytes.buffer);
  const count = bytes.length / size;
  if (type === 'f32') {
    const out = new Float32Array(count);
    for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, true);
    return { type, values: out };
  }
  if (type === 'u16') {
    const out = new Uint16Array(count);
    for (let i = 0; i < count; i++) out[i] = view.getUint16(i * 2, true);
    return { type, values: out };
  }
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getUint32(i * 4, true);
  return { type, values: out };
}

/** Encode values as a "f32:…" / "u16:…" / "u32:…" buffer (tests and tools). */
export function encodeBuffer(type: ElementType, values: ArrayLike<number>): string {
  const size = type === 'u16' ? 2 : 4;
  const bytes = new Uint8Array(values.length * size);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < values.length; i++) {
    if (type === 'f32') view.setFloat32(i * 4, values[i]!, true);
    else if (type === 'u16') view.setUint16(i * 2, values[i]!, true);
    else view.setUint32(i * 4, values[i]!, true);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return `${type}:${btoa(binary)}`;
}

class ModelReader {
  readonly r: DocReader;
  readonly diagnostics: Diagnostic[] = [];

  constructor(path: string) {
    this.r = new DocReader(path, this.diagnostics);
  }

  get path(): string {
    return this.r.path;
  }

  report(code: `PP${number}`, message: string, pointer: string, fix?: string): void {
    this.r.report(code, message, pointer, fix);
  }

  get failed(): boolean {
    return this.diagnostics.some((d) => d.severity === 'error');
  }

  finite(obj: JsonObject, key: string, pointer: string, fallback: number, min = -Infinity, max = Infinity): number {
    const value = this.r.number(obj, key, pointer);
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < min || value > max) {
      const range = max === Infinity ? `at least ${min}` : `between ${min} and ${max}`;
      this.report('PP1002', `"${key}" must be ${range}, got ${value}`, childPointer(pointer, key));
      return fallback;
    }
    return value;
  }

  bool(obj: JsonObject, key: string, pointer: string, fallback: boolean): boolean {
    return this.r.boolean(obj, key, pointer) ?? fallback;
  }

  vec3(obj: JsonObject, key: string, pointer: string, fallback: Vec3Tuple): Vec3Tuple {
    const v = this.r.numbers(obj, key, pointer, [3]);
    if (v === undefined) return fallback;
    if (!v.every(Number.isFinite)) {
      this.report('PP1002', `"${key}" must hold finite numbers`, childPointer(pointer, key));
      return fallback;
    }
    return [v[0]!, v[1]!, v[2]!];
  }

  /**
   * A rotation: Euler degrees [pitch, yaw, roll] (the convention `Transform.euler` and
   * scene/prefab `rotation` use), or a unit quaternion [x, y, z, w] (what exporters write).
   */
  quat(obj: JsonObject, key: string, pointer: string): QuatTuple {
    const v = this.r.numbers(obj, key, pointer, [3, 4]);
    if (v === undefined) return NO_ROTATION;
    if (!v.every(Number.isFinite)) {
      this.report('PP1002', `"${key}" must hold finite numbers`, childPointer(pointer, key));
      return NO_ROTATION;
    }
    if (v.length === 3) {
      const q = Quat.from_euler(new Vec3(v[0]!, v[1]!, v[2]!));
      return [q.x, q.y, q.z, q.w];
    }
    const length = Math.hypot(v[0]!, v[1]!, v[2]!, v[3]!);
    if (!(Math.abs(length - 1) < 1e-3)) {
      this.report('PP1002', `"${key}" must be Euler degrees [pitch, yaw, roll] or a unit quaternion [x, y, z, w], got a quaternion of length ${length}`,
        childPointer(pointer, key), 'Write [pitch, yaw, roll] in degrees, or a normalized quaternion in the engine\'s handedness.');
      return NO_ROTATION;
    }
    return [v[0]! / length, v[1]! / length, v[2]! / length, v[3]! / length];
  }

  color(obj: JsonObject, key: string, pointer: string, fallback: Rgba | undefined, emissive = false): Rgba | undefined {
    const value = obj[key];
    if (value === undefined) {
      if (fallback === undefined) this.report('PP1002', `Missing required "${key}" (a color)`, pointer);
      return fallback;
    }
    const at = childPointer(pointer, key);
    const parsed = parseColor(value);
    if (parsed === null) {
      this.report('PP1002', `"${key}" must be a color: ${COLOR_FORMS}`, at);
      return fallback;
    }
    const rgba: Rgba = [parsed.r, parsed.g, parsed.b, parsed.a];
    const top = emissive ? Infinity : 1;
    if (!rgba.every((c, i) => Number.isFinite(c) && c >= 0 && c <= (i === 3 ? 1 : top))) {
      this.report('PP1002', `"${key}" has a channel outside ${emissive ? '0 or more' : '0..1'}: [${rgba.join(', ')}]`, at);
      return fallback;
    }
    return rgba;
  }

  /** A texture map: an image under assets/ or a hosted image URL (canonical form); null: none. */
  map(obj: JsonObject, key: string, pointer: string): string | null {
    const value = obj[key];
    if (value === undefined || value === null) return null;
    const at = childPointer(pointer, key);
    if (typeof value !== 'string') {
      this.report('PP1002', `"${key}" must be an image path or a hosted image URL, got ${JSON.stringify(value)}`, at);
      return null;
    }
    if (isAssetUrl(value)) {
      const problem = remoteAssetProblem(value, 'images');
      if (problem !== undefined) {
        this.report('PP2063', `"${key}": ${problem}`, at, 'Use a hosted image URL (https://r2.parallaxpro.ai/assets/….jpg) or a project image ("assets/images/…png").');
        return null;
      }
      return remoteAssetUrl(value)!;
    }
    const lower = value.toLowerCase();
    if (!value.startsWith('assets/') || !REMOTE_EXTENSIONS['images']!.some((e) => lower.endsWith(e))) {
      this.report('PP2063', `"${key}" must name an image file under assets/ or a hosted image URL, got "${value}"`, at,
        'Write "assets/images/<file>.png" or "https://r2.parallaxpro.ai/assets/….jpg".');
      return null;
    }
    return value;
  }

  name(obj: JsonObject, pointer: string, what: string): string | undefined {
    const name = this.r.string(obj, 'name', pointer, true);
    if (name !== undefined && name === '') {
      this.report('PP1002', `${what} "name" can't be empty`, childPointer(pointer, 'name'));
      return undefined;
    }
    return name;
  }

  list(value: Json | undefined, pointer: string, what: string): readonly Json[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.report('PP1002', `${what} must be a list`, pointer);
      return [];
    }
    return value;
  }

  unknown(code: `PP${number}`, what: string, name: string, known: Iterable<string>, pointer: string): void {
    const list = [...known];
    const guess = closestMatch(name, list);
    this.report(code, `Unknown ${what} "${name}"`, pointer,
      guess !== undefined ? `Did you mean "${guess}"?` : list.length === 0 ? `The model has no ${what}s.` : `Known: ${list.slice(0, 12).join(', ')}${list.length > 12 ? ', …' : ''}.`);
  }
}

/** A material's keys (`partial`: an option choice — only the keys it names). */
function materialKeys(m: ModelReader, obj: JsonObject, pointer: string, partial: boolean): MaterialOverride {
  m.r.keys(obj, pointer, MATERIAL_KEYS, MATERIAL_RENAMES);
  const out: { -readonly [K in keyof MaterialOverride]: MaterialOverride[K] } = {};
  const has = (key: string): boolean => obj[key] !== undefined || !partial;
  const rgb = (c: Rgba): Rgb => [c[0], c[1], c[2]];
  if (has('color')) out.color = m.color(obj, 'color', pointer, partial ? [1, 1, 1, 1] : undefined) ?? [1, 1, 1, 1];
  if (has('metallic')) out.metallic = m.finite(obj, 'metallic', pointer, MATERIAL_DEFAULTS.metallic, 0, 1);
  if (has('roughness')) out.roughness = m.finite(obj, 'roughness', pointer, MATERIAL_DEFAULTS.roughness, 0, 1);
  if (has('emissive')) out.emissive = rgb(m.color(obj, 'emissive', pointer, [0, 0, 0, 1], true)!);
  if (has('emissive_strength')) out.emissiveStrength = m.finite(obj, 'emissive_strength', pointer, MATERIAL_DEFAULTS.emissiveStrength, 0);
  if (has('alpha')) {
    const alpha = m.r.string(obj, 'alpha', pointer) ?? 'opaque';
    if (!(ALPHA_MODES as readonly string[]).includes(alpha)) {
      m.report('PP1002', `"alpha" must be one of ${ALPHA_MODES.join(', ')}, got "${alpha}"`, childPointer(pointer, 'alpha'));
    } else {
      out.alpha = alpha as ModelMaterial['alpha'];
    }
  }
  if (has('alpha_cutoff')) out.alphaCutoff = m.finite(obj, 'alpha_cutoff', pointer, 0.5, 0, 1);
  if (has('double_sided')) out.doubleSided = m.bool(obj, 'double_sided', pointer, false);
  if (has('unlit')) out.unlit = m.bool(obj, 'unlit', pointer, false);
  if (has('clearcoat')) out.clearcoat = m.finite(obj, 'clearcoat', pointer, 0, 0, 1);
  if (has('clearcoat_roughness')) out.clearcoatRoughness = m.finite(obj, 'clearcoat_roughness', pointer, 0, 0, 1);
  if (has('transmission')) out.transmission = m.finite(obj, 'transmission', pointer, 0, 0, 1);
  if (has('subsurface')) out.subsurface = m.finite(obj, 'subsurface', pointer, 0, 0, 1);
  if (has('subsurface_color')) out.subsurfaceColor = rgb(m.color(obj, 'subsurface_color', pointer, [1, 1, 1, 1])!);
  if (has('anisotropy')) out.anisotropy = m.finite(obj, 'anisotropy', pointer, 0, -1, 1);
  if (has('anisotropy_rotation')) out.anisotropyRotation = m.finite(obj, 'anisotropy_rotation', pointer, 0);
  if (has('texture')) out.texture = m.map(obj, 'texture', pointer);
  if (has('normal_map')) out.normalMap = m.map(obj, 'normal_map', pointer);
  if (has('normal_strength')) out.normalStrength = m.finite(obj, 'normal_strength', pointer, MATERIAL_DEFAULTS.normalStrength, 0);
  return out;
}

function material(m: ModelReader, name: string, obj: JsonObject, pointer: string): ModelMaterial {
  return { name, ...(materialKeys(m, obj, pointer, false) as Omit<ModelMaterial, 'name'>) };
}

function buffer(m: ModelReader, obj: JsonObject, key: string, pointer: string, types: readonly ElementType[],
  per: number): Float32Array | Uint16Array | Uint32Array | null {
  const raw = obj[key];
  if (raw === undefined) return null;
  const at = childPointer(pointer, key);
  const decoded = typeof raw === 'string' ? decodeBuffer(raw) : undefined;
  if (decoded === undefined || !types.includes(decoded.type)) {
    m.report('PP2128', `"${key}" must be a base64 buffer written "${types.join(':…" or "')}:…"`, at,
      'Write every buffer in this form, or re-export the model.');
    return null;
  }
  if (decoded.values.length % per !== 0) {
    m.report('PP2128', `"${key}" holds ${decoded.values.length} numbers, not a multiple of ${per}`, at);
    return null;
  }
  return decoded.values;
}

function mesh(m: ModelReader, name: string, obj: JsonObject, pointer: string, bones: number): ModelMesh | undefined {
  m.r.keys(obj, pointer, MESH_KEYS);
  if (obj['positions'] === undefined) {
    m.report('PP1002', 'Missing required "positions" (a "f32:…" buffer)', pointer);
    return undefined;
  }
  const positions = buffer(m, obj, 'positions', pointer, ['f32'], 3) as Float32Array | null;
  if (positions === null) return undefined;
  const count = positions.length / 3;
  const normals = buffer(m, obj, 'normals', pointer, ['f32'], 3) as Float32Array | null;
  const uvs = buffer(m, obj, 'uvs', pointer, ['f32'], 2) as Float32Array | null;
  const indices = buffer(m, obj, 'indices', pointer, ['u16', 'u32'], 3) as Uint16Array | Uint32Array | null;
  const joints = buffer(m, obj, 'joints', pointer, ['u16'], 4) as Uint16Array | null;
  const weights = buffer(m, obj, 'weights', pointer, ['f32'], 4) as Float32Array | null;
  const fits = (values: ArrayLike<number> | null, key: string, n: number): void => {
    if (values !== null && values.length !== count * n) {
      m.report('PP2128', `"${key}" has ${values.length / n} entries for ${count} vertices`, childPointer(pointer, key));
    }
  };
  fits(normals, 'normals', 3);
  fits(uvs, 'uvs', 2);
  fits(joints, 'joints', 4);
  fits(weights, 'weights', 4);
  if (!positions.every(Number.isFinite)) m.report('PP2128', '"positions" holds a value that is not finite', childPointer(pointer, 'positions'));
  if (indices === null && count % 3 !== 0) m.report('PP2128', `${count} vertices without "indices" is not a whole number of triangles`, pointer);
  if (indices !== null) {
    const bad = indices.findIndex((i) => i >= count);
    if (bad !== -1) m.report('PP2128', `"indices" names vertex ${indices[bad]} of ${count}`, childPointer(pointer, 'indices'));
  }
  if ((joints === null) !== (weights === null)) {
    m.report('PP2128', `A skinned mesh needs both "joints" and "weights"; this one has only "${joints === null ? 'weights' : 'joints'}"`, pointer);
  }
  if (joints !== null) {
    const bad = joints.findIndex((j) => j >= bones);
    if (bad !== -1) {
      m.report('PP2128', `"joints" names bone ${joints[bad]}, but the skeleton has ${bones}`, childPointer(pointer, 'joints'),
        bones === 0 ? 'Add the "skeleton" this mesh is skinned to.' : undefined);
    }
  }
  return { name, positions, normals, uvs, indices, joints, weights };
}

function skeleton(m: ModelReader, value: Json | undefined): ModelSkeleton | null {
  if (value === undefined) return null;
  const obj = m.r.object(value, '/skeleton', '"skeleton"');
  if (obj === undefined) return null;
  m.r.keys(obj, '/skeleton', ['bones', 'inverse_bind']);
  const bones: ModelBone[] = [];
  m.list(obj['bones'], '/skeleton/bones', '"bones"').forEach((raw, i) => {
    const pointer = `/skeleton/bones/${i}`;
    const bone = m.r.object(raw, pointer, `bone ${i}`);
    if (bone === undefined) return;
    m.r.keys(bone, pointer, BONE_KEYS);
    const name = m.name(bone, pointer, 'A bone\'s') ?? `bone${i}`;
    let parent = -1;
    const p = bone['parent'];
    if (p !== undefined && p !== null) {
      if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p >= i) {
        m.report('PP2129', `Bone "${name}" has parent ${JSON.stringify(p)}; a parent is the index of an earlier bone, or null`, `${pointer}/parent`);
      } else {
        parent = p;
      }
    }
    bones.push({ name, parent, position: m.vec3(bone, 'position', pointer, ZERO), rotation: m.quat(bone, 'rotation', pointer), scale: m.vec3(bone, 'scale', pointer, ONE) });
  });
  if (bones.length === 0) m.report('PP2129', 'A skeleton needs at least one bone', '/skeleton/bones');
  if (obj['inverse_bind'] === undefined) {
    m.report('PP1002', 'Missing required "inverse_bind" (a "f32:…" buffer, 16 numbers per bone)', '/skeleton');
    return null;
  }
  const inverseBind = buffer(m, obj, 'inverse_bind', '/skeleton', ['f32'], 16) as Float32Array | null;
  if (inverseBind === null) return null;
  if (inverseBind.length !== bones.length * 16) {
    m.report('PP2128', `"inverse_bind" holds ${inverseBind.length / 16} matrices for ${bones.length} bones`, '/skeleton/inverse_bind');
  }
  return { bones, inverseBind };
}

interface Names {
  readonly parts: Map<string, number>;
  readonly bones: Map<string, number>;
}

function parentOf(m: ModelReader, value: Json | undefined, names: Names, pointer: string, what: string): ModelParent {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    m.report('PP1002', `${what} "parent" must be a part or bone name, or null`, pointer);
    return null;
  }
  const part = names.parts.get(value);
  if (part !== undefined) return { kind: 'part', index: part };
  const bone = names.bones.get(value);
  if (bone !== undefined) return { kind: 'bone', index: bone };
  m.unknown('PP2124', 'part or bone', value, [...names.parts.keys(), ...names.bones.keys()], pointer);
  return null;
}

function part(m: ModelReader, obj: JsonObject, pointer: string, names: Names, doc: {
  readonly materials: ReadonlyMap<string, ModelMaterial>; readonly meshes: ReadonlyMap<string, ModelMesh>;
  /** Every mesh name, broken ones too (already reported). */
  readonly meshNames: ReadonlySet<string>;
}): ModelPart | undefined {
  m.r.keys(obj, pointer, PART_KEYS);
  const name = m.name(obj, pointer, 'A part\'s');
  if (name === undefined) return undefined;
  const parent = parentOf(m, obj['parent'], names, `${pointer}/parent`, `Part "${name}"`);
  const meshName = m.r.string(obj, 'mesh', pointer);
  const shapeName = m.r.string(obj, 'shape', pointer);
  let draws: ModelPart['draws'] = null;
  let skinned = false;
  if (meshName !== undefined && shapeName !== undefined) {
    m.report('PP2129', `Part "${name}" has both "mesh" and "shape"; a part draws one of them`, pointer, 'Split it into two parts.');
  } else if (meshName !== undefined) {
    const found = doc.meshes.get(meshName);
    if (!doc.meshNames.has(meshName)) m.unknown('PP2126', 'mesh', meshName, doc.meshNames, `${pointer}/mesh`);
    else skinned = found?.joints !== null && found?.joints !== undefined;
    draws = { mesh: meshName };
  } else if (shapeName !== undefined) {
    if (!(MODEL_SHAPES as readonly string[]).includes(shapeName)) {
      m.report('PP1002', `"shape" must be one of ${MODEL_SHAPES.join(', ')}, got "${shapeName}"`, `${pointer}/shape`);
    } else {
      draws = { shape: shapeName as ModelShape };
    }
  }
  const materialName = m.r.string(obj, 'material', pointer);
  if (draws !== null && materialName === undefined) {
    m.report('PP1002', `Part "${name}" draws a ${'mesh' in draws ? 'mesh' : 'shape'} but has no "material"`, pointer);
  } else if (draws === null && materialName !== undefined) {
    m.report('PP2129', `Part "${name}" has a "material" but draws nothing`, `${pointer}/material`, 'Give it a "mesh" or "shape", or remove "material".');
  }
  if (materialName !== undefined && !doc.materials.has(materialName)) m.unknown('PP2125', 'material', materialName, doc.materials.keys(), `${pointer}/material`);
  if (draws === null && obj['size'] !== undefined) {
    m.report('PP2129', `Part "${name}" has a "size" but draws nothing`, `${pointer}/size`);
  }
  const size = m.vec3(obj, 'size', pointer, ONE);
  if (!size.every((s) => s > 0)) m.report('PP1002', `Part "${name}" "size" must be above 0 on every axis`, `${pointer}/size`);
  let uvScale: readonly [number, number] = [1, 1];
  if (obj['uv_scale'] !== undefined) {
    const uv = m.r.numbers(obj, 'uv_scale', pointer, [2]);
    if (draws === null) m.report('PP2129', `Part "${name}" has a "uv_scale" but draws nothing`, `${pointer}/uv_scale`);
    else if (uv !== undefined && !uv.every((n) => Number.isFinite(n) && n > 0)) {
      m.report('PP1002', `Part "${name}" "uv_scale" must be two numbers above 0`, `${pointer}/uv_scale`);
    } else if (uv !== undefined) uvScale = [uv[0]!, uv[1]!];
  }
  const position = m.vec3(obj, 'position', pointer, ZERO);
  const rotation = m.quat(obj, 'rotation', pointer);
  const scale = m.vec3(obj, 'scale', pointer, ONE);
  if (!scale.every((s) => s > 0)) {
    m.report('PP1002', `Part "${name}" "scale" must be above 0 on every axis`, `${pointer}/scale`, 'Mirror a part with a rotation, or mirror its mesh.');
  }
  if (skinned) {
    const placed = parent !== null || obj['position'] !== undefined || obj['rotation'] !== undefined || obj['scale'] !== undefined
      || obj['size'] !== undefined;
    if (placed) {
      m.report('PP2129', `Part "${name}" draws a skinned mesh, which is in model space: it can't have a parent, a transform or a size`, pointer,
        'Remove its "parent", "position", "rotation", "scale" and "size" (the skeleton places it).');
    }
  }
  return {
    name, parent, position, rotation, scale, draws, size, material: materialName ?? null, uvScale,
    castShadows: m.bool(obj, 'cast_shadows', pointer, true), hidden: m.bool(obj, 'hidden', pointer, false), skinned,
  };
}

function joint(m: ModelReader, obj: JsonObject, pointer: string, names: Names): ModelJoint | undefined {
  m.r.keys(obj, pointer, JOINT_KEYS);
  const name = m.name(obj, pointer, 'A joint\'s');
  const partName = m.r.string(obj, 'part', pointer, true);
  const type = m.r.string(obj, 'type', pointer, true);
  if (name === undefined || partName === undefined || type === undefined) return undefined;
  const part = names.parts.get(partName);
  if (part === undefined) {
    m.unknown('PP2124', 'part', partName, names.parts.keys(), `${pointer}/part`);
    return undefined;
  }
  if (!(JOINT_TYPES as readonly string[]).includes(type)) {
    m.report('PP1002', `"type" must be one of ${JOINT_TYPES.join(', ')}, got "${type}"`, `${pointer}/type`);
    return undefined;
  }
  const kind = m.r.string(obj, 'kind', pointer) ?? 'pose';
  if (kind !== 'pose' && kind !== 'aperture') m.report('PP1002', `"kind" must be "pose" or "aperture", got "${kind}"`, `${pointer}/kind`);
  if (obj['axis'] === undefined) m.report('PP1002', 'Missing required "axis" (a list of 3 numbers)', pointer);
  const raw = m.vec3(obj, 'axis', pointer, ZERO);
  const length = Math.hypot(raw[0], raw[1], raw[2]);
  if (obj['axis'] !== undefined && !(length > 0)) m.report('PP2129', `Joint "${name}" has a zero "axis"`, `${pointer}/axis`);
  const axis: Vec3Tuple = length > 0 ? [raw[0] / length, raw[1] / length, raw[2] / length] : [0, 1, 0];
  let limits: [number, number] | null = null;
  const rawLimits = obj['limits'];
  if (rawLimits !== undefined && rawLimits !== null) {
    const l = m.r.numbers(obj, 'limits', pointer, [2]);
    if (l !== undefined) {
      if (!(Number.isFinite(l[0]) && Number.isFinite(l[1]) && l[0]! <= l[1]!)) {
        m.report('PP2129', `Joint "${name}" has limits [${l.join(', ')}]; they must be finite, the lower first`, `${pointer}/limits`);
      } else {
        limits = [l[0]!, l[1]!];
      }
    }
  } else if (type !== 'hinge') {
    m.report('PP2129', `The ${type} joint "${name}" needs "limits"`, pointer, 'Only a hinge may turn without limits.');
  }
  if (type === 'scale' && limits !== null && !(limits[0] > 0)) {
    m.report('PP2129', `The scale joint "${name}" has limits [${limits.join(', ')}]; scale factors must be above 0`, `${pointer}/limits`);
  }
  const fallback = type === 'scale' ? 1 : 0;
  const value = m.finite(obj, 'default', pointer, fallback);
  if (limits !== null && (value < limits[0] || value > limits[1])) {
    m.report('PP2129', `Joint "${name}" has default ${value}, outside its limits [${limits.join(', ')}]`, `${pointer}/default`);
  }
  const defaultValue = obj['default'] === undefined && limits !== null ? Math.min(limits[1], Math.max(limits[0], fallback)) : value;
  return {
    name, part, type: type as JointType, kind: kind === 'aperture' ? 'aperture' : 'pose', axis, limits, default: defaultValue,
    duration: m.finite(obj, 'duration', pointer, 0.5, 0),
  };
}

function socket(m: ModelReader, obj: JsonObject, pointer: string, names: Names): ModelSocket | undefined {
  m.r.keys(obj, pointer, SOCKET_KEYS);
  const name = m.name(obj, pointer, 'A socket\'s');
  if (name === undefined) return undefined;
  let limit: number | null = null;
  if (obj['limit'] !== undefined && obj['limit'] !== null) {
    const l = obj['limit'];
    if (typeof l !== 'number' || !Number.isInteger(l) || l < 1) m.report('PP1002', '"limit" must be a whole number of at least 1', `${pointer}/limit`);
    else limit = l;
  }
  return {
    name,
    parent: parentOf(m, obj['parent'], names, `${pointer}/parent`, `Socket "${name}"`),
    position: m.vec3(obj, 'position', pointer, ZERO),
    rotation: m.quat(obj, 'rotation', pointer),
    kind: m.r.string(obj, 'kind', pointer) ?? null,
    accepts: obj['accepts'] === undefined ? null : m.r.strings(obj, 'accepts', pointer),
    limit,
  };
}

function option(m: ModelReader, obj: JsonObject, pointer: string, names: Names,
  materials: ReadonlyMap<string, ModelMaterial>): ModelOption | undefined {
  const isMaterial = obj['materials'] !== undefined;
  m.r.keys(obj, pointer, ['name', 'default', isMaterial ? 'materials' : 'parts', 'choices']);
  const name = m.name(obj, pointer, 'An option\'s');
  const fallback = m.r.string(obj, 'default', pointer, true);
  const choicesRaw = m.r.object(obj['choices'] ?? null, `${pointer}/choices`, `Option "${name ?? '?'}" "choices"`);
  if (name === undefined || fallback === undefined || choicesRaw === undefined) return undefined;
  if (Object.keys(choicesRaw).length === 0) m.report('PP2129', `Option "${name}" has no choices`, `${pointer}/choices`);
  if (!(fallback in choicesRaw)) m.unknown('PP2123', `choice of "${name}"`, fallback, Object.keys(choicesRaw), `${pointer}/default`);
  if (isMaterial) {
    const slots = m.r.strings(obj, 'materials', pointer);
    slots.forEach((slot, i) => {
      if (!materials.has(slot)) m.unknown('PP2125', 'material', slot, materials.keys(), `${pointer}/materials/${i}`);
    });
    if (slots.length === 0) m.report('PP2129', `Option "${name}" changes no materials`, `${pointer}/materials`);
    const choices = new Map<string, MaterialOverride>();
    for (const [choice, raw] of Object.entries(choicesRaw)) {
      const at = childPointer(`${pointer}/choices`, choice);
      const def = m.r.object(raw, at, `Choice "${choice}"`);
      if (def !== undefined) choices.set(choice, materialKeys(m, def, at, true));
    }
    return { name, kind: 'material', default: fallback, materials: slots, choices };
  }
  if (obj['parts'] === undefined) {
    m.report('PP1002', `Option "${name}" needs "materials" (a material option) or "parts" (a part-set option)`, pointer);
    return undefined;
  }
  const indexOf = (part: string, at: string): number | undefined => {
    const i = names.parts.get(part);
    if (i === undefined) m.unknown('PP2124', 'part', part, names.parts.keys(), at);
    return i;
  };
  const switched = m.r.strings(obj, 'parts', pointer).flatMap((p, i) => {
    const index = indexOf(p, `${pointer}/parts/${i}`);
    return index === undefined ? [] : [index];
  });
  const choices = new Map<string, readonly number[]>();
  for (const [choice, raw] of Object.entries(choicesRaw)) {
    const at = childPointer(`${pointer}/choices`, choice);
    if (!Array.isArray(raw) || !raw.every((p) => typeof p === 'string')) {
      m.report('PP1002', `Choice "${choice}" must be a list of the part names it shows`, at);
      continue;
    }
    const shown: number[] = [];
    (raw as readonly string[]).forEach((p, i) => {
      const index = indexOf(p, `${at}/${i}`);
      if (index === undefined) return;
      if (!switched.includes(index)) m.report('PP2129', `Choice "${choice}" shows "${p}", which isn't one of the option's "parts"`, `${at}/${i}`);
      shown.push(index);
    });
    choices.set(choice, shown);
  }
  return { name, kind: 'parts', default: fallback, parts: switched, choices };
}

/** Parse a model document. `path` names it in diagnostics and becomes `ModelDocument.path`. */
export function parseModelDocument(path: string, text: string): ParsedModel {
  const m = new ModelReader(path);
  const json = m.r.parse(text);
  if (json === undefined) return { document: undefined, diagnostics: m.diagnostics };
  if (!isObject(json)) {
    m.report('PP2120', 'A model document must be a JSON object', '');
    return { document: undefined, diagnostics: m.diagnostics };
  }
  if (json['format'] !== MODEL_FORMAT || json['version'] !== MODEL_VERSION) {
    m.report('PP2120', `This is not a ${MODEL_FORMAT} version ${MODEL_VERSION} document (format ${JSON.stringify(json['format'] ?? null)}, version ${JSON.stringify(json['version'] ?? null)})`, '',
      `Model documents start with "format": "${MODEL_FORMAT}", "version": ${MODEL_VERSION}.`);
    return { document: undefined, diagnostics: m.diagnostics };
  }
  m.r.keys(json, '', ROOT_KEYS);
  const source = m.r.string(json, 'source', '') ?? null;
  const provides = m.r.strings(json, 'provides', '');

  const materials = new Map<string, ModelMaterial>();
  if (json['materials'] === undefined) m.report('PP1002', 'Missing required "materials" (an object of named materials)', '');
  for (const [name, obj] of Object.entries(m.r.objectMap(json, 'materials', ''))) materials.set(name, material(m, name, obj, childPointer('/materials', name)));

  const skel = skeleton(m, json['skeleton']);
  const meshes = new Map<string, ModelMesh>();
  const meshObjects = m.r.objectMap(json, 'meshes', '');
  const meshNames = new Set(Object.keys(meshObjects));
  for (const [name, obj] of Object.entries(meshObjects)) {
    const made = mesh(m, name, obj, childPointer('/meshes', name), skel?.bones.length ?? 0);
    if (made !== undefined) meshes.set(name, made);
  }

  const names: Names = { parts: new Map(), bones: new Map() };
  skel?.bones.forEach((bone, i) => {
    if (names.bones.has(bone.name)) m.report('PP2127', `Two bones are named "${bone.name}"`, `/skeleton/bones/${i}/name`);
    names.bones.set(bone.name, i);
  });
  if (json['parts'] === undefined) m.report('PP1002', 'Missing required "parts" (a list)', '');
  const parts: ModelPart[] = [];
  m.list(json['parts'], '/parts', '"parts"').forEach((raw, i) => {
    const pointer = `/parts/${i}`;
    const obj = m.r.object(raw, pointer, `part ${i}`);
    if (obj === undefined) return;
    const made = part(m, obj, pointer, names, { materials, meshes, meshNames });
    if (made === undefined) return;
    if (names.parts.has(made.name) || names.bones.has(made.name)) {
      m.report('PP2127', `"${made.name}" names two ${names.bones.has(made.name) ? 'things (a part and a bone)' : 'parts'}`, `${pointer}/name`,
        'Part and bone names are unique in a model: code and data find them by name.');
      return;
    }
    names.parts.set(made.name, parts.length);
    parts.push(made);
  });

  const joints = new Map<string, ModelJoint>();
  m.list(json['joints'], '/joints', '"joints"').forEach((raw, i) => {
    const pointer = `/joints/${i}`;
    const obj = m.r.object(raw, pointer, `joint ${i}`);
    const made = obj === undefined ? undefined : joint(m, obj, pointer, names);
    if (made === undefined) return;
    if (joints.has(made.name)) m.report('PP2127', `Two joints are named "${made.name}"`, `${pointer}/name`);
    else if ([...joints.values()].some((j) => j.part === made.part && j.type === made.type)) {
      m.report('PP2129', `Joint "${made.name}" is a second ${made.type} on part "${parts[made.part]!.name}"`, `${pointer}/part`,
        'Give each motion its own pivot part (a parent group): one joint of a kind per part.');
    } else joints.set(made.name, made);
  });

  const sockets = new Map<string, ModelSocket>();
  m.list(json['sockets'], '/sockets', '"sockets"').forEach((raw, i) => {
    const pointer = `/sockets/${i}`;
    const obj = m.r.object(raw, pointer, `socket ${i}`);
    const made = obj === undefined ? undefined : socket(m, obj, pointer, names);
    if (made === undefined) return;
    if (sockets.has(made.name)) m.report('PP2127', `Two sockets are named "${made.name}"`, `${pointer}/name`);
    else sockets.set(made.name, made);
  });

  const options = new Map<string, ModelOption>();
  m.list(json['options'], '/options', '"options"').forEach((raw, i) => {
    const pointer = `/options/${i}`;
    const obj = m.r.object(raw, pointer, `option ${i}`);
    const made = obj === undefined ? undefined : option(m, obj, pointer, names, materials);
    if (made === undefined) return;
    if (options.has(made.name)) m.report('PP2127', `Two options are named "${made.name}"`, `${pointer}/name`);
    else options.set(made.name, made);
  });
  if (m.failed) return { document: undefined, diagnostics: m.diagnostics };
  return {
    document: {
      path, source, provides, materials, meshes, skeleton: skel, parts, partByName: names.parts, boneByName: names.bones, joints, sockets, options,
    },
    diagnostics: m.diagnostics,
  };
}

