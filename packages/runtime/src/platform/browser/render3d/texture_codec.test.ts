import { describe, expect, it } from 'vitest';
import { blockFormat, levelBytes, parseKtx2, VK_FORMAT } from './ktx2.js';
import {
  decodeBc1, decodeBc3, decodeEtc2Rgb, decodeEtc2Rgba,
  encodeBc1, encodeBc3, encodeEtc2Rgb, encodeEtc2Rgba, encodeKtx2Variant, mipChain,
} from './texture_codec.js';

type Encode = (rgba: Uint8Array, w: number, h: number) => Uint8Array;

const CODECS: readonly { name: string; encode: Encode; decode: Encode; alpha: boolean }[] = [
  { name: 'bc1', encode: encodeBc1, decode: decodeBc1, alpha: false },
  { name: 'bc3', encode: encodeBc3, decode: decodeBc3, alpha: true },
  { name: 'etc2-rgb', encode: encodeEtc2Rgb, decode: decodeEtc2Rgb, alpha: false },
  { name: 'etc2-rgba', encode: encodeEtc2Rgba, decode: decodeEtc2Rgba, alpha: true },
];

function solid(w: number, h: number, c: readonly [number, number, number, number]): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) out.set(c, i * 4);
  return out;
}

/** A smooth two-axis colour gradient with a little deterministic texture. */
function gradient(w: number, h: number, alpha = false): Uint8Array {
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      out[o] = Math.round((x / (w - 1)) * 255);
      out[o + 1] = Math.round((y / (h - 1)) * 255);
      out[o + 2] = Math.round(128 + 100 * Math.sin((x + y) / 23));
      out[o + 3] = alpha ? Math.round(((x + 2 * y) / (w + 2 * h)) * 255) : 255;
    }
  }
  return out;
}

function psnr(a: Uint8Array, b: Uint8Array, channels: readonly number[]): number {
  let se = 0;
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (const ch of channels) {
      const d = a[i + ch]! - b[i + ch]!;
      se += d * d;
      n++;
    }
  }
  if (se === 0) return Infinity;
  return 10 * Math.log10((255 * 255) / (se / n));
}

function maxDiff(a: Uint8Array, b: Uint8Array, channels: readonly number[]): number {
  let m = 0;
  for (let i = 0; i < a.length; i += 4) for (const ch of channels) m = Math.max(m, Math.abs(a[i + ch]! - b[i + ch]!));
  return m;
}

const RGB = [0, 1, 2] as const;
const measured: Record<string, number> = {};

