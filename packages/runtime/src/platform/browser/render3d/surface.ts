/**
 * The 3D render port in a browser: a canvas drawn by WebGPU or WebGL2 (`select.ts`).
 * The surface plans each frame (`plan.ts`) and hands the plan to the backend; around that:
 *
 *   textures      loaded on first sight, KTX2 variants where the GPU samples them, an upload
 *                 queue and the quality's GPU memory budget with least-recently-drawn
 *                 eviction (`textures.ts`)
 *   decal images  one texture array of every decal image in the frame, rebuilt when the set
 *                 changes (`decals.ts`)
 *   targets       offscreen views' render targets; one nothing draws for a while is freed
 *   pacing        the frame cap and dynamic resolution (`pacing.ts`)
 *   text          world text rasterized to textures
 *   problems      load failures and a lost GPU device, through `takeProblems`
 *
 * `globalThis.__parallax3d` holds the last frame's stats (render scale, culling counts,
 * textures, timings) for tools and the browser checks.
 *
 * The canvas's backing size is the surface size: boot sizes it (CSS size × devicePixelRatio)
 * and keeps it in step with the page; the surface follows on the next frame.
 */

import { diagnostic } from '../../../core/index.js';
import type { Capture3d, Diagnostic, Frame3d, Quality3d, RenderSurface3d, Texture3d } from '../../../core/index.js';
import type { Backend3d, BackendKind, BackendTexture, GpuLike, TextureImage } from './backend.js';
import type { CullStats } from './cull.js';
import { DECAL_LAYER_SIZE, decalImages } from './decals.js';
import { HiZ, OcclusionGovernor } from './occlusion.js';
import { FrameCap, pixelBudgetScale, ResolutionGovernor } from './pacing.js';
import { planFrame, isTextTexture } from './plan.js';
import type { FramePlan, TextureRef } from './plan.js';
import { countPlan } from './plan_counts.js';
import type { DrawCounts } from './plan_counts.js';
import { markWebGpuFailed } from '../device.js';
import { decodeImageBlob, isSvg } from '../render.js';
import { SCREEN_TARGETS } from '../screens.js';
import { selectBackend } from './select.js';
import type { BackendCanvas } from './select.js';
import { TerrainArrays } from './terrain_arrays.js';
import { TextRasterizer } from './text.js';
import type { CanvasLike2d } from './text.js';
import { imageMime, TextureStore } from './textures.js';
import type { TextureLoader, TextureStats } from './textures.js';
import { WebGl2Backend } from './webgl2.js';
import { WebGpuBackend } from './webgpu.js';

/** Frames a text texture is kept after it was last drawn. */
const TEXT_IDLE_FRAMES = 120;
/** Frames a render target is kept after its view last drew. */
const TARGET_IDLE_FRAMES = 300;

export interface BrowserSurface3dOptions {
  /** The URL a project path (`assets/images/bricks.png`) is fetched from. */
  readonly url: (path: string) => string;
  /** Decode an image, shrunk to fit `maxSize` per side when larger. Default: `createImageBitmap` (no premultiplying or color conversion; SVG via `decodeImageBlob`). */
  readonly decode?: (blob: Blob, maxSize: number) => Promise<TextureImage>;
  /** An image resized to exactly `size`² (decal layers). Default: `createImageBitmap` with resize options. */
  readonly resize?: (blob: Blob, size: number) => Promise<TextureImage>;
  /** A project file's bytes. Default: `fetch` of `url(path)`. */
  readonly fetchBytes?: (path: string) => Promise<Uint8Array>;
  /** An offscreen 2D canvas for text. Default: `new OffscreenCanvas(w, h)`. */
  readonly canvas2d?: (width: number, height: number) => CanvasLike2d;
  /** CSS font family for world text (default "system-ui, sans-serif"). */
  readonly font?: string;
  /** What the device can afford (`Settings.quality = "auto"`, `RenderSurface3d.deviceTier`). */
  readonly deviceTier?: Quality3d['level'];
  /** Milliseconds (frame pacing). Default: `performance.now`. */
  readonly now?: () => number;
}

