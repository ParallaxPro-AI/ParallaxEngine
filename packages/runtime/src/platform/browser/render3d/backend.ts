/**
 * The GPU backend interface: what the browser surface asks of WebGPU or WebGL2. The
 * surface owns everything API-neutral (texture decoding, text rasterizing, planning the
 * frame); a backend owns GPU objects and executes a `FramePlan` in `visitPasses` order.
 *
 * Also: the minimal WebGPU typings this code uses. TypeScript's DOM library has none,
 * and the runtime takes no dependencies, so descriptors are plain records and objects
 * carry only the members called here.
 */

import type { Wrap } from '../../../core/index.js';
import type { BlockFormat, Ktx2Image } from './ktx2.js';
import type { DepthGrid } from './occlusion.js';
import type { FramePlan, TextureRef } from './plan.js';

export type BackendKind = 'webgpu' | 'webgl2';

/** A decoded image either API can upload (ImageBitmap, canvas, OffscreenCanvas). */
export interface TextureImage {
  readonly width: number;
  readonly height: number;
}

export interface TextureDesc {
  readonly colorSpace: 'srgb' | 'linear';
  readonly wrapU: Wrap;
  readonly wrapV: Wrap;
  readonly filter: 'linear' | 'nearest';
}

export interface TextureArrayOptions {
  readonly colorSpace?: 'srgb' | 'linear';
  readonly wrap?: 'clamp' | 'repeat';
}

/** A texture a backend made; opaque to everyone else. */
export interface BackendTexture {
  readonly backend: BackendKind;
}

/** What a frame draws with beyond its textures. */
export interface FrameResources {
  /** The decal image array (`createTextureArray`, decals.ts); null: no decals. */
  readonly decals: BackendTexture | null;
  /** The terrain's layer arrays and splat map (terrain_arrays.ts); absent/null: none built. */
  readonly terrain?: { readonly albedo: BackendTexture; readonly normal: BackendTexture; readonly splat: BackendTexture | null } | null;
}

export const NO_RESOURCES: FrameResources = { decals: null };

/** Block-compression families a GPU may sample natively (KTX2 variants, ktx2.ts). */
export type CompressionFamily = BlockFormat['family'];

export interface Backend3d {
  readonly kind: BackendKind;
  createTexture(image: TextureImage, desc: TextureDesc): BackendTexture;
  /** The block-compression families this GPU samples (with sRGB variants), best first. */
  readonly compressed: readonly CompressionFamily[];
  /**
   * A block-compressed texture from a KTX2 image's levels (as stored: every level it has),
   * or null when this GPU can't take it (a family it lacks, or a size WebGPU refuses: the
   * base level must be whole blocks).
   */
  createCompressedTexture(image: Ktx2Image, format: BlockFormat, desc: TextureDesc): BackendTexture | null;
  /**
   * One texture array of same-size images (resized by the caller to `size`²), mipmapped:
   * sRGB and clamped by default (decal images); terrain layers repeat, normal maps are linear.
   */
  createTextureArray(images: readonly TextureImage[], size: number, options?: TextureArrayOptions): BackendTexture;
  destroyTexture(texture: BackendTexture): void;
  /** An offscreen view's render target as a texture (what it drew last), or null before it first drew. */
  target(id: string): BackendTexture | null;
  /** Free a render target nothing draws into anymore. */
  dropTarget(id: string): void;
  /**
   * Draw a plan into the canvas. `texture` gives the uploaded texture of every ref the plan
   * names. With `capture`, the plan is drawn into its own targets instead and its finished
   * image (RGBA8, rows top to bottom, straight alpha) handed to `capture` (now or once read back).
   */
  render(plan: FramePlan, texture: (ref: TextureRef) => BackendTexture, resources?: FrameResources, capture?: (pixels: Uint8Array) => void): void;
  /** The newest depth grid read back for Hi-Z (`plan.occlusion`), once, or null (occlusion.ts). */
  takeDepth(): DepthGrid | null;
  dispose(): void;
}

/**
 * GPU-side copies of geometry, freed when a geometry hasn't been drawn for a while. A
 * dynamic geometry (`Geometry3d.version`: morphed, cloth, clay) is refreshed when its
 * version moves: `refresh` rewrites what changed in place (positions, normals, colors), or
 * returns false to have the copy rebuilt (its sizes changed).
 */
export class GeometryCache<T> {
  readonly #entries = new Map<object, { value: T; used: number; version: number | undefined }>();
  readonly #create: (key: never) => T;
  readonly #destroy: (value: T) => void;
  readonly #refresh: ((value: T, key: never) => boolean) | null;
  readonly #idleFrames: number;
  #frame = 0;

  constructor(create: (key: never) => T, destroy: (value: T) => void, idleFrames = 600, refresh: ((value: T, key: never) => boolean) | null = null) {
    this.#create = create;
    this.#destroy = destroy;
    this.#idleFrames = idleFrames;
    this.#refresh = refresh;
  }

