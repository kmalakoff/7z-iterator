/**
 * LZMA Decoder Module
 *
 * Provides both synchronous and streaming LZMA1/LZMA2 decoders.
 *
 * Synchronous API: Use when input is a complete Buffer
 * Streaming API: Use with Transform streams for memory-efficient decompression
 *
 * LZMA1 vs LZMA2:
 * - LZMA2 is chunked and supports true streaming with bounded memory
 * - LZMA1 has no chunk boundaries and requires buffering all input for streaming
 */

// Streaming decoders (Transform streams)
export { createLzma2Decoder, createLzmaDecoder } from './stream/transforms.ts';
export { decodeLzma2, Lzma2Decoder } from './sync/Lzma2Decoder.ts';
// Synchronous decoders (for Buffer input)
export { decodeLzma, LzmaDecoder } from './sync/LzmaDecoder.ts';
export { BitTreeDecoder, RangeDecoder } from './sync/RangeDecoder.ts';
// Type exports
export * from './types.ts';

/**
 * Detect LZMA format from compressed data
 *
 * LZMA2 uses chunk-based framing with control bytes:
 * - 0x00: End of stream
 * - 0x01-0x02: Uncompressed chunks
 * - 0x80-0xFF: LZMA compressed chunks
 *
 * LZMA1 is raw LZMA-compressed data (no framing)
 *
 * @param data - Compressed data to analyze
 * @returns 'lzma1' for LZMA1, 'lzma2' for LZMA2
 */
export function detectFormat(data: Buffer): 'lzma1' | 'lzma2' {
  if (data.length === 0) {
    // Default to LZMA2 for empty data (matches LZMA2 decoder behavior)
    return 'lzma2';
  }

  const firstByte = data[0];

  // LZMA2 control bytes: 0x00, 0x01, 0x02, or 0x80-0xFF
  if (firstByte === 0x00 || firstByte === 0x01 || firstByte === 0x02 || (firstByte >= 0x80 && firstByte <= 0xff)) {
    return 'lzma2';
  }

  // All other values indicate LZMA1 (raw LZMA data)
  return 'lzma1';
}
