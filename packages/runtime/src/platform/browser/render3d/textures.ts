/**
 * The surface's textures: loaded on first sight, uploaded through a queue, kept within the
 * quality's GPU memory budget.
 *
 *   load      a texture's first draw starts its load; draws wait (are left out) until it is
 *             on the GPU. A precompressed KTX2 variant (`TextureSource.variants`) whose block
 *             family the GPU samples is used as is (no decode); otherwise the image is
 *             decoded, shrunk to the quality's `maxTextureSize` when larger.
 *   queue     decoded images wait in arrival order and are uploaded a few per frame — at
 *             most `UPLOAD_BYTES` (at least one) — so a level's worth of textures arriving
 *             together doesn't stall one frame.
 *   budget    bytes on the GPU are counted (images with their mips, compressed levels as
 *             stored); past `Quality3d.textureBudget` the least recently drawn textures go,
 *             never one drawn in the last two frames. An evicted texture loads again (from
 *             the browser's cache) the next time it is drawn.
 */

import { diagnostic } from '../../../core/index.js';
import type { Diagnostic, Texture3d } from '../../../core/index.js';
import type { Backend3d, BackendTexture, CompressionFamily, TextureImage } from './backend.js';
import { blockFormat, parseKtx2 } from './ktx2.js';
import type { BlockFormat, Ktx2Image } from './ktx2.js';

/** Bytes uploaded per frame at most (one texture always goes, however large). */
export const UPLOAD_BYTES = 24 * 2 ** 20;

export type Loaded =
  | { readonly kind: 'image'; readonly image: TextureImage }
  | { readonly kind: 'ktx2'; readonly image: Ktx2Image; readonly format: BlockFormat };

/** Where texture data comes from (the browser: fetch and `createImageBitmap`; tests: fakes). */
export interface TextureLoader {
  /** A project file's bytes. */
  bytes(path: string): Promise<Uint8Array>;
  /** Decode encoded image bytes, shrunk to fit `maxSize` per side when larger. */
  decode(bytes: Uint8Array, mimeType: string, maxSize: number): Promise<TextureImage>;
}

type Slot =
  | { readonly state: 'loading' }
  | { readonly state: 'queued'; readonly loaded: Loaded }
  | { readonly state: 'ready'; readonly texture: BackendTexture; readonly bytes: number; readonly compressed: boolean; used: number }
  | { readonly state: 'failed' };

export interface TextureStats {
  /** Bytes of textures on the GPU. */
  readonly bytes: number;
  readonly textures: number;
  readonly compressed: number;
  /** Decoded, waiting for upload. */
  readonly queued: number;
  /** Evicted since the store was made. */
  readonly evicted: number;
}

/** Bytes an image takes on the GPU with its mip chain (RGBA8). */
export function imageBytes(width: number, height: number): number {
  return Math.ceil((width * height * 4 * 4) / 3);
}

const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', svgz: 'image/svg+xml',
};

/** An image file's content type by its extension (PNG when unknown); SVG gets its own so it decodes through `decodeImageBlob`. */
export function imageMime(path: string): string {
  return MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'image/png';
}

/** The first variant whose family the GPU samples (`<name>.bc.ktx2`, `<name>.etc2.ktx2`, `<name>.astc.ktx2`). */
export function pickVariant(variants: readonly string[] | undefined, families: readonly CompressionFamily[]): string | null {
  for (const path of variants ?? []) {
    const family = /\.(bc|etc2|astc)\.ktx2$/.exec(path)?.[1] as CompressionFamily | undefined;
    if (family !== undefined && families.includes(family)) return path;
  }
  return null;
}

export class TextureStore {
  readonly #backend: Backend3d;
  readonly #loader: TextureLoader;
  readonly #report: (problem: Diagnostic) => void;
  readonly #slots = new Map<string, Slot>();
  /** Queued ids in arrival order. */
  #queue: { readonly id: string; readonly texture: Texture3d }[] = [];
  #bytes = 0;
  #evicted = 0;
  #frame = 0;
  /** Texels per side images are shrunk to (the quality's), for loads started from now on. */
  maxSize = 4096;

  constructor(backend: Backend3d, loader: TextureLoader, report: (problem: Diagnostic) => void) {
    this.#backend = backend;
    this.#loader = loader;
    this.#report = report;
  }

