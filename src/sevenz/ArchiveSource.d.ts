/**
 * ArchiveSource - Abstraction for reading 7z archive data
 *
 * Provides a common interface for reading archive data from either
 * a file descriptor or an in-memory buffer.
 */
import { type BufferLike } from 'extract-base-iterator';
import type Stream from 'stream';
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
export declare class BufferSource implements ArchiveSource {
  private buffer;
  constructor(buffer: Buffer);
  read(position: number, length: number): BufferLike;
  getSize(): number;
  close(): void;
  /**
   * Create a readable stream for a portion of the buffer.
   * Streams the data in chunks to avoid blocking.
   */
  createReadStream(offset: number, length: number): Stream.Readable;
}
/**
 * File descriptor based archive source
 *
 * Used for reading directly from a file on disk.
 * More memory efficient for large archives.
 */
export declare class FileSource implements ArchiveSource {
  private fd;
  private size;
  constructor(fd: number, size: number);
  read(position: number, length: number): BufferLike;
  private readChunk;
  getSize(): number;
  close(): void;
  /**
   * Create a readable stream for a portion of the file.
   * Uses async fs.read() to avoid blocking the event loop.
   */
  createReadStream(offset: number, length: number): Stream.Readable;
}
