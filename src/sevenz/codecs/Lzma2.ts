// LZMA2 codec using TypeScript LZMA decoder
//
// LZMA2 format specification:
// https://github.com/ulikunitz/xz/blob/master/doc/LZMA2.md
//
// Control byte values:
// 0x00         = End of stream
// 0x01         = Uncompressed chunk, dictionary reset
// 0x02         = Uncompressed chunk, no dictionary reset
// 0x80-0xFF    = LZMA compressed chunk (bits encode reset flags and size)

import type { Transform } from 'stream';
import { createLzma2Decoder as createLzma2Transform, decodeLzma2 as lzma2Decode } from '../../lzma/index.ts';

/**
 * Decode LZMA2 compressed data to buffer
 *
 * @param input - LZMA2 compressed data
 * @param properties - Properties buffer (1 byte: dictionary size)
 * @param unpackSize - Expected output size (optional, for pre-allocation)
 * @returns Decompressed data
 */
export function decodeLzma2(input: Buffer, properties?: Buffer, unpackSize?: number): Buffer {
  if (!properties || properties.length < 1) {
    throw new Error('LZMA2 requires properties byte');
  }

  return lzma2Decode(input, properties, unpackSize);
}

/**
 * Create an LZMA2 decoder Transform stream
 *
 * This is a true streaming decoder that processes LZMA2 chunks incrementally.
 * Memory usage is O(dictionary_size + max_chunk_size) instead of O(folder_size).
 *
 * LZMA2 chunks are up to ~2MB uncompressed, so memory is bounded regardless of
 * total archive size.
 */
export function createLzma2Decoder(properties?: Buffer, _unpackSize?: number): Transform {
  if (!properties || properties.length < 1) {
    throw new Error('LZMA2 requires properties byte');
  }

  return createLzma2Transform(properties) as Transform;
}
