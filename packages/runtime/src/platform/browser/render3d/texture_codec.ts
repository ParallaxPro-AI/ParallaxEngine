/**
 * CPU block encoders for the precompressed texture variants `parallax build` writes: BC1
 * and BC3 for desktop GPUs, ETC2 RGB8 and RGBA8 for mobile ones, each with a full mip
 * chain in a KTX2 container (`encodeKtx2Variant`). Everything here is plain integer and
 * float arithmetic over byte arrays, deterministic across machines, and runs in Node.
 *
 * The encoders aim for "good and fast", not for the last decibel:
 *  - BC1 colour: endpoints from the block's principal axis (power iteration on the colour
 *    covariance), then two least-squares refits of the endpoints given the chosen indices,
 *    keeping whichever quantized pair has the lowest squared RGB error. A BC1 block with
 *    any pixel of alpha < 128 uses the 3-colour mode (color0 <= color1) with index 3 as
 *    transparent black; otherwise blocks are 4-colour (color0 > color1, or equal with every
 *    index 0, which reads the same under either interpretation).
 *  - BC3: a BC4-style alpha block (8 interpolated alphas, or 6 plus explicit 0 and 255,
 *    whichever fits better) followed by a BC1 colour block kept in 4-colour order.
 *  - ETC2 RGB8: only the ETC1-compatible "individual" and "differential" modes are emitted
 *    (both are valid ETC2). Both flip orientations and both modes are tried, base colours
 *    are the sub-block averages, and each sub-block takes the best of the 8 intensity
 *    tables with per-pixel best modifiers. The decoder here therefore handles only those
 *    modes and rejects T/H/planar blocks.
 *  - EAC alpha (ETC2 RGBA8): a search over the 16 modifier tables, multipliers near the
 *    block's alpha range, and three base values each.
 *
 * Sizes that aren't a multiple of 4 are padded by clamping to the edge pixel; blocks are
 * stored row-major. The decoders exist for tests (error measurement) and tools.
 */

import { blockFormat, levelBytes, VK_FORMAT, writeKtx2 } from './ktx2.js';
import { fail } from '../../../core/index.js';

// ---------------------------------------------------------------------------------------
// Block plumbing

/** Copies the 4x4 block at (bx, by) into `out` (64 bytes, row-major RGBA), clamping to edges. */
function fetchBlock(rgba: Uint8Array, width: number, height: number, bx: number, by: number, out: Uint8Array): void {
  for (let y = 0; y < 4; y++) {
    const sy = Math.min(by * 4 + y, height - 1);
    for (let x = 0; x < 4; x++) {
      const sx = Math.min(bx * 4 + x, width - 1);
      const s = (sy * width + sx) * 4;
      const d = (y * 4 + x) * 4;
      out[d] = rgba[s]!;
      out[d + 1] = rgba[s + 1]!;
      out[d + 2] = rgba[s + 2]!;
      out[d + 3] = rgba[s + 3]!;
    }
  }
}

function checkImage(rgba: Uint8Array, width: number, height: number, what: string): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    fail('PP3843', `${what}: image size ${width}x${height} is invalid`, { fix: 'Pass a positive integer width and height.' });
  }
  if (rgba.byteLength !== width * height * 4) {
    fail('PP3843', `${what}: ${rgba.byteLength} bytes for a ${width}x${height} RGBA8 image (expected ${width * height * 4})`, {
      fix: 'Pass tightly packed RGBA8 pixels, row-major.',
    });
  }
}

type BlockEncoder = (px: Uint8Array, out: Uint8Array, offset: number) => void;
type BlockDecoder = (data: Uint8Array, offset: number, px: Uint8Array) => void;

function encodeBlocks(rgba: Uint8Array, width: number, height: number, bytesPerBlock: number, what: string, encode: BlockEncoder): Uint8Array {
  checkImage(rgba, width, height, what);
  const bw = Math.ceil(width / 4);
  const bh = Math.ceil(height / 4);
  const out = new Uint8Array(bw * bh * bytesPerBlock);
  const px = new Uint8Array(64);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      fetchBlock(rgba, width, height, bx, by, px);
      encode(px, out, (by * bw + bx) * bytesPerBlock);
    }
  }
  return out;
}

function decodeBlocks(data: Uint8Array, width: number, height: number, bytesPerBlock: number, what: string, decode: BlockDecoder): Uint8Array {
  const bw = Math.ceil(width / 4);
  const bh = Math.ceil(height / 4);
  if (data.byteLength < bw * bh * bytesPerBlock) {
    fail('PP3843', `${what}: ${data.byteLength} bytes for a ${width}x${height} image (expected ${bw * bh * bytesPerBlock})`, {
      fix: 'Pass the whole level.',
    });
  }
  const out = new Uint8Array(width * height * 4);
  const px = new Uint8Array(64);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      decode(data, (by * bw + bx) * bytesPerBlock, px);
      for (let y = 0; y < 4; y++) {
        const dy = by * 4 + y;
        if (dy >= height) break;
        for (let x = 0; x < 4; x++) {
          const dx = bx * 4 + x;
          if (dx >= width) break;
          const s = (y * 4 + x) * 4;
          const d = (dy * width + dx) * 4;
          out[d] = px[s]!;
          out[d + 1] = px[s + 1]!;
          out[d + 2] = px[s + 2]!;
          out[d + 3] = px[s + 3]!;
        }
      }
    }
  }
  return out;
}