/** What the last frame cost and drew (`globalThis.__parallax3d`, `BrowserSurface3d.stats`). */
export interface SurfaceStats {
  readonly backend: BackendKind;
  readonly frames: number;
  /** Per axis, of the canvas. */
  readonly renderScale: number;
  readonly renderWidth: number;
  readonly renderHeight: number;
  /** Milliseconds between the last two frames, and spent planning + recording the last one. */
  readonly frameMs: number;
  readonly cpuMs: number;
  readonly cull: CullStats;
  readonly textures: TextureStats;
  readonly decals: number;
  readonly targets: number;
  /** Hi-Z: on, suspended by its governor, or off at this quality. */
  readonly occlusion: 'active' | 'suspended' | 'off';
}

const BITMAP_OPTIONS = { imageOrientation: 'none', premultiplyAlpha: 'none', colorSpaceConversion: 'none' } as const;

/**
 * A bitmap of an image file with `extra` options. Raster formats decode straight from the blob;
 * an SVG (which `createImageBitmap` rejects) is rasterized through `decodeImageBlob` first.
 */
async function bitmapOf(blob: Blob, extra: ImageBitmapOptions = {}): Promise<ImageBitmap> {
  if (!isSvg(blob, '')) return createImageBitmap(blob, { ...BITMAP_OPTIONS, ...extra });
  const decoded = await decodeImageBlob(blob, '');
  const bitmap = await createImageBitmap(decoded as ImageBitmapSource, { ...BITMAP_OPTIONS, ...extra });
  if (typeof ImageBitmap !== 'undefined' && decoded instanceof ImageBitmap) decoded.close();
  return bitmap;
}

async function decodeBitmap(blob: Blob, maxSize: number): Promise<TextureImage> {
  const options = BITMAP_OPTIONS;
  const image = await bitmapOf(blob);
  const largest = Math.max(image.width, image.height);
  if (largest <= maxSize) return image;
  const k = maxSize / largest;
  const smaller = await createImageBitmap(image, {
    ...options, resizeWidth: Math.max(1, Math.round(image.width * k)), resizeHeight: Math.max(1, Math.round(image.height * k)), resizeQuality: 'high',
  });
  image.close();
  return smaller;
}

