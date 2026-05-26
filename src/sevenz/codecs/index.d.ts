import type { BufferLike } from 'extract-base-iterator';
import type { Transform } from 'stream';
import { type DecodeCallback as CodecDecodeCallback } from 'xz-compat';
import { getPassword, setPassword } from './Aes.ts';
import { decodeBcj2Multi } from './Bcj2.ts';
export { getPassword, setPassword };
export interface Codec {
  decode: (input: BufferLike, properties: Buffer | undefined, unpackSize: number | undefined, callback: CodecDecodeCallback<Buffer>) => void;
  createDecoder: (properties?: Buffer, unpackSize?: number) => Transform;
}
/**
 * Register a codec
 */
export declare function registerCodec(id: number[], codec: Codec): void;
/**
 * Get a codec by ID
 * @throws Error if codec is not supported
 */
export declare function getCodec(id: number[]): Codec;
/**
 * Check if a codec is supported
 */
export declare function isCodecSupported(id: number[]): boolean;
/**
 * Get human-readable codec name
 */
export declare function getCodecName(id: number[]): string;
/**
 * Check if a codec ID matches BCJ2
 */
export declare function isBcj2Codec(id: number[]): boolean;
export { decodeBcj2Multi };
