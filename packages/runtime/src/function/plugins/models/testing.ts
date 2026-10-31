/**
 * Writes small glTF 2.0 binaries (.glb) from plain arrays — fixtures for the loader's tests
 * and stand-in models for headless runs of projects whose model files aren't present.
 * Values are glTF's own (right-handed, linear colors); the loader converts them.
 */

export interface GlbMesh {
  readonly positions: readonly number[];
  readonly normals?: readonly number[];
  readonly uvs?: readonly number[];
  readonly indices?: readonly number[];
  readonly joints?: readonly number[];
  readonly weights?: readonly number[];
  readonly material?: number;
  /** Morph targets: position (and optionally normal) deltas per vertex, glTF handedness. */
  readonly targets?: readonly { readonly positions: readonly number[]; readonly normals?: readonly number[] }[];
  readonly targetNames?: readonly string[];
}

export interface GlbNode {
  readonly name?: string;
  readonly children?: readonly number[];
  readonly translation?: readonly number[];
  readonly rotation?: readonly number[];
  readonly scale?: readonly number[];
  readonly matrix?: readonly number[];
  readonly mesh?: number;
  readonly skin?: number;
  readonly extras?: Readonly<Record<string, unknown>>;
}

export interface GlbChannel {
  readonly node: number;
  readonly path: 'translation' | 'rotation' | 'scale' | 'weights';
  readonly times: readonly number[];
  readonly values: readonly number[];
  readonly interpolation?: 'LINEAR' | 'STEP' | 'CUBICSPLINE';
}

export interface GlbSpec {
  readonly nodes: readonly GlbNode[];
  readonly meshes?: readonly GlbMesh[];
  readonly materials?: readonly object[];
  readonly skins?: readonly { readonly joints: readonly number[]; readonly inverseBind?: readonly number[] }[];
  readonly animations?: readonly { readonly name: string; readonly channels: readonly GlbChannel[] }[];
  /** Embedded images (one texture each, texture i = image i). */
  readonly images?: readonly { readonly bytes: Uint8Array; readonly mimeType: string }[];
  readonly extensionsRequired?: readonly string[];
}

class BinWriter {
  readonly chunks: Uint8Array[] = [];
  length = 0;
  readonly bufferViews: object[] = [];
  readonly accessors: object[] = [];

  #view(bytes: Uint8Array): number {
    const pad = (4 - (this.length % 4)) % 4;
    if (pad > 0) { this.chunks.push(new Uint8Array(pad)); this.length += pad; }
    this.bufferViews.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.byteLength });
    this.chunks.push(bytes);
    this.length += bytes.byteLength;
    return this.bufferViews.length - 1;
  }

  bytes(bytes: Uint8Array): number {
    return this.#view(bytes);
  }

  accessor(values: readonly number[], type: string, componentType: 5126 | 5123 | 5125 = 5126, extra: object = {}): number {
    const array = componentType === 5126 ? new Float32Array(values) : componentType === 5123 ? new Uint16Array(values) : new Uint32Array(values);
    const view = this.#view(new Uint8Array(array.buffer));
    const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type]!;
    this.accessors.push({ bufferView: view, componentType, count: values.length / width, type, ...extra });
    return this.accessors.length - 1;
  }

  bin(): Uint8Array {
    const out = new Uint8Array(this.length);
    let at = 0;
    for (const chunk of this.chunks) { out.set(chunk, at); at += chunk.byteLength; }
    return out;
  }
}

