/**
 * Textures the foliage renderer draws itself, so built-in foliage needs no asset files
 * (after the platform engine's leaf_spray.ts):
 *
 *   leaf spray   a 256² alpha cutout of a whole sprig — a forked stem carrying dozens of
 *                leaflets — per leaf ARCHETYPE (a silhouette family: lobed broadleaf,
 *                ovate, needle fan, pinnate frond, narrow lance). RGB is a light luminance
 *                detail (midribs, per-leaf tone), not a color: the material's color is the
 *                layer's, and the mesh's vertex colors shade the crown
 *   bark         a tiling 128 × 256 luminance map per bark kind (furrowed, birch with dark
 *                lenticels, smooth, ringed palm), multiplied by the species' bark color
 *
 * Images are built as RGBA pixels and stored as PNG bytes (`TextureSource` 'bytes'): an
 * uncompressed-deflate PNG writer, a few lines of CRC and Adler. Deterministic (hash2).
 * Far foliage is drawn with the renderer's impostors, baked from the meshes themselves.
 */

import { hash2 } from '../../../core/index.js';
import type { Texture3d } from '../../../core/index.js';
import type { LeafArchetype } from './foliage_tree.js';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** RGBA pixels (row-major, top row first) as PNG bytes, deflate "stored" blocks. */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const zlib = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  zlib[0] = 0x78;
  zlib[1] = 0x01;
  let o = 2;
  for (let b = 0; b < blocks; b++) {
    const start = b * 65535;
    const len = Math.min(65535, raw.length - start);
    zlib[o++] = b === blocks - 1 ? 1 : 0;
    zlib[o++] = len & 0xff;
    zlib[o++] = len >>> 8;
    zlib[o++] = ~len & 0xff;
    zlib[o++] = (~len >>> 8) & 0xff;
    zlib.set(raw.subarray(start, start + len), o);
    o += len;
  }
  let a = 1;
  let s = 0;
  for (const byte of raw) {
    a = (a + byte) % 65521;
    s = (s + a) % 65521;
  }
  const adler = ((s << 16) | a) >>> 0;
  zlib[o++] = adler >>> 24;
  zlib[o++] = (adler >>> 16) & 0xff;
  zlib[o++] = (adler >>> 8) & 0xff;
  zlib[o++] = adler & 0xff;

  const chunks: [string, Uint8Array][] = [
    ['IHDR', new Uint8Array([width >>> 24, (width >>> 16) & 255, (width >>> 8) & 255, width & 255, height >>> 24, (height >>> 16) & 255, (height >>> 8) & 255, height & 255, 8, 6, 0, 0, 0])],
    ['IDAT', zlib],
    ['IEND', new Uint8Array(0)],
  ];
  const size = 8 + chunks.reduce((n, [, d]) => n + 12 + d.length, 0);
  const out = new Uint8Array(size);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let p = 8;
  for (const [type, data] of chunks) {
    out[p] = data.length >>> 24;
    out[p + 1] = (data.length >>> 16) & 255;
    out[p + 2] = (data.length >>> 8) & 255;
    out[p + 3] = data.length & 255;
    for (let i = 0; i < 4; i++) out[p + 4 + i] = type.charCodeAt(i);
    out.set(data, p + 8);
    const crc = crc32(out, p + 4, p + 8 + data.length);
    out[p + 8 + data.length] = crc >>> 24;
    out[p + 9 + data.length] = (crc >>> 16) & 255;
    out[p + 10 + data.length] = (crc >>> 8) & 255;
    out[p + 11 + data.length] = crc & 255;
    p += 12 + data.length;
  }
  return out;
}

function texture(id: string, bytes: Uint8Array, wrap: 'clamp' | 'repeat'): Texture3d {
  return { id, source: { kind: 'bytes', bytes, mimeType: 'image/png' }, colorSpace: 'srgb', wrapU: wrap, wrapV: wrap, filter: 'linear' };
}

