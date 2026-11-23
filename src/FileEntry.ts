/**
 * FileEntry for 7z archives
 *
 * Wraps a lazy stream - decompression happens when the stream is read.
 * API consistent with zip-iterator and tar-iterator.
 */

import type { CallFn } from 'call-once-fn';
import once from 'call-once-fn';
import { destroyStream, type FileAttributes, FileEntry, type Lock, type NoParamCallback, waitForAccess } from 'extract-base-iterator';
import fs from 'graceful-fs';
import oo from 'on-one';
import type { ExtractOptions } from './types.ts';

export default class SevenZipFileEntry extends FileEntry {
  private lock: Lock | null;
  private stream: NodeJS.ReadableStream | null;

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
      const cb: NoParamCallback = (err?: Error | null) => {
        (callback as NoParamCallback)(err);
        if (this.lock) {
          this.lock.release();
          this.lock = null;
        }
      };
      super.create(dest, options as ExtractOptions, cb);
      return;
    }
    return new Promise((resolve, reject) => this.create(dest, options as ExtractOptions, (err?: Error | null) => (err ? reject(err) : resolve(true))));
  }

  _writeFile(fullPath: string, _options: ExtractOptions, callback: NoParamCallback): void {
    if (!this.stream) {
      callback(new Error('7z FileEntry missing stream. Check for calling create multiple times'));
      return;
    }

    const stream = this.stream;
    this.stream = null; // Prevent reuse

    const cb = once(((err?: Error | null) => {
      err ? callback(err) : waitForAccess(fullPath, callback);
    }) as unknown as CallFn) as unknown as (err?: Error | null) => void;

    try {
      const writeStream = fs.createWriteStream(fullPath);
      let sourceError: Error | null = null;
      let writeStreamOpened = false;
      let writeStreamClosed = false;

      writeStream.once('open', () => {
        writeStreamOpened = true;
      });
      writeStream.once('close', () => {
        writeStreamClosed = true;
      });

      // Listen for errors on source stream (errors don't propagate through pipe)
      stream.on('error', (streamErr: Error) => {
        sourceError = streamErr;
        // Suppress late EBADF on Node 0.8 after destroying an active WriteStream
        writeStream.on('error', () => {});
        if (writeStreamClosed) {
          cb(streamErr);
        } else {
          writeStream.once('close', () => cb(streamErr));
          destroyStream(writeStream);
          // Node 0.10-0.12 can leave a pending open unclosed after destroy().
          const ws = writeStream as fs.WriteStream & { close?: () => void; closed?: boolean; fd?: number | null };
          if (!writeStreamOpened && !writeStreamClosed && typeof ws.close === 'function') {
            writeStream.once('open', () => {
              if (!writeStreamClosed && !ws.closed && ws.fd !== null && typeof ws.close === 'function') ws.close();
            });
          }
        }
      });

      // Pipe and listen for write stream completion/errors
      stream.pipe(writeStream);
      oo(writeStream, ['error', 'close', 'finish'], (err?: Error | null) => {
        if (!sourceError) cb(err);
      });
    } catch (pipeErr) {
      cb(pipeErr as Error);
    }
  }

  destroy() {
    super.destroy();
    if (this.stream) {
      destroyStream(this.stream);
      this.stream = null;
    }
    if (this.lock) {
      this.lock.release();
      this.lock = null;
    }
  }
}
