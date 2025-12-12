// Helper to create a Transform stream that buffers all input before decoding
// Used by codecs that need the full input before decompression (LZMA, LZMA2, BZip2, etc.)

import Stream from 'stream';

// Use native streams when available, readable-stream only for Node 0.x
const major = +process.versions.node.split('.')[0];
let Transform: typeof Stream.Transform;
if (major > 0) {
  Transform = Stream.Transform;
} else {
  Transform = require('readable-stream').Transform;
}
type TransformCallback = (error?: Error | null, data?: Buffer) => void;

export type DecodeFn = (input: Buffer, properties?: Buffer, unpackSize?: number) => Buffer;

/**
 * Create a Transform stream that buffers all input, then decodes in flush
 * This is the common pattern for codecs that can't stream (need full input)
 */
export default function createBufferingDecoder(decodeFn: DecodeFn, properties?: Buffer, unpackSize?: number): Stream.Transform {
  const chunks: Buffer[] = [];

  return new Transform({
    transform: (chunk: Buffer, _encoding: string, callback: TransformCallback) => {
      chunks.push(chunk);
      callback();
    },
    flush: function (callback: TransformCallback) {
      try {
        const input = Buffer.concat(chunks);
        const output = decodeFn(input, properties, unpackSize);
        this.push(output);
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
  });
}
