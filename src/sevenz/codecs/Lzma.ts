import Module from 'module';

const _require = typeof require === 'undefined' ? Module.createRequire(import.meta.url) : require;

// LZMA codec - uses vendored lzma-purejs for raw LZMA decompression
// LZMA properties in 7z are 5 bytes: 1 byte lc/lp/pb + 4 bytes dictionary size (little-endian)

import type { Transform } from 'readable-stream';
import createBufferingDecoder from './createBufferingDecoder.ts';
import { createInputStream, createOutputStream } from './streams.ts';

// Import vendored lzma-purejs - provides raw LZMA decoder (patched for LZMA2 support)
// Path accounts for build output in dist/esm/sevenz/codecs/
const { LZMA } = _require('../../../../assets/lzma-purejs');
const LzmaDecoder = LZMA.Decoder;

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

  // Use -1 for unknown size (decoder will use end marker)
  var size = typeof unpackSize === 'number' ? unpackSize : -1;

  // Pre-allocate output stream if size is known (memory optimization)
  var outStream = createOutputStream(size > 0 ? size : undefined);

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
