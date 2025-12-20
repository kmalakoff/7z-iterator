// Deflate codec - standard zlib/zip compression
// 7z uses raw deflate without zlib or gzip headers
//
// Uses native zlib.createInflateRaw() for true streaming decompression
// Falls back to pako for older Node versions via extract-base-iterator

import { createInflateRawStream, inflateRaw } from 'extract-base-iterator';
import type { Transform } from 'stream';

/**
 * Decode Deflate compressed data synchronously
 *
 * @param input - Deflate compressed data
 * @param _properties - Unused for Deflate
 * @param _unpackSize - Unused for Deflate
 * @returns Decompressed data
 */
export function decodeDeflate(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer {
  return inflateRaw(input);
}

/**
 * Create a Deflate decoder Transform stream.
 * Uses zlib's streaming createInflateRaw() for true streaming decompression.
 * Data is decompressed incrementally as it flows through, not buffered.
 */
export function createDeflateDecoder(_properties?: Buffer, _unpackSize?: number): Transform {
  return createInflateRawStream() as Transform;
}
