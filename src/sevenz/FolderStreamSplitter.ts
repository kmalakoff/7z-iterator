/**
 * FolderStreamSplitter - Splits a decompressed folder stream into individual file streams
 *
 * For multi-file solid archives, the folder is decompressed as a single stream.
 * This class splits that stream into individual file streams based on known file boundaries.
 */

import { crc32, destroyStream, PassThrough } from 'extract-base-iterator';
import type Stream from 'stream';
import { defer } from '../compat.ts';

// Ensure destroyed entry streams emit one error without finish/end on Node 0.x and 8, and one close on plain destroy
export function attachSafeDestroy(stream: Stream.PassThrough, onDestroy?: () => void): () => boolean {
  let destroyed = false;

  (stream as unknown as { _destroy: (err: Error | null, cb: (err: Error | null) => void) => void })._destroy = (err, cb) => cb(err);

  const streamWithDestroy = stream as NodeJS.ReadableStream & { destroy?: (err?: Error | null) => NodeJS.ReadableStream };
  const originalDestroy = typeof streamWithDestroy.destroy === 'function' ? streamWithDestroy.destroy.bind(stream) : null;
  let closed = false;
  stream.once('close', () => {
    closed = true;
  });
  streamWithDestroy.destroy = (err?: Error | null) => {
    if (destroyed) return stream;
    destroyed = true;
    if (err) stream.emit('error', err);
    if (onDestroy) onDestroy();
    if (originalDestroy) originalDestroy();
    if (!err) {
      process.nextTick(() => {
        if (!closed) stream.emit('close');
      });
    }
    return stream;
  };

  return () => destroyed;
}

export interface FolderStreamSplitterOptions {
  /** Sizes of each file in the folder (in order) */
  fileSizes: number[];
  /** Whether to verify CRC for each file */
  verifyCrc?: boolean;
  /** Expected CRCs for each file (parallel to fileSizes) */
  expectedCrcs?: (number | undefined)[];
}

/**
 * Splits a decompressed folder stream into individual file streams.
 */
export class FolderStreamSplitter {
  private fileBoundaries: number[]; // Cumulative offsets [0, size1, size1+size2, ...]
  private fileStreams: (Stream.PassThrough | null)[]; // Lazy-created, null after completion
  private requestedStreams: boolean[]; // Tracks streams returned to callers
  private fileCrcs: number[]; // Running CRC per file
  private currentFileIndex: number;
  private bytesWritten: number;
  private currentFileEnd: number;
  private verifyCrc: boolean;
  private expectedCrcs: (number | undefined)[];
  private finished: boolean;
  private error: Error | null;
  private drainCallbacks: (() => void)[];
  private _needsDrain: boolean;
  private _drainStream: Stream.PassThrough | null;

  constructor(options: FolderStreamSplitterOptions) {
    const fileSizes = options.fileSizes;
    const verifyCrc = options.verifyCrc !== undefined ? options.verifyCrc : true;
    const expectedCrcs = options.expectedCrcs || [];

    this.verifyCrc = verifyCrc;
    this.expectedCrcs = expectedCrcs;
    this.currentFileIndex = 0;
    this.bytesWritten = 0;
    this.finished = false;
    this.error = null;
    this.drainCallbacks = [];
    this._needsDrain = false;
    this._drainStream = null;

    this.fileBoundaries = [0];
    for (let i = 0; i < fileSizes.length; i++) {
      this.fileBoundaries.push(this.fileBoundaries[this.fileBoundaries.length - 1] + fileSizes[i]);
    }

    this.fileStreams = [];
    this.requestedStreams = [];
    this.fileCrcs = [];
    for (let i = 0; i < fileSizes.length; i++) {
      this.fileStreams.push(null);
      this.requestedStreams.push(false);
      this.fileCrcs.push(0);
    }

    this.currentFileEnd = this.fileBoundaries[1] || 0;
  }

  /**
   * Write decompressed data chunk. Data is routed to appropriate file stream(s).
   * Returns false if backpressure should be applied (downstream is full).
   */
  write(chunk: Buffer): boolean {
    if (this.finished || this.error) return true;

    let offset = 0;

    while (offset < chunk.length && this.currentFileIndex < this.fileStreams.length && !this.error) {
      const remaining = chunk.length - offset;
      const neededForFile = this.currentFileEnd - this.bytesWritten;
      const toWrite = Math.min(remaining, neededForFile);

      if (toWrite > 0) {
        const fileChunk = chunk.slice(offset, offset + toWrite);
        const fileStream = this.ensureFileStream(this.currentFileIndex);

        if (this.verifyCrc) {
          this.fileCrcs[this.currentFileIndex] = crc32(fileChunk, this.fileCrcs[this.currentFileIndex]);
        }

        if (!fileStream.write(fileChunk)) {
          this._needsDrain = true;
          if (this._drainStream !== fileStream) {
            this._drainStream = fileStream;
            fileStream.once('drain', () => {
              if (this._drainStream === fileStream) this._drainStream = null;
              this._needsDrain = false;
              this.notifyDrain();
            });
          }
        }
      }

      this.bytesWritten += toWrite;
      offset += toWrite;

      if (this.bytesWritten >= this.currentFileEnd) {
        this.finishCurrentFile();
      }
    }

    return !this._needsDrain;
  }