/** Pixel painter over an RGBA buffer. */
class Canvas {
  readonly width: number;
  readonly height: number;
  readonly px: Uint8Array;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.px = new Uint8Array(width * height * 4);
  }

  /** An ellipse centered at (cx, cy), radii rx, ry, turned by (cos, sin), shaded by `shade(u, v)` (u, v in -1..1). */
  ellipse(cx: number, cy: number, rx: number, ry: number, cos: number, sin: number, color: (u: number, v: number) => readonly [number, number, number]): void {
    const reach = Math.ceil(Math.max(rx, ry)) + 1;
    for (let y = Math.max(0, Math.floor(cy - reach)); y < Math.min(this.height, Math.ceil(cy + reach)); y++) {
      for (let x = Math.max(0, Math.floor(cx - reach)); x < Math.min(this.width, Math.ceil(cx + reach)); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const u = (dx * cos + dy * sin) / rx;
        const v = (-dx * sin + dy * cos) / ry;
        if (u * u + v * v > 1) continue;
        const [r, g, b] = color(u, v);
        const o = (y * this.width + x) * 4;
        this.px[o] = r;
        this.px[o + 1] = g;
        this.px[o + 2] = b;
        this.px[o + 3] = 255;
      }
    }
  }

  rect(x0: number, y0: number, x1: number, y1: number, rgb: readonly [number, number, number]): void {
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(this.height, Math.ceil(y1)); y++) {
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(this.width, Math.ceil(x1)); x++) {
        const o = (y * this.width + x) * 4;
        this.px.set([rgb[0], rgb[1], rgb[2], 255], o);
      }
    }
  }
}

const sprays = new Map<LeafArchetype, Texture3d>();

/** Paints one leaflet: base (x, y) in pixels, pointing `angle` (radians, 0 = up), `len` long. */
function leaflet(c: Canvas, x: number, y: number, angle: number, len: number, width: number, profile: (t: number) => number, tone: number, lobes = 0): void {
  const ux = Math.sin(angle);
  const uy = -Math.cos(angle);
  const reach = len + width;
  for (let py = Math.max(0, Math.floor(y - reach)); py < Math.min(c.height, Math.ceil(y + reach)); py++) {
    for (let px = Math.max(0, Math.floor(x - reach)); px < Math.min(c.width, Math.ceil(x + reach)); px++) {
      const dx = px + 0.5 - x;
      const dy = py + 0.5 - y;
      const t = (dx * ux + dy * uy) / len;
      if (t < 0 || t > 1) continue;
      const s = Math.abs(-dx * uy + dy * ux);
      let w = width * profile(t);
      if (lobes > 0) w *= 0.78 + 0.22 * Math.abs(Math.cos(t * Math.PI * lobes));
      if (s > w) continue;
      const vein = s < Math.max(0.6, w * 0.08) ? 0.8 : 1;
      const light = (0.82 + 0.18 * (1 - s / Math.max(w, 1e-3))) * vein * (0.94 + 0.06 * t);
      const o = (py * c.width + px) * 4;
      const v = Math.round(Math.min(255, tone * light));
      c.px[o] = Math.round(v * 0.96);
      c.px[o + 1] = v;
      c.px[o + 2] = Math.round(v * 0.9);
      c.px[o + 3] = 255;
    }
  }
}

/** A stem from (x0, y0) to (x1, y1), `w` pixels wide. */
function stem(c: Canvas, x0: number, y0: number, x1: number, y1: number, w: number): void {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0));
  for (let i = 0; i <= n; i++) {
    const t = i / Math.max(1, n);
    const r = w * (1 - 0.6 * t);
    c.ellipse(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, r, r, 1, 0, () => [150, 135, 105]);
  }
}

/**
 * Color bleed for an alpha cutout: every transparent texel takes the average color of its
 * opaque (or already filled) neighbours, `passes` times outward, alpha left at 0. Filtering
 * and mip levels then blend leaf edges toward leaf color instead of black, so cut edges, far
 * mips and impostor bakes (which keep low-alpha texels) are not darkened.
 */
function bleed(c: Canvas, passes: number): void {
  const W = c.width;
  const H = c.height;
  const filled = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) filled[i] = c.px[i * 4 + 3]! > 0 ? 1 : 0;
  for (let pass = 0; pass < passes; pass++) {
    const next: number[] = [];
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (filled[i] === 1) continue;
        let r = 0;
        let g = 0;
        let b = 0;
        let n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H || filled[yy * W + xx] === 0) continue;
            const o = (yy * W + xx) * 4;
            r += c.px[o]!;
            g += c.px[o + 1]!;
            b += c.px[o + 2]!;
            n++;
          }
        }
        if (n > 0) next.push(i, Math.round(r / n), Math.round(g / n), Math.round(b / n));
      }
    }
    if (next.length === 0) break;
    for (let k = 0; k < next.length; k += 4) {
      const o = next[k]! * 4;
      c.px[o] = next[k + 1]!;
      c.px[o + 1] = next[k + 2]!;
      c.px[o + 2] = next[k + 3]!;
      filled[next[k]!] = 1;
    }
  }
  // Anything still unfilled (far from every leaf): the average leaf tone.
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < W * H; i++) {
    if (c.px[i * 4 + 3]! === 0) continue;
    r += c.px[i * 4]!;
    g += c.px[i * 4 + 1]!;
    b += c.px[i * 4 + 2]!;
    n++;
  }
  for (let i = 0; i < W * H; i++) {
    if (filled[i] === 1) continue;
    c.px[i * 4] = Math.round(r / Math.max(n, 1));
    c.px[i * 4 + 1] = Math.round(g / Math.max(n, 1));
    c.px[i * 4 + 2] = Math.round(b / Math.max(n, 1));
  }
}

