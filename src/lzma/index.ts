/**
 * LZMA Decoder Module
 *
 * Provides both synchronous and streaming LZMA1/LZMA2 decoders.
 *
 * Synchronous API: Use when input is a complete Buffer
 * Streaming API: Use with Transform streams for memory-efficient decompression
 */

// Streaming decoders (Transform streams)
export { createLzma2Decoder, createLzmaDecoder } from './stream/transforms.ts';
export { decodeLzma2, Lzma2Decoder } from './sync/Lzma2Decoder.ts';
// Synchronous decoders (for Buffer input)
export { decodeLzma, LzmaDecoder } from './sync/LzmaDecoder.ts';
export { BitTreeDecoder, RangeDecoder } from './sync/RangeDecoder.ts';
// Type exports
export * from './types.ts';
