/**
 * ArchiveSource - Abstraction for reading 7z archive data
 *
 * Provides a common interface for reading archive data from either
 * a file descriptor or an in-memory buffer.
 */

import { allocBuffer, type BufferLike, BufferList, canAllocateBufferSize, Readable } from 'extract-base-iterator';
import fs from 'fs';
import type Stream from 'stream';

// Helper to create a Readable stream compatible with Node 0.8
function createReadableStream(readFn: (stream: Stream.Readable) => void): Stream.Readable {
  const stream = new Readable();
  stream._read = function () {
    readFn(this);
  };
  return stream;
}

/**
 * Archive source abstraction - allows reading from file descriptor or buffer
 */
export interface ArchiveSource {
  read(position: number, length: number): BufferLike;
  getSize(): number;
  close(): void;
  /**
   * Create a readable stream for a portion of the archive.
   * Used for streaming decompression.
   */
  createReadStream(offset: number, length: number): Stream.Readable;
}

/**
 * Buffer-based archive source
 *
 * Used when the entire archive is already in memory.
 */
export class BufferSource implements ArchiveSource {
  private buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  read(position: number, length: number): BufferLike {
    return this.buffer.slice(position, position + length);
  }

  getSize(): number {
    return this.buffer.length;
  }

  close(): void {
    // Nothing to close for buffer
  }

  /**
   * Create a readable stream for a portion of the buffer.
   * Streams the data in chunks to avoid blocking.
   */
  createReadStream(offset: number, length: number): Stream.Readable {
    const buffer = this.buffer;
    const end = Math.min(offset + length, buffer.length);
    let currentPos = offset;
    const chunkSize = 65536; // 64KB chunks

    return createReadableStream((stream) => {
      if (currentPos >= end) {
        stream.push(null);
        return;
      }

      const toRead = Math.min(chunkSize, end - currentPos);
      const chunk = buffer.slice(currentPos, currentPos + toRead);
      currentPos += toRead;
      stream.push(chunk);
    });
  }
}

/**
 * File descriptor based archive source
 *
 * Used for reading directly from a file on disk.
 * More memory efficient for large archives.
 */
export class FileSource implements ArchiveSource {
  private fd: number;
  private size: number;

  constructor(fd: number, size: number) {
    this.fd = fd;
    this.size = size;
  }

  read(position: number, length: number): BufferLike {
    // For small reads that fit in a single buffer, return directly
    // This is efficient on all Node versions
    if (canAllocateBufferSize(length)) {
      return this.readChunk(position, length);
    }

    // For large reads, return a BufferList to avoid large contiguous allocation
    // This enables LZMA1 decompression on old Node versions
    const result = new BufferList();
    let totalBytesRead = 0;
    let currentPos = position;

    while (totalBytesRead < length) {
      const remaining = length - totalBytesRead;
      // Use safe chunk size that works on all Node versions
      const chunkSize = Math.min(remaining, canAllocateBufferSize(remaining) ? remaining : 256 * 1024 * 1024);
      const chunk = this.readChunk(currentPos, chunkSize);

      result.append(chunk);
      totalBytesRead += chunk.length;
      currentPos += chunk.length;

      if (chunk.length < chunkSize) {
        // EOF reached
        break;
      }
    }

    return result;
  }

  private readChunk(position: number, length: number): Buffer {
    const buf = allocBuffer(length);
    const bytesRead = fs.readSync(this.fd, buf, 0, length, position);
    if (bytesRead < length) {
      return buf.slice(0, bytesRead);
    }
    return buf;
  }

  getSize(): number {
    return this.size;
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch (_e) {
      // Ignore close errors
    }
  }

  /**
   * Create a readable stream for a portion of the file.
   * Uses async fs.read() to avoid blocking the event loop.
   */
  createReadStream(offset: number, length: number): Stream.Readable {
    const fd = this.fd;
    let bytesRead = 0;
    let reading = false;
    let finished = false;
    const chunkSize = 65536; // 64KB chunks
    let _streamRef: Stream.Readable | null = null;

    const stream = createReadableStream((s) => {
      _streamRef = s;
      if (reading || finished) return; // Prevent re-entrant reads

      const toRead = Math.min(chunkSize, length - bytesRead);
      if (toRead <= 0) {
        finished = true;
        s.push(null);
        return;
      }

      reading = true;
      const buffer = allocBuffer(toRead);
      const currentOffset = offset + bytesRead;

      fs.read(fd, buffer, 0, toRead, currentOffset, (err, n) => {
        reading = false;

        if (err) {
          // Emit error for Node 0.8 compatibility (no destroy method)
          s.emit('error', err);
          finished = true;
          s.push(null);
          return;
        }

        if (n === 0) {
          finished = true;
          s.push(null);
        } else {
          bytesRead += n;
          s.push(buffer.slice(0, n));
        }
      });
    });

    return stream;
  }
}
