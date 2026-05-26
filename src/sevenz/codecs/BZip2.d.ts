import type { Transform } from 'stream';
/**
 * Decode BZip2 compressed data synchronously
 *
 * @param input - BZip2 compressed data (with BZh header)
 * @param _properties - Unused for BZip2
 * @param _unpackSize - Unused
 * @returns Decompressed data
 */
export declare function decodeBzip2(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer;
/**
 * Create a BZip2 decoder Transform stream
 * Uses unbzip2-stream for true streaming decompression (block by block)
 */
export declare function createBzip2Decoder(_properties?: Buffer, _unpackSize?: number): Transform;