const ovalProfile = (t: number): number => Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.05)), 0.75) * (1 - 0.25 * t);
const lanceProfile = (t: number): number => Math.pow(Math.sin(Math.PI * t), 0.9);
const needleProfile = (t: number): number => 1 - t * 0.7;

/** The leaf-spray cutout of an archetype (stem at the bottom center, tip at the top). */
export function leafSprayTexture(archetype: LeafArchetype = 'broad'): Texture3d {
  let t = sprays.get(archetype);
  if (t !== undefined) return t;
  const S = 256;
  const c = new Canvas(S, S);
  const seed = { broad: 11, ovate: 12, needle: 13, frond: 14, lance: 15 }[archetype];
  const r = (i: number, k: number): number => hash2(i, k, seed);
  const base = [S / 2, S - 4] as const;
  if (archetype === 'frond') {
    // A rachis up the middle, opposite pairs of long narrow leaflets shrinking to the tip.
    stem(c, base[0], base[1], S / 2, 10, 2.2);
    const pairs = 22;
    for (let i = 0; i < pairs; i++) {
      const f = i / (pairs - 1);
      const y = S - 18 - f * (S - 34);
      const len = (64 - 40 * f) * (0.9 + 0.2 * r(i, 1));
      for (const side of [-1, 1]) leaflet(c, S / 2, y, side * (1.05 - 0.35 * f), len, 4.2 - 1.6 * f, lanceProfile, 205 + 45 * r(i, side + 2));
    }
  } else if (archetype === 'needle') {
    // A twig with side shoots, every shoot a dense fan of needles angled forward.
    const shoots: [number, number, number, number][] = [[base[0], base[1], S / 2, 8]];
    for (let i = 0; i < 6; i++) {
      const y = S - 40 - i * 34;
      const side = i % 2 === 0 ? 1 : -1;
      shoots.push([S / 2, y, S / 2 + side * (70 - i * 6), y - 46]);
    }
    shoots.forEach(([x0, y0, x1, y1], k) => {
      stem(c, x0, y0, x1, y1, k === 0 ? 2.4 : 1.5);
      const dir = Math.atan2(x1 - x0, -(y1 - y0));
      const n = k === 0 ? 70 : 34;
      for (let i = 0; i < n; i++) {
        const f = i / n;
        const x = x0 + (x1 - x0) * f;
        const y = y0 + (y1 - y0) * f;
        const side = i % 2 === 0 ? 1 : -1;
        leaflet(c, x, y, dir + side * (0.55 + 0.35 * r(i, k)), (k === 0 ? 30 : 24) * (1 - 0.4 * f), 1.6, needleProfile, 190 + 60 * r(i, k + 9));
      }
    });
  } else {
    // A forked sprig: a main stem and side twigs, leaflets alternating along each.
    const lance = archetype === 'lance';
    const twigs: [number, number, number, number][] = [[base[0], base[1], S / 2 + (r(0, 0) - 0.5) * 20, 14]];
    const sides = lance ? 2 : 4;
    for (let i = 0; i < sides; i++) {
      const y = S - 50 - i * (lance ? 80 : 44);
      const side = i % 2 === 0 ? 1 : -1;
      twigs.push([S / 2, y, S / 2 + side * (lance ? 55 : 80 - i * 8), y - (lance ? 90 : 60)]);
    }
    const len = { broad: 30, ovate: 24, lance: 46 }[archetype as 'broad' | 'ovate' | 'lance'];
    const width = { broad: 13, ovate: 9.5, lance: 5 }[archetype as 'broad' | 'ovate' | 'lance'];
    twigs.forEach(([x0, y0, x1, y1], k) => {
      stem(c, x0, y0, x1, y1, k === 0 ? 2.2 : 1.5);
      const dir = Math.atan2(x1 - x0, -(y1 - y0));
      const n = k === 0 ? (lance ? 12 : 14) : (lance ? 8 : 7);
      for (let i = 0; i < n; i++) {
        const f = (i + 0.5) / n;
        const side = i % 2 === 0 ? 1 : -1;
        const x = x0 + (x1 - x0) * f;
        const y = y0 + (y1 - y0) * f;
        const a = dir + side * (lance ? 0.35 : 0.7 + 0.35 * r(i, k + 3));
        const l = len * (1 - 0.35 * f) * (0.8 + 0.4 * r(i, k + 5));
        leaflet(c, x, y, a, l, width * (0.8 + 0.4 * r(i, k + 7)), lance ? lanceProfile : ovalProfile, 195 + 60 * r(i, k + 11), archetype === 'broad' ? 2.5 : 0);
      }
      leaflet(c, x1, y1, dir, len * 0.8, width * 0.85, lance ? lanceProfile : ovalProfile, 230, archetype === 'broad' ? 2.5 : 0);
    });
  }
  bleed(c, 24);
  t = texture(`builtin:leaf_spray:${archetype}`, encodePng(S, S, c.px), 'clamp');
  sprays.set(archetype, t);
  return t;
}

