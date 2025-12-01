// BZip2 codec - bzip2 compression
// 7z stores bzip2 data with the standard BZh header
//
// Uses seek-bzip for decompression (pure JavaScript)

import type { Transform } from 'readable-stream';
import Bunzip from 'seek-bzip';
import createBufferingDecoder from './createBufferingDecoder.ts';

/**
 * Decode BZip2 compressed data
 *
 * @param input - BZip2 compressed data (with BZh header)
 * @param _properties - Unused for BZip2
 * @param _unpackSize - Unused for seek-bzip
 * @returns Decompressed data
 */
export function decodeBzip2(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer {
  // seek-bzip.decode(input, output) - returns output buffer
  return Bunzip.decode(input);
}

/**
 * Create a BZip2 decoder Transform stream
 */
export function createBzip2Decoder(properties?: Buffer, unpackSize?: number): Transform {
  return createBufferingDecoder(decodeBzip2, properties, unpackSize);
}