const clamp255 = (v: number): number => (v < 0 ? 0 : v > 255 ? 255 : v);

// ---------------------------------------------------------------------------------------
// BC1 colour blocks

function pack565(r: number, g: number, b: number): number {
  const r5 = Math.round(clamp255(r) * 31 / 255);
  const g6 = Math.round(clamp255(g) * 63 / 255);
  const b5 = Math.round(clamp255(b) * 31 / 255);
  return (r5 << 11) | (g6 << 5) | b5;
}

/** Writes the expanded RGB of a 565 colour at `pal[at..at+2]`. */
function expand565(c: number, pal: Int32Array, at: number): void {
  const r5 = (c >> 11) & 31;
  const g6 = (c >> 5) & 63;
  const b5 = c & 31;
  pal[at] = (r5 << 3) | (r5 >> 2);
  pal[at + 1] = (g6 << 2) | (g6 >> 4);
  pal[at + 2] = (b5 << 3) | (b5 >> 2);
}

/** The 4 palette colours (RGB triples) of a block; 3-colour mode leaves entry 3 as black. */
function bc1Palette(c0: number, c1: number, fourColour: boolean, pal: Int32Array): void {
  expand565(c0, pal, 0);
  expand565(c1, pal, 3);
  for (let ch = 0; ch < 3; ch++) {
    const a = pal[ch]!;
    const b = pal[3 + ch]!;
    if (fourColour) {
      pal[6 + ch] = ((2 * a + b) / 3) | 0;
      pal[9 + ch] = ((a + 2 * b) / 3) | 0;
    } else {
      pal[6 + ch] = (a + b) >> 1;
      pal[9 + ch] = 0;
    }
  }
}

/** Weight of color0 for each index: 4-colour and 3-colour modes. */
const W4 = [1, 0, 2 / 3, 1 / 3] as const;
const W3 = [1, 0, 1 / 2] as const;

interface Bc1Fit { c0: number; c1: number; indices: Uint8Array; err: number }

const scratchPal = new Int32Array(12);

/**
 * Orders and evaluates a quantized endpoint pair. `mask[i]` says pixel i takes part;
 * in transparent mode the rest get index 3.
 */
function evaluateBc1(qa: number, qb: number, px: Uint8Array, mask: Uint8Array, transparent: boolean, fit: Bc1Fit): void {
  const indices = fit.indices;
  let c0: number;
  let c1: number;
  let entries: number;
  if (transparent) {
    c0 = Math.min(qa, qb);
    c1 = Math.max(qa, qb);
    entries = 3;
    bc1Palette(c0, c1, false, scratchPal);
  } else if (qa === qb) {
    c0 = qa;
    c1 = qb;
    entries = 1; // every index 0: the same colour whichever mode a decoder assumes
    bc1Palette(c0, c1, true, scratchPal);
  } else {
    c0 = Math.max(qa, qb);
    c1 = Math.min(qa, qb);
    entries = 4;
    bc1Palette(c0, c1, true, scratchPal);
  }
  let err = 0;
  for (let i = 0; i < 16; i++) {
    if (mask[i] === 0) {
      indices[i] = 3;
      continue;
    }
    const r = px[i * 4]!;
    const g = px[i * 4 + 1]!;
    const b = px[i * 4 + 2]!;
    let best = 0;
    let bestErr = Infinity;
    for (let k = 0; k < entries; k++) {
      const dr = scratchPal[k * 3]! - r;
      const dg = scratchPal[k * 3 + 1]! - g;
      const db = scratchPal[k * 3 + 2]! - b;
      const e = dr * dr + dg * dg + db * db;
      if (e < bestErr) {
        bestErr = e;
        best = k;
      }
    }
    indices[i] = best;
    err += bestErr;
  }
  fit.c0 = c0;
  fit.c1 = c1;
  fit.err = err;
}

const fitA: Bc1Fit = { c0: 0, c1: 0, indices: new Uint8Array(16), err: 0 };
const fitB: Bc1Fit = { c0: 0, c1: 0, indices: new Uint8Array(16), err: 0 };
const bc1Mask = new Uint8Array(16);

function copyFit(from: Bc1Fit, to: Bc1Fit): void {
  to.c0 = from.c0;
  to.c1 = from.c1;
  to.err = from.err;
  to.indices.set(from.indices);
}

