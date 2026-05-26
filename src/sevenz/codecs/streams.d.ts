/**
 * Input stream wrapper for lzma-purejs
 * Wraps a Buffer region as a readable stream interface
 */
export declare function createInputStream(
  buffer: Buffer,
  offset: number,
  length: number
): {
  readByte: () => number;
  read: (buf: number[], bufOffset: number, len: number) => number;
};
/**
 * Output stream wrapper for lzma-purejs
 * Collects output bytes into Buffer chunks
 * Uses typed arrays for memory efficiency (1 byte per element instead of 8)
 *
 * Memory optimization: If expectedSize is provided, pre-allocates a single buffer
 * to avoid double-memory during Buffer.concat.
 *
 * @param expectedSize - Optional expected output size for pre-allocation
 */
export declare function createOutputStream(expectedSize?: number): {
  writeByte: (b: number) => void;
  write: (buf: number[], bufOffset: number, len: number) => number;
  flush: () => void;
  toBuffer: () => Buffer;
};
