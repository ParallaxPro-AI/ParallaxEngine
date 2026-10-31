import { diagnostic, fail } from '../../core/index.js';
import type { BinaryFiles, Capture3d, Diagnostic, Frame3d, Material3d, RenderSurface3d, Texture3d } from '../../core/index.js';

export interface RecordingSurface3dOptions {
  /** Pretend screen size in pixels (default 1280 × 720). */
  readonly width?: number;
  readonly height?: number;
  /** How many recent frames to keep (default 1). */
  readonly keep?: number;
  /** Texture files that fail to load, as a broken or missing file would in a browser. */
  readonly failing?: readonly string[];
}

/** Every texture a frame draws with (materials, terrain layers, billboard and particle images). */
export function frameTextures(frame: Frame3d): Texture3d[] {
  const out = new Set<Texture3d>();
  const material = (m: Material3d): void => {
    for (const t of [m.baseColorTexture, m.metallicRoughnessTexture, m.emissiveTexture, m.normalTexture ?? null, m.occlusionTexture ?? null]) {
      if (t !== null) out.add(t);
    }
  };
  for (const batch of frame.meshes) material(batch.material);
  for (const draw of frame.skinned) material(draw.material);
  for (const m of frame.terrain?.materials ?? []) {
    if (m.texture !== null) out.add(m.texture);
    if (m.detail !== null) out.add(m.detail);
  }
  for (const batch of frame.billboards) if (batch.image !== null) out.add(batch.image);
  for (const batch of frame.particles ?? []) if (batch.image !== null) out.add(batch.image);
  return [...out];
}

/**
 * A 3D surface that draws nothing and remembers everything: the frames it was given and
 * the textures they used. Playtests and engine tests assert on it; it never touches a GPU.
 */
export class RecordingSurface3d implements RenderSurface3d {
  readonly width: number;
  readonly height: number;
  readonly #keep: number;
  readonly #failing: ReadonlySet<string>;
  readonly #textures = new Map<string, Texture3d>();
  #frames: Frame3d[] = [];
  #drawn = 0;
  #problems: Diagnostic[] = [];

  constructor(options: RecordingSurface3dOptions = {}) {
    this.width = options.width ?? 1280;
    this.height = options.height ?? 720;
    this.#keep = options.keep ?? 1;
    if (!(Number.isInteger(this.#keep) && this.#keep >= 1)) fail('PP9803', `keep must be a whole number of frames ≥ 1, got ${this.#keep}`);
    this.#failing = new Set(options.failing ?? []);
  }

  size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  /** Captures asked for (photos, portraits): their frames and sizes, oldest first. */
  readonly captures: { readonly frame: Frame3d; readonly width: number; readonly height: number }[] = [];

  /**
   * Records the capture; the image is the frame's first view's clear color (or its sky's
   * horizon) everywhere — headless draws nothing, but the size and background are honest.
   */
  capture(frame: Frame3d, width: number, height: number): Promise<Capture3d> {
    this.captures.push({ frame, width, height });
    const view = frame.views[0];
    const c = view?.clear ?? [...frame.environment.sky.horizon, 1];
    const pixels = new Uint8Array(width * height * 4);
    const px = [c[0]!, c[1]!, c[2]!, c[3] ?? 1].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
    for (let i = 0; i < pixels.length; i += 4) pixels.set(px, i);
    return Promise.resolve({ width, height, pixels });
  }

  draw(frame: Frame3d): void {
    this.#drawn++;
    for (const texture of frameTextures(frame)) {
      if (this.#textures.has(texture.id)) continue;
      this.#textures.set(texture.id, texture);
      // Built-in textures are generated on first read of their source (render3d's flipbooks): never a file.
      if (!texture.id.startsWith('builtin:') && texture.source.kind === 'file' && this.#failing.has(texture.source.path)) {
        this.#problems.push(diagnostic('PP3816', `The texture ${texture.source.path} could not be loaded`, {
          path: texture.source.path, fix: 'Check that the file is a PNG, JPEG or WebP image the browser can decode.',
        }));
      }
    }
    this.#frames.push(frame);
    if (this.#frames.length > this.#keep) this.#frames = this.#frames.slice(-this.#keep);
  }

  takeProblems(): readonly Diagnostic[] {
    const problems = this.#problems;
    this.#problems = [];
    return problems;
  }

  /** Textures seen, by id, in first-use order. */
  get textures(): ReadonlyMap<string, Texture3d> {
    return this.#textures;
  }

  get frames(): readonly Frame3d[] {
    return this.#frames;
  }

  get last(): Frame3d | undefined {
    return this.#frames[this.#frames.length - 1];
  }

  get drawn(): number {
    return this.#drawn;
  }
}

/** Binary files from memory (tests, the headless runner). A missing path rejects like a 404. */
export class MemoryBinaryFiles implements BinaryFiles {
  readonly #files: ReadonlyMap<string, Uint8Array>;

  constructor(files: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>) {
    this.#files = files instanceof Map ? files : new Map(Object.entries(files));
  }

  read(path: string): Promise<Uint8Array> {
    const bytes = this.#files.get(path);
    return bytes === undefined ? Promise.reject(new Error(`no file ${path}`)) : Promise.resolve(bytes);
  }
}
