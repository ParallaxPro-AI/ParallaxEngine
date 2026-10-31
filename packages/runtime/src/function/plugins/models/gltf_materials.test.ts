import { describe, expect, it } from 'vitest';
import { ParallaxError } from '../../../core/index.js';
import { buildModel, readContainer } from '../../../resource/index.js';
import type { GltfJson, ModelAsset } from '../../../resource/index.js';
import { gltfParts, writeGlb } from './testing.js';

// The smallest WebP the tests need: a RIFF/WEBP header (the loader never decodes it; the browser does).
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0x1a, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 0x0d, 0, 0, 0, 0x2f, 0, 0, 0, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0]);
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

const TRIANGLE_UV = {
  nodes: [{ mesh: 0 }],
  meshes: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1], uvs: [0, 0, 1, 0, 0, 1], indices: [0, 1, 2], material: 0 }],
};

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof ParallaxError) return e.diagnostic.code;
    throw e;
  }
  return 'no error';
}

/** Build a model from a spec's parts after `edit` rewrites its JSON, through the .glb container like a real file. */
function build(edit: (json: Record<string, unknown>) => void, spec: Parameters<typeof gltfParts>[0] = TRIANGLE_UV): ModelAsset {
  const { json, bin } = gltfParts(spec);
  edit(json);
  const { json: read } = readContainer('m.glb', glbOf(json, bin));
  return buildModel('m.glb', read, [bin]);
}

function glbOf(json: Record<string, unknown>, bin: Uint8Array): Uint8Array {
  // writeGlb only takes a spec; rebuild the container around edited JSON.
  const text = new TextEncoder().encode(JSON.stringify(json).padEnd(Math.ceil(JSON.stringify(json).length / 4) * 4, ' '));
  const binPad = (4 - (bin.byteLength % 4)) % 4;
  const out = new Uint8Array(12 + 8 + text.byteLength + 8 + bin.byteLength + binPad);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, out.byteLength, true);
  view.setUint32(12, text.byteLength, true); view.setUint32(16, 0x4e4f534a, true); out.set(text, 20);
  const at = 20 + text.byteLength;
  view.setUint32(at, bin.byteLength + binPad, true); view.setUint32(at + 4, 0x004e4942, true); out.set(bin, at + 8);
  return out;
}

const uvsOf = (model: ModelAsset): number[] => [...model.meshes[0]![0]!.geometry.uvs].map((x) => Number(x.toFixed(5)));

