// Helper to create a Transform stream that buffers all input before decoding
// Used by codecs that need the full input before decompression (LZMA, LZMA2, BZip2, etc.)

import { Transform } from 'extract-base-iterator';
import type { DecodeCallback } from 'xz-compat';

type TransformCallback = (error?: Error | null, data?: Buffer) => void;

export type DecodeFn = (input: Buffer, properties?: Buffer, unpackSize?: number, callback?: DecodeCallback<Buffer>) => Buffer | Promise<Buffer> | void;

/**
 * Create a Transform stream that buffers all input, then decodes in flush
 * This is the common pattern for codecs that can't stream (need full input)
 */
export default function createBufferingDecoder(decodeFn: DecodeFn, properties?: Buffer, unpackSize?: number): InstanceType<typeof Transform> {
  const chunks: Buffer[] = [];

  return new Transform({
    transform: (chunk: Buffer, _encoding: string, callback: TransformCallback) => {
      chunks.push(chunk);
      callback();
    },
    flush: function (callback: TransformCallback) {
      const input = Buffer.concat(chunks);
      const finish = (err?: Error | null, output?: Buffer) => {
        if (err) {
          callback(err);
          return;
        }
        if (output) {
          this.push(output);
        }
        callback();
      };

      try {
        const maybeResult = decodeFn(input, properties, unpackSize, finish);
        if (maybeResult && typeof (maybeResult as Promise<Buffer>).then === 'function') {
          (maybeResult as Promise<Buffer>).then(
            (value) => finish(null, value),
            (err) => finish(err as Error)
          );
          return;
        }
        if (Buffer.isBuffer(maybeResult)) {
          finish(null, maybeResult);
        }
      } catch (err) {
        callback(err as Error);
      }
    },
  });
}
