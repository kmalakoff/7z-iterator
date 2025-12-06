import SevenZipIterator from '7z-iterator';
import assert from 'assert';
import fs from 'fs';
import { safeRm } from 'fs-remove-compat';
import mkdirp from 'mkdirp-classic';
import path from 'path';
import { DATA_DIR, TARGET } from '../lib/constants.ts';
import validateFiles from '../lib/validateFiles.ts';

function extract(iterator, dest, options, callback) {
  iterator.forEach(
    (entry, callback) => {
      entry.create(dest, options, callback);
    },
    { callbacks: true, concurrency: options.concurrency },
    callback
  );
}

describe('callback', () => {
  beforeEach((callback) => {
    // Clean only the target directory, not the entire .tmp (preserve downloaded fixtures cache)
    safeRm(TARGET, () => {
      mkdirp(TARGET, callback);
    });
  });

  afterEach((callback) => {
    safeRm(TARGET, callback);
  });

  describe('happy path', () => {
    it('destroy iterator', () => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'copy.7z'));
      iterator.destroy();
      assert.ok(true);
    });

    it('destroy entries', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'copy.7z'));
      iterator.forEach(
        (entry): undefined => {
          entry.destroy();
        },
        (err) => {
          if (err) {
            done(err);
            return;
          }
          done();
        }
      );
    });

    it('extract - no strip - concurrency 1', (done) => {
      const options = { now: new Date(), concurrency: 1 };
      extract(new SevenZipIterator(path.join(DATA_DIR, 'copy.7z')), TARGET, options, (err) => {
        if (err) {
          done(err);
          return;
        }

        validateFiles(options, (err) => {
          if (err) {
            done(err);
            return;
          }
          done();
        });
      });
    });

    it('extract - no strip - concurrency Infinity', (done) => {
      const options = { now: new Date(), concurrency: Infinity };
      extract(new SevenZipIterator(path.join(DATA_DIR, 'copy.7z')), TARGET, options, (err) => {
        if (err) {
          done(err);
          return;
        }

        validateFiles(options, (err) => {
          if (err) {
            done(err);
            return;
          }
          done();
        });
      });
    });

    it('extract - stream', (done) => {
      const options = { now: new Date() };
      const source = fs.createReadStream(path.join(DATA_DIR, 'copy.7z'));
      extract(new SevenZipIterator(source), TARGET, options, (err) => {
        if (err) {
          done(err);
          return;
        }

        validateFiles(options, (err) => {
          if (err) {
            done(err);
            return;
          }
          done();
        });
      });
    });

    it('extract - strip 1', (done) => {
      const options = { now: new Date(), strip: 1 };
      extract(new SevenZipIterator(path.join(DATA_DIR, 'copy.7z')), TARGET, options, (err) => {
        if (err) {
          done(err);
          return;
        }

        validateFiles(options, (err) => {
          if (err) {
            done(err);
            return;
          }
          done();
        });
      });
    });

    it('extract multiple times', (done) => {
      const options = { now: new Date(), strip: 1 };
      extract(new SevenZipIterator(path.join(DATA_DIR, 'copy.7z')), TARGET, options, (err) => {
        if (err) {
          done(err);
          return;
        }

        validateFiles(options, (err) => {
          if (err) {
            done(err);
            return;
          }

          extract(new SevenZipIterator(path.join(DATA_DIR, 'copy.7z')), TARGET, options, (err) => {
            assert.ok(err);

            extract(new SevenZipIterator(path.join(DATA_DIR, 'copy.7z')), TARGET, { force: true, ...options }, (err) => {
              if (err) {
                done(err);
                return;
              }

              validateFiles(options, (err) => {
                if (err) {
                  done(err);
                  return;
                }
                done();
              });
            });
          });
        });
      });
    });
  });

  describe('unhappy path', () => {
    it('should fail with bad path', (done) => {
      const options = { now: new Date(), strip: 2 };
      extract(new SevenZipIterator(path.join(DATA_DIR, 'copy.7z' + 'does-not-exist')), TARGET, options, (err) => {
        assert.ok(!!err);
        done();
      });
    });

    it('should fail with bad stream', (done) => {
      const options = { now: new Date(), strip: 2 };
      extract(new SevenZipIterator(fs.createReadStream(path.join(DATA_DIR, 'copy.7z' + 'does-not-exist'))), TARGET, options, (err) => {
        assert.ok(!!err);
        done();
      });
    });

    it('should fail with too large strip', (done) => {
      const options = { now: new Date(), strip: 2 };
      extract(new SevenZipIterator(path.join(DATA_DIR, 'copy.7z')), TARGET, options, (err) => {
        assert.ok(!!err);
        done();
      });
    });
  });
});
