// LZMA codec using TypeScript LZMA decoder
// LZMA properties in 7z are 5 bytes: 1 byte lc/lp/pb + 4 bytes dictionary size (little-endian)

import type { Transform } from 'stream';
import { createLzmaDecoder as createLzmaTransform, decodeLzma as lzmaDecode } from '../../lzma/index.ts';

/**
 * Decode LZMA compressed data to buffer
 *
 * @param input - LZMA compressed data
 * @param properties - Properties buffer (5 bytes: lc/lp/pb + dict size)
 * @param unpackSize - Expected output size
 * @returns Decompressed data
 */
export function decodeLzma(input: Buffer, properties?: Buffer, unpackSize?: number): Buffer {
  if (!properties || properties.length < 5) {
    throw new Error('LZMA requires 5-byte properties');
  }

  if (typeof unpackSize !== 'number' || unpackSize < 0) {
    throw new Error('LZMA requires known unpack size');
  }

  return lzmaDecode(input, properties, unpackSize);
}

/**
 * Create an LZMA decoder Transform stream
 *
 * Note: LZMA1 has no chunk boundaries, so this buffers all input
 * and decompresses when the stream ends.
 */
export function createLzmaDecoder(properties?: Buffer, unpackSize?: number): Transform {
  if (!properties || properties.length < 5) {
    throw new Error('LZMA requires 5-byte properties');
  }

  if (typeof unpackSize !== 'number' || unpackSize < 0) {
    throw new Error('LZMA requires known unpack size');
  }

  return createLzmaTransform(properties, unpackSize) as Transform;
}
