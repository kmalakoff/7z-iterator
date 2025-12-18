import BaseIterator, { Lock } from 'extract-base-iterator';
import fs from 'fs';
import { rmSync } from 'fs-remove-compat';
import path from 'path';
import Queue from 'queue-cb';
import shortHash from 'short-hash';
import tempSuffix from 'temp-suffix';
import { tmpdir } from './compat.ts';
import streamToSource, { type SourceResult } from './lib/streamToSource.ts';
import nextEntry from './nextEntry.ts';
import { setPassword } from './sevenz/codecs/index.ts';
import { type ArchiveSource, FileSource, type SevenZipEntry, SevenZipParser } from './sevenz/SevenZipParser.ts';

import type { Entry, ExtractOptions, SevenZipFileIterator } from './types.ts';

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
  iterator: SevenZipFileIterator;

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
      // Stream input - use hybrid memory/temp-file approach
      // Register cleanup for source stream
      const stream = source as NodeJS.ReadableStream;
      this.lock.registerCleanup(() => {
        const s = stream as NodeJS.ReadableStream & { destroy?: () => void };
        if (typeof s.destroy === 'function') s.destroy();
      });

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
              const fd = result.fd;
              // Register cleanup for file descriptor
              this.lock.registerCleanup(() => {
                fs.closeSync(fd);
              });
            }
            if (result.tempPath) {
              const tp = result.tempPath;
              // Register cleanup for temp file
              this.lock.registerCleanup(() => {
                try {
                  rmSync(tp);
                } catch (_e) {
                  /* ignore */
                }
              });
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