/** Encodes the colour half of a BC1/BC3 block. `allowTransparent`: BC1 punch-through alpha. */
function encodeBc1Colour(px: Uint8Array, out: Uint8Array, offset: number, allowTransparent: boolean): void {
  let transparent = false;
  if (allowTransparent) {
    for (let i = 0; i < 16; i++) if (px[i * 4 + 3]! < 128) transparent = true;
  }
  let count = 0;
  let mr = 0;
  let mg = 0;
  let mb = 0;
  for (let i = 0; i < 16; i++) {
    const inSet = !transparent || px[i * 4 + 3]! >= 128;
    bc1Mask[i] = inSet ? 1 : 0;
    if (!inSet) continue;
    count++;
    mr += px[i * 4]!;
    mg += px[i * 4 + 1]!;
    mb += px[i * 4 + 2]!;
  }
  const best = fitA;
  if (count === 0) {
    // Every pixel transparent: color0 <= color1 and every index 3.
    best.c0 = 0;
    best.c1 = 0;
    best.indices.fill(3);
    writeBc1(out, offset, best);
    return;
  }
  mr /= count;
  mg /= count;
  mb /= count;

  // Covariance and its principal axis.
  let crr = 0, crg = 0, crb = 0, cgg = 0, cgb = 0, cbb = 0;
  let minR = 255, minG = 255, minB = 255, maxR = 0, maxG = 0, maxB = 0;
  for (let i = 0; i < 16; i++) {
    if (bc1Mask[i] === 0) continue;
    const r = px[i * 4]!;
    const g = px[i * 4 + 1]!;
    const b = px[i * 4 + 2]!;
    const dr = r - mr;
    const dg = g - mg;
    const db = b - mb;
    crr += dr * dr; crg += dr * dg; crb += dr * db;
    cgg += dg * dg; cgb += dg * db; cbb += db * db;
    if (r < minR) minR = r; if (r > maxR) maxR = r;
    if (g < minG) minG = g; if (g > maxG) maxG = g;
    if (b < minB) minB = b; if (b > maxB) maxB = b;
  }
  let ax = maxR - minR;
  let ay = maxG - minG;
  let az = maxB - minB;
  if (crg < 0) ay = -ay; // seed in the quadrant the covariance points to
  if (crb < 0) az = -az;
  for (let iter = 0; iter < 6; iter++) {
    const nx = crr * ax + crg * ay + crb * az;
    const ny = crg * ax + cgg * ay + cgb * az;
    const nz = crb * ax + cgb * ay + cbb * az;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) break;
    ax = nx / len;
    ay = ny / len;
    az = nz / len;
  }
  const alen = Math.hypot(ax, ay, az);
  let qa: number;
  let qb: number;
  if (alen < 1e-9) {
    qa = pack565(mr, mg, mb);
    qb = qa;
  } else {
    ax /= alen; ay /= alen; az /= alen;
    let tmin = Infinity;
    let tmax = -Infinity;
    for (let i = 0; i < 16; i++) {
      if (bc1Mask[i] === 0) continue;
      const t = (px[i * 4]! - mr) * ax + (px[i * 4 + 1]! - mg) * ay + (px[i * 4 + 2]! - mb) * az;
      if (t < tmin) tmin = t;
      if (t > tmax) tmax = t;
    }
    qa = pack565(mr + ax * tmax, mg + ay * tmax, mb + az * tmax);
    qb = pack565(mr + ax * tmin, mg + ay * tmin, mb + az * tmin);
  }
  evaluateBc1(qa, qb, px, bc1Mask, transparent, best);
  // Bounding-box corners as a second seed.
  evaluateBc1(pack565(maxR, maxG, maxB), pack565(minR, minG, minB), px, bc1Mask, transparent, fitB);
  if (fitB.err < best.err) copyFit(fitB, best);

  // Least-squares refits of the endpoints given the current indices.
  const weights: readonly number[] = transparent ? W3 : W4;
  for (let iter = 0; iter < 2 && best.err > 0; iter++) {
    let aa = 0, bb = 0, ab = 0;
    let axr = 0, axg = 0, axb = 0, bxr = 0, bxg = 0, bxb = 0;
    for (let i = 0; i < 16; i++) {
      if (bc1Mask[i] === 0) continue;
      const w = weights[best.indices[i]!]!;
      const v = 1 - w;
      aa += w * w; bb += v * v; ab += w * v;
      const r = px[i * 4]!;
      const g = px[i * 4 + 1]!;
      const b = px[i * 4 + 2]!;
      axr += w * r; axg += w * g; axb += w * b;
      bxr += v * r; bxg += v * g; bxb += v * b;
    }
    const det = aa * bb - ab * ab;
    if (Math.abs(det) < 1e-9) break;
    const ar = (axr * bb - bxr * ab) / det;
    const ag = (axg * bb - bxg * ab) / det;
    const ab_ = (axb * bb - bxb * ab) / det;
    const br = (bxr * aa - axr * ab) / det;
    const bg = (bxg * aa - axg * ab) / det;
    const bb_ = (bxb * aa - axb * ab) / det;
    evaluateBc1(pack565(ar, ag, ab_), pack565(br, bg, bb_), px, bc1Mask, transparent, fitB);
    if (fitB.err < best.err) copyFit(fitB, best);
    else break;
  }
  if (!transparent && best.c0 === best.c1) best.indices.fill(0);
  writeBc1(out, offset, best);
}

