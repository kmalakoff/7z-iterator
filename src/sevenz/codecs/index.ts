// Codec registry for 7z decompression
// Each codec provides a decode function and optionally a streaming decoder

import type { BufferLike } from 'extract-base-iterator';
import type { Transform } from 'stream';
import {
  createLzma2Decoder as _createLzma2Decoder,
  createLzmaDecoder as _createLzmaDecoder,
  type DecodeCallback as CodecDecodeCallback,
  createBcjArm64Decoder,
  createBcjArmDecoder,
  createBcjArmtDecoder,
  createBcjDecoder,
  createBcjIa64Decoder,
  createBcjPpcDecoder,
  createBcjSparcDecoder,
  createDeltaDecoder,
  decode7zLzma,
  decode7zLzma2,
  decodeBcj,
  decodeBcjArm,
  decodeBcjArm64,
  decodeBcjArmt,
  decodeBcjIa64,
  decodeBcjPpc,
  decodeBcjSparc,
  decodeDelta,
} from 'xz-compat';
import { CodecId, createCodedError, ErrorCode } from '../constants.ts';
import { createAesDecoder, decodeAes, getPassword, setPassword } from './Aes.ts';
import { createBcj2Decoder, decodeBcj2, decodeBcj2Multi } from './Bcj2.ts';
import { createBzip2Decoder, decodeBzip2 } from './BZip2.ts';
import { createCopyDecoder, decodeCopy } from './Copy.ts';
import { createDeflateDecoder, decodeDeflate } from './Deflate.ts';

// Re-export password functions for API access
export { getPassword, setPassword };

const schedule = typeof setImmediate === 'function' ? setImmediate : (fn: () => void) => process.nextTick(fn);

function wrapSyncDecode(fn: (input: Buffer, properties?: Buffer, unpackSize?: number) => Buffer): Codec['decode'] {
  return (input, properties, unpackSize, callback) => {
    schedule(() => {
      try {
        // Convert BufferList to Buffer if needed
        const buf = Buffer.isBuffer(input) ? input : input.toBuffer();
        callback(null, fn(buf, properties, unpackSize));
      } catch (err) {
        callback(err as Error);
      }
    });
  };
}

export interface Codec {
  decode: (input: BufferLike, properties: Buffer | undefined, unpackSize: number | undefined, callback: CodecDecodeCallback<Buffer>) => void;
  createDecoder: (properties?: Buffer, unpackSize?: number) => Transform;
}

// Simple wrappers with validation that use xz-compat's optimized decode7zLzma/decode7zLzma2
function decodeLzma(input: BufferLike, properties: Buffer, unpackSize: number, callback: CodecDecodeCallback<Buffer>): void {
  if (properties.length < 5) {
    throw new Error('LZMA requires 5-byte properties');
  }
  // Convert BufferList to Buffer if needed
  const buf = Buffer.isBuffer(input) ? input : input.toBuffer();
  decode7zLzma(buf, properties, unpackSize, callback);
}

function createLzmaDecoder(properties?: Buffer, unpackSize?: number): Transform {
  if (!properties || properties.length < 5) {
    throw new Error('LZMA requires 5-byte properties');
  }
  if (typeof unpackSize !== 'number' || unpackSize < 0) {
    throw new Error('LZMA requires known unpack size');
  }
  return _createLzmaDecoder(properties, unpackSize) as Transform;
}

function decodeLzma2(input: BufferLike, properties: Buffer, unpackSize: number | undefined, callback: CodecDecodeCallback<Buffer>): void {
  if (properties.length < 1) {
    throw new Error('LZMA2 requires properties byte');
  }
  // Convert BufferList to Buffer if needed
  const buf = Buffer.isBuffer(input) ? input : input.toBuffer();
  decode7zLzma2(buf, properties, unpackSize, callback);
}

function createLzma2Decoder(properties?: Buffer, _unpackSize?: number): Transform {
  if (!properties || properties.length < 1) {
    throw new Error('LZMA2 requires properties byte');
  }
  return _createLzma2Decoder(properties) as Transform;
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
  decode: wrapSyncDecode(decodeCopy),
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
  decode: wrapSyncDecode(decodeBcj),
  createDecoder: createBcjDecoder,
});

// BCJ (ARM) filter
registerCodec(CodecId.BCJ_ARM, {
  decode: wrapSyncDecode(decodeBcjArm),
  createDecoder: createBcjArmDecoder,
});

// BCJ (ARM Thumb) filter
registerCodec(CodecId.BCJ_ARMT, {
  decode: wrapSyncDecode(decodeBcjArmt),
  createDecoder: createBcjArmtDecoder,
});

// BCJ (ARM64) filter
registerCodec(CodecId.BCJ_ARM64, {
  decode: wrapSyncDecode(decodeBcjArm64),
  createDecoder: createBcjArm64Decoder,
});

// BCJ (PowerPC) filter
registerCodec(CodecId.BCJ_PPC, {
  decode: wrapSyncDecode(decodeBcjPpc),
  createDecoder: createBcjPpcDecoder,
});

// BCJ (IA64) filter
registerCodec(CodecId.BCJ_IA64, {
  decode: wrapSyncDecode(decodeBcjIa64),
  createDecoder: createBcjIa64Decoder,
});

// BCJ (SPARC) filter
registerCodec(CodecId.BCJ_SPARC, {
  decode: wrapSyncDecode(decodeBcjSparc),
  createDecoder: createBcjSparcDecoder,
});

// Delta filter
registerCodec(CodecId.DELTA, {
  decode: wrapSyncDecode(decodeDelta),
  createDecoder: createDeltaDecoder,
});

// Deflate codec
registerCodec(CodecId.DEFLATE, {
  decode: wrapSyncDecode(decodeDeflate),
  createDecoder: createDeflateDecoder,
});

// BZip2 codec
registerCodec(CodecId.BZIP2, {
  decode: wrapSyncDecode(decodeBzip2),
  createDecoder: createBzip2Decoder,
});

// AES-256-CBC codec (encryption)
registerCodec(CodecId.AES, {
  decode: wrapSyncDecode(decodeAes),
  createDecoder: createAesDecoder,
});

// BCJ2 (x86-64) filter - multi-stream
// Note: BCJ2 requires special handling in SevenZipParser due to 4-stream architecture
registerCodec(CodecId.BCJ2, {
  decode: decodeBcj2,
  createDecoder: createBcj2Decoder,
});

// Note: PPMd codec is not implemented. See FUTURE_ENHANCEMENTS.md