/** The glTF JSON and binary buffer for a spec. */
export function gltfParts(spec: GlbSpec): { readonly json: Record<string, unknown>; readonly bin: Uint8Array } {
  const w = new BinWriter();
  const meshes = (spec.meshes ?? []).map((mesh) => {
    const attributes: Record<string, number> = {};
    const min = [0, 1, 2].map((k) => Math.min(...mesh.positions.filter((_, i) => i % 3 === k)));
    const max = [0, 1, 2].map((k) => Math.max(...mesh.positions.filter((_, i) => i % 3 === k)));
    attributes['POSITION'] = w.accessor(mesh.positions, 'VEC3', 5126, { min, max });
    if (mesh.normals !== undefined) attributes['NORMAL'] = w.accessor(mesh.normals, 'VEC3');
    if (mesh.uvs !== undefined) attributes['TEXCOORD_0'] = w.accessor(mesh.uvs, 'VEC2');
    if (mesh.joints !== undefined) attributes['JOINTS_0'] = w.accessor(mesh.joints, 'VEC4', 5123);
    if (mesh.weights !== undefined) attributes['WEIGHTS_0'] = w.accessor(mesh.weights, 'VEC4');
    const targets = (mesh.targets ?? []).map((t) => ({
      POSITION: w.accessor(t.positions, 'VEC3'),
      ...(t.normals !== undefined && { NORMAL: w.accessor(t.normals, 'VEC3') }),
    }));
    return {
      primitives: [{
        attributes,
        ...(mesh.indices !== undefined && { indices: w.accessor(mesh.indices, 'SCALAR', 5123) }),
        ...(mesh.material !== undefined && { material: mesh.material }),
        ...(targets.length > 0 && { targets }),
      }],
      ...(mesh.targetNames !== undefined && { extras: { targetNames: mesh.targetNames } }),
    };
  });
  const skins = (spec.skins ?? []).map((skin) => ({
    joints: skin.joints,
    ...(skin.inverseBind !== undefined && { inverseBindMatrices: w.accessor(skin.inverseBind, 'MAT4') }),
  }));
  const animations = (spec.animations ?? []).map((animation) => {
    const samplers: object[] = [];
    const channels = animation.channels.map((c, i) => {
      samplers.push({
        input: w.accessor(c.times, 'SCALAR', 5126, { min: [Math.min(...c.times)], max: [Math.max(...c.times)] }),
        output: w.accessor(c.values, c.path === 'rotation' ? 'VEC4' : c.path === 'weights' ? 'SCALAR' : 'VEC3'),
        interpolation: c.interpolation ?? 'LINEAR',
      });
      return { sampler: i, target: { node: c.node, path: c.path } };
    });
    return { name: animation.name, channels, samplers };
  });
  const images = (spec.images ?? []).map((image) => ({ bufferView: w.bytes(image.bytes), mimeType: image.mimeType }));
  const bin = w.bin();
  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'parallax render3d testing' },
    scene: 0,
    scenes: [{ nodes: spec.nodes.map((_, i) => i).filter((i) => !spec.nodes.some((n) => n.children?.includes(i))) }],
    nodes: spec.nodes,
    meshes,
    materials: spec.materials ?? [],
    skins,
    animations,
    images,
    textures: images.map((_, i) => ({ source: i })),
    accessors: w.accessors,
    bufferViews: w.bufferViews,
    buffers: [{ byteLength: bin.byteLength }],
    ...(spec.extensionsRequired !== undefined && { extensionsRequired: spec.extensionsRequired, extensionsUsed: spec.extensionsRequired }),
  };
  return { json, bin };
}

/** A .glb file for a spec. */
export function writeGlb(spec: GlbSpec): Uint8Array {
  const { json, bin } = gltfParts(spec);
  let text = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (text.byteLength % 4)) % 4;
  if (jsonPad > 0) {
    const padded = new Uint8Array(text.byteLength + jsonPad).fill(0x20);
    padded.set(text);
    text = padded;
  }
  const binPad = (4 - (bin.byteLength % 4)) % 4;
  const total = 12 + 8 + text.byteLength + 8 + bin.byteLength + binPad;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, text.byteLength, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(text, 20);
  const binAt = 20 + text.byteLength;
  view.setUint32(binAt, bin.byteLength + binPad, true);
  view.setUint32(binAt + 4, 0x004e4942, true);
  out.set(bin, binAt + 8);
  return out;
}

/**
 * A stand-in character: a 1 m box skinned to two joints ("root" and "upper", the upper
 * half following "upper"), with one clip per name that swings "upper" about z over
 * `seconds`.
 */
export function standInCharacter(clips: readonly string[], seconds = 1): Uint8Array {
  const positions: number[] = [];
  const normals: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  const indices: number[] = [];
  const faces: [number[], number[], number[]][] = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[-1, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, -1, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, -1], [0, 1, 0], [1, 0, 0]],
  ];
  for (const [n, u, v] of faces) {
    const first = positions.length / 3;
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      const p = [0, 1, 2].map((k) => n[k]! * 0.5 + u[k]! * a * 0.5 + v[k]! * b * 0.5);
      positions.push(p[0]!, p[1]! + 0.5, p[2]!);
      normals.push(...n);
      const upper = p[1]! > 0;
      joints.push(upper ? 1 : 0, 0, 0, 0);
      weights.push(1, 0, 0, 0);
    }
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  const swing = (deg: number): number[] => [0, 0, Math.sin((deg * Math.PI) / 360), Math.cos((deg * Math.PI) / 360)];
  return writeGlb({
    nodes: [
      { name: 'body', mesh: 0, skin: 0 },
      { name: 'root', children: [2] },
      { name: 'upper', translation: [0, 0.5, 0] },
    ],
    meshes: [{ positions, normals, joints, weights, indices, material: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.8, 0.8, 0.8, 1], metallicFactor: 0, roughnessFactor: 0.7 } }],
    skins: [{ joints: [1, 2], inverseBind: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -0.5, 0, 1] }],
    animations: clips.map((name) => ({
      name,
      channels: [{ node: 2, path: 'rotation' as const, times: [0, seconds / 2, seconds], values: [...swing(0), ...swing(30), ...swing(0)] }],
    })),
  });
}
