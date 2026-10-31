/**
 * KTX2 containers: the file format `parallax build` writes its precompressed texture
 * variants in, and the one both backends upload block-compressed textures from. Only the
 * slice of the spec the engine uses is accepted: a single 2D image (no array layers, cube
 * faces or depth) with a full or partial mip chain of BC, ETC2 or ASTC 4x4 blocks and no
 * supercompression. Anything else is refused with a coded error rather than guessed at, so
 * a file that would need a Basis transcoder or a Zstandard inflater says so up front.
 *
 * The writer emits the minimal valid file: header, level index, a basic Data Format
 * Descriptor for the block format (colour model, transfer function, 4x4 texel block, one
 * sample per plane), no key/value data and no supercompression global data. Level data is
 * stored smallest mip first, each level aligned to lcm(block size, 4), as the spec asks.
 * `blockFormat` maps a Vulkan format number to the WebGPU format string and the WebGL
 * extension enums the backends need, so neither backend carries its own table.
 */

import { fail } from '../../../core/index.js';

/** The Vulkan format numbers (`VkFormat`) the engine reads and writes. */
export const VK_FORMAT = {
  BC1_RGB_UNORM: 131,
  BC1_RGB_SRGB: 132,
  BC1_RGBA_UNORM: 133,
  BC1_RGBA_SRGB: 134,
  BC3_UNORM: 137,
  BC3_SRGB: 138,
  BC7_UNORM: 145,
  BC7_SRGB: 146,
  ETC2_RGB8_UNORM: 147,
  ETC2_RGB8_SRGB: 148,
  ETC2_RGBA8_UNORM: 151,
  ETC2_RGBA8_SRGB: 152,
  ASTC_4x4_UNORM: 157,
  ASTC_4x4_SRGB: 158,
} as const;

export interface Ktx2Image {
  readonly vkFormat: number;
  readonly width: number;
  readonly height: number;
  /** Level 0 (full size) first. */
  readonly levels: readonly Uint8Array[];
  readonly supercompression: number;
}

export interface BlockFormat {
  readonly family: 'bc' | 'etc2' | 'astc';
  readonly bytesPerBlock: 8 | 16;
  readonly alpha: boolean;
  readonly webgpu: { readonly unorm: string; readonly srgb: string };
  readonly webgl: { readonly extension: string; readonly unorm: number; readonly srgb: number; readonly srgbExtension: string };
}

/** The 12-byte file identifier: «KTX 20»\r\n\x1A\n. */
const IDENTIFIER = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const HEADER_BYTES = 80;
const LEVEL_ENTRY_BYTES = 24;

const S3TC = 'WEBGL_compressed_texture_s3tc';
const S3TC_SRGB = 'WEBGL_compressed_texture_s3tc_srgb';
const BPTC = 'EXT_texture_compression_bptc';
const ETC = 'WEBGL_compressed_texture_etc';
const ASTC = 'WEBGL_compressed_texture_astc';

const BC1_RGB: BlockFormat = {
  family: 'bc', bytesPerBlock: 8, alpha: false,
  webgpu: { unorm: 'bc1-rgba-unorm', srgb: 'bc1-rgba-unorm-srgb' },
  webgl: { extension: S3TC, unorm: 0x83f0, srgb: 0x8c4c, srgbExtension: S3TC_SRGB },
};
const BC1_RGBA: BlockFormat = {
  family: 'bc', bytesPerBlock: 8, alpha: true,
  webgpu: { unorm: 'bc1-rgba-unorm', srgb: 'bc1-rgba-unorm-srgb' },
  webgl: { extension: S3TC, unorm: 0x83f1, srgb: 0x8c4d, srgbExtension: S3TC_SRGB },
};
const BC3: BlockFormat = {
  family: 'bc', bytesPerBlock: 16, alpha: true,
  webgpu: { unorm: 'bc3-rgba-unorm', srgb: 'bc3-rgba-unorm-srgb' },
  webgl: { extension: S3TC, unorm: 0x83f3, srgb: 0x8c4f, srgbExtension: S3TC_SRGB },
};
const BC7: BlockFormat = {
  family: 'bc', bytesPerBlock: 16, alpha: true,
  webgpu: { unorm: 'bc7-rgba-unorm', srgb: 'bc7-rgba-unorm-srgb' },
  webgl: { extension: BPTC, unorm: 0x8e8c, srgb: 0x8e8d, srgbExtension: BPTC },
};
const ETC2_RGB: BlockFormat = {
  family: 'etc2', bytesPerBlock: 8, alpha: false,
  webgpu: { unorm: 'etc2-rgb8unorm', srgb: 'etc2-rgb8unorm-srgb' },
  webgl: { extension: ETC, unorm: 0x9274, srgb: 0x9275, srgbExtension: ETC },
};
const ETC2_RGBA: BlockFormat = {
  family: 'etc2', bytesPerBlock: 16, alpha: true,
  webgpu: { unorm: 'etc2-rgba8unorm', srgb: 'etc2-rgba8unorm-srgb' },
  webgl: { extension: ETC, unorm: 0x9278, srgb: 0x9279, srgbExtension: ETC },
};
const ASTC_4x4: BlockFormat = {
  family: 'astc', bytesPerBlock: 16, alpha: true,
  webgpu: { unorm: 'astc-4x4-unorm', srgb: 'astc-4x4-unorm-srgb' },
  webgl: { extension: ASTC, unorm: 0x93b0, srgb: 0x93d0, srgbExtension: ASTC },
};

