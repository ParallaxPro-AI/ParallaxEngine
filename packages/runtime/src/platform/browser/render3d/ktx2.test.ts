import { describe, expect, it } from 'vitest';
import { ParallaxError } from '../../../core/index.js';
import { blockFormat, levelBytes, parseKtx2, VK_FORMAT, writeKtx2 } from './ktx2.js';

function codeOf(run: () => unknown): string | undefined {
  try {
    run();
  } catch (e) {
    if (e instanceof ParallaxError) return e.diagnostic.code;
    throw e;
  }
  return undefined;
}

function levelsFor(vkFormat: number, width: number, height: number, count: number): Uint8Array[] {
  const format = blockFormat(vkFormat)!;
  const levels: Uint8Array[] = [];
  for (let level = 0; level < count; level++) {
    const bytes = new Uint8Array(levelBytes(format, Math.max(1, width >> level), Math.max(1, height >> level)));
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + level * 7) & 0xff;
    levels.push(bytes);
  }
  return levels;
}

describe('ktx2', () => {
  it('round-trips every block format with a full mip chain', () => {
    for (const vkFormat of Object.values(VK_FORMAT)) {
      const levels = levelsFor(vkFormat, 20, 12, 5);
      const file = writeKtx2({ vkFormat, width: 20, height: 12, levels });
      const parsed = parseKtx2(file, 'tex.ktx2');
      expect(parsed.vkFormat).toBe(vkFormat);
      expect(parsed.width).toBe(20);
      expect(parsed.height).toBe(12);
      expect(parsed.supercompression).toBe(0);
      expect(parsed.levels.length).toBe(5);
      for (let i = 0; i < 5; i++) expect(Array.from(parsed.levels[i]!)).toEqual(Array.from(levels[i]!));
    }
  });

  it('writes the identifier, a basic DFD, and aligned levels stored smallest first', () => {
    const levels = levelsFor(VK_FORMAT.BC3_SRGB, 16, 16, 5);
    const file = writeKtx2({ vkFormat: VK_FORMAT.BC3_SRGB, width: 16, height: 16, levels });
    expect(Array.from(file.subarray(0, 12))).toEqual([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(file.buffer);
    expect(view.getUint32(16, true)).toBe(1); // typeSize
    expect(view.getUint32(36, true)).toBe(1); // faceCount
    const dfdOffset = view.getUint32(48, true);
    const dfdLength = view.getUint32(52, true);
    expect(dfdOffset).toBe(80 + 5 * 24);
    expect(view.getUint32(dfdOffset, true)).toBe(dfdLength);
    expect(dfdLength).toBe(4 + 24 + 2 * 16);
    expect(view.getUint32(dfdOffset + 8, true) >>> 16).toBe(24 + 2 * 16);
    expect(file[dfdOffset + 12]).toBe(130); // KHR_DF_MODEL_BC3
    expect(file[dfdOffset + 14]).toBe(2); // sRGB transfer
    expect(file[dfdOffset + 16]).toBe(3); // 4-wide block
    expect(file[dfdOffset + 20]).toBe(16); // bytesPlane0
    const offsets = [0, 1, 2, 3, 4].map((l) => view.getUint32(80 + l * 24, true));
    for (const o of offsets) expect(o % 16).toBe(0);
    for (let l = 0; l < 4; l++) expect(offsets[l]!).toBeGreaterThan(offsets[l + 1]!);
    const linear = writeKtx2({ vkFormat: VK_FORMAT.ETC2_RGB8_UNORM, width: 4, height: 4, levels: levelsFor(VK_FORMAT.ETC2_RGB8_UNORM, 4, 4, 1) });
    const ldfd = new DataView(linear.buffer).getUint32(48, true);
    expect(linear[ldfd + 12]).toBe(161);
    expect(linear[ldfd + 14]).toBe(1);
  });

  it('maps formats to WebGPU and WebGL names', () => {
    expect(blockFormat(VK_FORMAT.BC1_RGB_SRGB)!.webgl.srgb).toBe(0x8c4c);
    expect(blockFormat(VK_FORMAT.BC7_UNORM)!.webgpu.unorm).toBe('bc7-rgba-unorm');
    expect(blockFormat(VK_FORMAT.ETC2_RGBA8_SRGB)!.webgpu.srgb).toBe('etc2-rgba8unorm-srgb');
    expect(blockFormat(VK_FORMAT.ASTC_4x4_UNORM)!.webgl.unorm).toBe(0x93b0);
    expect(blockFormat(37)).toBeNull();
    expect(levelBytes(blockFormat(VK_FORMAT.BC1_RGB_UNORM)!, 5, 1)).toBe(16);
  });

  it('refuses bad files, layered textures, supercompression and Basis', () => {
    const good = writeKtx2({ vkFormat: VK_FORMAT.BC1_RGB_UNORM, width: 8, height: 8, levels: levelsFor(VK_FORMAT.BC1_RGB_UNORM, 8, 8, 4) });
    expect(codeOf(() => parseKtx2(new Uint8Array(10), 'a.ktx2'))).toBe('PP3840');
    const noMagic = good.slice();
    noMagic[1] = 0;
    expect(codeOf(() => parseKtx2(noMagic, 'a.ktx2'))).toBe('PP3840');
    expect(codeOf(() => parseKtx2(good.subarray(0, good.length - 1), 'a.ktx2'))).toBe('PP3840');

    const patch = (offset: number, value: number): Uint8Array => {
      const copy = good.slice();
      new DataView(copy.buffer).setUint32(offset, value, true);
      return copy;
    };
    expect(codeOf(() => parseKtx2(patch(32, 6), 'a.ktx2'))).toBe('PP3841');
    expect(codeOf(() => parseKtx2(patch(36, 6), 'a.ktx2'))).toBe('PP3841');
    expect(codeOf(() => parseKtx2(patch(28, 4), 'a.ktx2'))).toBe('PP3841');
    for (const scheme of [1, 2, 3]) expect(codeOf(() => parseKtx2(patch(44, scheme), 'a.ktx2'))).toBe('PP3842');
    expect(codeOf(() => parseKtx2(patch(12, 0), 'a.ktx2'))).toBe('PP3842');
    expect(codeOf(() => parseKtx2(patch(40, 9), 'a.ktx2'))).toBe('PP3840');
    expect(codeOf(() => parseKtx2(patch(80 + 8, 4), 'a.ktx2'))).toBe('PP3840');
    expect(codeOf(() => parseKtx2(patch(80, 0xfffff0), 'a.ktx2'))).toBe('PP3840');
    expect(codeOf(() => writeKtx2({ vkFormat: 37, width: 4, height: 4, levels: [new Uint8Array(8)] }))).toBe('PP3840');
    expect(codeOf(() => writeKtx2({ vkFormat: VK_FORMAT.BC1_RGB_UNORM, width: 4, height: 4, levels: [new Uint8Array(7)] }))).toBe('PP3840');
  });

  it('parses from a subarray at a non-zero byte offset', () => {
    const file = writeKtx2({ vkFormat: VK_FORMAT.BC7_SRGB, width: 4, height: 4, levels: levelsFor(VK_FORMAT.BC7_SRGB, 4, 4, 3) });
    const padded = new Uint8Array(file.length + 3);
    padded.set(file, 3);
    expect(parseKtx2(padded.subarray(3), 'p.ktx2').levels.length).toBe(3);
  });
});
