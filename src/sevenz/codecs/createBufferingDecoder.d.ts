import { Transform } from 'extract-base-iterator';
import type { DecodeCallback } from 'xz-compat';
export type DecodeFn = (input: Buffer, properties?: Buffer, unpackSize?: number, callback?: DecodeCallback<Buffer>) => Buffer | Promise<Buffer> | void;
/**
 * Create a Transform stream that buffers all input, then decodes in flush
 * This is the common pattern for codecs that can't stream (need full input)
 */
export default function createBufferingDecoder(decodeFn: DecodeFn, properties?: Buffer, unpackSize?: number): InstanceType<typeof Transform>;
