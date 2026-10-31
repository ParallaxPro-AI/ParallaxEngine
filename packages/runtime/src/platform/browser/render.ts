/**
 * The 2D render port on a Canvas2D context. World meters (+y up) map to the canvas through
 * the frame's view; each command sets its own transform, so nothing leaks between them.
 *
 * Images decode asynchronously (`load`); a command whose image hasn't decoded yet is
 * skipped for that frame, and a failed load is reported through `takeProblems` (the
 * renderer raises it). Tinted images are tinted once into an offscreen canvas and cached.
 *
 * The canvas's backing size is the surface size: boot sizes it (CSS size × devicePixelRatio)
 * and keeps it in step with the page.
 */

import { diagnostic, fail, LIGHT_FALLOFF_STOPS, PARTICLE_STRIDE } from '../../core/index.js';
import type { Affine2d, Diagnostic, Draw2d, Fog2d, Frame2d, Lighting2d, RenderSurface2d, Rgba, Ripple2d, Stroke2d, TextDraw } from '../../core/index.js';

/** Wedges a 2D spot's soft edge is drawn in, each side. */
const SPOT_EDGE_STEPS = 6;

/** Bloom's glow is thresholded and blurred at 1/this of the viewport's size. */
const BLOOM_DOWNSCALE = 4;

/** The vignette's (offset along the radius to a corner, darkness) stops: smoothstep(0.35, 1, offset). */
export const VIGNETTE_STOPS: readonly (readonly [offset: number, darkness: number])[] = [0, 0.35, 0.5, 0.6, 0.7, 0.8, 0.9, 1].map((o) => {
  const x = Math.min(1, Math.max(0, (o - 0.35) / 0.65));
  return [o, x * x * (3 - 2 * x)] as const;
});

export type Context2d = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** A decoded image: anything Canvas2D can draw, with its pixel size. */
export type DecodedImage = CanvasImageSource & { readonly width: number; readonly height: number };

export interface CanvasLike {
  readonly width: number;
  readonly height: number;
  getContext(kind: '2d'): Context2d | null;
}

export interface CanvasSurfaceOptions {
  /** The URL a project path (`assets/images/ship.png`) is fetched from. */
  readonly url: (path: string) => string;
  /** Fetch and decode an image. Default: `fetch` + `decodeImageBlob` (raster formats and SVG). */
  readonly decode?: (url: string) => Promise<DecodedImage>;
  /** An offscreen canvas for tinting. Default: `new OffscreenCanvas(w, h)`. */
  readonly scratch?: (width: number, height: number) => CanvasLike;
  /** CSS font family for text (default "system-ui, sans-serif"). */
  readonly font?: string;
}

/** Canvas fonts misbehave at sub-pixel sizes, so text is laid out this many times larger and scaled back. */
const TEXT_SCALE = 64;

/** What `decodeImageBlob` uses from the page; tests pass fakes. */
export interface ImageDecoders {
  /** Raster formats (PNG, JPEG, WebP, GIF). */
  bitmap(source: Blob | DecodedImage): Promise<DecodedImage>;
  /** An `<img>` loaded from the blob: the only path that decodes SVG. */
  element(blob: Blob): Promise<{ image: DecodedImage; release(): void }>;
}

const PAGE_DECODERS: ImageDecoders = {
  bitmap: (source) => createImageBitmap(source as ImageBitmapSource),
  element: async (blob) => {
    const src = URL.createObjectURL(blob);
    const image = new Image();
    image.src = src;
    try {
      await image.decode();
    } catch (error) {
      URL.revokeObjectURL(src);
      throw error;
    }
    return { image, release: () => URL.revokeObjectURL(src) };
  },
};