function writeBc1(out: Uint8Array, offset: number, fit: Bc1Fit): void {
  out[offset] = fit.c0 & 0xff;
  out[offset + 1] = fit.c0 >> 8;
  out[offset + 2] = fit.c1 & 0xff;
  out[offset + 3] = fit.c1 >> 8;
  let bits = 0;
  for (let i = 0; i < 16; i++) bits |= fit.indices[i]! << (2 * i);
  out[offset + 4] = bits & 0xff;
  out[offset + 5] = (bits >>> 8) & 0xff;
  out[offset + 6] = (bits >>> 16) & 0xff;
  out[offset + 7] = (bits >>> 24) & 0xff;
}

const decodePal = new Int32Array(12);

/** `forceFourColour`: BC2/BC3 colour blocks ignore the endpoint order. */
function decodeBc1Colour(data: Uint8Array, offset: number, px: Uint8Array, forceFourColour: boolean): void {
  const c0 = data[offset]! | (data[offset + 1]! << 8);
  const c1 = data[offset + 2]! | (data[offset + 3]! << 8);
  const four = forceFourColour || c0 > c1;
  bc1Palette(c0, c1, four, decodePal);
  const bits = (data[offset + 4]! | (data[offset + 5]! << 8) | (data[offset + 6]! << 16) | (data[offset + 7]! << 24)) >>> 0;
  for (let i = 0; i < 16; i++) {
    const k = (bits >>> (2 * i)) & 3;
    px[i * 4] = decodePal[k * 3]!;
    px[i * 4 + 1] = decodePal[k * 3 + 1]!;
    px[i * 4 + 2] = decodePal[k * 3 + 2]!;
    px[i * 4 + 3] = !four && k === 3 ? 0 : 255;
  }
}

// ---------------------------------------------------------------------------------------
// BC3 / BC4-style alpha blocks

function alphaPalette(a0: number, a1: number, pal: Int32Array): void {
  pal[0] = a0;
  pal[1] = a1;
  if (a0 > a1) {
    for (let k = 1; k < 7; k++) pal[k + 1] = (((7 - k) * a0 + k * a1 + 3) / 7) | 0;
  } else {
    for (let k = 1; k < 5; k++) pal[k + 1] = (((5 - k) * a0 + k * a1 + 2) / 5) | 0;
    pal[6] = 0;
    pal[7] = 255;
  }
}

const alphaPal = new Int32Array(8);
const alphaIdxA = new Uint8Array(16);
const alphaIdxB = new Uint8Array(16);

function fitAlpha(px: Uint8Array, a0: number, a1: number, indices: Uint8Array): number {
  alphaPalette(a0, a1, alphaPal);
  let err = 0;
  for (let i = 0; i < 16; i++) {
    const a = px[i * 4 + 3]!;
    let best = 0;
    let bestErr = Infinity;
    for (let k = 0; k < 8; k++) {
      const d = alphaPal[k]! - a;
      const e = d * d;
      if (e < bestErr) {
        bestErr = e;
        best = k;
      }
    }
    indices[i] = best;
    err += bestErr;
  }
  return err;
}

function encodeAlphaBlock(px: Uint8Array, out: Uint8Array, offset: number): void {
  let min = 255;
  let max = 0;
  let innerMin = 255;
  let innerMax = 0;
  for (let i = 0; i < 16; i++) {
    const a = px[i * 4 + 3]!;
    if (a < min) min = a;
    if (a > max) max = a;
    if (a !== 0 && a !== 255) {
      if (a < innerMin) innerMin = a;
      if (a > innerMax) innerMax = a;
    }
  }
  // Mode 8 (a0 > a1, or a0 == a1 with every pixel equal).
  let a0 = max;
  let a1 = min;
  let err = fitAlpha(px, a0, a1, alphaIdxA);
  let indices = alphaIdxA;
  if (err > 0) {
    // Mode 6 + explicit 0/255 (a0 <= a1).
    const b0 = innerMin > innerMax ? 0 : innerMin;
    const b1 = innerMin > innerMax ? 0 : innerMax;
    const err6 = fitAlpha(px, b0, b1, alphaIdxB);
    if (err6 < err) {
      a0 = b0;
      a1 = b1;
      err = err6;
      indices = alphaIdxB;
    }
  }
  out[offset] = a0;
  out[offset + 1] = a1;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < 8; i++) lo |= indices[i]! << (3 * i);
  for (let i = 0; i < 8; i++) hi |= indices[i + 8]! << (3 * i);
  out[offset + 2] = lo & 0xff;
  out[offset + 3] = (lo >>> 8) & 0xff;
  out[offset + 4] = (lo >>> 16) & 0xff;
  out[offset + 5] = hi & 0xff;
  out[offset + 6] = (hi >>> 8) & 0xff;
  out[offset + 7] = (hi >>> 16) & 0xff;
}

