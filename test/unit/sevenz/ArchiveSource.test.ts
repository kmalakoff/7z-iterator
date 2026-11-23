import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { BufferSource, SevenZipParser } from '../../../src/sevenz/index.ts';
import { bufferFrom } from '../../lib/compat.ts';
import { DATA_DIR } from '../../lib/constants.ts';

describe('ArchiveSource', () => {
  describe('BufferSource', () => {
    it('should clamp reads past EOF without throwing', () => {
      const source = new BufferSource(bufferFrom([1, 2, 3, 4, 5]));
      const partial = source.read(3, 100);
      const partialBuf = Buffer.isBuffer(partial) ? partial : partial.toBuffer();
      assert.strictEqual(partialBuf.length, 2);
      assert.strictEqual(partialBuf[0], 4);
      assert.strictEqual(partialBuf[1], 5);

      const pastEnd = source.read(10, 5);
      assert.strictEqual(pastEnd.length, 0);
    });

    it('should parse lzma2.7z with compressed header via BufferSource', (done) => {
      const buf = fs.readFileSync(path.join(DATA_DIR, 'lzma2.7z'));
      const parser = new SevenZipParser(new BufferSource(buf));
      parser.parse((err) => {
        if (err) {
          parser.close();
          done(err);
          return;
        }
        const entries = parser.getEntries();
        parser.close();
        assert.ok(entries.length > 0, 'Should yield entries');
        done();
      });
    });
  });
});
