/**
 * FileEntry for 7z archives
 *
 * Wraps a lazy stream - decompression happens when the stream is read.
 * API consistent with zip-iterator and tar-iterator.
 */

import once from 'call-once-fn';
import { type FileAttributes, FileEntry, type Lock, type NoParamCallback, waitForAccess } from 'extract-base-iterator';
import fs from 'fs';
import oo from 'on-one';
import type { ExtractOptions } from './types.ts';

export default class SevenZipFileEntry extends FileEntry {
  private lock: Lock;
  private stream: NodeJS.ReadableStream;

  /**
   * Whether this entry's folder supports streaming decompression.
   */
  readonly _canStream: boolean;

  constructor(attributes: FileAttributes, stream: NodeJS.ReadableStream, lock: Lock, canStream: boolean) {
    super(attributes);
    this.stream = stream;
    this.lock = lock;
    this.lock.retain();
    this._canStream = canStream;
  }

  create(dest: string, callback: NoParamCallback): void;
  create(dest: string, options: ExtractOptions, callback: NoParamCallback): void;
  create(dest: string, options?: ExtractOptions): Promise<boolean>;
  create(dest: string, options?: ExtractOptions | NoParamCallback, callback?: NoParamCallback): void | Promise<boolean> {
    callback = typeof options === 'function' ? options : callback;
    options = typeof options === 'function' ? {} : ((options || {}) as ExtractOptions);

    if (typeof callback === 'function') {
      return FileEntry.prototype.create.call(this, dest, options, (err?: Error) => {
        callback(err);
        if (this.lock) {
          this.lock.release();
          this.lock = null;
        }
      });
    }
    return new Promise((resolve, reject) =>
      this.create(dest, options, (err?: Error, done?: boolean) => {
        err ? reject(err) : resolve(done);
      })
    );
  }

  _writeFile(fullPath: string, _options: ExtractOptions, callback: NoParamCallback): void {
    if (!this.stream) {
      callback(new Error('7z FileEntry missing stream. Check for calling create multiple times'));
      return;
    }

    const stream = this.stream;
    this.stream = null; // Prevent reuse

    // Use once since errors can come from either stream
    const cb = once((err?: Error) => {
      err ? callback(err) : waitForAccess(fullPath, callback);
    });

    try {
      const writeStream = fs.createWriteStream(fullPath);

      // Listen for errors on source stream (errors don't propagate through pipe)
      stream.on('error', (streamErr: Error) => {
        // Destroy the write stream on source error.
        // On Node 0.8, destroy() emits 'close' before 'error'. Since on-one is listening
        // for ['error', 'close', 'finish'], it catches 'close' first, calls our callback,
        // and removes ALL listeners - including the 'error' listener. The subsequent EBADF
        // error then fires with no handler, causing an uncaught exception.
        // Adding a no-op error handler ensures there's always a listener for any error.
        const ws = writeStream as fs.WriteStream & { destroy?: () => void };
        writeStream.on('error', () => {});
        if (typeof ws.destroy === 'function') ws.destroy();
        cb(streamErr);
      });

      // Pipe and listen for write stream completion/errors
      stream.pipe(writeStream);
      oo(writeStream, ['error', 'close', 'finish'], cb);
    } catch (pipeErr) {
      cb(pipeErr);
    }
  }

  destroy() {
    FileEntry.prototype.destroy.call(this);
    if (this.stream) {
      // Use destroy() to prevent decompression (our stream has custom destroy that sets destroyed flag)
      // Fallback to resume() for older Node versions without destroy()
      const s = this.stream as NodeJS.ReadableStream & { destroy?: () => void };
      if (typeof s.destroy === 'function') {
        s.destroy();
      }
      this.stream = null;
    }
    if (this.lock) {
      this.lock.release();
      this.lock = null;
    }
  }
}
