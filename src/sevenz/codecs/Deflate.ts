// Deflate codec - standard zlib/zip compression
// 7z uses raw deflate without zlib or gzip headers
//
// Uses pako for pure JavaScript decompression (works on all Node versions)

import { bufferFrom } from 'extract-base-iterator';
import pako from 'pako';
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
  // pako.inflateRaw returns Uint8Array, convert to Buffer
  var result = pako.inflateRaw(input);
  return bufferFrom(result);
}

/**
 * Create a Deflate decoder Transform stream
 */
export function createDeflateDecoder(properties?: Buffer, unpackSize?: number): Transform {
  return createBufferingDecoder(decodeDeflate, properties, unpackSize);
}
