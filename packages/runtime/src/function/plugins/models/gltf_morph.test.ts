import { describe, expect, it } from 'vitest';
import { ParallaxError } from '../../../core/index.js';
import { buildModel } from '../../../resource/index.js';
import type { GltfJson } from '../../../resource/index.js';

/** A triangle with two morph targets (one dense, one sparse) and a clip that drives their weights. */
function morphed(extra: { nodeWeights?: number[]; withNormals?: boolean } = {}): { json: GltfJson; bin: Uint8Array } {
  const parts: ArrayBufferView[] = [];
  const views: { buffer: number; byteOffset: number; byteLength: number }[] = [];
  let length = 0;
  const view = (data: Float32Array | Uint16Array): number => {
    const pad = (4 - (length % 4)) % 4;
    if (pad > 0) { parts.push(new Uint8Array(pad)); length += pad; }
    views.push({ buffer: 0, byteOffset: length, byteLength: data.byteLength });
    parts.push(data);
    length += data.byteLength;
    return views.length - 1;
  };
  const accessors: object[] = [];
  const accessor = (data: Float32Array | Uint16Array, type: string, count: number, more: object = {}): number => {
    accessors.push({ bufferView: view(data), componentType: data instanceof Float32Array ? 5126 : 5123, count, type, ...more });
    return accessors.length - 1;
  };
  const position = accessor(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 'VEC3', 3, { min: [0, 0, 0], max: [1, 1, 0] });
  const normal = accessor(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 'VEC3', 3);
  const indices = accessor(new Uint16Array([0, 1, 2]), 'SCALAR', 3);
  const dense = accessor(new Float32Array([0.5, 0, 0, 0, 0, 0, 0, 0, 0]), 'VEC3', 3);
  const denseNormal = accessor(new Float32Array([1, 0, 0, 0, 0, 0, 0, 0, 0]), 'VEC3', 3);
  // Sparse: only vertex 2 moves, by (0, 0, 2).
  accessors.push({
    componentType: 5126, count: 3, type: 'VEC3',
    sparse: { count: 1, indices: { bufferView: view(new Uint16Array([2, 0])), componentType: 5123 }, values: { bufferView: view(new Float32Array([0, 0, 2])) } },
  });
  const sparse = accessors.length - 1;
  const times = accessor(new Float32Array([0, 1]), 'SCALAR', 2, { min: [0], max: [1] });
  const weights = accessor(new Float32Array([0, 0, 1, 0.5]), 'SCALAR', 4);
  const bin = new Uint8Array(length);
  let at = 0;
  for (const p of parts) { bin.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), at); at += p.byteLength; }
  const json: GltfJson = {
    asset: { version: '2.0' },
    nodes: [{ name: 'face', mesh: 0, ...(extra.nodeWeights !== undefined && { weights: extra.nodeWeights }) }],
    meshes: [{
      primitives: [{
        attributes: { POSITION: position, ...(extra.withNormals !== false && { NORMAL: normal }) }, indices,
        targets: [{ POSITION: dense, NORMAL: denseNormal }, { POSITION: sparse }],
      }],
      weights: [0.25, 0],
      extras: { targetNames: ['smile', 'blink'] },
    }],
    accessors: accessors as GltfJson['accessors'],
    bufferViews: views,
    buffers: [{ byteLength: length }],
    animations: [{ name: 'talk', channels: [{ sampler: 0, target: { node: 0, path: 'weights' } }], samplers: [{ input: times, output: weights }] }],
  };
  return { json, bin };
}

/** Plain numbers (-0 becomes 0) for comparison. */
const plain = (a: Float32Array): number[] => [...a].map((v) => v + 0);

describe('glTF morph targets', () => {
  it('read targets as deltas in engine handedness, sparse ones included, with their names', () => {
    const { json, bin } = morphed();
    const model = buildModel('assets/models/face.gltf', json, [bin]);
    expect(model.warnings).toEqual([]);
    const morphs = model.meshes[0]![0]!.morphs!;
    expect(morphs.names).toEqual(['smile', 'blink']);
    // Mirrored across x like the positions.
    expect(plain(morphs.positions[0]!)).toEqual([-0.5, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(plain(morphs.normals[0]!)).toEqual([-1, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(plain(morphs.positions[1]!)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 2]);
    expect(morphs.normals[1]).toBeNull();
  });

  it('give nodes their default weights: the node\'s, else the mesh\'s', () => {
    const { json, bin } = morphed();
    expect(buildModel('a.gltf', json, [bin]).nodes[0]!.weights).toEqual([0.25, 0]);
    const own = morphed({ nodeWeights: [0, 1] });
    expect(buildModel('a.gltf', own.json, [own.bin]).nodes[0]!.weights).toEqual([0, 1]);
    const wrong = morphed({ nodeWeights: [1] });
    expect(() => buildModel('a.gltf', wrong.json, [wrong.bin])).toThrow(ParallaxError);
  });

  it('read weight animation channels as clips\' morph channels', () => {
    const { json, bin } = morphed();
    const clip = buildModel('a.gltf', json, [bin]).clips.get('talk')!;
    expect(clip.channels).toEqual([]);
    expect(clip.duration).toBe(1);
    const channel = clip.morphChannels![0]!;
    expect(channel).toMatchObject({ node: 0, count: 2, interpolation: 'LINEAR' });
    expect([...channel.values]).toEqual([0, 0, 1, 0.5]);
  });

  it('follow flat-shaded geometry\'s vertex order', () => {
    const { json, bin } = morphed({ withNormals: false });
    const model = buildModel('a.gltf', json, [bin]);
    const g = model.meshes[0]![0]!.geometry;
    const morphs = model.meshes[0]![0]!.morphs!;
    expect(morphs.positions[0]!.length).toBe(g.positions.length);
    // One vertex per triangle corner, in the source triangle's order (the winding flips in the indices).
    expect(plain(morphs.positions[1]!)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 2]);
  });
});

describe('normal and occlusion maps', () => {
  it('fill Material3d.normalTexture/normalScale and occlusionTexture/occlusionStrength as linear data', () => {
    const { json, bin } = morphed();
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const withMaps: GltfJson = {
      ...json,
      images: [{ uri: png }, { uri: png }],
      textures: [{ source: 0 }, { source: 1 }],
      materials: [{ normalTexture: { index: 0, scale: 0.5 }, occlusionTexture: { index: 1, strength: 0.25 } }],
      meshes: json.meshes!.map((m) => ({ ...m, primitives: m.primitives.map((p) => ({ ...p, material: 0 })) })),
    };
    const material = buildModel('assets/models/face.glb', withMaps, [bin]).meshes[0]![0]!.material;
    expect(material.normalTexture?.colorSpace).toBe('linear');
    expect(material.normalScale).toBe(0.5);
    expect(material.occlusionTexture?.colorSpace).toBe('linear');
    expect(material.occlusionStrength).toBe(0.25);
    const plain = buildModel('assets/models/face.glb', json, [bin]).meshes[0]![0]!.material;
    expect(plain.normalTexture ?? null).toBe(null);
    expect(plain.occlusionTexture ?? null).toBe(null);
  });
});
