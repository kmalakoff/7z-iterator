import { type FileAttributes, FileEntry, type Lock, type NoParamCallback, waitForAccess } from 'extract-base-iterator';
import fs from 'fs';
import oo from 'on-one';
import type { SevenZipEntry, SevenZipParser } from './sevenz/SevenZipParser.ts';
import type { ExtractOptions } from './types.ts';

export default class SevenZipFileEntry extends FileEntry {
  private lock: Lock;
  private entry: SevenZipEntry;
  private parser: SevenZipParser;

  constructor(attributes: FileAttributes, entry: SevenZipEntry, parser: SevenZipParser, lock: Lock) {
    super(attributes);
    this.entry = entry;
    this.parser = parser;
    this.lock = lock;
    this.lock.retain();
  }

  create(dest: string, options: ExtractOptions | NoParamCallback, callback: NoParamCallback): undefined | Promise<boolean> {
    if (typeof options === 'function') {
      callback = options;
      options = null;
    }

    if (typeof callback === 'function') {
      options = options || {};
      return FileEntry.prototype.create.call(this, dest, options, (err?: Error) => {
        callback(err);
        if (this.lock) {
          this.lock.release();
          this.lock = null;
        }
      });
    }
    return new Promise((resolve, reject) => {
      this.create(dest, options, (err?: Error, done?: boolean) => {
        err ? reject(err) : resolve(done);
      });
    });
  }

  _writeFile(fullPath: string, _options: ExtractOptions, callback: NoParamCallback): undefined {
    if (!this.entry || !this.parser) {
      callback(new Error('7z FileEntry missing entry. Check for calling create multiple times'));
      return;
    }

    // Use callback-based async decompression
    this.parser.getEntryStreamAsync(this.entry, (err, stream) => {
      if (err) return callback(err);
      if (!stream) return callback(new Error('No stream returned'));

      const res = stream.pipe(fs.createWriteStream(fullPath));
      oo(res, ['error', 'end', 'close', 'finish'], (writeErr?: Error) => {
        writeErr ? callback(writeErr) : waitForAccess(fullPath, callback);
      });
    });
  }

  destroy() {
    FileEntry.prototype.destroy.call(this);
    this.entry = null;
    this.parser = null;
    if (this.lock) {
      this.lock.release();
      this.lock = null;
    }
  }
}