const BLOCK_FORMATS = new Map<number, BlockFormat>([
  [VK_FORMAT.BC1_RGB_UNORM, BC1_RGB], [VK_FORMAT.BC1_RGB_SRGB, BC1_RGB],
  [VK_FORMAT.BC1_RGBA_UNORM, BC1_RGBA], [VK_FORMAT.BC1_RGBA_SRGB, BC1_RGBA],
  [VK_FORMAT.BC3_UNORM, BC3], [VK_FORMAT.BC3_SRGB, BC3],
  [VK_FORMAT.BC7_UNORM, BC7], [VK_FORMAT.BC7_SRGB, BC7],
  [VK_FORMAT.ETC2_RGB8_UNORM, ETC2_RGB], [VK_FORMAT.ETC2_RGB8_SRGB, ETC2_RGB],
  [VK_FORMAT.ETC2_RGBA8_UNORM, ETC2_RGBA], [VK_FORMAT.ETC2_RGBA8_SRGB, ETC2_RGBA],
  [VK_FORMAT.ASTC_4x4_UNORM, ASTC_4x4], [VK_FORMAT.ASTC_4x4_SRGB, ASTC_4x4],
]);

const SRGB_FORMATS: ReadonlySet<number> = new Set([
  VK_FORMAT.BC1_RGB_SRGB, VK_FORMAT.BC1_RGBA_SRGB, VK_FORMAT.BC3_SRGB, VK_FORMAT.BC7_SRGB,
  VK_FORMAT.ETC2_RGB8_SRGB, VK_FORMAT.ETC2_RGBA8_SRGB, VK_FORMAT.ASTC_4x4_SRGB,
]);

/** The block format a Vulkan format number names, or null when the engine doesn't upload it. */
export function blockFormat(vkFormat: number): BlockFormat | null {
  return BLOCK_FORMATS.get(vkFormat) ?? null;
}

/** Whether a Vulkan format number is one of the sRGB-encoded block formats. */
export function isSrgbFormat(vkFormat: number): boolean {
  return SRGB_FORMATS.has(vkFormat);
}

/** Bytes of one mip level: whole 4x4 blocks covering the image. */
export function levelBytes(format: BlockFormat, width: number, height: number): number {
  return Math.ceil(width / 4) * Math.ceil(height / 4) * format.bytesPerBlock;
}

const SUPERCOMPRESSION_NAMES: Record<number, string> = { 1: 'BasisLZ', 2: 'Zstandard', 3: 'ZLIB' };

function bad(where: string, why: string): never {
  return fail('PP3840', `${where} isn't a valid KTX2 file: ${why}`, {
    path: where,
    fix: 'Re-export the texture as KTX2 (or let `parallax build` produce it from the PNG source).',
  });
}

function u64(view: DataView, offset: number): number {
  const lo = view.getUint32(offset, true);
  const hi = view.getUint32(offset + 4, true);
  return hi * 0x1_0000_0000 + lo;
}

