export { DirectoryEntry, LinkEntry, Lock, SymbolicLinkEntry } from 'extract-base-iterator';
export { default as FileEntry } from './FileEntry.ts';
export type { SevenZipEntry } from './sevenz/SevenZipParser.ts';

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
}

export type EntryCallback = (error?: Error, result?: IteratorResult<Entry>) => void;
