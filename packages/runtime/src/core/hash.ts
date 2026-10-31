/** Stable 32-bit hashing for value types (`__hash__`), FNV-1a over float64 bytes. */

const scratch = new DataView(new ArrayBuffer(8));

export function hashNumbers(...values: readonly number[]): number {
  let h = 0x811c9dc5;
  for (const value of values) {
    // -0 and 0 are equal, so they must hash the same.
    scratch.setFloat64(0, value === 0 ? 0 : value);
    for (let i = 0; i < 8; i++) {
      h ^= scratch.getUint8(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return h >>> 0;
}
