// Shared stream wrappers for lzma-purejs codec interface
// These adapters convert between Buffer/lzma-purejs stream interfaces

import { allocBufferUnsafe } from 'extract-base-iterator';

/**
 * Input stream wrapper for lzma-purejs
 * Wraps a Buffer region as a readable stream interface
 */
export function createInputStream(buffer: Buffer, offset: number, length: number) {
  var pos = 0;
  var end = Math.min(offset + length, buffer.length);
  var start = offset;

  return {
    readByte: (): number => {
      if (start + pos >= end) return -1;
      return buffer[start + pos++];
    },
    read: (buf: number[], bufOffset: number, len: number): number => {
      var bytesRead = 0;
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
 */
export function createOutputStream() {
  var chunks: Buffer[] = [];
  var currentChunk: number[] = [];
  var CHUNK_SIZE = 16384;

  return {
    writeByte: (b: number): void => {
      currentChunk.push(b);
      if (currentChunk.length >= CHUNK_SIZE) {
        chunks.push(allocBufferUnsafe(currentChunk.length));
        for (var i = 0; i < currentChunk.length; i++) {
          chunks[chunks.length - 1][i] = currentChunk[i];
        }
        currentChunk = [];
      }
    },
    write: function (buf: number[], bufOffset: number, len: number): number {
      for (var i = 0; i < len; i++) {
        this.writeByte(buf[bufOffset + i]);
      }
      return len;
    },
    flush: (): void => {
      if (currentChunk.length > 0) {
        var finalChunk = allocBufferUnsafe(currentChunk.length);
        for (var i = 0; i < currentChunk.length; i++) {
          finalChunk[i] = currentChunk[i];
        }
        chunks.push(finalChunk);
        currentChunk = [];
      }
    },
    toBuffer: function (): Buffer {
      this.flush();
      return Buffer.concat(chunks);
    },
  };
}