function decodeAlphaBlock(data: Uint8Array, offset: number, px: Uint8Array): void {
  alphaPalette(data[offset]!, data[offset + 1]!, alphaPal);
  const lo = data[offset + 2]! | (data[offset + 3]! << 8) | (data[offset + 4]! << 16);
  const hi = data[offset + 5]! | (data[offset + 6]! << 8) | (data[offset + 7]! << 16);
  for (let i = 0; i < 8; i++) px[i * 4 + 3] = alphaPal[(lo >>> (3 * i)) & 7]!;
  for (let i = 0; i < 8; i++) px[(i + 8) * 4 + 3] = alphaPal[(hi >>> (3 * i)) & 7]!;
}

// ---------------------------------------------------------------------------------------
// ETC1-mode colour blocks (valid ETC2 RGB8)

/** Intensity modifier tables: [small, large]; indices 0..3 = +small, +large, -small, -large. */
const ETC_TABLES: readonly (readonly [number, number])[] = [
  [2, 8], [5, 17], [9, 29], [13, 42], [18, 60], [24, 80], [33, 106], [47, 183],
];
const etcModifier = (table: number, index: number): number => {
  const t = ETC_TABLES[table]!;
  return index === 0 ? t[0] : index === 1 ? t[1] : index === 2 ? -t[0] : -t[1];
};

/** Pixels (row-major block index) of each sub-block, per flip. */
const ETC_SUBBLOCKS: readonly (readonly [readonly number[], readonly number[]])[] = [0, 1].map((flip) => {
  const a: number[] = [];
  const b: number[] = [];
  for (let i = 0; i < 16; i++) {
    const x = i & 3;
    const y = i >> 2;
    ((flip === 0 ? x < 2 : y < 2) ? a : b).push(i);
  }
  return [a, b] as const;
});

interface SubFit { table: number; err: number }

const subIdxScratch = new Uint8Array(16);

/** Best table for one sub-block around an expanded base colour; writes indices into `indices`. */
function fitSubblock(px: Uint8Array, pixels: readonly number[], r: number, g: number, b: number, indices: Uint8Array, limit: number): SubFit {
  let bestTable = 0;
  let bestErr = Infinity;
  for (let t = 0; t < 8; t++) {
    let err = 0;
    for (const i of pixels) {
      const pr = px[i * 4]!;
      const pg = px[i * 4 + 1]!;
      const pb = px[i * 4 + 2]!;
      let pixelBest = 0;
      let pixelErr = Infinity;
      for (let k = 0; k < 4; k++) {
        const m = etcModifier(t, k);
        const dr = clamp255(r + m) - pr;
        const dg = clamp255(g + m) - pg;
        const db = clamp255(b + m) - pb;
        const e = dr * dr + dg * dg + db * db;
        if (e < pixelErr) {
          pixelErr = e;
          pixelBest = k;
        }
      }
      subIdxScratch[i] = pixelBest;
      err += pixelErr;
      if (err >= bestErr || err >= limit) break;
    }
    if (err < bestErr) {
      bestErr = err;
      bestTable = t;
      for (const i of pixels) indices[i] = subIdxScratch[i]!;
    }
  }
  return { table: bestTable, err: bestErr };
}

interface EtcCandidate {
  err: number;
  hi: number;
  indices: Uint8Array;
}

const etcIdx = new Uint8Array(16);
const etcBestIdx = new Uint8Array(16);

const expand4 = (c: number): number => c * 17;
const expand5 = (c: number): number => (c << 3) | (c >> 2);

function encodeEtcColour(px: Uint8Array, out: Uint8Array, offset: number): void {
  const best: EtcCandidate = { err: Infinity, hi: 0, indices: etcBestIdx };
  for (let flip = 0; flip < 2; flip++) {
    const [sa, sb] = ETC_SUBBLOCKS[flip]!;
    const avg = [0, 0, 0, 0, 0, 0];
    for (const i of sa) for (let ch = 0; ch < 3; ch++) avg[ch] = avg[ch]! + px[i * 4 + ch]!;
    for (const i of sb) for (let ch = 0; ch < 3; ch++) avg[3 + ch] = avg[3 + ch]! + px[i * 4 + ch]!;
    for (let ch = 0; ch < 6; ch++) avg[ch] = avg[ch]! / 8;

    for (let diff = 0; diff < 2; diff++) {
      const q = [0, 0, 0, 0, 0, 0];
      const e = [0, 0, 0, 0, 0, 0];
      if (diff === 0) {
        for (let ch = 0; ch < 6; ch++) {
          q[ch] = Math.round(avg[ch]! * 15 / 255);
          e[ch] = expand4(q[ch]!);
        }
      } else {
        for (let ch = 0; ch < 3; ch++) {
          const q1 = Math.round(avg[ch]! * 31 / 255);
          const q2 = Math.round(avg[3 + ch]! * 31 / 255);
          const d = Math.max(-4, Math.min(3, q2 - q1));
          q[ch] = q1;
          q[3 + ch] = q1 + d;
          e[ch] = expand5(q1);
          e[3 + ch] = expand5(q1 + d);
        }
      }
      const f1 = fitSubblock(px, sa, e[0]!, e[1]!, e[2]!, etcIdx, best.err);
      if (f1.err >= best.err) continue;
      const f2 = fitSubblock(px, sb, e[3]!, e[4]!, e[5]!, etcIdx, best.err - f1.err);
      const err = f1.err + f2.err;
      if (err >= best.err) continue;
      let hi: number;
      if (diff === 0) {
        hi = (q[0]! << 28) | (q[3]! << 24) | (q[1]! << 20) | (q[4]! << 16) | (q[2]! << 12) | (q[5]! << 8);
      } else {
        hi = (q[0]! << 27) | (((q[3]! - q[0]!) & 7) << 24) | (q[1]! << 19) | (((q[4]! - q[1]!) & 7) << 16)
          | (q[2]! << 11) | (((q[5]! - q[2]!) & 7) << 8);
      }
      hi |= (f1.table << 5) | (f2.table << 2) | (diff << 1) | flip;
      best.err = err;
      best.hi = hi >>> 0;
      best.indices.set(etcIdx);
    }
  }
  let lo = 0;
  for (let i = 0; i < 16; i++) {
    const n = (i & 3) * 4 + (i >> 2); // column-major pixel number
    const k = best.indices[i]!;
    lo |= ((k >> 1) << (16 + n)) | ((k & 1) << n);
  }
  writeBe32(out, offset, best.hi);
  writeBe32(out, offset + 4, lo >>> 0);
}

