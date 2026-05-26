import type { Transform } from 'stream';
/**
 * BCJ2 multi-stream decoder
 * Takes 4 pre-decompressed streams and combines them
 */
export declare function decodeBcj2Multi(streams: Buffer[], _properties?: Buffer, unpackSize?: number): Buffer;
/**
 * Single-buffer decode (for API compatibility)
 * Note: BCJ2 requires multi-stream, this throws
 */
export declare function decodeBcj2(_input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer;
/**
 * Create a BCJ2 decoder Transform stream
 * Note: BCJ2 requires multi-stream, this is for API compatibility
 */
export declare function createBcj2Decoder(_properties?: Buffer, _unpackSize?: number): Transform;
