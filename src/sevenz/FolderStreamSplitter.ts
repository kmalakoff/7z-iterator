/**
 * FolderStreamSplitter - Splits a decompressed folder stream into individual file streams
 *
 * For multi-file solid archives, the folder is decompressed as a single stream.
 * This class splits that stream into individual file streams based on known file boundaries.
 *
 * Features:
 * - Lazy stream creation (streams created on first access)
 * - Backpressure propagation (returns false when downstream is full)
 * - Running CRC verification per file
 * - Automatic cleanup of completed streams
 */

import { crc32, PassThrough } from 'extract-base-iterator';
import type Stream from 'stream';

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
 *
 * Usage:
 * ```
 * const splitter = new FolderStreamSplitter({ fileSizes: [1000, 2000, 500] });
 *
 * decompressStream.on('data', (chunk) => {
 *   if (!splitter.write(chunk)) {
 *     decompressStream.pause();
 *     splitter.onDrain(() => decompressStream.resume());
 *   }
 * });
 * decompressStream.on('end', () => splitter.end());
 *
 * // Get stream for file at index 1 (created lazily)
 * const fileStream = splitter.getFileStream(1);
 * ```
 */
export class FolderStreamSplitter {
  private fileBoundaries: number[]; // Cumulative offsets [0, size1, size1+size2, ...]
  private fileStreams: (Stream.PassThrough | null)[]; // Lazy-created, null after completion
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

    // Calculate cumulative boundaries
    this.fileBoundaries = [0];
    for (let i = 0; i < fileSizes.length; i++) {
      this.fileBoundaries.push(this.fileBoundaries[this.fileBoundaries.length - 1] + fileSizes[i]);
    }

    // Initialize streams array (lazy creation - all null initially)
    this.fileStreams = [];
    this.fileCrcs = [];
    for (let i = 0; i < fileSizes.length; i++) {
      this.fileStreams.push(null);
      this.fileCrcs.push(0);
    }

    // Set first file boundary
    this.currentFileEnd = this.fileBoundaries[1] || 0;
  }

  /**
   * Write decompressed data chunk. Data is routed to appropriate file stream(s).
   * Returns false if backpressure should be applied (downstream is full).
   */
  write(chunk: Buffer): boolean {
    if (this.finished || this.error) return true;

    let offset = 0;
    let canContinue = true;

    while (offset < chunk.length && this.currentFileIndex < this.fileStreams.length) {
      const remaining = chunk.length - offset;
      const neededForFile = this.currentFileEnd - this.bytesWritten;
      const toWrite = Math.min(remaining, neededForFile);

      if (toWrite > 0) {
        const fileChunk = chunk.slice(offset, offset + toWrite);

        // Ensure stream exists (lazy creation)
        const fileStream = this.ensureFileStream(this.currentFileIndex);

        // Update CRC
        if (this.verifyCrc) {
          this.fileCrcs[this.currentFileIndex] = crc32(fileChunk, this.fileCrcs[this.currentFileIndex]);
        }

        // Write to file stream, track backpressure
        if (!fileStream.write(fileChunk)) {
          canContinue = false;
          this._needsDrain = true;
          fileStream.once('drain', () => {
            this._needsDrain = false;
            this.notifyDrain();
          });
        }
      }

      this.bytesWritten += toWrite;
      offset += toWrite;

      // Check if current file is complete
      if (this.bytesWritten >= this.currentFileEnd) {
        this.finishCurrentFile();
      }
    }

    return canContinue;
  }

  /**
   * Ensure stream exists for file index (lazy creation)
   */
  private ensureFileStream(fileIndex: number): Stream.PassThrough {
    let stream = this.fileStreams[fileIndex];
    if (!stream) {
      stream = new PassThrough();
      this.fileStreams[fileIndex] = stream;
    }
    return stream;
  }

  /**
   * Complete current file and move to next
   */
  private finishCurrentFile(): void {
    const fileStream = this.fileStreams[this.currentFileIndex];

    // Verify CRC if enabled
    if (this.verifyCrc) {
      const expectedCrc = this.expectedCrcs[this.currentFileIndex];
      if (expectedCrc !== undefined && this.fileCrcs[this.currentFileIndex] !== expectedCrc) {
        const err = new Error(`CRC mismatch for file ${this.currentFileIndex}: expected ${expectedCrc.toString(16)}, got ${this.fileCrcs[this.currentFileIndex].toString(16)}`);
        this.emitError(err);
        return;
      }
    }

    // End this file's stream
    if (fileStream) {
      fileStream.end();
    }

    // Release reference for GC
    this.fileStreams[this.currentFileIndex] = null;

    // Move to next file
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

    // End any remaining streams
    for (let i = this.currentFileIndex; i < this.fileStreams.length; i++) {
      const stream = this.fileStreams[i];
      if (stream) {
        stream.end();
      }
      this.fileStreams[i] = null;
    }
  }

  /**
   * Emit error to all pending file streams
   */
  private emitError(err: Error): void {
    this.error = err;
    for (let i = this.currentFileIndex; i < this.fileStreams.length; i++) {
      const stream = this.fileStreams[i];
      if (stream) {
        stream.emit('error', err);
        stream.end();
      }
      this.fileStreams[i] = null;
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

    // Check if file already completed
    if (fileIndex < this.currentFileIndex) {
      throw new Error(`File ${fileIndex} already completed - streams must be accessed in order`);
    }

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

  /**
   * Notify all drain callbacks
   */
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
