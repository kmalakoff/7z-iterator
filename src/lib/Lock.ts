import BaseIterator from 'extract-base-iterator';
import fs from 'fs';
import { rmSync } from 'fs-remove-compat';

export default class Lock {
  private count = 1;

  // members
  tempPath: string = null;
  fd: number = null;
  iterator: BaseIterator = null;
  err: Error = null;

  // cleanup resources
  sourceStream: NodeJS.ReadableStream = null;

  retain() {
    this.count++;
  }

  release() {
    if (this.count <= 0) throw new Error('Lock count is corrupted');
    this.count--;
    if (this.count === 0) this.__destroy();
  }

  private __destroy() {
    // Destroy source stream FIRST to stop data flow (e.g., during download)
    if (this.sourceStream) {
      const stream = this.sourceStream as NodeJS.ReadableStream & { destroy?: () => void };
      if (typeof stream.destroy === 'function') stream.destroy();
      this.sourceStream = null;
    }

    if (this.tempPath) {
      try {
        rmSync(this.tempPath);
      } catch (_err) {
        /* empty */
      }
      this.tempPath = null;
    }

    if (this.fd) {
      fs.closeSync(this.fd);
      this.fd = null;
    }

    if (this.iterator) {
      BaseIterator.prototype.end.call(this.iterator, this.err || null);
      this.iterator = null;
    }
  }
}
