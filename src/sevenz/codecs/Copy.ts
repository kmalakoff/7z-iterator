// Copy codec - passthrough (no compression)
// This is the simplest codec, just passes data through unchanged

import { PassThrough, type Transform } from 'readable-stream';

/**
 * Create a Copy decoder stream
 * Simply passes through data unchanged
 */
export function createCopyDecoder(): Transform {
  return new PassThrough();
}

/**
 * Decode a buffer using Copy codec (no-op)
 * @param input - Input buffer
 * @param _properties - Unused
 * @param _unpackSize - Unused
 * @returns Same buffer (no transformation)
 */
export function decodeCopy(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer {
  return input;
}