export function parseKtx2(bytes: Uint8Array, where: string): Ktx2Image {
  if (bytes.byteLength < HEADER_BYTES) bad(where, `only ${bytes.byteLength} bytes`);
  for (let i = 0; i < IDENTIFIER.length; i++) {
    if (bytes[i] !== IDENTIFIER[i]) bad(where, 'the file identifier is missing');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const vkFormat = view.getUint32(12, true);
  const width = view.getUint32(20, true);
  const height = view.getUint32(24, true);
  const pixelDepth = view.getUint32(28, true);
  const layerCount = view.getUint32(32, true);
  const faceCount = view.getUint32(36, true);
  const levelCount = Math.max(1, view.getUint32(40, true));
  const supercompression = view.getUint32(44, true);

  if (pixelDepth !== 0 || layerCount > 1 || faceCount !== 1) {
    fail('PP3841', `${where}: array/cube/3D KTX2 textures aren't supported (layers ${layerCount}, faces ${faceCount}, depth ${pixelDepth})`, {
      path: where,
      fix: 'Export a single 2D texture; split arrays and cube faces into separate files.',
    });
  }
  if (supercompression !== 0) {
    const name = SUPERCOMPRESSION_NAMES[supercompression] ?? `scheme ${supercompression}`;
    fail('PP3842', `${where} uses ${name} supercompression, which the engine doesn't decode`, {
      path: where,
      fix: 're-encode without supercompression (`parallax build` writes plain BC/ETC2 KTX2)',
    });
  }
  if (vkFormat === 0) {
    fail('PP3842', `${where} is a Basis Universal / UASTC KTX2 (vkFormat 0), which needs a Basis transcoder`, {
      path: where,
      fix: 're-encode without supercompression (`parallax build` writes plain BC/ETC2 KTX2)',
    });
  }
  if (width === 0 || height === 0) bad(where, `size ${width}x${height}`);
  if (levelCount > 32 || Math.max(width, height) >>> (levelCount - 1) === 0) {
    bad(where, `${levelCount} mip levels for a ${width}x${height} image`);
  }
  const indexEnd = HEADER_BYTES + levelCount * LEVEL_ENTRY_BYTES;
  if (indexEnd > bytes.byteLength) bad(where, 'the level index runs past the end of the file');

  const format = blockFormat(vkFormat);
  const levels: Uint8Array[] = [];
  for (let level = 0; level < levelCount; level++) {
    const entry = HEADER_BYTES + level * LEVEL_ENTRY_BYTES;
    const offset = u64(view, entry);
    const length = u64(view, entry + 8);
    if (offset < indexEnd || offset + length > bytes.byteLength) {
      bad(where, `mip level ${level} (${length} bytes at ${offset}) lies outside the file`);
    }
    if (format !== null) {
      const want = levelBytes(format, Math.max(1, width >>> level), Math.max(1, height >>> level));
      if (length !== want) bad(where, `mip level ${level} holds ${length} bytes, expected ${want}`);
    }
    levels.push(bytes.subarray(offset, offset + length));
  }
  return { vkFormat, width, height, levels, supercompression };
}

// Data Format Descriptor constants (Khronos Data Format spec).
const DF_MODEL = { BC1A: 128, BC3: 130, BC7: 134, ETC2: 161, ASTC: 162 } as const;
const DF_CHANNEL_COLOR = 0;
const DF_CHANNEL_ETC2_COLOR = 2;
const DF_CHANNEL_ALPHA = 15;
const DF_PRIMARIES_BT709 = 1;
const DF_TRANSFER_LINEAR = 1;
const DF_TRANSFER_SRGB = 2;

interface DfdSample { readonly bitOffset: number; readonly bitLength: number; readonly channel: number }

function dfdShape(vkFormat: number): { model: number; samples: readonly DfdSample[] } {
  const color = (channel: number, bitOffset: number, bits: number): DfdSample => ({ bitOffset, bitLength: bits - 1, channel });
  switch (vkFormat) {
    case VK_FORMAT.BC1_RGB_UNORM: case VK_FORMAT.BC1_RGB_SRGB:
      return { model: DF_MODEL.BC1A, samples: [color(DF_CHANNEL_COLOR, 0, 64)] };
    case VK_FORMAT.BC1_RGBA_UNORM: case VK_FORMAT.BC1_RGBA_SRGB:
      return { model: DF_MODEL.BC1A, samples: [color(DF_CHANNEL_ALPHA, 0, 64)] };
    case VK_FORMAT.BC3_UNORM: case VK_FORMAT.BC3_SRGB:
      return { model: DF_MODEL.BC3, samples: [color(DF_CHANNEL_ALPHA, 0, 64), color(DF_CHANNEL_COLOR, 64, 64)] };
    case VK_FORMAT.BC7_UNORM: case VK_FORMAT.BC7_SRGB:
      return { model: DF_MODEL.BC7, samples: [color(DF_CHANNEL_COLOR, 0, 128)] };
    case VK_FORMAT.ETC2_RGB8_UNORM: case VK_FORMAT.ETC2_RGB8_SRGB:
      return { model: DF_MODEL.ETC2, samples: [color(DF_CHANNEL_ETC2_COLOR, 0, 64)] };
    case VK_FORMAT.ETC2_RGBA8_UNORM: case VK_FORMAT.ETC2_RGBA8_SRGB:
      return { model: DF_MODEL.ETC2, samples: [color(DF_CHANNEL_ALPHA, 0, 64), color(DF_CHANNEL_ETC2_COLOR, 64, 64)] };
    case VK_FORMAT.ASTC_4x4_UNORM: case VK_FORMAT.ASTC_4x4_SRGB:
      return { model: DF_MODEL.ASTC, samples: [color(DF_CHANNEL_COLOR, 0, 128)] };
    default:
      return fail('PP3840', `writeKtx2: vkFormat ${vkFormat} isn't a block format the engine writes`, {
        fix: 'Use one of the VK_FORMAT block formats.',
      });
  }
}

/** The basic DFD block, preceded by its total-size word. */
function writeDfd(vkFormat: number, bytesPerBlock: number): Uint8Array {
  const { model, samples } = dfdShape(vkFormat);
  const blockSize = 24 + 16 * samples.length;
  const out = new Uint8Array(4 + blockSize);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.byteLength, true);
  view.setUint32(4, 0, true); // vendorId 0 (Khronos), descriptorType 0 (basic)
  view.setUint32(8, 2 | (blockSize << 16), true); // versionNumber 2, descriptorBlockSize
  out[12] = model;
  out[13] = DF_PRIMARIES_BT709;
  out[14] = isSrgbFormat(vkFormat) ? DF_TRANSFER_SRGB : DF_TRANSFER_LINEAR;
  out[15] = 0; // straight alpha
  out[16] = 3; out[17] = 3; out[18] = 0; out[19] = 0; // texel block 4x4x1x1, stored minus one
  out[20] = bytesPerBlock; // bytesPlane0; planes 1..7 stay 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const at = 28 + i * 16;
    view.setUint32(at, s.bitOffset | (s.bitLength << 16) | (s.channel << 24), true);
    view.setUint32(at + 4, 0, true); // sample position 0,0,0,0
    view.setUint32(at + 8, 0, true); // sampleLower
    view.setUint32(at + 12, 0xffffffff, true); // sampleUpper
  }
  return out;
}

