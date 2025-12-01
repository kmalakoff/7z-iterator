// LZMA codec - uses lzma-purejs for raw LZMA decompression
// LZMA properties in 7z are 5 bytes: 1 byte lc/lp/pb + 4 bytes dictionary size (little-endian)

// Import lzma-purejs - provides raw LZMA decoder
import lzmajs from 'lzma-purejs';
import type { Transform } from 'readable-stream';
import createBufferingDecoder from './createBufferingDecoder.ts';
import { createInputStream, createOutputStream } from './streams.ts';

var LzmaDecoder = lzmajs.LZMA.Decoder;

/**
 * Decode LZMA compressed data to buffer
 *
 * @param input - LZMA compressed data
 * @param properties - Properties buffer (5 bytes: lc/lp/pb + dict size)
 * @param unpackSize - Expected output size (optional, -1 for unknown)
 * @returns Decompressed data
 */
export function decodeLzma(input: Buffer, properties?: Buffer, unpackSize?: number): Buffer {
  if (!properties || properties.length < 5) {
    throw new Error('LZMA requires 5-byte properties');
  }

  var decoder = new LzmaDecoder();

  // setDecoderProperties expects array-like with 5 bytes
  if (!decoder.setDecoderProperties(properties)) {
    throw new Error('Invalid LZMA properties');
  }

  var inStream = createInputStream(input, 0, input.length);
  var outStream = createOutputStream();

  // Use -1 for unknown size (decoder will use end marker)
  var size = typeof unpackSize === 'number' ? unpackSize : -1;

  var success = decoder.code(inStream, outStream, size);
  if (!success) {
    throw new Error('LZMA decompression failed');
  }

  return outStream.toBuffer();
}

/**
 * Create an LZMA decoder Transform stream
 */
export function createLzmaDecoder(properties?: Buffer, unpackSize?: number): Transform {
  return createBufferingDecoder(decodeLzma, properties, unpackSize);
}