describe('glTF textures', () => {
  it('reads EXT_texture_webp (the shape of the cargo plane and boat glbs: webp only, extension required)', () => {
    const model = build((json) => {
      json['textures'] = [{ extensions: { EXT_texture_webp: { source: 0 } } }, { extensions: { EXT_texture_webp: { source: 1 } } }];
      json['extensionsUsed'] = json['extensionsRequired'] = ['EXT_texture_webp'];
      json['materials'] = [{
        pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicRoughnessTexture: { index: 1 }, metallicFactor: 1, roughnessFactor: 1 },
        alphaMode: 'OPAQUE',
      }];
    }, { ...TRIANGLE_UV, images: [{ bytes: WEBP, mimeType: 'image/webp' }, { bytes: WEBP, mimeType: 'image/webp' }] });
    const material = model.meshes[0]![0]!.material;
    const base = material.baseColorTexture!;
    expect(base.source.kind === 'bytes' && base.source.mimeType).toBe('image/webp');
    expect(base.source.kind === 'bytes' && [...base.source.bytes.subarray(8, 12)]).toEqual([0x57, 0x45, 0x42, 0x50]);
    expect(material.metallicRoughnessTexture?.colorSpace).toBe('linear');
    expect(model.warnings).toEqual([]);
  });

  it('prefers the webp source over the fallback `source`', () => {
    const model = build((json) => {
      json['textures'] = [{ source: 1, extensions: { EXT_texture_webp: { source: 0 } } }];
      json['materials'] = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
    }, { ...TRIANGLE_UV, images: [{ bytes: WEBP, mimeType: 'image/webp' }, { bytes: PNG, mimeType: 'image/png' }] });
    const base = model.meshes[0]![0]!.material.baseColorTexture!;
    expect(base.source.kind === 'bytes' && base.source.mimeType).toBe('image/webp');
    expect(base.id).toBe('m.glb#image0:srgb');
  });

  it('uses KTX2/Basis textures\' fallback source, and draws none (a warning) without one', () => {
    const fallback = build((json) => {
      json['textures'] = [{ source: 0, extensions: { KHR_texture_basisu: { source: 1 } } }];
      json['materials'] = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
    }, { ...TRIANGLE_UV, images: [{ bytes: PNG, mimeType: 'image/png' }, { bytes: new Uint8Array(4), mimeType: 'image/ktx2' }] });
    expect(fallback.meshes[0]![0]!.material.baseColorTexture!.source).toMatchObject({ mimeType: 'image/png' });
    const none = build((json) => {
      json['textures'] = [{ extensions: { KHR_texture_basisu: { source: 0 } } }];
      json['materials'] = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }];
    }, { ...TRIANGLE_UV, images: [{ bytes: new Uint8Array(4), mimeType: 'image/ktx2' }] });
    expect(none.meshes[0]![0]!.material.baseColorTexture).toBeNull();
    expect(none.warnings.map((w) => w.code)).toEqual(['PP3803']);
    expect(code(() => readContainer('x.gltf', new TextEncoder().encode(
      '{"asset":{"version":"2.0"},"extensionsRequired":["KHR_texture_basisu"]}',
    )))).toBe('PP3802');
  });

  it('bakes KHR_texture_transform into the uvs (offset, rotation, scale; identity changes nothing)', () => {
    const material = (transform: object): (json: Record<string, unknown>) => void => (json) => {
      json['materials'] = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0, extensions: { KHR_texture_transform: transform } } } }];
    };
    const images = [{ bytes: PNG, mimeType: 'image/png' }];
    // The boulder's (and 30 other template glbs'): an identity transform.
    const identity = build(material({ texCoord: 0 }), { ...TRIANGLE_UV, images });
    expect(uvsOf(identity)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(identity.warnings).toEqual([]);
    const scaled = build(material({ offset: [0.5, 0.25], scale: [2, 3] }), { ...TRIANGLE_UV, images });
    expect(uvsOf(scaled)).toEqual([0.5, 0.25, 2.5, 0.25, 0.5, 3.25]);
    // Rotation r: u' = cos·u + sin·v, v' = -sin·u + cos·v (glTF's matrix).
    const turned = build(material({ rotation: Math.PI / 2 }), { ...TRIANGLE_UV, images });
    expect(uvsOf(turned)).toEqual([0, 0, 0, -1, 1, 0]);
    expect(turned.warnings).toEqual([]);
  });

  it('samples the UV set the material names (texCoord, or the transform\'s texCoord)', () => {
    const second = (texture: object): (json: Record<string, unknown>) => void => (json) => {
      const primitive = (json['meshes'] as { primitives: { attributes: Record<string, number> }[] }[])[0]!.primitives[0]!;
      // The uvs become set 1; set 0 is the positions' x, y.
      primitive.attributes['TEXCOORD_1'] = primitive.attributes['TEXCOORD_0']!;
      (json['accessors'] as object[]).push({ ...(json['accessors'] as object[])[0]!, type: 'VEC2', min: undefined, max: undefined });
      primitive.attributes['TEXCOORD_0'] = (json['accessors'] as object[]).length - 1;
      json['materials'] = [{ pbrMetallicRoughness: { baseColorTexture: { index: 0, ...texture } } }];
    };
    const images = [{ bytes: PNG, mimeType: 'image/png' }];
    expect(uvsOf(build(second({ texCoord: 1 }), { ...TRIANGLE_UV, images }))).toEqual([0, 0, 1, 0, 0, 1]);
    expect(uvsOf(build(second({ extensions: { KHR_texture_transform: { texCoord: 1, offset: [1, 0] } } }), { ...TRIANGLE_UV, images }))).toEqual([1, 0, 2, 0, 1, 1]);
    const first = build(second({}), { ...TRIANGLE_UV, images });
    expect(first.warnings).toEqual([]);
    expect(uvsOf(first)).not.toEqual([0, 0, 1, 0, 0, 1]);
  });

  it('warns when a material\'s maps disagree on their UV set or transform', () => {
    const model = build((json) => {
      json['materials'] = [{
        pbrMetallicRoughness: { baseColorTexture: { index: 0 } },
        normalTexture: { index: 0, extensions: { KHR_texture_transform: { scale: [4, 4] } } },
      }];
    }, { ...TRIANGLE_UV, images: [{ bytes: PNG, mimeType: 'image/png' }] });
    expect(uvsOf(model)).toEqual([0, 0, 1, 0, 0, 1]);
    expect(model.warnings.map((w) => w.code)).toEqual(['PP3803']);
  });
});

