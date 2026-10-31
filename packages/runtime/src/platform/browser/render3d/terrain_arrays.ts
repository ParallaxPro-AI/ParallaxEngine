/**
 * The terrain's layer images as two texture arrays (base color and normal maps), one layer
 * per textured material, all at one size. Both are sampled as stored, with no sRGB decode: a
 * ground texture's bytes are its albedo, as in the old renderer (its terrain arrays were
 * rgba8unorm), so catalog ground textures keep the brightness and saturation they were picked
 * and tuned for. (Decoded, a typical 0.5 texel would light as 0.21: ground 2-4x darker and
 * more saturated than the same scene in the old engine.) Arrays keep the terrain pass at two
 * texture bindings however many materials it blends (WebGL2 and WebGPU guarantee 16
 * sampled textures per stage, and the frame already binds six).
 *
 * When the frame's materials change, a new pair is built in the background (each image
 * fetched and resized to the layer size) and swapped in once every image has arrived; until
 * then the terrain waits (as it waits for any texture). An image that fails to load is
 * reported and stands in as plain white (base color: the layer's color then shows through
 * a recolored layer) or flat (normal map).
 */

import { diagnostic } from '../../../core/index.js';
import type { Diagnostic, TerrainMaterial3d, TerrainSplat3d, Texture3d } from '../../../core/index.js';
import type { Backend3d, BackendTexture, TextureImage } from './backend.js';

/** How the base color array is sampled: as stored (see the file comment). */
export const GROUND_COLOR_SPACE = 'linear';

/** Texels per side of each layer: the quality's largest texture, at most this. */
export const TERRAIN_LAYER_SIZE = 1024;

export interface TerrainArrayImages {
  /** A texture's image resized to `size`² (`linear`: no color conversion). */
  load(texture: Texture3d, size: number, linear: boolean): Promise<TextureImage>;
  /** A `size`² image of one color (RGBA bytes). */
  solid(rgba: readonly [number, number, number, number], size: number): TextureImage;
  /** An image of raw RGBA8 pixels (rows top to bottom). */
  pixels(data: Uint8Array, width: number, height: number): TextureImage;
}

export interface TerrainArrayPair {
  readonly albedo: BackendTexture;
  readonly normal: BackendTexture;
}

/** What the terrain pass binds beyond its detail textures. */
export interface TerrainBindings extends TerrainArrayPair {
  /** The splat map (`Terrain3d.splat`, linear RGBA8, clamped), or null: blend by the vertex weights. */
  readonly splat: BackendTexture | null;
}

type Pending = TextureImage | 'loading' | 'failed';

interface Layer {
  readonly albedo: Texture3d;
  readonly normal: Texture3d | null;
  a: Pending;
  n: Pending;
}

interface Building {
  readonly key: string;
  readonly size: number;
  readonly layers: readonly Layer[];
}

const WHITE = [255, 255, 255, 255] as const;
const FLAT = [128, 128, 255, 255] as const;

/** The textured materials' array layer, keyed by their images. */
export function arrayKey(materials: readonly TerrainMaterial3d[], size: number): string {
  return `${size}|${materials.filter((m) => m.texture !== null).map((m) => `${m.texture!.id}+${m.normal?.id ?? ''}`).join('\n')}`;
}

export class TerrainArrays {
  readonly #backend: Backend3d;
  readonly #images: TerrainArrayImages;
  readonly #report: (problem: Diagnostic) => void;
  #current: { key: string; pair: TerrainArrayPair; layers: ReadonlyMap<string, number> } | null = null;
  #building: Building | null = null;
  #empty: TerrainArrayPair | null = null;

  constructor(backend: Backend3d, images: TerrainArrayImages, report: (problem: Diagnostic) => void) {
    this.#backend = backend;
    this.#images = images;
    this.#report = report;
  }

  /** The arrays the terrain pass binds (a one-layer placeholder pair until one is built). */
  get pair(): TerrainArrayPair {
    if (this.#current !== null) return this.#current.pair;
    // Nothing samples it (no textured material is drawn before its layer is in).
    this.#empty ??= {
      albedo: this.#backend.createTextureArray([], 4, { colorSpace: GROUND_COLOR_SPACE, wrap: 'repeat' }),
      normal: this.#backend.createTextureArray([], 4, { colorSpace: 'linear', wrap: 'repeat' }),
    };
    return this.#empty;
  }