function writeBe32(out: Uint8Array, offset: number, v: number): void {
  out[offset] = (v >>> 24) & 0xff;
  out[offset + 1] = (v >>> 16) & 0xff;
  out[offset + 2] = (v >>> 8) & 0xff;
  out[offset + 3] = v & 0xff;
}

const readBe32 = (data: Uint8Array, offset: number): number =>
  ((data[offset]! << 24) | (data[offset + 1]! << 16) | (data[offset + 2]! << 8) | data[offset + 3]!) >>> 0;

const signed3 = (v: number): number => (v & 4 ? v - 8 : v);

function decodeEtcColour(data: Uint8Array, offset: number, px: Uint8Array): void {
  const hi = readBe32(data, offset);
  const lo = readBe32(data, offset + 4);
  const diff = (hi >>> 1) & 1;
  const flip = hi & 1;
  const base = [0, 0, 0, 0, 0, 0];
  if (diff === 0) {
    const shifts = [28, 20, 12];
    for (let ch = 0; ch < 3; ch++) {
      base[ch] = expand4((hi >>> shifts[ch]!) & 15);
      base[3 + ch] = expand4((hi >>> (shifts[ch]! - 4)) & 15);
    }
  } else {
    const shifts = [27, 19, 11];
    const modes = ['T', 'H', 'planar'];
    for (let ch = 0; ch < 3; ch++) {
      const c1 = (hi >>> shifts[ch]!) & 31;
      const c2 = c1 + signed3((hi >>> (shifts[ch]! - 3)) & 7);
      if (c2 < 0 || c2 > 31) {
        fail('PP3843', `ETC2 ${modes[ch]!}-mode blocks aren't decoded (the engine's encoder emits only ETC1-compatible blocks)`, {
          fix: 'Decode ETC2 T/H/planar textures with a full ETC2 decoder.',
        });
      }
      base[ch] = expand5(c1);
      base[3 + ch] = expand5(c2);
    }
  }
  const tables = [(hi >>> 5) & 7, (hi >>> 2) & 7];
  for (let i = 0; i < 16; i++) {
    const x = i & 3;
    const y = i >> 2;
    const sub = (flip === 0 ? x < 2 : y < 2) ? 0 : 1;
    const n = x * 4 + y;
    const k = (((lo >>> (16 + n)) & 1) << 1) | ((lo >>> n) & 1);
    const m = etcModifier(tables[sub]!, k);
    px[i * 4] = clamp255(base[sub * 3]! + m);
    px[i * 4 + 1] = clamp255(base[sub * 3 + 1]! + m);
    px[i * 4 + 2] = clamp255(base[sub * 3 + 2]! + m);
    px[i * 4 + 3] = 255;
  }
}

// ---------------------------------------------------------------------------------------
// EAC alpha blocks (ETC2 RGBA8)

const EAC_TABLES: readonly (readonly number[])[] = [
  [-3, -6, -9, -15, 2, 5, 8, 14],
  [-3, -7, -10, -13, 2, 6, 9, 12],
  [-2, -5, -8, -13, 1, 4, 7, 12],
  [-2, -4, -6, -13, 1, 3, 5, 12],
  [-3, -6, -8, -12, 2, 5, 7, 11],
  [-3, -7, -9, -11, 2, 6, 8, 10],
  [-4, -7, -8, -11, 3, 6, 7, 10],
  [-3, -5, -8, -11, 2, 4, 7, 10],
  [-2, -6, -8, -10, 1, 5, 7, 9],
  [-2, -5, -8, -10, 1, 4, 7, 9],
  [-2, -4, -8, -10, 1, 3, 7, 9],
  [-2, -5, -7, -10, 1, 4, 6, 9],
  [-3, -4, -7, -10, 2, 3, 6, 9],
  [-1, -2, -3, -10, 0, 1, 2, 9],
  [-4, -6, -8, -9, 3, 5, 7, 8],
  [-3, -5, -7, -9, 2, 4, 6, 8],
];

