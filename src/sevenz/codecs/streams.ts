// Shared stream wrappers for lzma-purejs codec interface
// These adapters convert between Buffer/lzma-purejs stream interfaces

import { allocBufferUnsafe } from 'extract-base-iterator';

/**
 * Input stream wrapper for lzma-purejs
 * Wraps a Buffer region as a readable stream interface
 */
export function createInputStream(buffer: Buffer, offset: number, length: number) {
  let pos = 0;
  const end = Math.min(offset + length, buffer.length);
  const start = offset;

  return {
    readByte: (): number => {
      if (start + pos >= end) return -1;
      return buffer[start + pos++];
    },
    read: (buf: number[], bufOffset: number, len: number): number => {
      let bytesRead = 0;
      while (bytesRead < len && start + pos < end) {
        buf[bufOffset + bytesRead] = buffer[start + pos];
        pos++;
        bytesRead++;
      }
      return bytesRead === 0 ? -1 : bytesRead;
    },
  };
}

/**
 * Output stream wrapper for lzma-purejs
 * Collects output bytes into Buffer chunks
 * Uses typed arrays for memory efficiency (1 byte per element instead of 8)
 *
 * Memory optimization: If expectedSize is provided, pre-allocates a single buffer
 * to avoid double-memory during Buffer.concat.
 *
 * @param expectedSize - Optional expected output size for pre-allocation
 */
export function createOutputStream(expectedSize?: number) {
  // Pre-allocation mode: single buffer, no concat needed
  // Includes bounds checking for safety on older Node.js versions
  if (expectedSize && expectedSize > 0) {
    const buffer = allocBufferUnsafe(expectedSize);
    let bufPos = 0;
    const bufLen = buffer.length;

    return {
      writeByte: (b: number): void => {
        if (bufPos < bufLen) {
          buffer[bufPos++] = b;
        }
        // Silently ignore overflow (should not happen with correct size)
      },
      write: (buf: number[], bufOffset: number, len: number): number => {
        for (let i = 0; i < len && bufPos < bufLen; i++) {
          buffer[bufPos++] = buf[bufOffset + i];
        }
        return len;
      },
      flush: (): void => {
        // No-op for pre-allocated buffer
      },
      toBuffer: (): Buffer => {
        // Return only the used portion
        return bufPos < buffer.length ? buffer.slice(0, bufPos) : buffer;
      },
    };
  }

  // Chunked mode: accumulate in 64KB chunks (fallback for unknown size)
  const chunks: Buffer[] = [];
  const CHUNK_SIZE = 65536; // 64KB chunks for better memory efficiency
  let currentChunk: Buffer = allocBufferUnsafe(CHUNK_SIZE);
  let pos = 0;

  return {
    writeByte: (b: number): void => {
      currentChunk[pos++] = b;
      if (pos >= CHUNK_SIZE) {
        chunks.push(currentChunk);
        currentChunk = allocBufferUnsafe(CHUNK_SIZE);
        pos = 0;
      }
    },
    write: function (buf: number[], bufOffset: number, len: number): number {
      for (let i = 0; i < len; i++) {
        this.writeByte(buf[bufOffset + i]);
      }
      return len;
    },
    flush: (): void => {
      if (pos > 0) {
        // Only keep the used portion of the current chunk
        chunks.push(currentChunk.slice(0, pos));
        currentChunk = allocBufferUnsafe(CHUNK_SIZE);
        pos = 0;
      }
    },
    toBuffer: function (): Buffer {
      this.flush();
      // Optimization: if single chunk, return it directly
      if (chunks.length === 1) {
        return chunks[0];
      }
      return Buffer.concat(chunks);
    },
  };
}
