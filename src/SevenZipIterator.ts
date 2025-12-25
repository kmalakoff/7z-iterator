import BaseIterator, { Lock } from 'extract-base-iterator';
import { rmSync } from 'fs-remove-compat';
import fs from 'graceful-fs';
import path from 'path';
import Queue from 'queue-cb';
import shortHash from 'short-hash';
import tempSuffix from 'temp-suffix';
import { tmpdir } from './compat.ts';
import streamToSource, { type SourceResult } from './lib/streamToSource.ts';
import nextEntry from './nextEntry.ts';
import { setPassword } from './sevenz/codecs/index.ts';
import { type ArchiveSource, FileSource, type SevenZipEntry, SevenZipParser } from './sevenz/SevenZipParser.ts';

import type { Entry, ExtractOptions } from './types.ts';

/**
 * Internal iterator interface for SevenZipParser entries
 * @internal
 */
interface SevenZipFileIterator {
  next(): SevenZipEntry | null;
  getParser(): SevenZipParser;
}

/**
 * Iterator wrapper around SevenZipParser entries
 */
class EntryIterator implements SevenZipFileIterator {
  private parser: SevenZipParser;
  private entries: SevenZipEntry[];
  private index = 0;

  constructor(parser: SevenZipParser) {
    this.parser = parser;
    this.entries = parser.getEntries();
  }

  next(): SevenZipEntry | null {
    if (this.index >= this.entries.length) {
      return null;
    }
    return this.entries[this.index++];
  }

  getParser(): SevenZipParser {
    return this.parser;
  }
}

export default class SevenZipIterator extends BaseIterator<Entry> {
  lock: Lock | null;
  /** @internal - Do not use directly */
  _iterator: unknown;

  constructor(source: string | NodeJS.ReadableStream, options: ExtractOptions = {}) {
    super(options);
    this.lock = new Lock();
    this.lock.onDestroy = (err) => BaseIterator.prototype.end.call(this, err);
    const queue = new Queue(1);
    let cancelled = false;
    let archiveSource: ArchiveSource | null = null;
    const setup = (): void => {
      cancelled = true;
    };
    this.processing.push(setup);

    // Set password (or clear if not provided)
    setPassword(options.password || null);

    if (typeof source === 'string') {
      // File path input - use FileSource directly
      queue.defer((cb: (err?: Error) => void) => {
        fs.stat(source, (statErr, stats) => {
          if (this.done || cancelled) return;
          if (statErr) return cb(statErr);

          fs.open(source, 'r', (err, fd) => {
            if (this.done || cancelled) return;
            if (err) return cb(err);

            archiveSource = new FileSource(fd, stats.size);
            // Register cleanup for file descriptor
            this.lock.registerCleanup(() => {
              fs.closeSync(fd);
            });
            cb();
          });
        });
      });
    } else {
      // Stream input - write to temp file for random access
      // Register cleanup for source stream
      const stream = source as NodeJS.ReadableStream;
      this.lock.registerCleanup(() => {
        const s = stream as NodeJS.ReadableStream & { destroy?: () => void };
        if (typeof s.destroy === 'function') s.destroy();
      });

      const tempPath = path.join(tmpdir(), '7z-iterator', shortHash(process.cwd()), tempSuffix('tmp.7z'));
      queue.defer((cb: (err?: Error) => void) => {
        streamToSource(source, { tempPath }, (err?: Error, result?: SourceResult) => {
          if (this.done || cancelled) return;
          if (err) return cb(err);
          if (!result) return cb(new Error('No result from streamToSource'));

          archiveSource = result.source;

          // Register cleanup for file descriptor
          this.lock.registerCleanup(() => {
            fs.closeSync(result.fd);
          });

          // Register cleanup for temp file
          this.lock.registerCleanup(() => {
            try {
              rmSync(result.tempPath);
            } catch (_e) {
              /* ignore */
            }
          });

          cb();
        });
      });
    }

    // Parse and build iterator
    queue.defer((cb: (err?: Error) => void) => {
      if (this.done || cancelled) return;
      if (!archiveSource) return cb(new Error('No archive source'));

      const parser = new SevenZipParser(archiveSource);
      parser.parse((parseErr) => {
        if (parseErr) {
          cb(parseErr);
          return;
        }
        try {
          this._iterator = new EntryIterator(parser);
          cb();
        } catch (err) {
          cb(err as Error);
        }
      });
    });

    // start processing
    queue.await((err?: Error) => {
      this.processing.remove(setup);
      if (this.done || cancelled) return;
      err ? this.end(err) : this.push(nextEntry);
    });
  }

  end(err?: Error) {
    if (this.lock) {
      const lock = this.lock;
      this.lock = null; // Clear before release to prevent re-entrancy
      lock.err = err;
      lock.release();
    }
    // Don't call base end here - Lock.__destroy() handles it
    this._iterator = null;
  }

  /**
   * Check if streaming extraction is available for any folder in this archive.
   * Streaming is possible when folders use codecs like BZip2, Deflate, or Copy
   * that can decompress incrementally without buffering the entire input.
   *
   * @returns true if at least one folder supports streaming
   */
  canStream(): boolean {
    if (!this._iterator) return false;
    const parser = (this._iterator as SevenZipFileIterator).getParser();
    if (!parser) return false;

    const entries = parser.getEntries();
    const checkedFolders: { [key: number]: boolean } = {};

    for (let i = 0; i < entries.length; i++) {
      const folderIndex = entries[i]._folderIndex;
      if (folderIndex >= 0 && checkedFolders[folderIndex] === undefined) {
        checkedFolders[folderIndex] = parser.canStreamFolder(folderIndex);
        if (checkedFolders[folderIndex]) {
          return true;
        }
      }
    }

    return false;
  }

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
  getStreamingOrder(): SevenZipEntry[] {
    if (!this._iterator) return [];
    const parser = (this._iterator as SevenZipFileIterator).getParser();
    if (!parser) return [];

    const entries = parser.getEntries();

    // Create a copy and sort for streaming order
    const sorted: SevenZipEntry[] = [];
    for (let i = 0; i < entries.length; i++) {
      sorted.push(entries[i]);
    }

    sorted.sort((a, b) => {
      // First by folder index
      if (a._folderIndex !== b._folderIndex) {
        return a._folderIndex - b._folderIndex;
      }
      // Then by stream index within folder
      return a._streamIndexInFolder - b._streamIndexInFolder;
    });

    return sorted;
  }
}