  get<K extends object>(key: K): T {
    let entry = this.#entries.get(key);
    const version = (key as { version?: number }).version;
    if (entry !== undefined && entry.version !== version) {
      if (this.#refresh === null || !(this.#refresh as (value: T, key: K) => boolean)(entry.value, key)) {
        this.#destroy(entry.value);
        entry = undefined;
        this.#entries.delete(key);
      } else {
        entry.version = version;
      }
    }
    if (entry === undefined) {
      entry = { value: (this.#create as (key: K) => T)(key), used: this.#frame, version };
      this.#entries.set(key, entry);
    }
    entry.used = this.#frame;
    return entry.value;
  }

  /** Call once per frame, after drawing: frees what went unused for `idleFrames` frames. */
  endFrame(): void {
    for (const [key, entry] of this.#entries) {
      if (this.#frame - entry.used > this.#idleFrames) {
        this.#destroy(entry.value);
        this.#entries.delete(key);
      }
    }
    this.#frame++;
  }

  get size(): number {
    return this.#entries.size;
  }

  clear(): void {
    for (const entry of this.#entries.values()) this.#destroy(entry.value);
    this.#entries.clear();
  }
}

// ── Minimal WebGPU typings ────────────────────────────────────────────────────

export type Desc = Record<string, unknown>;

export interface GpuLike {
  requestAdapter(options?: Desc): Promise<GpuAdapter | null>;
  getPreferredCanvasFormat(): string;
}

export interface GpuAdapter {
  /** Optional features the adapter has (texture compression families among them). */
  readonly features?: ReadonlySet<string>;
  requestDevice(descriptor?: Desc): Promise<GpuDevice>;
}

export interface GpuBuffer {
  readonly size: number;
  destroy(): void;
  /** Mappable buffers (read-backs). */
  mapAsync?(mode: number): Promise<void>;
  getMappedRange?(): ArrayBuffer;
  unmap?(): void;
}

export interface GpuTextureView { readonly __view?: never }

export interface GpuTexture {
  readonly width: number;
  readonly height: number;
  createView(descriptor?: Desc): GpuTextureView;
  destroy(): void;
}

export interface GpuRenderPass {
  setPipeline(pipeline: unknown): void;
  setBindGroup(index: number, group: unknown, offsets?: number[]): void;
  setVertexBuffer(slot: number, buffer: GpuBuffer, offset?: number, size?: number): void;
  setIndexBuffer(buffer: GpuBuffer, format: string): void;
  setViewport(x: number, y: number, width: number, height: number, minDepth: number, maxDepth: number): void;
  setScissorRect(x: number, y: number, width: number, height: number): void;
  draw(vertices: number, instances?: number, firstVertex?: number, firstInstance?: number): void;
  drawIndexed(indices: number, instances?: number, firstIndex?: number, baseVertex?: number, firstInstance?: number): void;
  end(): void;
}

export interface GpuEncoder {
  beginRenderPass(descriptor: Desc): GpuRenderPass;
  copyTextureToBuffer?(source: Desc, destination: Desc, size: readonly number[]): void;
  copyTextureToTexture?(source: Desc, destination: Desc, size: readonly number[]): void;
  finish(): unknown;
}

export interface GpuQueue {
  writeBuffer(buffer: GpuBuffer, offset: number, data: ArrayBufferView, dataOffset?: number, size?: number): void;
  writeTexture(destination: Desc, data: ArrayBufferView, layout: Desc, size: Desc): void;
  copyExternalImageToTexture(source: Desc, destination: Desc, size: Desc | readonly number[]): void;
  submit(buffers: unknown[]): void;
}

export interface GpuDevice {
  readonly queue: GpuQueue;
  /** Features the device was created with. */
  readonly features?: ReadonlySet<string>;
  readonly limits: { readonly maxTextureDimension2D: number };
  /** Resolves if the device is lost (driver reset, another tab took the GPU). */
  readonly lost?: Promise<{ readonly message: string }>;
  createBuffer(descriptor: Desc): GpuBuffer;
  createTexture(descriptor: Desc): GpuTexture;
  createSampler(descriptor?: Desc): unknown;
  createShaderModule(descriptor: Desc): unknown;
  createBindGroupLayout(descriptor: Desc): unknown;
  createPipelineLayout(descriptor: Desc): unknown;
  createRenderPipeline(descriptor: Desc): unknown;
  createBindGroup(descriptor: Desc): unknown;
  createCommandEncoder(descriptor?: Desc): GpuEncoder;
  destroy(): void;
}

export interface GpuCanvasContext {
  configure(configuration: Desc): void;
  getCurrentTexture(): GpuTexture;
}

/** WebGPU buffer and texture usage flags (GPUBufferUsage / GPUTextureUsage). */
export const BUFFER = { MAP_READ: 0x01, COPY_SRC: 0x04, COPY_DST: 0x08, INDEX: 0x10, VERTEX: 0x20, UNIFORM: 0x40, STORAGE: 0x80 } as const;
/** GPUMapMode.READ. */
export const MAP_READ = 0x01;
export const TEXTURE = { COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 } as const;
export const STAGE = { VERTEX: 0x1, FRAGMENT: 0x2 } as const;