describe('glTF alpha (the old engine\'s rules)', () => {
  const alpha = (mode: string | undefined, factor: number, cutoff?: number): ReturnType<typeof build>['meshes'][0][0]['material'] => build((json) => {
    json['materials'] = [{
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, factor], baseColorTexture: { index: 0 } },
      ...(mode !== undefined && { alphaMode: mode }), ...(cutoff !== undefined && { alphaCutoff: cutoff }),
    }];
  }, { ...TRIANGLE_UV, images: [{ bytes: PNG, mimeType: 'image/png' }] }).meshes[0]![0]!.material;

  it('MASK with a base color alpha of 0 tests the texture alpha only (the kitchen bin, stove, crates: 168 template materials)', () => {
    const material = alpha('MASK', 0);
    expect(material.alphaMode).toBe('mask');
    expect(material.baseColor[3]).toBe(1);
    expect(material.alphaCutoff).toBe(0.5);
    expect(alpha('MASK', 0, 0.3).alphaCutoff).toBe(0.3);
  });

  it('OPAQUE ignores the factor\'s alpha; BLEND keeps it', () => {
    const opaque = alpha(undefined, 0.2);
    expect(opaque.alphaMode).toBe('opaque');
    expect(opaque.baseColor[3]).toBe(1);
    const blend = alpha('BLEND', 0.35);
    expect(blend.alphaMode).toBe('blend');
    expect(blend.baseColor[3]).toBe(0.35);
  });

  it('keeps BLEND foliage and transmission glass translucent', () => {
    const glass = build((json) => {
      json['extensionsUsed'] = ['KHR_materials_transmission'];
      json['materials'] = [{ alphaMode: 'BLEND', pbrMetallicRoughness: { baseColorFactor: [0.6, 0.8, 1, 0.3], metallicFactor: 0, roughnessFactor: 0.05 }, extensions: { KHR_materials_transmission: { transmissionFactor: 0.9 } } }];
    }).meshes[0]![0]!.material;
    expect(glass.alphaMode).toBe('blend');
    expect(glass.baseColor[3]).toBe(0.3);
    expect(glass.layers?.transmission).toBe(0.9);
  });
});

describe('glTF metal and roughness', () => {
  const pbr = (p: object): ModelAsset['meshes'][0][0]['material'] => build((json) => {
    json['materials'] = [{ pbrMetallicRoughness: p }];
  }).meshes[0]![0]!.material;

  it('reads absent factors as the old engine\'s look, metallic 0 and roughness 0.5 (the template pines: Blender left both out)', () => {
    expect(pbr({ baseColorFactor: [0.8, 0.8, 0.8, 1], roughnessFactor: 0.55 })).toMatchObject({ metallic: 0, roughness: 0.55 });
    expect(pbr({})).toMatchObject({ metallic: 0, roughness: 0.5 });
    expect(build(() => undefined, { ...TRIANGLE_UV, meshes: [{ ...TRIANGLE_UV.meshes[0]!, material: undefined }] }).meshes[0]![0]!.material)
      .toMatchObject({ metallic: 0, roughness: 0.5 });
  });

  it('keeps factors the file sets (the cargo plane: metallic 1, roughness 1 with a metal/rough map)', () => {
    expect(pbr({ metallicFactor: 1, roughnessFactor: 1 })).toMatchObject({ metallic: 1, roughness: 1 });
    expect(pbr({ metallicFactor: 0.9, roughnessFactor: 0.15 })).toMatchObject({ metallic: 0.9, roughness: 0.15 });
  });
});

describe('glTF container', () => {
  it('a writeGlb file with the webp extension required reads', () => {
    const glb = writeGlb({ ...TRIANGLE_UV, extensionsRequired: ['EXT_texture_webp', 'KHR_texture_transform'] });
    expect(readContainer('w.glb', glb).json.extensionsRequired).toEqual(['EXT_texture_webp', 'KHR_texture_transform']);
    expect((readContainer('w.glb', glb).json as GltfJson).asset?.version).toBe('2.0');
  });
});
