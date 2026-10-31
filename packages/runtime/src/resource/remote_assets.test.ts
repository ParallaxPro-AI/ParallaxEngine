/**
 * Hosted assets (core/remote_assets.ts): a `https://r2.parallaxpro.ai/assets/…` URL in place
 * of a project path — resolved and normalized by the catalogs, loaded only where the run can
 * fetch (a browser), absent headless; model documents' texture maps and tiling.
 */

import { describe, expect, it } from 'vitest';
import { isRemoteAsset, ParallaxError, remoteAssetProblem, remoteAssetUrl } from '../core/index.js';
import type { ProjectFiles } from '../core/index.js';
import { MemoryBinaryFiles } from '../platform/headless/render3d.js';
import { AudioCatalog } from '../function/plugins/audio/catalog.js';
import { AssetCatalog as AssetCatalog2d } from '../function/plugins/render2d/assets.js';
import { ModelLibrary } from '../function/plugins/models/library.js';
import { standInCharacter } from '../function/plugins/models/testing.js';
import { AssetCatalog, buildCodeModel, loadProject, parseModelDocument, resolveUri } from './index.js';
import { checkAudioDefaults } from '../function/plugins/audio/defaults.js';

const GLB = 'https://r2.parallaxpro.ai/assets/model_character/e9/3e/e93e873bf8ac7981b7b5568eb71ddc4bdd19c7c1441f35be01b45df9a5ff359c.glb';
const JPG = 'https://r2.parallaxpro.ai/assets/image_texture/4d/91/4d916dfe89c9d2b88bf52e0c70c6a9798a5c29c8c2fcb6ba1ab7b7ded9ef3ed5.jpg';
const OGG = 'https://r2.parallaxpro.ai/assets/audio_sfx/12/34/1234abcd.ogg';

const files = (contents: Record<string, string> = {}): ProjectFiles => ({
  list: () => Object.keys(contents).sort(), read: (p) => contents[p]!,
});

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof ParallaxError) return error.diagnostic.code;
    throw error;
  }
  return undefined;
};

