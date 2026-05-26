declare module 'pako' {
  /**
   * Decompress data with raw deflate algorithm (no zlib header)
   * @param data - Compressed data as Buffer or Uint8Array
   * @returns Decompressed data as Uint8Array
   */
  export function inflateRaw(data: Buffer | Uint8Array): Uint8Array;

  /**
   * Decompress data with deflate algorithm (zlib header)
   * @param data - Compressed data as Buffer or Uint8Array
   * @returns Decompressed data as Uint8Array
   */
  export function inflate(data: Buffer | Uint8Array): Uint8Array;
}
