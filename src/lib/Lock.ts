import BaseIterator from 'extract-base-iterator';
import fs from 'fs';
import rimraf2 from 'rimraf2';

export default class Lock {
  private count = 1;

  // members
  tempPath: string = null;
  fd: number = null;
  iterator: BaseIterator = null;
  err: Error = null;

  retain() {
    this.count++;
  }

  release() {
    if (this.count <= 0) throw new Error('Lock count is corrupted');
    this.count--;
    if (this.count === 0) this.__destroy();
  }

  private __destroy() {
    if (this.tempPath) {
      try {
        rimraf2.sync(this.tempPath, { disableGlob: true });
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