describe('hosted asset URLs', () => {
  it('normalize parallaxpro.ai to the r2 host and check the form', () => {
    expect(remoteAssetUrl(GLB.replace('r2.', ''))).toBe(GLB);
    expect(remoteAssetUrl(GLB.replace('r2.', 'www.'))).toBe(GLB);
    expect(remoteAssetUrl(GLB)).toBe(GLB);
    expect(isRemoteAsset('assets/models/knight.glb')).toBe(false);
    for (const bad of ['http://r2.parallaxpro.ai/assets/a.glb', `${GLB}?v=1`, `${GLB}#run`, 'https://r2.parallaxpro.ai/assets/../x.glb',
      'https://evil.example/assets/a.glb', 'https://r2.parallaxpro.ai/other/a.glb']) {
      expect(remoteAssetUrl(bad), bad).toBeUndefined();
    }
    expect(remoteAssetProblem(GLB, 'models')).toBeUndefined();
    expect(remoteAssetProblem(JPG, 'models')).toContain('.glb, .gltf, .model.json');
    expect(remoteAssetProblem(OGG, 'music')).toBeUndefined();
    expect(remoteAssetProblem(JPG, 'vfx')).toContain("can't be hosted");
    expect(remoteAssetProblem(JPG)).toBeUndefined();
  });

  it('the 3D catalog resolves them by kind, loadable only where the run fetches', () => {
    const headless = new AssetCatalog(files());
    expect(headless.resolve(GLB.replace('r2.', ''), 'models', 'm')).toBe(GLB);
    expect(headless.loadable(GLB)).toBe(false);
    expect(headless.has(GLB)).toBe(false);
    expect(new AssetCatalog(files(), true, true).loadable(GLB)).toBe(true);
    expect(code(() => headless.resolve(JPG, 'models', 'm'))).toBe('PP2063');
    expect(code(() => headless.resolve('https://example.com/a.glb', 'models', 'm'))).toBe('PP2063');
    expect(headless.resolve(JPG, 'images', 'texture')).toBe(JPG);
  });

  it('the 2D catalog: sprites by URL, drawn as missing files headless', () => {
    const png = 'https://parallaxpro.ai/assets/image_sprite/41/2d/412d9d91b45c42ea51966b71f1f0af61b00ae67323784fd5f27ee92f976624da.png';
    const catalog = new AssetCatalog2d(files(), true);
    const path = catalog.resolve(png, 'images', 'sprite');
    expect(path).toBe(png.replace('https://', 'https://r2.'));
    expect(catalog.loadable(path)).toBe(false);
    expect(new AssetCatalog2d(files(), true, true).loadable(path)).toBe(true);
  });

  it('sounds: a URL is its own handle, in either folder; a file only where fetched', () => {
    const headless = new AudioCatalog(['assets/sfx/hit.ogg']);
    expect(headless.sound(OGG, 'sfx', 'play')).toEqual({ handle: OGG, file: null });
    expect(headless.sound(OGG.replace('r2.', ''), 'music', 'music')).toEqual({ handle: OGG, file: null });
    expect(new AudioCatalog(['assets/sfx/hit.ogg'], true).sound(OGG, 'sfx', 'play')).toEqual({ handle: OGG, file: OGG });
    expect(code(() => headless.sound(JPG, 'sfx', 'play'))).toBe('PP3500');
  });

  it('assets/audio.json may key a hosted sound by its URL (normalized)', () => {
    const project = loadProject(files({ 'assets/audio.json': JSON.stringify({ [OGG.replace('r2.', '')]: { volume: 0.3 }, 'https://example.com/a.ogg': { volume: 1 } }) }));
    expect(project.diagnostics.map((d) => d.code)).toEqual(['PP1009']);
    expect(project.audio.get(OGG)).toEqual({ volume: 0.3 });
    expect(checkAudioDefaults(new Map([[OGG, { volume: 0.3 }]]), new AudioCatalog([]))).toEqual([]);
  });

  it('a hosted glb: absent headless (no fetch), loaded through the binary files where fetched', async () => {
    const glb = standInCharacter(['run']);
    const reads: string[] = [];
    const binary = { read: (path: string) => { reads.push(path); return new MemoryBinaryFiles({ [GLB]: glb }).read(path); } };
    const headless = new ModelLibrary(binary, new AssetCatalog(files()));
    expect(headless.geometry(GLB)).toBeNull();
    expect(headless.clipLength(`${GLB}#run`)).toBe(0);
    expect(reads).toEqual([]);

    const browser = new ModelLibrary(binary, new AssetCatalog(files(), true, true));
    const path = browser.resolve(GLB.replace('r2.', ''), 'model');
    await browser.whenLoaded();
    expect(reads).toEqual([GLB]);
    expect(browser.get(path)?.clips.has('run')).toBe(true);
    expect(browser.clipLength(`${GLB}#run`)).toBeGreaterThan(0);
  });

  it('a hosted model document is fetched and parsed where fetched', async () => {
    const url = 'https://r2.parallaxpro.ai/assets/model_doc/ab/cd/crate.model.json';
    const doc = { format: 'parallax.model', version: 1, materials: { wood: { color: '#aa8855', metallic: 0, roughness: 0.8 } }, parts: [{ name: 'box', shape: 'box', material: 'wood' }] };
    const binary = new MemoryBinaryFiles({ [url]: new TextEncoder().encode(JSON.stringify(doc)) });
    const library = new ModelLibrary(binary, new AssetCatalog(files(), true, true));
    library.resolve(url, 'model');
    await library.whenLoaded();
    expect(library.get(url)?.code?.document.parts[0]?.name).toBe('box');
  });

  it('glTF uris beside a hosted .gltf resolve on its host', () => {
    expect(resolveUri('https://r2.parallaxpro.ai/assets/m/a/b.gltf', 'b.bin')).toBe('https://r2.parallaxpro.ai/assets/m/a/b.bin');
    expect(resolveUri('assets/models/a/b.gltf', '../c.bin')).toBe('assets/models/c.bin');
  });
});

