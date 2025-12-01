// Helper to create a Transform stream that buffers all input before decoding
// Used by codecs that need the full input before decompression (LZMA, LZMA2, BZip2, etc.)

import { Transform, type TransformCallback } from 'readable-stream';

export type DecodeFn = (input: Buffer, properties?: Buffer, unpackSize?: number) => Buffer;

/**
 * Create a Transform stream that buffers all input, then decodes in flush
 * This is the common pattern for codecs that can't stream (need full input)
 */
export default function createBufferingDecoder(decodeFn: DecodeFn, properties?: Buffer, unpackSize?: number): Transform {
  var chunks: Buffer[] = [];

  return new Transform({
    transform: (chunk: Buffer, _encoding: string, callback: TransformCallback) => {
      chunks.push(chunk);
      callback();
    },
    flush: function (callback: TransformCallback) {
      try {
        var input = Buffer.concat(chunks);
        var output = decodeFn(input, properties, unpackSize);
        this.push(output);
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
  });
}