const eacIdx = new Uint8Array(16);
const eacBestIdx = new Uint8Array(16);

function encodeEacAlpha(px: Uint8Array, out: Uint8Array, offset: number): void {
  let min = 255;
  let max = 0;
  for (let i = 0; i < 16; i++) {
    const a = px[i * 4 + 3]!;
    if (a < min) min = a;
    if (a > max) max = a;
  }
  let bestBase = min;
  let bestMult = 1;
  let bestTable = 13; // holds a 0 modifier (index 4): exact for a flat block
  eacBestIdx.fill(4);
  if (min !== max) {
    let bestErr = Infinity;
    for (let t = 0; t < 16 && bestErr > 0; t++) {
      const tbl = EAC_TABLES[t]!;
      const lowMod = tbl[3]!;
      const highMod = tbl[7]!;
      const span = highMod - lowMod;
      const estimate = (max - min) / span;
      const mLo = Math.max(1, Math.floor(estimate) - 1);
      const mHi = Math.min(15, Math.ceil(estimate) + 1);
      for (let m = mLo; m <= mHi; m++) {
        const centre = Math.round((max + min) / 2 - ((highMod + lowMod) * m) / 2);
        for (let b = centre - 1; b <= centre + 1; b++) {
          if (b < 0 || b > 255) continue;
          let err = 0;
          for (let i = 0; i < 16 && err < bestErr; i++) {
            const a = px[i * 4 + 3]!;
            let pixelBest = 0;
            let pixelErr = Infinity;
            for (let k = 0; k < 8; k++) {
              const d = clamp255(b + tbl[k]! * m) - a;
              const e = d * d;
              if (e < pixelErr) {
                pixelErr = e;
                pixelBest = k;
              }
            }
            eacIdx[i] = pixelBest;
            err += pixelErr;
          }
          if (err < bestErr) {
            bestErr = err;
            bestBase = b;
            bestMult = m;
            bestTable = t;
            eacBestIdx.set(eacIdx);
          }
        }
      }
    }
  }
  out[offset] = bestBase;
  out[offset + 1] = (bestMult << 4) | bestTable;
  // 48 bits of 3-bit indices, column-major pixel a first, most significant bits first.
  let top = 0;
  let bottom = 0;
  for (let n = 0; n < 16; n++) {
    const x = n >> 2;
    const y = n & 3;
    const k = eacBestIdx[y * 4 + x]!;
    if (n < 8) top |= k << (21 - 3 * n);
    else bottom |= k << (21 - 3 * (n - 8));
  }
  out[offset + 2] = (top >>> 16) & 0xff;
  out[offset + 3] = (top >>> 8) & 0xff;
  out[offset + 4] = top & 0xff;
  out[offset + 5] = (bottom >>> 16) & 0xff;
  out[offset + 6] = (bottom >>> 8) & 0xff;
  out[offset + 7] = bottom & 0xff;
}

function decodeEacAlpha(data: Uint8Array, offset: number, px: Uint8Array): void {
  const base = data[offset]!;
  const mult = data[offset + 1]! >> 4;
  const tbl = EAC_TABLES[data[offset + 1]! & 15]!;
  const top = (data[offset + 2]! << 16) | (data[offset + 3]! << 8) | data[offset + 4]!;
  const bottom = (data[offset + 5]! << 16) | (data[offset + 6]! << 8) | data[offset + 7]!;
  for (let n = 0; n < 16; n++) {
    const k = n < 8 ? (top >>> (21 - 3 * n)) & 7 : (bottom >>> (21 - 3 * (n - 8))) & 7;
    const x = n >> 2;
    const y = n & 3;
    px[(y * 4 + x) * 4 + 3] = clamp255(base + tbl[k]! * mult);
  }
}

// ---------------------------------------------------------------------------------------
// Public encoders and decoders

export function encodeBc1(rgba: Uint8Array, width: number, height: number): Uint8Array {
  return encodeBlocks(rgba, width, height, 8, 'encodeBc1', (px, out, offset) => encodeBc1Colour(px, out, offset, true));
}

export function encodeBc3(rgba: Uint8Array, width: number, height: number): Uint8Array {
  return encodeBlocks(rgba, width, height, 16, 'encodeBc3', (px, out, offset) => {
    encodeAlphaBlock(px, out, offset);
    encodeBc1Colour(px, out, offset + 8, false);
  });
}

export function encodeEtc2Rgb(rgba: Uint8Array, width: number, height: number): Uint8Array {
  return encodeBlocks(rgba, width, height, 8, 'encodeEtc2Rgb', encodeEtcColour);
}

export function encodeEtc2Rgba(rgba: Uint8Array, width: number, height: number): Uint8Array {
  return encodeBlocks(rgba, width, height, 16, 'encodeEtc2Rgba', (px, out, offset) => {
    encodeEacAlpha(px, out, offset);
    encodeEtcColour(px, out, offset + 8);
  });
}

