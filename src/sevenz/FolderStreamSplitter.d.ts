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
export declare class FolderStreamSplitter {
  private fileBoundaries;
  private fileStreams;
  private fileCrcs;
  private currentFileIndex;
  private bytesWritten;
  private currentFileEnd;
  private verifyCrc;
  private expectedCrcs;
  private finished;
  private error;
  private drainCallbacks;
  private _needsDrain;
  constructor(options: FolderStreamSplitterOptions);
  /**
   * Write decompressed data chunk. Data is routed to appropriate file stream(s).
   * Returns false if backpressure should be applied (downstream is full).
   */
  write(chunk: Buffer): boolean;
  /**
   * Ensure stream exists for file index (lazy creation)
   */
  private ensureFileStream;
  /**
   * Complete current file and move to next
   */
  private finishCurrentFile;
  /**
   * Signal end of decompressed data
   */
  end(): void;
  /**
   * Emit error to all pending file streams
   */
  private emitError;
  /**
   * Get the stream for a specific file by index.
   * Stream is created lazily on first access.
   */
  getFileStream(fileIndex: number): Stream.PassThrough;
  /**
   * Register callback for when backpressure clears
   */
  onDrain(callback: () => void): void;
  /**
   * Notify all drain callbacks
   */
  private notifyDrain;
  /**
   * Check if a specific file's stream has been fully written
   */
  isFileComplete(fileIndex: number): boolean;
  /**
   * Get total number of files in this folder
   */
  get fileCount(): number;
  /**
   * Check if splitter has encountered an error
   */
  getError(): Error | null;
}
