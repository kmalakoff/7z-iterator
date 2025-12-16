/**
 * ArchiveSource - Abstraction for reading 7z archive data
 *
 * Provides a common interface for reading archive data from either
 * a file descriptor or an in-memory buffer.
 */

import { allocBuffer } from 'extract-base-iterator';
import fs from 'fs';

/**
 * Archive source abstraction - allows reading from file descriptor or buffer
 */
export interface ArchiveSource {
  read(position: number, length: number): Buffer;
  getSize(): number;
  close(): void;
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

  read(position: number, length: number): Buffer {
    return this.buffer.slice(position, position + length);
  }

  getSize(): number {
    return this.buffer.length;
  }

  close(): void {
    // Nothing to close for buffer
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

  read(position: number, length: number): Buffer {
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
}
