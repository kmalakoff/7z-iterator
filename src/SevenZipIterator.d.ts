import BaseIterator, { Lock } from 'extract-base-iterator';
import { type SevenZipEntry } from './sevenz/SevenZipParser.ts';
import type { Entry, ExtractOptions } from './types.ts';
export default class SevenZipIterator extends BaseIterator<Entry> {
  lock: Lock | null;
  /** @internal - Do not use directly */
  _iterator: unknown;
  constructor(source: string | NodeJS.ReadableStream, options?: ExtractOptions);
  end(err?: Error): void;
  /**
   * Check if streaming extraction is available for any folder in this archive.
   * Streaming is possible when folders use codecs like BZip2, Deflate, or Copy
   * that can decompress incrementally without buffering the entire input.
   *
   * @returns true if at least one folder supports streaming
   */
  canStream(): boolean;
  /**
   * Get entries sorted for optimal streaming extraction.
   *
   * Entries are sorted by:
   * 1. Folder index (process one folder at a time)
   * 2. Stream index within folder (for solid block streaming)
   *
   * This ordering allows multi-file solid folders to stream with
   * O(largest file) memory instead of O(folder size).
   *
   * @returns Array of entries in streaming order
   */
  getStreamingOrder(): SevenZipEntry[];
}
