import type { Transform } from 'stream';
/**
 * Decode Deflate compressed data synchronously
 *
 * @param input - Deflate compressed data
 * @param _properties - Unused for Deflate
 * @param _unpackSize - Unused for Deflate
 * @returns Decompressed data
 */
export declare function decodeDeflate(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer;
/**
 * Create a Deflate decoder Transform stream.
 * Uses zlib's streaming createInflateRaw() for true streaming decompression.
 * Data is decompressed incrementally as it flows through, not buffered.
 */
export declare function createDeflateDecoder(_properties?: Buffer, _unpackSize?: number): Transform;