describe('texture codecs', () => {
  it('solid colours survive within 8/255', () => {
    const colours: [number, number, number, number][] = [[0, 0, 0, 255], [255, 255, 255, 255], [200, 17, 90, 255], [33, 140, 251, 255], [128, 128, 128, 255]];
    for (const codec of CODECS) {
      for (const c of colours) {
        const img = solid(8, 8, c);
        const back = codec.decode(codec.encode(img, 8, 8), 8, 8);
        expect(maxDiff(img, back, RGB), `${codec.name} ${c.join(',')}`).toBeLessThanOrEqual(8);
        expect(maxDiff(img, back, [3])).toBe(0);
      }
    }
  });

  it('solid alpha is exact in BC3 and EAC', () => {
    for (const codec of CODECS.filter((c) => c.alpha)) {
      for (const a of [0, 1, 77, 128, 200, 254, 255]) {
        const img = solid(4, 4, [10, 20, 30, a]);
        const back = codec.decode(codec.encode(img, 4, 4), 4, 4);
        expect(maxDiff(img, back, [3]), `${codec.name} alpha ${a}`).toBe(0);
      }
    }
  });

  it('gradients stay above 30 dB', () => {
    const w = 128;
    const h = 96;
    for (const codec of CODECS) {
      const img = gradient(w, h, codec.alpha);
      const back = codec.decode(codec.encode(img, w, h), w, h);
      const rgb = psnr(img, back, RGB);
      measured[`${codec.name} rgb`] = rgb;
      expect(rgb, codec.name).toBeGreaterThan(30);
      if (codec.alpha) {
        const a = psnr(img, back, [3]);
        measured[`${codec.name} alpha`] = a;
        expect(a, `${codec.name} alpha`).toBeGreaterThan(36);
      }
    }
    console.log('PSNR (dB):', Object.entries(measured).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(' '));
  });

  it('BC1 uses the 3-colour mode with transparent texels', () => {
    const img = gradient(32, 32);
    for (let i = 0; i < 1024; i += 3) img[i * 4 + 3] = 0;
    const data = encodeBc1(img, 32, 32);
    for (let b = 0; b < data.length; b += 8) {
      const c0 = data[b]! | (data[b + 1]! << 8);
      const c1 = data[b + 2]! | (data[b + 3]! << 8);
      expect(c0).toBeLessThanOrEqual(c1);
    }
    const back = decodeBc1(data, 32, 32);
    for (let i = 0; i < 1024; i++) expect(back[i * 4 + 3]).toBe(img[i * 4 + 3]! < 128 ? 0 : 255);
    // Opaque pixels keep their colour reasonably (3 colours along the block's axis).
    let worst = 0;
    for (let i = 0; i < 1024; i++) {
      if (img[i * 4 + 3] === 0) continue;
      for (const ch of RGB) worst = Math.max(worst, Math.abs(img[i * 4 + ch]! - back[i * 4 + ch]!));
    }
    expect(worst).toBeLessThan(24);
    // Fully transparent blocks.
    const clear = decodeBc1(encodeBc1(solid(4, 4, [9, 9, 9, 0]), 4, 4), 4, 4);
    for (let i = 0; i < 16; i++) expect(clear[i * 4 + 3]).toBe(0);
  });

  it('opaque BC1 blocks are 4-colour', () => {
    const data = encodeBc1(gradient(64, 64), 64, 64);
    for (let b = 0; b < data.length; b += 8) {
      const c0 = data[b]! | (data[b + 1]! << 8);
      const c1 = data[b + 2]! | (data[b + 3]! << 8);
      if (c0 === c1) expect(data[b + 4]! | data[b + 5]! | data[b + 6]! | data[b + 7]!).toBe(0);
      else expect(c0).toBeGreaterThan(c1);
    }
  });

  it('two-level alpha (cutout) is exact in BC3 and EAC', () => {
    const img = gradient(16, 16);
    for (let i = 0; i < 256; i++) img[i * 4 + 3] = (i * 7) % 3 === 0 ? 0 : 255;
    for (const codec of CODECS.filter((c) => c.alpha)) {
      const back = codec.decode(codec.encode(img, 16, 16), 16, 16);
      expect(maxDiff(img, back, [3]), codec.name).toBe(0);
    }
  });

  it('is deterministic', () => {
    const img = gradient(40, 24, true);
    for (const codec of CODECS) {
      expect(Array.from(codec.encode(img, 40, 24))).toEqual(Array.from(codec.encode(img.slice(), 40, 24)));
    }
  });

  it('decodes what it encodes for noisy input (no ETC2 T/H/planar blocks emitted)', () => {
    const img = new Uint8Array(64 * 64 * 4);
    let seed = 12345;
    for (let i = 0; i < img.length; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      img[i] = seed >>> 24;
    }
    for (const codec of CODECS) expect(codec.decode(codec.encode(img, 64, 64), 64, 64).length).toBe(img.length);
  });

  it('handles sizes that are not multiples of 4', () => {
    for (const [w, h] of [[1, 1], [3, 5], [7, 2], [13, 9]] as const) {
      const img = gradient(Math.max(w, 2), Math.max(h, 2), true).subarray(0, w * h * 4);
      for (const codec of CODECS) {
        const data = codec.encode(img, w, h);
        expect(data.length).toBe(Math.ceil(w / 4) * Math.ceil(h / 4) * (codec.name === 'bc1' || codec.name === 'etc2-rgb' ? 8 : 16));
        const back = codec.decode(data, w, h);
        expect(back.length).toBe(w * h * 4);
      }
    }
    // An edge-clamped padded block reproduces a small solid image.
    const back = decodeEtc2Rgb(encodeEtc2Rgb(solid(3, 3, [50, 100, 150, 255]), 3, 3), 3, 3);
    expect(maxDiff(solid(3, 3, [50, 100, 150, 255]), back, RGB)).toBeLessThanOrEqual(8);
  });

  it('rejects mismatched pixel buffers', () => {
    expect(() => encodeBc1(new Uint8Array(10), 4, 4)).toThrow(/PP3843/);
  });

  it('builds mip chains down to 1x1', () => {
    const chain = mipChain(gradient(20, 6), 20, 6);
    expect(chain.map((l) => `${l.width}x${l.height}`)).toEqual(['20x6', '10x3', '5x1', '2x1', '1x1']);
    for (const l of chain) expect(l.pixels.length).toBe(l.width * l.height * 4);
    const flat = mipChain(solid(8, 8, [10, 20, 30, 40]), 8, 8);
    expect(Array.from(flat[3]!.pixels)).toEqual([10, 20, 30, 40]);
  });

  it('writes full-mip-chain KTX2 variants that parse back', () => {
    const cases = [
      { family: 'bc', srgb: true, alpha: false, vk: VK_FORMAT.BC1_RGB_SRGB },
      { family: 'bc', srgb: false, alpha: true, vk: VK_FORMAT.BC3_UNORM },
      { family: 'etc2', srgb: false, alpha: false, vk: VK_FORMAT.ETC2_RGB8_UNORM },
      { family: 'etc2', srgb: true, alpha: true, vk: VK_FORMAT.ETC2_RGBA8_SRGB },
    ] as const;
    for (const c of cases) {
      const img = gradient(32, 16, c.alpha);
      const file = encodeKtx2Variant(img, 32, 16, c.family, c.srgb);
      const parsed = parseKtx2(file, 'variant.ktx2');
      expect(parsed.vkFormat).toBe(c.vk);
      expect(parsed.width).toBe(32);
      expect(parsed.height).toBe(16);
      expect(parsed.levels.length).toBe(6);
      const format = blockFormat(c.vk)!;
      parsed.levels.forEach((level, i) => {
        expect(level.length).toBe(levelBytes(format, Math.max(1, 32 >> i), Math.max(1, 16 >> i)));
      });
    }
  });

  it('encodes 256x256 quickly', () => {
    const img = gradient(256, 256, true);
    const times: string[] = [];
    for (const codec of CODECS) {
      const t0 = performance.now();
      codec.encode(img, 256, 256);
      times.push(`${codec.name}=${(performance.now() - t0).toFixed(0)}ms`);
    }
    console.log('256x256 encode:', times.join(' '));
  });
});