  private ensureFileStream(fileIndex: number): Stream.PassThrough {
    let stream = this.fileStreams[fileIndex];
    if (!stream) {
      stream = new PassThrough();
      attachSafeDestroy(stream);
      this.fileStreams[fileIndex] = stream;
    }
    return stream;
  }

  private finishCurrentFile(): void {
    const fileStream = this.fileStreams[this.currentFileIndex];

    if (this.verifyCrc) {
      const expectedCrc = this.expectedCrcs[this.currentFileIndex];
      if (expectedCrc !== undefined && this.fileCrcs[this.currentFileIndex] !== expectedCrc) {
        const err = new Error(`CRC mismatch for file ${this.currentFileIndex}: expected ${expectedCrc.toString(16)}, got ${this.fileCrcs[this.currentFileIndex].toString(16)}`);
        this.emitError(err);
        return;
      }
    }

    if (fileStream) {
      fileStream.end();
      if (this._drainStream === fileStream) {
        this._drainStream = null;
        this._needsDrain = false;
        this.notifyDrain();
      }
    }

    this.fileStreams[this.currentFileIndex] = null;

    this.currentFileIndex++;
    if (this.currentFileIndex < this.fileBoundaries.length - 1) {
      this.currentFileEnd = this.fileBoundaries[this.currentFileIndex + 1];
    }
  }

  /**
   * Signal end of decompressed data
   */
  end(): void {
    if (this.finished) return;
    this.finished = true;
    this.drainCallbacks = [];
    this._drainStream = null;
    this._needsDrain = false;

    for (let i = this.currentFileIndex; i < this.fileStreams.length; i++) {
      const stream = this.fileStreams[i];
      if (stream) {
        stream.end();
      }
      this.fileStreams[i] = null;
    }
  }

  /**
   * Fail the folder and report error to all requested pending streams
   */
  fail(err: Error): void {
    this.emitError(err);
  }

  private emitError(err: Error): void {
    if (this.error) return;
    this.error = err;
    this.finished = true;
    this.drainCallbacks = [];
    this._drainStream = null;
    this._needsDrain = false;

    for (let i = this.currentFileIndex; i < this.fileStreams.length; i++) {
      const stream = this.fileStreams[i];
      this.fileStreams[i] = null;
      if (stream && this.requestedStreams[i]) {
        destroyStream(stream, err);
      }
    }
  }

  /**
   * Get the stream for a specific file by index.
   * Stream is created lazily on first access.
   */
  getFileStream(fileIndex: number): Stream.PassThrough {
    if (fileIndex < 0 || fileIndex >= this.fileBoundaries.length - 1) {
      throw new Error(`Invalid file index: ${fileIndex}`);
    }

    if (this.error) {
      const err = this.error;
      const errStream = new PassThrough();
      attachSafeDestroy(errStream);
      defer(() => {
        destroyStream(errStream, err);
      });
      return errStream;
    }

    if (fileIndex < this.currentFileIndex) {
      throw new Error(`File ${fileIndex} already completed - streams must be accessed in order`);
    }

    this.requestedStreams[fileIndex] = true;
    return this.ensureFileStream(fileIndex);
  }

  /**
   * Register callback for when backpressure clears
   */
  onDrain(callback: () => void): void {
    if (!this._needsDrain) {
      callback();
    } else {
      this.drainCallbacks.push(callback);
    }
  }

  private notifyDrain(): void {
    const callbacks = this.drainCallbacks;
    this.drainCallbacks = [];
    for (let i = 0; i < callbacks.length; i++) {
      callbacks[i]();
    }
  }

  /**
   * Check if a specific file's stream has been fully written
   */
  isFileComplete(fileIndex: number): boolean {
    return fileIndex < this.currentFileIndex;
  }

  /**
   * Get total number of files in this folder
   */
  get fileCount(): number {
    return this.fileBoundaries.length - 1;
  }

  /**
   * Check if splitter has encountered an error
   */
  getError(): Error | null {
    return this.error;
  }
}