export function decodeBc1(data: Uint8Array, width: number, height: number): Uint8Array {
  return decodeBlocks(data, width, height, 8, 'decodeBc1', (d, offset, px) => decodeBc1Colour(d, offset, px, false));
}

export function decodeBc3(data: Uint8Array, width: number, height: number): Uint8Array {
  return decodeBlocks(data, width, height, 16, 'decodeBc3', (d, offset, px) => {
    decodeBc1Colour(d, offset + 8, px, true);
    decodeAlphaBlock(d, offset, px);
  });
}

/** Decodes ETC1-compatible blocks only; throws PP3843 on ETC2 T/H/planar blocks. */
export function decodeEtc2Rgb(data: Uint8Array, width: number, height: number): Uint8Array {
  return decodeBlocks(data, width, height, 8, 'decodeEtc2Rgb', decodeEtcColour);
}

/** EAC alpha plus ETC1-compatible colour blocks; throws PP3843 on ETC2 T/H/planar blocks. */
export function decodeEtc2Rgba(data: Uint8Array, width: number, height: number): Uint8Array {
  return decodeBlocks(data, width, height, 16, 'decodeEtc2Rgba', (d, offset, px) => {
    decodeEtcColour(d, offset + 8, px);
    decodeEacAlpha(d, offset, px);
  });
}

export interface MipLevel {
  readonly width: number;
  readonly height: number;
  readonly pixels: Uint8Array;
}

/**
 * Box-filtered mips down to 1x1, level 0 being the input itself. The average is taken on
 * the stored values (gamma-naive): sRGB textures darken slightly in their far mips.
 */
export function mipChain(rgba: Uint8Array, width: number, height: number): MipLevel[] {
  checkImage(rgba, width, height, 'mipChain');
  const levels: MipLevel[] = [{ width, height, pixels: rgba }];
  let src = rgba;
  let sw = width;
  let sh = height;
  while (sw > 1 || sh > 1) {
    const dw = Math.max(1, sw >> 1);
    const dh = Math.max(1, sh >> 1);
    const dst = new Uint8Array(dw * dh * 4);
    for (let y = 0; y < dh; y++) {
      const y0 = Math.min(2 * y, sh - 1);
      const y1 = Math.min(2 * y + 1, sh - 1);
      for (let x = 0; x < dw; x++) {
        const x0 = Math.min(2 * x, sw - 1);
        const x1 = Math.min(2 * x + 1, sw - 1);
        const a = (y0 * sw + x0) * 4;
        const b = (y0 * sw + x1) * 4;
        const c = (y1 * sw + x0) * 4;
        const d = (y1 * sw + x1) * 4;
        const o = (y * dw + x) * 4;
        for (let ch = 0; ch < 4; ch++) {
          dst[o + ch] = (src[a + ch]! + src[b + ch]! + src[c + ch]! + src[d + ch]! + 2) >> 2;
        }
      }
    }
    levels.push({ width: dw, height: dh, pixels: dst });
    src = dst;
    sw = dw;
    sh = dh;
  }
  return levels;
}

/**
 * A full-mip-chain KTX2 for one GPU family: BC1 / ETC2 RGB8 when every alpha is 255,
 * BC3 / ETC2 RGBA8 otherwise.
 */
export function encodeKtx2Variant(rgba: Uint8Array, width: number, height: number, family: 'bc' | 'etc2', srgb: boolean): Uint8Array {
  checkImage(rgba, width, height, 'encodeKtx2Variant');
  let opaque = true;
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] !== 255) {
      opaque = false;
      break;
    }
  }
  let vkFormat: number;
  let encode: (px: Uint8Array, w: number, h: number) => Uint8Array;
  if (family === 'bc') {
    vkFormat = opaque ? (srgb ? VK_FORMAT.BC1_RGB_SRGB : VK_FORMAT.BC1_RGB_UNORM) : (srgb ? VK_FORMAT.BC3_SRGB : VK_FORMAT.BC3_UNORM);
    encode = opaque ? encodeBc1 : encodeBc3;
  } else {
    vkFormat = opaque ? (srgb ? VK_FORMAT.ETC2_RGB8_SRGB : VK_FORMAT.ETC2_RGB8_UNORM) : (srgb ? VK_FORMAT.ETC2_RGBA8_SRGB : VK_FORMAT.ETC2_RGBA8_UNORM);
    encode = opaque ? encodeEtc2Rgb : encodeEtc2Rgba;
  }
  const format = blockFormat(vkFormat)!;
  const levels = mipChain(rgba, width, height).map((level) => {
    const data = encode(level.pixels, level.width, level.height);
    if (data.byteLength !== levelBytes(format, level.width, level.height)) {
      fail('PP9000', 'encodeKtx2Variant: encoded level size mismatch', { fix: 'Report this engine bug.' });
    }
    return data;
  });
  return writeKtx2({ vkFormat, width, height, levels });
}
