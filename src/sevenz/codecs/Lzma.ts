import Module from 'module';

const _require = typeof require === 'undefined' ? Module.createRequire(import.meta.url) : require;

// LZMA codec - uses native lzma-native when available, falls back to lzma-purejs
// LZMA properties in 7z are 5 bytes: 1 byte lc/lp/pb + 4 bytes dictionary size (little-endian)
//
// Native optimization: On Node.js 8+, lzma-native provides liblzma bindings
// that decode LZMA1 streams natively for better performance.
// Falls back to lzma-purejs for Node.js 0.8-7.x compatibility.

import type { Transform } from 'readable-stream';
import createBufferingDecoder from './createBufferingDecoder.ts';
import { createNativeLzma1Decoder, hasNativeLzma } from './lzmaCompat.ts';
import { createInputStream, createOutputStream } from './streams.ts';

// Import vendored lzma-purejs - provides raw LZMA decoder (patched for LZMA2 support)
// Path accounts for build output in dist/esm/sevenz/codecs/
const { LZMA } = _require('../../../../assets/lzma-purejs');
const LzmaDecoder = LZMA.Decoder;

/**
 * Parse LZMA properties from 5-byte buffer
 * First byte: lc + lp*9 + pb*45
 * Next 4 bytes: dictionary size (little-endian)
 */
function parseLzmaProperties(properties: Buffer): { lc: number; lp: number; pb: number; dictSize: number } {
  const propByte = properties[0];
  const lc = propByte % 9;
  const remainder = Math.floor(propByte / 9);
  const lp = remainder % 5;
  const pb = Math.floor(remainder / 5);
  const dictSize = properties.readUInt32LE(1);
  return { lc: lc, lp: lp, pb: pb, dictSize: dictSize };
}

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

  const decoder = new LzmaDecoder();

  // setDecoderProperties expects array-like with 5 bytes
  if (!decoder.setDecoderProperties(properties)) {
    throw new Error('Invalid LZMA properties');
  }

  const inStream = createInputStream(input, 0, input.length);

  // Use -1 for unknown size (decoder will use end marker)
  const size = typeof unpackSize === 'number' ? unpackSize : -1;

  // Pre-allocate output stream if size is known (memory optimization)
  const outStream = createOutputStream(size > 0 ? size : undefined);

  const success = decoder.code(inStream, outStream, size);
  if (!success) {
    throw new Error('LZMA decompression failed');
  }

  return outStream.toBuffer();
}

/**
 * Create an LZMA decoder Transform stream
 *
 * Uses native lzma-native when available for better performance,
 * falls back to lzma-purejs buffering decoder for Node.js 0.8+ compatibility.
 */
export function createLzmaDecoder(properties?: Buffer, _unpackSize?: number): Transform {
  // Try native decoder first (available on Node.js 8+ with lzma-native installed)
  if (hasNativeLzma && properties && properties.length >= 5) {
    const props = parseLzmaProperties(properties);
    const nativeDecoder = createNativeLzma1Decoder(props.lc, props.lp, props.pb, props.dictSize);
    if (nativeDecoder) {
      return nativeDecoder;
    }
  }

  // Fall back to buffering decoder with pure JS implementation
  return createBufferingDecoder(decodeLzma, properties, _unpackSize);
}