async function resizeBitmap(blob: Blob, size: number): Promise<TextureImage> {
  return bitmapOf(blob, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' });
}

const blobOf = (bytes: Uint8Array, type: string): Blob => new Blob([bytes as Uint8Array<ArrayBuffer>], { type });

/** The decal image array in use, and the one being built for a new set of images. */
interface DecalArrays {
  current: { readonly key: string; readonly texture: BackendTexture; readonly layers: ReadonlyMap<string, number> } | null;
  building: { readonly key: string; readonly images: Map<string, TextureImage | 'loading' | 'failed'> } | null;
}

export class BrowserSurface3d implements RenderSurface3d {
  readonly #canvas: { readonly width: number; readonly height: number };
  readonly #backend: Backend3d;
  readonly #url: (path: string) => string;
  readonly #fetchBytes: (path: string) => Promise<Uint8Array>;
  readonly #resize: (blob: Blob, size: number) => Promise<TextureImage>;
  readonly #text: TextRasterizer;
  readonly #textures: TextureStore;
  readonly #texts = new Map<string, { texture: BackendTexture; used: number }>();
  readonly #targets = new Map<string, number>();
  /** In-world UI screens' uploaded images by target name, with the version uploaded. */
  readonly #screens = new Map<string, { texture: BackendTexture; version: number }>();
  /**
   * Screen textures replaced by a repaint, kept until the next frame: a screen can be looked up
   * twice in one frame, and destroying the first lookup's texture before that frame is
   * submitted makes the GPU drop the whole frame.
   */
  #retiredScreens: BackendTexture[] = [];
  readonly #decals: DecalArrays = { current: null, building: null };
  readonly #terrainArrays: TerrainArrays;
  readonly #now: () => number;
  readonly #cap = new FrameCap();
  readonly #governor = new ResolutionGovernor();
  readonly deviceTier: Quality3d['level'] | undefined;
  #problems: Diagnostic[] = [];
  #frames = 0;
  #lastFrameAt: number | null = null;
  #stats: SurfaceStats | null = null;
  /** The last frame's plan, counted only when someone asks (`drawCounts`). */
  #lastPlan: FramePlan | null = null;
  #counts: DrawCounts | null = null;
  #hiz: HiZ | null = null;
  readonly #occlusion = new OcclusionGovernor();
  #lastEye: [number, number, number] | null = null;

  constructor(canvas: { readonly width: number; readonly height: number }, backend: Backend3d, options: BrowserSurface3dOptions) {
    this.#canvas = canvas;
    this.#backend = backend;
    this.#url = options.url;
    this.#now = options.now ?? (() => performance.now());
    this.#resize = options.resize ?? resizeBitmap;
    this.deviceTier = options.deviceTier;
    this.#fetchBytes = options.fetchBytes ?? (async (path) => {
      const response = await fetch(this.#url(path));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return new Uint8Array(await response.arrayBuffer());
    });
    const decode = options.decode ?? decodeBitmap;
    const loader: TextureLoader = {
      bytes: (path) => this.#fetchBytes(path),
      decode: (bytes, mimeType, maxSize) => decode(blobOf(bytes, mimeType), maxSize),
    };
    this.#textures = new TextureStore(backend, loader, (problem) => this.#problems.push(problem));
    this.#terrainArrays = new TerrainArrays(backend, {
      load: async (texture, size) => {
        const source = texture.source;
        if (source.kind === 'target') throw new Error('a render target is not an image');
        const bytes = source.kind === 'file' ? await this.#fetchBytes(source.path) : source.bytes;
        return this.#resize(blobOf(bytes, source.kind === 'file' ? imageMime(source.path) : source.mimeType), size);
      },
      solid: (rgba, size) => {
        const canvas = new OffscreenCanvas(size, size);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = `rgba(${rgba[0]}, ${rgba[1]}, ${rgba[2]}, ${rgba[3] / 255})`;
        ctx.fillRect(0, 0, size, size);
        return canvas as unknown as TextureImage;
      },
      pixels: (data, width, height) => new ImageData(new Uint8ClampedArray(data) as Uint8ClampedArray<ArrayBuffer>, width, height) as unknown as TextureImage,
    }, (problem) => this.#problems.push(problem));
    this.#text = new TextRasterizer(
      options.canvas2d ?? ((w, h) => new OffscreenCanvas(w, h) as unknown as CanvasLike2d),
      options.font,
    );
  }

  get backend(): BackendKind {
    return this.#backend.kind;
  }

  /** The last frame's stats (null before the first). */
  get stats(): SurfaceStats | null {
    return this.#stats;
  }

  /** Draw calls and triangles of the last frame, by pass (plan_counts.ts); null before the first. Counted on demand. */
  drawCounts(): DrawCounts | null {
    if (this.#counts === null && this.#lastPlan !== null) this.#counts = countPlan(this.#lastPlan);
    return this.#counts;
  }

  size(): { width: number; height: number } {
    return { width: this.#canvas.width, height: this.#canvas.height };
  }

  takeProblems(): readonly Diagnostic[] {
    const problems = this.#problems;
    this.#problems = [];
    return problems;
  }

  /** Report a problem found outside a frame (a lost GPU device). */
  report(problem: Diagnostic): void {
    this.#problems.push(problem);
  }

  wantsFrame(cap: number): boolean {
    return this.#cap.wants(this.#now(), cap);
  }

  draw(frame: Frame3d): void {
    for (const texture of this.#retiredScreens) this.#backend.destroyTexture(texture);
    this.#retiredScreens = [];
    const { width, height } = this.size();
    if (width === 0 || height === 0) return;
    const quality = frame.quality;
    const started = this.#now();
    // Dynamic resolution: the pixel budget caps the scale; the governor lowers it while frames run long.
    const frameMs = this.#lastFrameAt === null ? 0 : started - this.#lastFrameAt;
    this.#lastFrameAt = started;
    const ceiling = pixelBudgetScale(width, height, quality.maxRenderPixels);
    const budget = quality.frameCap > 0 ? 1000 / quality.frameCap : Math.max(1000 / 60, this.#cap.interval);
    const scale = frameMs > 0 && frameMs < 250
      ? this.#governor.update(frameMs, budget, Math.min(ceiling, quality.minRenderScale), ceiling)
      : Math.min(ceiling, this.#governor.scale);
    const renderWidth = Math.max(1, Math.round(width * scale));
    const renderHeight = Math.max(1, Math.round(height * scale));
    this.#textures.maxSize = quality.maxTextureSize;
    this.#textures.upload();
    const decalLayer = this.#decalLayers(frame);
    const terrainLayer = frame.terrain != null ? this.#terrainArrays.update(frame.terrain.materials, frame.quality.maxTextureSize) : undefined;
    const terrainBindings = frame.terrain != null ? this.#terrainArrays.bindings(frame.terrain.splat) : null;
    // Hi-Z: the newest read-back depth, used while the camera is still where it was drawn from.
    const grid = this.#backend.takeDepth();
    if (grid !== null) this.#hiz = new HiZ(grid);
    const occlusion = quality.occlusion && this.#occlusion.wanted;
    const hiz = occlusion && this.#hiz !== null && frame.views.some((v) => this.#hiz!.matches(v)) ? this.#hiz : null;
    const plan = planFrame(frame, {
      width: renderWidth, height: renderHeight, renderScale: renderWidth / width, output: { width, height },
      ready: (texture) => this.#ready(texture),
      text: (text) => this.#text.quad(text),
      decalLayer,
      ...(terrainLayer !== undefined && { terrainLayer }),
      terrainSplat: terrainBindings?.splat != null,
      readDepth: occlusion,
      ...(hiz !== null && { occluded: (camera: number, x: number, y: number, z: number, r: number) => camera === hiz.grid.camera && hiz.occluded(x, y, z, r) }),
    });
    const eye = frame.views[0]?.position;
    const last = this.#lastEye;
    const jumped = eye !== undefined && last !== null && Math.hypot(eye[0] - last[0], eye[1] - last[1], eye[2] - last[2]) > 10;
    this.#lastEye = eye === undefined ? null : [...eye];
    if (quality.occlusion) this.#occlusion.record(plan.stats, jumped);
    for (const group of plan.groups) if (group.target !== null) this.#targets.set(group.target.id, this.#frames);
    this.#backend.render(plan, (ref) => this.#handle(ref), { decals: this.#decals.current?.texture ?? null, terrain: terrainBindings });
    this.#lastPlan = plan;
    this.#counts = null;
    this.#frames++;
    for (const [id, entry] of this.#texts) {
      if (this.#frames - entry.used > TEXT_IDLE_FRAMES) {
        this.#backend.destroyTexture(entry.texture);
        this.#texts.delete(id);
      }
    }
    for (const [id, used] of this.#targets) {
      if (this.#frames - used > TARGET_IDLE_FRAMES) {
        this.#backend.dropTarget(id);
        this.#targets.delete(id);
      }
    }
    this.#textures.endFrame(quality.textureBudget);
    this.#stats = {
      backend: this.#backend.kind, frames: this.#frames, renderScale: renderWidth / width, renderWidth, renderHeight,
      frameMs, cpuMs: this.#now() - started, cull: plan.stats, textures: this.#textures.stats,
      decals: plan.decals?.views.reduce((n, v) => n + v.count, 0) ?? 0, targets: this.#targets.size,
      occlusion: quality.occlusion ? this.#occlusion.state : 'off',
    };
    (globalThis as { __parallax3d?: SurfaceStats }).__parallax3d = this.#stats;
  }

  /**
   * Draw a frame at its own size into its own targets and read the image back (a photo, a
   * portrait). Its textures must have loaded (a capture draws what is ready, like a frame).
   */
  capture(frame: Frame3d, width: number, height: number): Promise<Capture3d> {
    const terrainLayer = frame.terrain != null ? this.#terrainArrays.update(frame.terrain.materials, frame.quality.maxTextureSize) : undefined;
    const terrainBindings = frame.terrain != null ? this.#terrainArrays.bindings(frame.terrain.splat) : null;
    const plan = planFrame(frame, {
      width, height, output: { width, height },
      ready: (texture) => this.#ready(texture),
      text: (text) => this.#text.quad(text),
      decalLayer: this.#decalLayers(frame),
      ...(terrainLayer !== undefined && { terrainLayer }),
      terrainSplat: terrainBindings?.splat != null,
    });
    return new Promise((resolve) => {
      this.#backend.render(plan, (ref) => this.#handle(ref), { decals: this.#decals.current?.texture ?? null, terrain: terrainBindings }, (pixels) => resolve({ width, height, pixels }));
    });
  }

  dispose(): void {
    for (const texture of this.#retiredScreens) this.#backend.destroyTexture(texture);
    this.#retiredScreens = [];
    this.#textures.dispose();
    this.#terrainArrays.dispose();
    this.#backend.dispose();
  }

  #ready(texture: Texture3d): boolean {
    if (texture.source.kind === 'target') {
      const name = texture.source.target;
      if (name.startsWith('screen:')) return this.#screen(name) !== null;
      return this.#backend.target(name) !== null;
    }
    return this.#textures.ready(texture);
  }

  /**
   * An in-world UI screen's image (`screen:<entity>`, painted by the platform's screen
   * surface into `SCREEN_TARGETS`): uploaded again whenever its version moves. Null until
   * it is first painted.
   */
  #screen(name: string): BackendTexture | null {
    const painted = SCREEN_TARGETS.get(name);
    if (painted === undefined) return null;
    const known = this.#screens.get(name);
    if (known !== undefined && known.version === painted.version) return known.texture;
    if (known !== undefined) this.#retiredScreens.push(known.texture);
    const texture = this.#backend.createTexture(painted.canvas as unknown as TextureImage, { colorSpace: 'srgb', wrapU: 'clamp', wrapV: 'clamp', filter: 'linear' });
    this.#screens.set(name, { texture, version: painted.version });
    return texture;
  }

  /**
   * The layer of each decal image in the current array; when the frame's set of images
   * differs, a new array is built in the background (each image decoded at the layer size)
   * and swapped in once every image is ready. Undefined: the frame has no decals.
   */
  #decalLayers(frame: Frame3d): ((texture: Texture3d) => number | null) | undefined {
    const images = decalImages(frame.decals ?? []);
    if (images.length === 0) return undefined;
    const key = images.map((t) => t.id).join('\n');
    const d = this.#decals;
    if (d.current?.key !== key && d.building?.key !== key) {
      const building = { key, images: new Map<string, TextureImage | 'loading' | 'failed'>() };
      d.building = building;
      for (const texture of images) {
        building.images.set(texture.id, 'loading');
        const source = texture.source;
        const bytes = source.kind === 'file' ? this.#fetchBytes(source.path) : source.kind === 'bytes' ? Promise.resolve(source.bytes) : Promise.reject(new Error('a render target is not an image'));
        const type = source.kind === 'bytes' ? source.mimeType : source.kind === 'file' ? imageMime(source.path) : 'image/png';
        bytes.then((b) => this.#resize(blobOf(b, type), DECAL_LAYER_SIZE)).then(
          (image) => building.images.set(texture.id, image),
          (error: unknown) => {
            building.images.set(texture.id, 'failed');
            const where = source.kind === 'file' ? source.path : texture.id;
            this.#problems.push(diagnostic('PP3816', `The decal image ${where} could not be loaded (${String((error as Error)?.message ?? error)})`, {
              path: where, fix: 'Check that the file is deployed with the game and is a PNG, JPEG or WebP image.',
            }));
          },
        );
      }
    }
    const b = d.building;
    if (b !== null && [...b.images.values()].every((i) => i !== 'loading')) {
      const ok = images.filter((t) => b.images.get(t.id) instanceof Object);
      const texture = this.#backend.createTextureArray(ok.map((t) => b.images.get(t.id) as TextureImage), DECAL_LAYER_SIZE);
      if (d.current !== null) this.#backend.destroyTexture(d.current.texture);
      d.current = { key: b.key, texture, layers: new Map(ok.map((t, i) => [t.id, i])) };
      d.building = null;
    }
    const layers = d.current?.layers;
    return (texture) => layers?.get(texture.id) ?? null;
  }

  #handle(ref: TextureRef): BackendTexture {
    if (isTextTexture(ref)) {
      let entry = this.#texts.get(ref.id);
      if (entry === undefined) {
        const image = this.#text.raster(ref.text);
        entry = {
          texture: this.#backend.createTexture(image.canvas as unknown as TextureImage, { colorSpace: 'srgb', wrapU: 'clamp', wrapV: 'clamp', filter: 'linear' }),
          used: this.#frames,
        };
        this.#texts.set(ref.id, entry);
      }
      entry.used = this.#frames;
      return entry.texture;
    }
    if (ref.source.kind === 'target') {
      const name = ref.source.target;
      return name.startsWith('screen:') ? this.#screen(name)! : this.#backend.target(name)!;
    }
    return this.#textures.handle(ref.id);
  }
}