  /**
   * Each textured material's layer in the current arrays (null: not in yet), starting a
   * build when the materials differ from the current arrays'.
   */
  update(materials: readonly TerrainMaterial3d[], maxSize: number): (material: TerrainMaterial3d) => number | null {
    const size = Math.max(4, Math.min(TERRAIN_LAYER_SIZE, maxSize));
    const key = arrayKey(materials, size);
    const textured = materials.filter((m) => m.texture !== null);
    if (textured.length > 0 && this.#current?.key !== key && this.#building?.key !== key) this.#start(key, size, textured);
    const b = this.#building;
    if (b !== null && b.layers.every((l) => l.a !== 'loading' && l.n !== 'loading')) {
      const albedo = this.#backend.createTextureArray(b.layers.map((l) => (l.a === 'failed' ? this.#images.solid(WHITE, b.size) : l.a as TextureImage)), b.size, { colorSpace: GROUND_COLOR_SPACE, wrap: 'repeat' });
      const normal = this.#backend.createTextureArray(b.layers.map((l) => (l.n === 'failed' ? this.#images.solid(FLAT, b.size) : l.n as TextureImage)), b.size, { colorSpace: 'linear', wrap: 'repeat' });
      for (const l of b.layers) for (const image of [l.a, l.n]) (image as { close?: () => void }).close?.();
      if (this.#current !== null) {
        this.#backend.destroyTexture(this.#current.pair.albedo);
        this.#backend.destroyTexture(this.#current.pair.normal);
      }
      this.#current = { key: b.key, pair: { albedo, normal }, layers: new Map(b.layers.map((l, i) => [`${l.albedo.id}+${l.normal?.id ?? ''}`, i])) };
      this.#building = null;
    }
    // The current arrays serve any material they hold (also while a new pair builds).
    const layers = this.#current?.layers;
    return (m) => (m.texture === null ? 0 : layers?.get(`${m.texture.id}+${m.normal?.id ?? ''}`) ?? null);
  }

  #start(key: string, size: number, textured: readonly TerrainMaterial3d[]): void {
    const seen = new Set<string>();
    const layers: Layer[] = [];
    for (const m of textured) {
      const id = `${m.texture!.id}+${m.normal?.id ?? ''}`;
      if (seen.has(id)) continue;
      seen.add(id);
      layers.push({ albedo: m.texture!, normal: m.normal, a: 'loading', n: m.normal === null ? 'failed' : 'loading' });
    }
    const building: Building = { key, size, layers };
    this.#building = building;
    const fill = (texture: Texture3d, linear: boolean, set: (p: Pending) => void): void => {
      this.#images.load(texture, size, linear).then(
        (image) => (this.#building === building ? set(image) : (image as { close?: () => void }).close?.()),
        (error: unknown) => {
          set('failed');
          const where = texture.source.kind === 'file' ? texture.source.path : texture.id;
          this.#report(diagnostic('PP3816', `The terrain ${linear ? 'normal map' : 'texture'} ${where} could not be loaded (${String((error as Error)?.message ?? error)})`, {
            path: where, fix: 'Check the path or URL, and that it is a PNG, JPEG or WebP image.',
          }));
        },
      );
    };
    for (const l of layers) {
      fill(l.albedo, false, (p) => { l.a = p; });
      if (l.normal !== null) fill(l.normal, true, (p) => { l.n = p; });
    }
  }

  #splat: { key: string; texture: BackendTexture } | null = null;

  /** The splat map's texture, uploaded again when its key changes (a new field, a crater's paint). */
  splat(splat: TerrainSplat3d | null | undefined): BackendTexture | null {
    if (splat === null || splat === undefined) return null;
    if (this.#splat?.key !== splat.key) {
      if (this.#splat !== null) this.#backend.destroyTexture(this.#splat.texture);
      const image = this.#images.pixels(splat.data, splat.columns, splat.rows * splat.planes);
      this.#splat = { key: splat.key, texture: this.#backend.createTexture(image, { colorSpace: 'linear', wrapU: 'clamp', wrapV: 'clamp', filter: 'linear' }) };
    }
    return this.#splat.texture;
  }

  /** The frame's terrain bindings. */
  bindings(splat: TerrainSplat3d | null | undefined): TerrainBindings {
    return { ...this.pair, splat: this.splat(splat) };
  }

  dispose(): void {
    if (this.#splat !== null) this.#backend.destroyTexture(this.#splat.texture);
    this.#splat = null;
    const pairs = [this.#current?.pair, this.#empty].filter((p): p is TerrainArrayPair => p !== undefined && p !== null);
    for (const p of pairs) {
      this.#backend.destroyTexture(p.albedo);
      this.#backend.destroyTexture(p.normal);
    }
    this.#current = null;
    this.#empty = null;
    this.#building = null;
  }
}