  get stats(): TextureStats {
    let textures = 0;
    let compressed = 0;
    for (const slot of this.#slots.values()) {
      if (slot.state !== 'ready') continue;
      textures++;
      if (slot.compressed) compressed++;
    }
    return { bytes: this.#bytes, textures, compressed, queued: this.#queue.length, evicted: this.#evicted };
  }

  /** Whether a texture is on the GPU (marking it drawn this frame); starts its load on first sight. */
  ready(texture: Texture3d): boolean {
    const slot = this.#slots.get(texture.id);
    if (slot === undefined) {
      this.#load(texture);
      return false;
    }
    if (slot.state !== 'ready') return false;
    slot.used = this.#frame;
    return true;
  }

  /** A ready texture's GPU copy (the plan names only textures `ready` confirmed). */
  handle(id: string): BackendTexture {
    return (this.#slots.get(id) as { texture: BackendTexture }).texture;
  }

  #load(texture: Texture3d): void {
    const source = texture.source;
    if (source.kind === 'target') return;
    this.#slots.set(texture.id, { state: 'loading' });
    const where = source.kind === 'file' ? source.path : texture.id;
    const maxSize = this.maxSize;
    const loaded = (async (): Promise<Loaded> => {
      if (source.kind === 'file') {
        const variant = pickVariant(source.variants, this.#backend.compressed);
        if (variant !== null) {
          const image = parseKtx2(await this.#loader.bytes(variant), variant);
          const format = blockFormat(image.vkFormat);
          if (format !== null) return { kind: 'ktx2', image, format };
        }
        const bytes = await this.#loader.bytes(source.path);
        return { kind: 'image', image: await this.#loader.decode(bytes, imageMime(source.path), maxSize) };
      }
      return { kind: 'image', image: await this.#loader.decode(source.bytes, source.mimeType, maxSize) };
    })();
    loaded.then(
      (data) => {
        if (this.#slots.get(texture.id)?.state !== 'loading') return;
        this.#slots.set(texture.id, { state: 'queued', loaded: data });
        this.#queue.push({ id: texture.id, texture });
      },
      (error: unknown) => {
        this.#slots.set(texture.id, { state: 'failed' });
        this.#report(diagnostic('PP3816', `The texture ${where} could not be loaded (${String((error as Error)?.message ?? error)})`, {
          path: where, fix: 'Check that the file is deployed with the game and is a PNG, JPEG or WebP image (or a KTX2 variant `parallax build` wrote).',
        }));
      },
    );
  }

  /** Upload queued textures, oldest first, up to `budget` bytes this frame (always at least one). */
  upload(budget = UPLOAD_BYTES): number {
    let spent = 0;
    let count = 0;
    while (this.#queue.length > 0 && (count === 0 || spent < budget)) {
      const { id, texture } = this.#queue.shift()!;
      const slot = this.#slots.get(id);
      if (slot?.state !== 'queued') continue;
      const data = slot.loaded;
      let made: BackendTexture | null = null;
      let bytes = 0;
      if (data.kind === 'ktx2') {
        made = this.#backend.createCompressedTexture(data.image, data.format, texture);
        bytes = data.image.levels.reduce((n, l) => n + l.byteLength, 0);
        if (made === null) {
          // This GPU refused the variant (a size it can't take): decode the image instead.
          this.#slots.delete(id);
          this.#loadPlain(texture);
          continue;
        }
      } else {
        made = this.#backend.createTexture(data.image, texture);
        bytes = imageBytes(data.image.width, data.image.height);
        (data.image as { close?: () => void }).close?.();
      }
      this.#slots.set(id, { state: 'ready', texture: made, bytes, compressed: data.kind === 'ktx2', used: this.#frame });
      this.#bytes += bytes;
      spent += bytes;
      count++;
    }
    return count;
  }

  /** A texture's plain image (its compressed variant was refused). */
  #loadPlain(texture: Texture3d): void {
    if (texture.source.kind !== 'file') return;
    this.#load({ ...texture, source: { kind: 'file', path: texture.source.path } });
  }

  /** End of a frame: evict the least recently drawn textures while over `budget` bytes. */
  endFrame(budget: number): number {
    let evicted = 0;
    if (this.#bytes > budget) {
      const idle = [...this.#slots].flatMap(([id, slot]) => (slot.state === 'ready' && this.#frame - slot.used >= 2 ? [{ id, slot }] : []))
        .sort((a, b) => a.slot.used - b.slot.used);
      for (const { id, slot } of idle) {
        if (this.#bytes <= budget) break;
        this.#backend.destroyTexture(slot.texture);
        this.#bytes -= slot.bytes;
        this.#slots.delete(id);
        evicted++;
      }
    }
    this.#evicted += evicted;
    this.#frame++;
    return evicted;
  }

  dispose(): void {
    for (const slot of this.#slots.values()) if (slot.state === 'ready') this.#backend.destroyTexture(slot.texture);
    this.#slots.clear();
    this.#queue = [];
    this.#bytes = 0;
  }
}