describe('model documents: texture maps and uv_scale', () => {
  const doc = (body: Record<string, unknown>, part: Record<string, unknown> = {}) => JSON.stringify({
    format: 'parallax.model', version: 1,
    materials: { hull: { color: '#ffffff', metallic: 0.5, roughness: 0.5, ...body } },
    parts: [{ name: 'plate', shape: 'box', material: 'hull', ...part }],
    options: [{ name: 'finish', materials: ['hull'], default: 'plain', choices: { plain: {}, painted: { texture: null, color: '#ff0000' } } }],
  });

  it('maps become textures (hosted URLs normalized), tiled by the part\'s uv_scale', () => {
    const parsed = parseModelDocument('assets/models/plate.model.json', doc(
      { texture: JPG.replace('r2.', ''), normal_map: 'assets/images/plate_n.png', normal_strength: 0.5 }, { uv_scale: [2, 0.5] },
    ));
    expect(parsed.diagnostics).toEqual([]);
    const model = buildCodeModel(parsed.document!);
    const { material, geometry } = model.meshes[0]![0]!;
    expect(material.baseColorTexture?.source).toEqual({ kind: 'file', path: JPG });
    expect(material.baseColorTexture?.colorSpace).toBe('srgb');
    expect(material.normalTexture?.source).toEqual({ kind: 'file', path: 'assets/images/plate_n.png' });
    expect(material.normalTexture?.colorSpace).toBe('linear');
    expect(material.normalScale).toBe(0.5);
    const plain = buildCodeModel(parseModelDocument('assets/models/b.model.json', doc({})).document!).meshes[0]![0]!.geometry;
    expect(geometry.id).not.toBe(plain.id);
    expect(geometry.positions).toBe(plain.positions);
    for (let i = 0; i < plain.uvs.length; i += 2) {
      expect(geometry.uvs[i]).toBeCloseTo(plain.uvs[i]! * 2);
      expect(geometry.uvs[i + 1]).toBeCloseTo(plain.uvs[i + 1]! * 0.5);
    }
    // Equal shapes at equal scales share one geometry (they instance together).
    const again = buildCodeModel(parseModelDocument('assets/models/c.model.json', doc({ texture: JPG }, { uv_scale: [2, 0.5] })).document!);
    expect(again.meshes[0]![0]!.geometry).toBe(geometry);
  });

  it('a map that is neither a project image nor a hosted image is PP2063; bad uv_scale is PP1002', () => {
    const codes = (body: Record<string, unknown>, part: Record<string, unknown> = {}) =>
      parseModelDocument('assets/models/p.model.json', doc(body, part)).diagnostics.map((d) => `${d.code} ${d.pointer}`);
    expect(codes({ texture: 'https://example.com/a.png' })).toEqual(['PP2063 /materials/hull/texture']);
    expect(codes({ texture: GLB })).toEqual(['PP2063 /materials/hull/texture']);
    expect(codes({ normal_map: 'images/plate_n.png' })).toEqual(['PP2063 /materials/hull/normal_map']);
    expect(codes({}, { uv_scale: [0, 1] })).toEqual(['PP1002 /parts/0/uv_scale']);
  });

  it('the old material key names are errors that name the new key; metallic and roughness default like a shape\'s', () => {
    const parsed = parseModelDocument('assets/models/old.model.json', doc({ base_color_map: JPG, normal_scale: 0.5 }));
    expect(parsed.diagnostics.map((d) => `${d.code} ${d.pointer}`)).toEqual(['PP1003 /materials/hull/base_color_map', 'PP1003 /materials/hull/normal_scale']);
    expect(parsed.diagnostics[0]!.fix).toContain('"texture"');
    expect(parsed.diagnostics[1]!.fix).toContain('"normal_strength"');
    const bare = parseModelDocument('assets/models/bare.model.json', JSON.stringify({
      format: 'parallax.model', version: 1, materials: { m: { color: '#ffffff', emissive: [1, 0.5, 0], emissive_strength: 3 } },
      parts: [{ name: 'p', shape: 'plane', material: 'm' }],
    }));
    expect(bare.diagnostics).toEqual([]);
    const m = bare.document!.materials.get('m')!;
    expect([m.metallic, m.roughness, m.emissiveStrength]).toEqual([0, 0.5, 3]);
    expect(buildCodeModel(bare.document!).meshes[0]![0]!.material.emissiveStrength).toBe(3);
  });
});
