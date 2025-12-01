import '../lib/polyfills.ts';

import SevenZipIterator from '7z-iterator';
import assert from 'assert';
import mkdirp from 'mkdirp-classic';
import path from 'path';
import Pinkie from 'pinkie-promise';
import rimraf2 from 'rimraf2';
import { DATA_DIR, TARGET } from '../lib/constants.ts';
import validateFiles from '../lib/validateFiles.ts';

async function extract(iterator, dest, options) {
  let value = await iterator.next();
  while (!value.done) {
    const entry = value.value;
    await entry.create(dest, options);
    value = await iterator.next();
  }
}

async function extractForEach(iterator, dest, options) {
  await iterator.forEach(
    async (entry) => {
      await entry.create(dest, options);
    },
    { concurrency: options.concurrency }
  );
}

describe('asyncAwait', () => {
  if (typeof Symbol === 'undefined' || !Symbol.asyncIterator) return;
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
    rimraf2(TARGET, { disableGlob: true }, () => {
      mkdirp(TARGET, callback);
    });
  });

  afterEach((callback) => {
    rimraf2(TARGET, { disableGlob: true }, callback);
  });

  describe('happy path', () => {
    it('extract - no strip - concurrency 1', async () => {
      const options = { now: new Date(), concurrency: 1 };
      await extract(new SevenZipIterator(path.join(DATA_DIR, 'copy.7z')), TARGET, options);
      await validateFiles(options);
    });

    it('extract - no strip - concurrency Infinity', async () => {
      const options = { now: new Date(), concurrency: Infinity };
      await extract(new SevenZipIterator(path.join(DATA_DIR, 'copy.7z')), TARGET, options);
      await validateFiles(options);
    });

    it('extract - no strip - forEach', async () => {
      const options = { now: new Date(), concurrency: Infinity };
      await extractForEach(new SevenZipIterator(path.join(DATA_DIR, 'copy.7z')), TARGET, options);
      await validateFiles(options);
    });

    it('extract - strip 1', async () => {
      const options = { now: new Date(), strip: 1 };
      await extract(new SevenZipIterator(path.join(DATA_DIR, 'copy.7z')), TARGET, options);
      await validateFiles(options);
    });

    it('extract multiple times', async () => {
      const options = { now: new Date(), strip: 1 };
      await extract(new SevenZipIterator(path.join(DATA_DIR, 'copy.7z')), TARGET, options);
      await validateFiles(options);
      try {
        await extract(new SevenZipIterator(path.join(DATA_DIR, 'copy.7z')), TARGET, options);
        assert.ok(false);
      } catch (err) {
        assert.ok(err);
      }
      await extract(new SevenZipIterator(path.join(DATA_DIR, 'copy.7z')), TARGET, { force: true, ...options });
      await validateFiles(options);
    });
  });

  describe('unhappy path', () => {
    it('should fail with too large strip', async () => {
      const options = { now: new Date(), strip: 2 };
      try {
        await extract(new SevenZipIterator(path.join(DATA_DIR, 'copy.7z')), TARGET, options);
        assert.ok(false);
      } catch (err) {
        assert.ok(!!err);
      }
    });
  });
});
