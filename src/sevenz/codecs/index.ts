// Codec registry for 7z decompression
// Each codec provides a decode function and optionally a streaming decoder

import type { Transform } from 'stream';
import { CodecId, createCodedError, ErrorCode } from '../constants.ts';
import { createAesDecoder, decodeAes, getPassword, setPassword } from './Aes.ts';
import { createBcjDecoder, decodeBcj } from './Bcj.ts';
import { createBcj2Decoder, decodeBcj2, decodeBcj2Multi } from './Bcj2.ts';
import { createBcjArmDecoder, decodeBcjArm } from './BcjArm.ts';
import { createBcjArm64Decoder, decodeBcjArm64 } from './BcjArm64.ts';
import { createBcjArmtDecoder, decodeBcjArmt } from './BcjArmt.ts';
import { createBcjIa64Decoder, decodeBcjIa64 } from './BcjIa64.ts';
import { createBcjPpcDecoder, decodeBcjPpc } from './BcjPpc.ts';
import { createBcjSparcDecoder, decodeBcjSparc } from './BcjSparc.ts';
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
const codecs: { [key: string]: Codec } = {};

/**
 * Convert codec ID bytes to a string key
 */
function codecIdToKey(id: number[]): string {
  const parts: string[] = [];
  for (let i = 0; i < id.length; i++) {
    parts.push(id[i].toString(16).toUpperCase());
  }
  return parts.join('-');
}

/**
 * Check if two codec IDs match
 */
function codecIdEquals(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
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
  const key = codecIdToKey(id);
  const codec = codecs[key];
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
  if (codecIdEquals(id, CodecId.BCJ_ARM)) return 'BCJ (ARM)';
  if (codecIdEquals(id, CodecId.BCJ_ARMT)) return 'BCJ (ARM Thumb)';
  if (codecIdEquals(id, CodecId.BCJ_ARM64)) return 'BCJ (ARM64)';
  if (codecIdEquals(id, CodecId.BCJ_PPC)) return 'BCJ (PowerPC)';
  if (codecIdEquals(id, CodecId.BCJ_IA64)) return 'BCJ (IA64)';
  if (codecIdEquals(id, CodecId.BCJ_SPARC)) return 'BCJ (SPARC)';
  if (codecIdEquals(id, CodecId.BCJ2)) return 'BCJ2';
  if (codecIdEquals(id, CodecId.PPMD)) return 'PPMd';
  if (codecIdEquals(id, CodecId.DELTA)) return 'Delta';
  if (codecIdEquals(id, CodecId.DEFLATE)) return 'Deflate';
  if (codecIdEquals(id, CodecId.BZIP2)) return 'BZip2';
  if (codecIdEquals(id, CodecId.AES)) return 'AES-256';
  return `Unknown (${codecIdToKey(id)})`;
}

/**
 * Check if a codec ID matches BCJ2
 */
export function isBcj2Codec(id: number[]): boolean {
  return codecIdEquals(id, CodecId.BCJ2);
}

// Re-export BCJ2 multi-stream decoder for special handling
export { decodeBcj2Multi };

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

// BCJ (ARM) filter
registerCodec(CodecId.BCJ_ARM, {
  decode: decodeBcjArm,
  createDecoder: createBcjArmDecoder,
});

// BCJ (ARM Thumb) filter
registerCodec(CodecId.BCJ_ARMT, {
  decode: decodeBcjArmt,
  createDecoder: createBcjArmtDecoder,
});

// BCJ (ARM64) filter
registerCodec(CodecId.BCJ_ARM64, {
  decode: decodeBcjArm64,
  createDecoder: createBcjArm64Decoder,
});

// BCJ (PowerPC) filter
registerCodec(CodecId.BCJ_PPC, {
  decode: decodeBcjPpc,
  createDecoder: createBcjPpcDecoder,
});

// BCJ (IA64) filter
registerCodec(CodecId.BCJ_IA64, {
  decode: decodeBcjIa64,
  createDecoder: createBcjIa64Decoder,
});

// BCJ (SPARC) filter
registerCodec(CodecId.BCJ_SPARC, {
  decode: decodeBcjSparc,
  createDecoder: createBcjSparcDecoder,
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

// BCJ2 (x86-64) filter - multi-stream
// Note: BCJ2 requires special handling in SevenZipParser due to 4-stream architecture
registerCodec(CodecId.BCJ2, {
  decode: decodeBcj2,
  createDecoder: createBcj2Decoder,
});

// Note: PPMd codec is not implemented. See FUTURE_ENHANCEMENTS.md
