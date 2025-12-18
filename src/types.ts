export { DirectoryEntry, LinkEntry, Lock, SymbolicLinkEntry } from 'extract-base-iterator';

import type { ExtractOptions as BaseExtractOptions, DirectoryEntry, LinkEntry, SymbolicLinkEntry } from 'extract-base-iterator';
import type FileEntry from './FileEntry.ts';

// 7z-specific Entry union type with 7z-specific FileEntry
export type Entry = DirectoryEntry | FileEntry | LinkEntry | SymbolicLinkEntry;

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

export interface SevenZipFile {
  getStream: () => NodeJS.ReadableStream;
}

export interface SevenZipFileIterator {
  next: () => SevenZipEntry | null;
  getParser: () => SevenZipParser;
}

export type EntryCallback = (error?: Error, result?: IteratorResult<Entry>) => void;
