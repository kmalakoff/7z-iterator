import SevenZipIterator from '7z-iterator';
import assert from 'assert';
import fs from 'fs';
import { safeRm } from 'fs-remove-compat';
import mkdirp from 'mkdirp-classic';
import path from 'path';
import Pinkie from 'pinkie-promise';
import { DATA_DIR, TARGET } from '../lib/constants.ts';
import validateFiles from '../lib/validateFiles.ts';

function extract(iterator, dest, options, callback) {
  iterator
    // biome-ignore lint/suspicious/useIterableCallbackReturn: Returns promise for async handling
    .forEach(
      (entry) => {
        return entry.create(dest, options);
      },
      { concurrency: options.concurrency }
    )
    .then(() => {
      callback();
    })
    .catch(callback);
}

describe('promise', () => {
  (() => {
    // patch and restore promise
    if (typeof global === 'undefined') return;
    const globalPromise = global.Promise;
    before(() => {
      global.Promise = Pinkie;
    });
    after(() => {
      global.Promise = globalPromise;
    });
  })();

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
