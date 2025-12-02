// Deflate codec - standard zlib/zip compression
// 7z uses raw deflate without zlib or gzip headers
//
// Uses native zlib on Node 0.11.12+, falls back to pako for older versions

import { inflateRaw } from 'extract-base-iterator';
import type { Transform } from 'readable-stream';
import createBufferingDecoder from './createBufferingDecoder.ts';

/**
 * Decode Deflate compressed data
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
 * Create a Deflate decoder Transform stream
 */
export function createDeflateDecoder(properties?: Buffer, unpackSize?: number): Transform {
  return createBufferingDecoder(decodeDeflate, properties, unpackSize);
}