const barks = new Map<string, Texture3d>();

/** Value noise that tiles every `period` lattice cells along x and y. */
function tileNoise(x: number, y: number, px: number, py: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const h = (a: number, b: number): number => hash2(((a % px) + px) % px, ((b % py) + py) % py, seed);
  const top = h(ix, iy) + (h(ix + 1, iy) - h(ix, iy)) * sx;
  const bottom = h(ix, iy + 1) + (h(ix + 1, iy + 1) - h(ix, iy + 1)) * sx;
  return top + (bottom - top) * sy;
}

/** A tiling bark luminance map (u around the branch, v along it). */
export function barkTexture(kind: 'rough' | 'birch' | 'smooth' | 'palm'): Texture3d {
  let t = barks.get(kind);
  if (t !== undefined) return t;
  const W = 128;
  const H = 256;
  const c = new Canvas(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = x / W;
      const v = y / H;
      let k: number;
      if (kind === 'rough') {
        // Vertical furrows: ridges broken by noise, deep dark cracks between.
        const warp = tileNoise(u * 8, v * 4, 8, 4, 31) * 0.6;
        const ridge = Math.abs(Math.sin((u * 9 + warp) * Math.PI));
        const crack = Math.pow(1 - ridge, 3);
        k = 0.78 + 0.22 * tileNoise(u * 16, v * 32, 16, 32, 32) - 0.45 * crack;
      } else if (kind === 'birch') {
        const patch = tileNoise(u * 4, v * 6, 4, 6, 41);
        const lent = tileNoise(u * 6, v * 64, 6, 64, 42);
        k = 0.92 + 0.08 * tileNoise(u * 24, v * 24, 24, 24, 43) - (lent > 0.78 ? 0.6 : 0) - (patch > 0.8 ? 0.45 : 0);
      } else if (kind === 'palm') {
        // Leaf-scar rings with a diamond weave.
        const ring = Math.abs(Math.sin(v * Math.PI * 14 + Math.sin(u * Math.PI * 6) * 0.6));
        k = 0.7 + 0.25 * ring + 0.1 * tileNoise(u * 16, v * 32, 16, 32, 51);
      } else {
        k = 0.85 + 0.15 * tileNoise(u * 12, v * 24, 12, 24, 61);
      }
      const o = (y * W + x) * 4;
      const g = Math.round(255 * Math.max(0.15, Math.min(1, k)));
      c.px[o] = g;
      c.px[o + 1] = g;
      c.px[o + 2] = g;
      c.px[o + 3] = 255;
    }
  }
  t = texture(`builtin:bark:${kind}`, encodePng(W, H, c.px), 'repeat');
  barks.set(kind, t);
  return t;
}

let stone: Texture3d | undefined;

/**
 * A tiling stone grain (256², luminance around 0.85): mottled blotches, fine speckle, faint
 * strata and thin dark cracks. Rocks sample it world-projected (triplanar), having no uvs.
 */
export function stoneTexture(): Texture3d {
  if (stone !== undefined) return stone;
  const S = 256;
  const c = new Canvas(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = x / S;
      const v = y / S;
      const blotch = tileNoise(u * 6, v * 6, 6, 6, 71) * 0.6 + tileNoise(u * 14, v * 14, 14, 14, 72) * 0.4;
      const speck = hash2(x, y, 73);
      const strata = Math.abs(Math.sin((v * 5 + tileNoise(u * 4, v * 4, 4, 4, 74) * 0.5) * Math.PI * 2));
      const crack = Math.abs(tileNoise(u * 8, v * 8, 8, 8, 75) - 0.5) < 0.012 ? 0.55 : 1;
      let k = 0.72 + 0.24 * blotch + 0.06 * strata + (speck > 0.97 ? 0.12 : speck < 0.03 ? -0.12 : 0);
      k *= crack;
      const o = (y * S + x) * 4;
      const g = Math.round(255 * Math.max(0.2, Math.min(1, k)));
      c.px[o] = g;
      c.px[o + 1] = g;
      c.px[o + 2] = Math.round(g * 0.97);
      c.px[o + 3] = 255;
    }
  }
  stone = texture('builtin:stone', encodePng(S, S, c.px), 'repeat');
  return stone;
}
