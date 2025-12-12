import BaseIterator from 'extract-base-iterator';
import fs from 'fs';
import path from 'path';
import Queue from 'queue-cb';
import shortHash from 'short-hash';
import tempSuffix from 'temp-suffix';
import { tmpdir } from './compat.ts';
import Lock from './lib/Lock.ts';
import streamToSource, { type SourceResult } from './lib/streamToSource.ts';
import nextEntry from './nextEntry.ts';
import { setPassword } from './sevenz/codecs/index.ts';
import { type ArchiveSource, FileSource, type SevenZipEntry, SevenZipParser } from './sevenz/SevenZipParser.ts';

import type { ExtractOptions, LockT, SevenZipFileIterator } from './types.ts';

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

export default class SevenZipIterator extends BaseIterator {
  lock: LockT;
  iterator: SevenZipFileIterator;

  constructor(source: string | NodeJS.ReadableStream, options: ExtractOptions = {}) {
    super(options);
    this.lock = new Lock();
    this.lock.iterator = this;
    const queue = new Queue(1);
    let cancelled = false;
    let archiveSource: ArchiveSource | null = null;
    const setup = (): undefined => {
      cancelled = true;
      return undefined;
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
            this.lock.fd = fd;
            cb();
          });
        });
      });
    } else {
      // Stream input - use hybrid memory/temp-file approach
      // Store source stream in lock for cleanup if destroyed during download
      this.lock.sourceStream = source as NodeJS.ReadableStream;
      const tempPath = path.join(tmpdir(), '7z-iterator', shortHash(process.cwd()), tempSuffix('tmp.7z'));
      queue.defer((cb: (err?: Error) => void) => {
        streamToSource(
          source,
          {
            memoryThreshold: options.memoryThreshold,
            tempPath: tempPath,
          },
          (err?: Error, result?: SourceResult) => {
            if (this.done || cancelled) return;
            if (err) return cb(err);
            if (!result) return cb(new Error('No result from streamToSource'));

            archiveSource = result.source;
            if (result.fd !== undefined) {
              this.lock.fd = result.fd;
            }
            if (result.tempPath) {
              this.lock.tempPath = result.tempPath;
            }
            cb();
          }
        );
      });
    }

    // Parse and build iterator
    queue.defer((cb: (err?: Error) => void) => {
      if (this.done || cancelled) return;
      if (!archiveSource) return cb(new Error('No archive source'));

      try {
        const parser = new SevenZipParser(archiveSource);
        parser.parse();
        this.iterator = new EntryIterator(parser);
        cb();
      } catch (parseErr) {
        cb(parseErr as Error);
      }
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
    this.iterator = null;
  }
}
