export { DirectoryEntry, type Entry, LinkEntry, SymbolicLinkEntry } from 'extract-base-iterator';

import type { ExtractOptions as BaseExtractOptions } from 'extract-base-iterator';

/**
 * Options for SevenZipIterator
 */
export interface ExtractOptions extends BaseExtractOptions {
  /**
   * Password for encrypted archives
   */
  password?: string;

  /**
   * Memory threshold in bytes for stream input.
   * Archives smaller than this are buffered in memory for faster processing.
   * Archives larger than this are written to a temp file.
   * Default: 100 MB (100 * 1024 * 1024)
   */
  memoryThreshold?: number;
}
export { default as FileEntry } from './FileEntry.ts';

import type { SevenZipEntry, SevenZipParser } from './sevenz/SevenZipParser.ts';

export interface LockT {
  iterator?: unknown;
  err?: Error;
  fd?: number;
  tempPath: string;
  retain: () => void;
  release: () => void;
}

export interface SevenZipFile {
  getStream: () => NodeJS.ReadableStream;
}

export interface SevenZipFileIterator {
  next: () => SevenZipEntry | null;
  getParser: () => SevenZipParser;
}

import type { Entry } from 'extract-base-iterator';

export type EntryCallback = (error?: Error, result?: IteratorResult<Entry>) => undefined;
