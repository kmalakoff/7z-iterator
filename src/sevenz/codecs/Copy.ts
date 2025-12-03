// Copy codec - passthrough (no compression)
// This is the simplest codec, just passes data through unchanged

import Stream from 'stream';

// Use native streams when available, readable-stream only for Node 0.x
const major = +process.versions.node.split('.')[0];
let PassThrough: typeof Stream.PassThrough;
if (major > 0) {
  PassThrough = Stream.PassThrough;
} else {
  PassThrough = require('readable-stream').PassThrough;
}
type Transform = Stream.Transform;

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