const align = (n: number, to: number): number => Math.ceil(n / to) * to;

export function writeKtx2(image: { readonly vkFormat: number; readonly width: number; readonly height: number; readonly levels: readonly Uint8Array[] }): Uint8Array {
  const format = blockFormat(image.vkFormat);
  if (format === null) {
    fail('PP3840', `writeKtx2: vkFormat ${image.vkFormat} isn't a block format the engine writes`, { fix: 'Use one of the VK_FORMAT block formats.' });
  }
  const { width, height, levels } = image;
  if (levels.length === 0) fail('PP3840', 'writeKtx2: an image needs at least one mip level', { fix: 'Pass level 0 at least.' });
  for (let level = 0; level < levels.length; level++) {
    const want = levelBytes(format, Math.max(1, width >>> level), Math.max(1, height >>> level));
    if (levels[level]!.byteLength !== want) {
      fail('PP3840', `writeKtx2: mip level ${level} holds ${levels[level]!.byteLength} bytes, expected ${want}`, {
        fix: 'Encode each level at max(1, size >> level).',
      });
    }
  }
  const dfd = writeDfd(image.vkFormat, format.bytesPerBlock);
  const dfdOffset = HEADER_BYTES + levels.length * LEVEL_ENTRY_BYTES;
  const levelAlign = format.bytesPerBlock; // lcm(8 or 16, 4)
  const offsets = new Array<number>(levels.length).fill(0);
  let cursor = dfdOffset + dfd.byteLength;
  for (let level = levels.length - 1; level >= 0; level--) {
    cursor = align(cursor, levelAlign);
    offsets[level] = cursor;
    cursor += levels[level]!.byteLength;
  }
  const out = new Uint8Array(cursor);
  const view = new DataView(out.buffer);
  out.set(IDENTIFIER, 0);
  view.setUint32(12, image.vkFormat, true);
  view.setUint32(16, 1, true); // typeSize: 1 for block-compressed formats
  view.setUint32(20, width, true);
  view.setUint32(24, height, true);
  view.setUint32(28, 0, true); // pixelDepth
  view.setUint32(32, 0, true); // layerCount
  view.setUint32(36, 1, true); // faceCount
  view.setUint32(40, levels.length, true);
  view.setUint32(44, 0, true); // supercompressionScheme
  view.setUint32(48, dfdOffset, true);
  view.setUint32(52, dfd.byteLength, true);
  // kvd and sgd offsets/lengths stay 0.
  for (let level = 0; level < levels.length; level++) {
    const entry = HEADER_BYTES + level * LEVEL_ENTRY_BYTES;
    const length = levels[level]!.byteLength;
    view.setUint32(entry, offsets[level]!, true);
    view.setUint32(entry + 8, length, true);
    view.setUint32(entry + 16, length, true); // uncompressedByteLength
    out.set(levels[level]!, offsets[level]!);
  }
  out.set(dfd, dfdOffset);
  return out;
}
