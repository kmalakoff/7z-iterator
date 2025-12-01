// Codec registry for 7z decompression
// Each codec provides a decode function and optionally a streaming decoder

import type { Transform } from 'readable-stream';
import { CodecId, createCodedError, ErrorCode } from '../constants.ts';
import { createAesDecoder, decodeAes, getPassword, setPassword } from './Aes.ts';
import { createBcjDecoder, decodeBcj } from './Bcj.ts';
import { createBzip2Decoder, decodeBzip2 } from './BZip2.ts';
import { createCopyDecoder, decodeCopy } from './Copy.ts';
import { createDeflateDecoder, decodeDeflate } from './Deflate.ts';
import { createDeltaDecoder, decodeDelta } from './Delta.ts';
import { createLzmaDecoder, decodeLzma } from './Lzma.ts';
import { createLzma2Decoder, decodeLzma2 } from './Lzma2.ts';

// Re-export password functions for API access
export { getPassword, setPassword };

export interface Codec {
  decode: (input: Buffer, properties?: Buffer, unpackSize?: number) => Buffer;
  createDecoder: (properties?: Buffer, unpackSize?: number) => Transform;
}

// Registry of supported codecs
var codecs: { [key: string]: Codec } = {};

/**
 * Convert codec ID bytes to a string key
 */
function codecIdToKey(id: number[]): string {
  var parts: string[] = [];
  for (var i = 0; i < id.length; i++) {
    parts.push(id[i].toString(16).toUpperCase());
  }
  return parts.join('-');
}

/**
 * Check if two codec IDs match
 */
function codecIdEquals(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Register a codec
 */
export function registerCodec(id: number[], codec: Codec): void {
  codecs[codecIdToKey(id)] = codec;
}

/**
 * Get a codec by ID
 * @throws Error if codec is not supported
 */
export function getCodec(id: number[]): Codec {
  var key = codecIdToKey(id);
  var codec = codecs[key];
  if (!codec) {
    throw createCodedError(`Unsupported codec: ${key}`, ErrorCode.UNSUPPORTED_CODEC);
  }
  return codec;
}

/**
 * Check if a codec is supported
 */
export function isCodecSupported(id: number[]): boolean {
  return codecs[codecIdToKey(id)] !== undefined;
}

/**
 * Get human-readable codec name
 */
export function getCodecName(id: number[]): string {
  if (codecIdEquals(id, CodecId.COPY)) return 'Copy';
  if (codecIdEquals(id, CodecId.LZMA)) return 'LZMA';
  if (codecIdEquals(id, CodecId.LZMA2)) return 'LZMA2';
  if (codecIdEquals(id, CodecId.BCJ_X86)) return 'BCJ (x86)';
  if (codecIdEquals(id, CodecId.DELTA)) return 'Delta';
  if (codecIdEquals(id, CodecId.DEFLATE)) return 'Deflate';
  if (codecIdEquals(id, CodecId.BZIP2)) return 'BZip2';
  if (codecIdEquals(id, CodecId.AES)) return 'AES-256';
  return `Unknown (${codecIdToKey(id)})`;
}

// Register built-in codecs

// Copy codec (no compression)
registerCodec(CodecId.COPY, {
  decode: decodeCopy,
  createDecoder: createCopyDecoder,
});

// LZMA codec
registerCodec(CodecId.LZMA, {
  decode: decodeLzma,
  createDecoder: createLzmaDecoder,
});

// LZMA2 codec
registerCodec(CodecId.LZMA2, {
  decode: decodeLzma2,
  createDecoder: createLzma2Decoder,
});

// BCJ (x86) filter
registerCodec(CodecId.BCJ_X86, {
  decode: decodeBcj,
  createDecoder: createBcjDecoder,
});

// Delta filter
registerCodec(CodecId.DELTA, {
  decode: decodeDelta,
  createDecoder: createDeltaDecoder,
});

// Deflate codec
registerCodec(CodecId.DEFLATE, {
  decode: decodeDeflate,
  createDecoder: createDeflateDecoder,
});

// BZip2 codec
registerCodec(CodecId.BZIP2, {
  decode: decodeBzip2,
  createDecoder: createBzip2Decoder,
});

// AES-256-CBC codec (encryption)
registerCodec(CodecId.AES, {
  decode: decodeAes,
  createDecoder: createAesDecoder,
});
