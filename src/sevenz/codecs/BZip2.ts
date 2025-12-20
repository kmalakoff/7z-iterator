// BZip2 codec - bzip2 compression
// 7z stores bzip2 data with the standard BZh header
//
// Uses unbzip2-stream's internal bzip2 library for both sync and streaming decompression

import { bufferFrom } from 'extract-base-iterator';
import type { Transform } from 'stream';
import unbzip2Stream from 'unbzip2-stream';

// Access the internal bzip2 decoder from unbzip2-stream
import bzip2 from 'unbzip2-stream/lib/bzip2.js';

/**
 * Decode BZip2 compressed data synchronously
 *
 * @param input - BZip2 compressed data (with BZh header)
 * @param _properties - Unused for BZip2
 * @param _unpackSize - Unused
 * @returns Decompressed data
 */
export function decodeBzip2(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer {
  const chunks: number[] = [];
  // Pass buffer directly - simple() calls array() internally
  bzip2.simple(input, (byte: number) => {
    chunks.push(byte);
  });
  return bufferFrom(chunks);
}

/**
 * Create a BZip2 decoder Transform stream
 * Uses unbzip2-stream for true streaming decompression (block by block)
 */
export function createBzip2Decoder(_properties?: Buffer, _unpackSize?: number): Transform {
  return unbzip2Stream() as Transform;
}
