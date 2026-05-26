/**
 * SevenZipParser - Main 7z archive parser
 *
 * Handles reading archive structure and providing file streams.
 *
 * Parser Flow:
 * 1. Read signature header (32 bytes) to get header location
 * 2. Read encoded header from nextHeaderOffset
 * 3. If header is compressed, decompress it first
 * 4. Parse streams info (folder structure, pack positions)
 * 5. Parse files info (names, sizes, attributes)
 * 6. Build entry list for iteration
 *
 * Decompression:
 * - 7z uses "folders" as decompression units
 * - Solid archives: multiple files share one folder (decompress once)
 * - Non-solid: one file per folder
 * - Supports LZMA, LZMA2, COPY, BCJ2, and other codecs
 */
import type Stream from 'stream';
import type { ArchiveSource } from './ArchiveSource.ts';
type Readable = Stream.Readable;
export { type ArchiveSource, BufferSource, FileSource } from './ArchiveSource.ts';
export interface SevenZipEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'link';
  size: number;
  mtime?: Date;
  atime?: Date;
  ctime?: Date;
  mode?: number;
  isAntiFile: boolean;
  _folderIndex: number;
  _streamIndex: number;
  _streamIndexInFolder: number;
  _hasStream: boolean;
  _crc?: number;
  _canStream: boolean;
}
/** Callback for operations that don't return data */
export type VoidCallback = (error: Error | null) => void;
/**
 * SevenZipParser - parses 7z archives and provides entry iteration
 */
export declare class SevenZipParser {
  private source;
  private signature;
  private streamsInfo;
  private filesInfo;
  private entries;
  private parsed;
  private decompressedCache;
  private filesPerFolder;
  private extractedPerFolder;
  private folderSplitters;
  private pendingFolders;
  constructor(source: ArchiveSource);
  /**
   * Convert BufferLike to Buffer (for small data like headers)
   */
  private toBuffer;
  /**
   * Decode using codec - accepts BufferLike for LZMA1 support
   */
  private decodeWithCodec;
  /**
   * Parse the archive structure
   * Must be called before iterating entries
   */
  parse(callback?: VoidCallback): Promise<void> | void;
  private parseInternal;
  /**
   * Handle compressed header (kEncodedHeader)
   */
  private handleCompressedHeader;
  private parseDecompressedHeader;
  /**
   * Parse streams info from encoded header block
   * This is a simplified parser for the header's own compression info
   */
  private parseEncodedHeaderStreams;
  /**
   * Build the entries list from parsed file info
   */
  private buildEntries;
  /**
   * Create an entry from file info
   */
  private createEntry;
  /**
   * Get the list of entries
   */
  getEntries(): SevenZipEntry[];
  /**
   * Get a readable stream for an entry's content.
   * Returns immediately - decompression happens when data is read (proper streaming).
   * Uses true streaming for codecs that support it, buffered for others.
   */
  getEntryStream(entry: SevenZipEntry): Readable;
  /**
   * True streaming: data flows through without buffering entire folder.
   * Only used for single-file folders with streamable codecs (BZip2, Deflate, LZMA2).
   */
  private _getEntryStreamStreaming;
  /**
   * Buffered extraction: decompress entire folder, slice out file.
   * Used for codecs that don't support incremental streaming (LZMA1, BCJ2).
   */
  private _getEntryStreamBuffered;
  /**
   * Check if a folder uses BCJ2 codec
   */
  private folderHasBcj2;
  /**
   * Get decompressed data for a folder, with smart caching for solid archives
   * Only caches when multiple files share a block, releases when last file extracted
   */
  private getDecompressedFolder;
  private shouldCacheFolder;
  private decodeFolderData;
  private readPackedData;
  private decodeFolderCoders;
  /**
   * Decompress a BCJ2 folder with multi-stream handling
   * BCJ2 uses 4 input streams: main, call, jump, range coder
   */
  private decompressBcj2Folder;
  private finishBcj2Decode;
  /**
   * Get processing order for coders (dependency order)
   */
  private getCoderProcessOrder;
  /**
   * Close the parser and release resources
   */
  close(): void;
  /**
   * Check if a codec supports true streaming decompression.
   *
   * Only codecs that process data incrementally (not buffering entire input) qualify.
   * @param codecId - The codec ID as an array of bytes
   * @returns true if the codec can stream
   */
  private codecSupportsStreaming;
  /**
   * Check if a folder can be streamed (vs buffered).
   *
   * Streaming is possible when ALL codecs in the chain support streaming.
   * BCJ2 folders are never streamable due to their 4-stream architecture.
   *
   * @param folderIndex - Index of the folder to check
   * @returns true if the folder can be streamed
   */
  canStreamFolder(folderIndex: number): boolean;
  /**
   * Stream a folder's decompression.
   *
   * Creates a pipeline: packed data → codec decoders → output stream
   *
   * @param folderIndex - Index of folder to decompress
   * @returns Object with output stream and control methods
   */
  streamFolder(folderIndex: number): {
    output: Readable;
    pause: () => void;
    resume: () => void;
    destroy: (err?: Error) => void;
  };
  /**
   * Get a streaming entry stream (Promise-based API).
   *
   * For streamable folders: Returns a true streaming decompression
   * For non-streamable folders: Falls back to buffered extraction
   *
   * @param entry - The entry to get stream for
   * @returns Promise resolving to readable stream
   */
  getEntryStreamStreaming(entry: SevenZipEntry): Promise<Readable>;
  /**
   * Direct streaming for single-file folders.
   * Pipes folder decompression directly to output with CRC verification.
   */
  private getEntryStreamDirect;
  /**
   * Get stream from folder splitter (for multi-file folders).
   * Creates splitter on first access, reuses for subsequent files in same folder.
   */
  private getEntryStreamFromSplitter;
  /**
   * Get file sizes and CRCs for all files in a folder (in stream order).
   * Used by FolderStreamSplitter to know file boundaries.
   */
  private getFolderFileInfo;
}