/** An SVG by its content type or, when the server sends none, its file name. */
export function isSvg(blob: Blob, url: string): boolean {
  if (blob.type !== '') return blob.type.startsWith('image/svg');
  return /\.svgz?(?:[?#]|$)/i.test(url);
}

/**
 * Decode an image file. `createImageBitmap` rejects SVG, so an SVG loads into an `<img>` and is
 * rasterized at its intrinsic size (the `<img>` itself is kept when the browser can't
 * rasterize it, e.g. an SVG without width/height).
 */
export async function decodeImageBlob(blob: Blob, url: string, decoders: ImageDecoders = PAGE_DECODERS): Promise<DecodedImage> {
  if (!isSvg(blob, url)) return decoders.bitmap(blob);
  const { image, release } = await decoders.element(blob);
  try {
    const bitmap = await decoders.bitmap(image);
    release();
    return bitmap;
  } catch {
    return image;
  }
}

async function fetchAndDecode(url: string): Promise<DecodedImage> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return decodeImageBlob(await response.blob(), url);
}

function css(c: Rgba): string {
  const byte = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
  return `rgba(${byte(c[0])}, ${byte(c[1])}, ${byte(c[2])}, ${Math.min(1, Math.max(0, c[3]))})`;
}

function mul(p: Affine2d, l: Affine2d): Affine2d {
  return [
    p[0] * l[0] + p[2] * l[1], p[1] * l[0] + p[3] * l[1],
    p[0] * l[2] + p[2] * l[3], p[1] * l[2] + p[3] * l[3],
    p[0] * l[4] + p[2] * l[5] + p[4], p[1] * l[4] + p[3] * l[5] + p[5],
  ];
}

type Slot = { state: 'loading' } | { state: 'ready'; image: DecodedImage } | { state: 'failed' };

export class CanvasSurface2d implements RenderSurface2d {
  readonly #canvas: CanvasLike;
  readonly #ctx: Context2d;
  readonly #url: (path: string) => string;
  readonly #decode: (url: string) => Promise<DecodedImage>;
  readonly #scratch: (width: number, height: number) => CanvasLike;
  readonly #font: string;
  readonly #images = new Map<string, Slot>();
  readonly #tinted = new Map<string, DecodedImage>();
  #problems: Diagnostic[] = [];
  #lightMap: CanvasLike | null = null;
  /** The viewport as drawn, which shockwave ripples bend. */
  #rippleCopy: CanvasLike | null = null;
  /** Fog of war's cell image and the key it was painted for. */
  #fogImage: CanvasLike | null = null;
  #fogKey = '';
  /** Bloom's thresholded, blurred quarter-size copy of the viewport. */
  #glow: CanvasLike | null = null;

  constructor(canvas: CanvasLike, options: CanvasSurfaceOptions) {
    const ctx = canvas.getContext('2d');
    if (ctx === null) fail('PP9603', 'This canvas has no 2D context', { fix: 'Give render2d a canvas not already used for WebGL.' });
    this.#canvas = canvas;
    this.#ctx = ctx;
    this.#url = options.url;
    this.#decode = options.decode ?? fetchAndDecode;
    this.#scratch = options.scratch ?? ((w, h) => new OffscreenCanvas(w, h) as unknown as CanvasLike);
    this.#font = options.font ?? 'system-ui, sans-serif';
  }

  size(): { width: number; height: number } {
    return { width: this.#canvas.width, height: this.#canvas.height };
  }

  load(image: string): void {
    if (this.#images.has(image)) return;
    this.#images.set(image, { state: 'loading' });
    const url = this.#url(image);
    this.#decode(url).then(
      (decoded) => { this.#images.set(image, { state: 'ready', image: decoded }); },
      (error: unknown) => {
        this.#images.set(image, { state: 'failed' });
        this.#problems.push(diagnostic('PP3610', `The image ${image} could not be loaded from ${url} (${String((error as Error)?.message ?? error)})`, {
          path: image, fix: 'Check that the file is deployed with the game and is a PNG, JPEG, WebP or SVG image.',
        }));
      },
    );
  }

  takeProblems(): readonly Diagnostic[] {
    const problems = this.#problems;
    this.#problems = [];
    return problems;
  }

  /** Decoded and ready to draw (tests, loading screens). */
  ready(image: string): boolean {
    return this.#images.get(image)?.state === 'ready';
  }

  draw(frame: Frame2d): void {
    const ctx = this.#ctx;
    const { width, height } = this.#canvas;
    const { view } = frame;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, width, height);

    const [fx, fy, fw, fh] = view.viewport;
    const vx = fx * width;
    const vy = fy * height;
    const vw = fw * width;
    const vh = fh * height;
    ctx.save();
    ctx.beginPath();
    ctx.rect(vx, vy, vw, vh);
    ctx.clip();
    if (view.background !== null) {
      ctx.fillStyle = css(view.background);
      ctx.fillRect(vx, vy, vw, vh);
    }

    // world → pixels: center the view, meters → pixels with y flipped, undo the camera's roll.
    const k = vh / 2 / view.halfHeight;
    const r = (-view.angle * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    const toScreen = mul(
      [k, 0, 0, -k, vx + vw / 2, vy + vh / 2],
      mul([c, s, -s, c, 0, 0], [1, 0, 0, 1, -view.center[0], -view.center[1]]),
    );
    for (const command of frame.commands) {
      // An additive sprite adds its colors to what is under it (glows, lasers, magic).
      const additive = (command.kind === 'image' || command.kind === 'rect') && command.blend === 'additive';
      if (additive) this.#ctx.globalCompositeOperation = 'lighter';
      this.#command(toScreen, command);
      if (additive) this.#ctx.globalCompositeOperation = 'source-over';
    }
    if (frame.lighting !== null) this.#light(frame.lighting, toScreen, k, view.angle, vx, vy, vw, vh);
    const post = frame.post ?? null;
    // Bloom glows from the lit scene, under the fog of war (unexplored ground doesn't glow through).
    if (post !== null && post.bloom > 0 && post.bloomThreshold < 1) this.#bloom(post.bloom, post.bloomThreshold, vx, vy, vw, vh);
    const fog = frame.fog ?? null;
    if (fog !== null) this.#fog(fog, toScreen);
    if (frame.ripples !== undefined && frame.ripples.length > 0) this.#ripples(frame.ripples, toScreen, k, vx, vy, vw, vh);
    if (post !== null && post.vignette > 0) this.#vignette(post.vignette, vx, vy, vw, vh);
    ctx.restore();
  }

  /**
   * Bloom: the viewport drawn into a quarter-size canvas through one filter chain — a
   * threshold (brightness then contrast: (c - t) / (1 - t), so only what is brighter than
   * `threshold` survives) and a blur — then added back over the viewport (`lighter`),
   * `strength` times (whole passes at full alpha, the rest at partial). Browsers without
   * canvas filters (no `filter` property) skip it: unthresholded, it would wash the image out.
   */
  #bloom(strength: number, threshold: number, vx: number, vy: number, vw: number, vh: number): void {
    const w = Math.max(1, Math.ceil(vw / BLOOM_DOWNSCALE));
    const h = Math.max(1, Math.ceil(vh / BLOOM_DOWNSCALE));
    if (this.#glow === null || this.#glow.width !== w || this.#glow.height !== h) this.#glow = this.#scratch(w, h);
    const g = this.#glow.getContext('2d');
    if (g === null) fail('PP9603', 'The bloom canvas has no 2D context');
    if (typeof g.filter !== 'string') return;
    const t = Math.max(0, threshold);
    const blur = Math.max(1.5, h / 60);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'copy';
    g.imageSmoothingEnabled = true;
    g.filter = `brightness(${(1 / (1 + t)).toFixed(4)}) contrast(${((1 + t) / (1 - t)).toFixed(4)}) blur(${blur.toFixed(2)}px)`;
    g.drawImage(this.#canvas as unknown as CanvasImageSource, vx, vy, vw, vh, 0, 0, w, h);
    g.filter = 'none';
    g.globalCompositeOperation = 'source-over';
    const ctx = this.#ctx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    ctx.imageSmoothingEnabled = true;
    for (let left = Math.min(strength, 8); left > 0.001; left -= 1) {
      ctx.globalAlpha = Math.min(1, left);
      ctx.drawImage(this.#glow as unknown as CanvasImageSource, 0, 0, w, h, vx, vy, vw, vh);
    }
    ctx.restore();
  }

  /**
   * Vignette: black over the viewport, its alpha `amount · smoothstep(0.35, 1, corner)` where
   * corner is 0 at the center and 1 in the corners (an ellipse with the viewport's aspect),
   * as the 3D post pass darkens.
   */
  #vignette(amount: number, vx: number, vy: number, vw: number, vh: number): void {
    const ctx = this.#ctx;
    ctx.save();
    // The viewport as the square -1..1: a circular gradient there is the viewport's ellipse.
    ctx.setTransform(vw / 2, 0, 0, vh / 2, vx + vw / 2, vy + vh / 2);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    const gradient = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.SQRT2);
    for (const [offset, darkness] of VIGNETTE_STOPS) gradient.addColorStop(offset, `rgba(0, 0, 0, ${(Math.min(1, amount) * darkness).toFixed(4)})`);
    ctx.fillStyle = gradient;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }

  /**
   * Shockwave ripples over the finished image: the viewport is copied, then each ring's band
   * is redrawn in thin annuli from the copy magnified about the ring's center, so the image
   * bulges outward across the band (most at its middle), with a faint bright edge.
   */
  #ripples(ripples: readonly Ripple2d[], toScreen: Affine2d, pixelsPerMeter: number, vx: number, vy: number, vw: number, vh: number): void {
    const w = Math.max(1, Math.ceil(vw));
    const h = Math.max(1, Math.ceil(vh));
    if (this.#rippleCopy === null || this.#rippleCopy.width !== w || this.#rippleCopy.height !== h) this.#rippleCopy = this.#scratch(w, h);
    const g = this.#rippleCopy.getContext('2d');
    if (g === null) fail('PP9603', 'The ripple canvas has no 2D context');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'copy';
    g.drawImage(this.#canvas as unknown as CanvasImageSource, vx, vy, w, h, 0, 0, w, h);
    g.globalCompositeOperation = 'source-over';
    const copy = this.#rippleCopy as unknown as CanvasImageSource;
    const ctx = this.#ctx;
    for (const ripple of ripples) {
      const sx = toScreen[0] * ripple.x + toScreen[2] * ripple.y + toScreen[4];
      const sy = toScreen[1] * ripple.x + toScreen[3] * ripple.y + toScreen[5];
      const radius = ripple.radius * pixelsPerMeter;
      const width = Math.min(ripple.width * pixelsPerMeter, radius * 2);
      const strength = Math.min(1, Math.max(0, ripple.strength));
      if (!(width > 1 && strength > 0)) continue;
      const inner = Math.max(0, radius - width / 2);
      const span = radius + width / 2 - inner;
      // Annuli about 2 px wide: the bend changes smoothly from one to the next.
      const bands = Math.min(64, Math.max(6, Math.ceil(span / 2)));
      const step = span / bands;
      for (let i = 0; i < bands; i++) {
        const r0 = inner + i * step;
        const r1 = r0 + step + 0.75; // a sliver of overlap: no seams between annuli
        const mid = r0 + step / 2;
        const shift = strength * width * 0.25 * Math.sin((Math.PI * (mid - inner)) / span);
        if (shift < 0.05 || mid <= shift + 1) continue;
        const scale = mid / (mid - shift);
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.beginPath();
        ctx.arc(sx, sy, r1, 0, Math.PI * 2);
        if (r0 > 0) ctx.arc(sx, sy, r0, 0, Math.PI * 2, true);
        ctx.clip();
        // Only the band's square: the copy around the center, magnified by `scale` about it.
        const src = r1 / scale;
        ctx.drawImage(copy, sx - vx - src, sy - vy - src, src * 2, src * 2, sx - r1, sy - r1, r1 * 2, r1 * 2);
        ctx.restore();
      }
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = `rgba(255, 255, 255, ${(0.12 * strength).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, width * 0.08);
      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Fog of war: one pixel per cell (its state's color), drawn smoothed over the grid's world rectangle. */
  #fog(fog: Fog2d, toScreen: Affine2d): void {
    if (fog.cols === 0 || fog.rows === 0) return;
    if (this.#fogKey !== fog.key || this.#fogImage === null) {
      const image = this.#scratch(fog.cols, fog.rows);
      const g = image.getContext('2d')!;
      const pixels = g.createImageData(fog.cols, fog.rows);
      const paint = (i: number, c: Rgba): void => {
        pixels.data[i * 4] = Math.round(c[0] * 255);
        pixels.data[i * 4 + 1] = Math.round(c[1] * 255);
        pixels.data[i * 4 + 2] = Math.round(c[2] * 255);
        pixels.data[i * 4 + 3] = Math.round(c[3] * 255);
      };
      for (let row = 0; row < fog.rows; row++) {
        for (let col = 0; col < fog.cols; col++) {
          const cell = fog.cells[row * fog.cols + col]!;
          // Image row 0 is the grid's top (its last row: +y is up on screen).
          const i = (fog.rows - 1 - row) * fog.cols + col;
          if ((cell & 1) !== 0) paint(i, [0, 0, 0, 0]);
          else paint(i, (cell & 2) !== 0 ? fog.explored : fog.unexplored);
        }
      }
      g.putImageData(pixels, 0, 0);
      this.#fogImage = image;
      this.#fogKey = fog.key;
    }
    const ctx = this.#ctx;
    ctx.save();
    ctx.setTransform(...toScreen);
    ctx.imageSmoothingEnabled = true;
    // The image's top edge is the grid's maxY; world +y is up, so flip it into place.
    ctx.transform(1, 0, 0, -1, 0, 0);
    ctx.drawImage(this.#fogImage as unknown as CanvasImageSource, fog.minX, -(fog.minY + fog.rows * fog.cell), fog.cols * fog.cell, fog.rows * fog.cell);
    ctx.restore();
  }

  /**
   * The light map (ambient, plus each light added with its falloff) drawn offscreen at the
   * viewport's size, then multiplied over the scene.
   */
  #light(lighting: Lighting2d, toScreen: Affine2d, pixelsPerMeter: number, viewAngle: number, vx: number, vy: number, vw: number, vh: number): void {
    const w = Math.max(1, Math.ceil(vw));
    const h = Math.max(1, Math.ceil(vh));
    if (this.#lightMap === null || this.#lightMap.width !== w || this.#lightMap.height !== h) this.#lightMap = this.#scratch(w, h);
    const g = this.#lightMap.getContext('2d');
    if (g === null) fail('PP9603', 'The light map canvas has no 2D context');
    const byte = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 255);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    const [ar, ag, ab] = lighting.ambient;
    g.fillStyle = `rgb(${byte(ar)}, ${byte(ag)}, ${byte(ab)})`;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'lighter';
    for (const light of lighting.lights) {
      const sx = toScreen[0] * light.x + toScreen[2] * light.y + toScreen[4] - vx;
      const sy = toScreen[1] * light.x + toScreen[3] * light.y + toScreen[5] - vy;
      const radius = light.radius * pixelsPerMeter;
      if (radius <= 0) continue;
      const gradient = g.createRadialGradient(sx, sy, 0, sx, sy, radius);
      for (const [offset, strength] of LIGHT_FALLOFF_STOPS) {
        const s = strength * light.intensity;
        gradient.addColorStop(offset, `rgb(${byte(light.color[0] * s)}, ${byte(light.color[1] * s)}, ${byte(light.color[2] * s)})`);
      }
      g.fillStyle = gradient;
      g.beginPath();
      if (light.kind === 'spot' && light.inner !== undefined && light.inner < light.cone) {
        // A soft-edged cone: the core at full strength, then wedges stepping down to the edge.
        const center = (-(light.direction - viewAngle) * Math.PI) / 180;
        const inner = (light.inner / 2) * (Math.PI / 180);
        const outer = (light.cone / 2) * (Math.PI / 180);
        const wedge = (from: number, to: number): void => {
          g.beginPath();
          g.moveTo(sx, sy);
          g.arc(sx, sy, radius, from, to);
          g.closePath();
          g.fill();
        };
        if (inner > 0) wedge(center - inner, center + inner);
        const step = (outer - inner) / SPOT_EDGE_STEPS;
        for (let i = 0; i < SPOT_EDGE_STEPS; i++) {
          const e = 1 - (i + 0.5) / SPOT_EDGE_STEPS;
          g.globalAlpha = e * e * (3 - 2 * e);
          wedge(center - inner - step * (i + 1), center - inner - step * i);
          wedge(center + inner + step * i, center + inner + step * (i + 1));
        }
        g.globalAlpha = 1;
        continue;
      } else if (light.kind === 'spot') {
        // Screen y points down and the camera's roll turns the world: the cone's screen angle.
        const center = (-(light.direction - viewAngle) * Math.PI) / 180;
        const half = (light.cone / 2) * (Math.PI / 180);
        g.moveTo(sx, sy);
        g.arc(sx, sy, radius, center - half, center + half);
        g.closePath();
      } else {
        g.arc(sx, sy, radius, 0, Math.PI * 2);
      }
      g.fill();
    }
    const ctx = this.#ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'multiply';
    ctx.drawImage(this.#lightMap as unknown as CanvasImageSource, vx, vy);
    ctx.globalCompositeOperation = 'source-over';
  }

  /** Outline the current path (built in local meters, so the width is in meters too). */
  #stroke(stroke: Stroke2d | undefined): void {
    if (stroke === undefined) return;
    const ctx = this.#ctx;
    ctx.strokeStyle = css(stroke.color);
    ctx.lineWidth = stroke.width;
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  #set(m: Affine2d): void {
    this.#ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  }

  #ready(path: string): DecodedImage | undefined {
    const slot = this.#images.get(path);
    if (slot === undefined) this.load(path);
    return slot?.state === 'ready' ? slot.image : undefined;
  }

  #command(view: Affine2d, d: Draw2d): void {
    const ctx = this.#ctx;
    ctx.globalAlpha = 1;
    switch (d.kind) {
      case 'rect': {
        this.#set(mul(view, d.transform));
        const [w, h] = d.size;
        ctx.fillStyle = css(d.fill);
        if (d.radius === undefined && d.stroke === undefined) {
          ctx.fillRect(-w / 2, -h / 2, w, h);
          return;
        }
        ctx.beginPath();
        if (d.radius !== undefined) ctx.roundRect(-w / 2, -h / 2, w, h, d.radius);
        else ctx.rect(-w / 2, -h / 2, w, h);
        if (d.fill[3] > 0) ctx.fill();
        this.#stroke(d.stroke);
        return;
      }
      case 'ellipse': {
        this.#set(mul(view, d.transform));
        ctx.beginPath();
        ctx.ellipse(0, 0, d.size[0] / 2, d.size[1] / 2, 0, 0, Math.PI * 2);
        if (d.hole !== undefined) {
          // The hole as its own subpath: even-odd leaves it unfilled.
          ctx.moveTo(d.hole[0] / 2, 0);
          ctx.ellipse(0, 0, d.hole[0] / 2, d.hole[1] / 2, 0, 0, Math.PI * 2);
        }
        const rule: CanvasFillRule = d.hole === undefined ? 'nonzero' : 'evenodd';
        const image = d.image === null ? undefined : this.#ready(d.image);
        if (image === undefined) {
          ctx.fillStyle = css(d.fill);
          ctx.fill(rule);
          this.#stroke(d.stroke);
          return;
        }
        ctx.save();
        ctx.clip(rule);
        this.#set(mul(mul(view, d.transform), [1, 0, 0, -1, 0, 0]));
        this.#image(image, d.image!, d.fill, d.size[0], d.size[1]);
        ctx.restore();
        if (d.stroke !== undefined) {
          // The clip's restore dropped the transform the path was built in; the path stays.
          this.#set(mul(view, d.transform));
          this.#stroke(d.stroke);
        }
        return;
      }
      case 'polygon': {
        if (d.points.length < 6) return;
        this.#set(mul(view, d.transform));
        ctx.beginPath();
        ctx.moveTo(d.points[0]!, d.points[1]!);
        for (let i = 2; i < d.points.length; i += 2) ctx.lineTo(d.points[i]!, d.points[i + 1]!);
        ctx.closePath();
        ctx.fillStyle = css(d.fill);
        ctx.fill();
        this.#stroke(d.stroke);
        return;
      }
      case 'image': {
        const image = this.#ready(d.image);
        if (image === undefined) return;
        // Images are stored y-down; the world is y-up.
        this.#set(mul(mul(view, d.transform), [d.flipX ? -1 : 1, 0, 0, d.flipY ? 1 : -1, 0, 0]));
        this.#image(image, d.image, d.tint, d.size[0], d.size[1]);
        return;
      }
      case 'text':
        this.#text(view, d);
        return;
      case 'particles': {
        const data = d.data;
        const image = d.image === null ? undefined : this.#ready(d.image);
        if (d.image !== null && image === undefined) return;
        // Additive: overlapping particles add up toward white (fire, sparks, magic).
        if (d.blend === 'additive') ctx.globalCompositeOperation = 'lighter';
        for (let i = 0; i < d.count; i++) {
          const o = i * PARTICLE_STRIDE;
          const size = data[o + 2]!;
          const color: Rgba = [data[o + 4]!, data[o + 5]!, data[o + 6]!, data[o + 7]!];
          const a = (data[o + 3]! * Math.PI) / 180;
          const at = mul(view, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), data[o]!, data[o + 1]!]);
          if (image !== undefined) {
            this.#set(mul(at, [1, 0, 0, -1, 0, 0]));
            // Quantized so a fading particle reuses a handful of tinted copies.
            const q = (v: number): number => Math.round(v * 15) / 15;
            this.#image(image, d.image!, [q(color[0]), q(color[1]), q(color[2]), color[3]], size, size);
          } else if (d.shape === 'square') {
            this.#set(at);
            ctx.fillStyle = css(color);
            ctx.fillRect(-size / 2, -size / 2, size, size);
          } else {
            this.#set(at);
            ctx.fillStyle = css(color);
            ctx.beginPath();
            ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.globalCompositeOperation = 'source-over';
        return;
      }
      case 'line': {
        if (d.points.length < 4) return;
        this.#set(view);
        ctx.strokeStyle = css(d.color);
        ctx.lineWidth = d.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(d.points[0]!, d.points[1]!);
        for (let i = 2; i < d.points.length; i += 2) ctx.lineTo(d.points[i]!, d.points[i + 1]!);
        ctx.stroke();
        return;
      }
    }
  }

  /** Draw an image centered on the current origin, tinted (RGB multiplied, alpha as opacity). */
  #image(image: DecodedImage, path: string, tint: Rgba, w: number, h: number): void {
    const ctx = this.#ctx;
    const plain = tint[0] === 1 && tint[1] === 1 && tint[2] === 1;
    const source = plain ? image : this.#tint(image, path, tint);
    ctx.globalAlpha = Math.min(1, Math.max(0, tint[3]));
    ctx.drawImage(source, -w / 2, -h / 2, w, h);
    ctx.globalAlpha = 1;
  }

  #tint(image: DecodedImage, path: string, tint: Rgba): DecodedImage {
    const key = `${path}|${tint[0]},${tint[1]},${tint[2]}`;
    const cached = this.#tinted.get(key);
    if (cached !== undefined) return cached;
    const canvas = this.#scratch(image.width, image.height);
    const g = canvas.getContext('2d')!;
    g.drawImage(image, 0, 0);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = css([tint[0], tint[1], tint[2], 1]);
    g.fillRect(0, 0, image.width, image.height);
    // multiply fills transparent pixels too; keep only the image's own alpha.
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(image, 0, 0);
    const tinted = canvas as unknown as DecodedImage;
    this.#tinted.set(key, tinted);
    return tinted;
  }

  #text(view: Affine2d, d: TextDraw): void {
    const ctx = this.#ctx;
    // Text is laid out y-down at TEXT_SCALE units per meter.
    this.#set(mul(mul(view, d.transform), [1 / TEXT_SCALE, 0, 0, -1 / TEXT_SCALE, 0, 0]));
    const px = d.size * TEXT_SCALE;
    const lines: Array<Array<{ text: string; font: string; color: string; width: number }>> = [[]];
    for (const span of d.spans) {
      const font = `${span.bold ? 'bold ' : ''}${px}px ${this.#font}`;
      span.text.split('\n').forEach((part, i) => {
        if (i > 0) lines.push([]);
        if (part === '') return;
        ctx.font = font;
        lines[lines.length - 1]!.push({ text: part, font, color: css(span.color), width: ctx.measureText(part).width });
      });
    }
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const top = (-(lines.length - 1) * px) / 2;
    lines.forEach((line, row) => {
      let x = -line.reduce((sum, part) => sum + part.width, 0) / 2;
      for (const part of line) {
        ctx.font = part.font;
        ctx.fillStyle = part.color;
        ctx.fillText(part.text, x, top + row * px);
        x += part.width;
      }
    });
  }
}