export interface CreateSurface3dOptions extends BrowserSurface3dOptions {
  /** `navigator.gpu` (default: the page's). */
  readonly gpu?: GpuLike;
  /** Force one API; default WebGPU, then WebGL2. */
  readonly prefer?: BackendKind;
  /**
   * A lost WebGPU device (a driver reset, a WebView's GPU process dying): by default the
   * tab remembers that WebGPU failed (`markWebGpuFailed`) and reloads, so it comes back on
   * WebGL2. A function replaces the reload (tests, an editor that keeps its state).
   */
  readonly onDeviceLost?: (message: string) => void;
}

/**
 * Pick the GPU API and make the surface. `fallbackReason` says why WebGPU wasn't used
 * (null when it was, or when WebGL2 was asked for).
 */
export async function createBrowserSurface3d(
  canvas: BackendCanvas & { readonly width: number; readonly height: number },
  options: CreateSurface3dOptions,
): Promise<{ readonly surface: BrowserSurface3d; readonly fallbackReason: string | null }> {
  const gpu = options.gpu ?? (globalThis.navigator as unknown as { gpu?: GpuLike } | undefined)?.gpu;
  const selection = await selectBackend({ gpu, canvas, ...(options.prefer !== undefined && { prefer: options.prefer }) });
  const backend = selection.kind === 'webgpu'
    ? new WebGpuBackend(selection.device, selection.context, selection.format)
    : new WebGl2Backend(selection.gl);
  const surface = new BrowserSurface3d(canvas, backend, options);
  if (selection.kind === 'webgpu' && selection.device.lost !== undefined) {
    void selection.device.lost.then((info) => {
      // `destroy()` on our own dispose is not a loss.
      if ((info as { reason?: string }).reason === 'destroyed') return;
      surface.report(diagnostic('PP9809', `The GPU device was lost (${info.message}); the game restarts on WebGL2`, {
        fix: 'If it keeps happening, the GPU driver is resetting; WebGL2 is used for the rest of this tab.',
      }));
      markWebGpuFailed();
      if (options.onDeviceLost !== undefined) options.onDeviceLost(info.message);
      else (globalThis as { location?: { reload(): void } }).location?.reload();
    });
  }
  return { surface, fallbackReason: selection.fallbackReason };
}
