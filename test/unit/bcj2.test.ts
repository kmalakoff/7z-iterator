/**
 * BCJ2 Archive Integration Tests
 *
 * Tests parsing of 7z archives that use BCJ2 (Branch/Call/Jump x86-64) filter.
 * BCJ2 archives have large varint values in the encoded header that exercise
 * the multi-byte number decoding. This tests the fix for the varint parsing bug.
 *
 * Uses Node.js Windows distribution as a real-world BCJ2 test case.
 * The archive is downloaded and cached in .tmp/fixtures on first run.
 */
import '../lib/polyfills.ts';
import SevenZipIterator from '7z-iterator';
import assert from 'assert';
import { ensureFixture, getFixturePath } from '../lib/download.ts';

// Node.js Windows x64 7z archive - uses LZMA2:26 LZMA:20 BCJ2 codecs
var NODE_7Z_URL = 'https://nodejs.org/dist/v22.12.0/node-v22.12.0-win-x64.7z';
var NODE_7Z_FILENAME = 'node-v22.12.0-win-x64.7z';
var EXPECTED_ENTRY_COUNT = 2721; // Number of entries in the archive

describe('BCJ2 archives (large varints)', function () {
  // Download the fixture before running tests (cached after first download)
  before(ensureFixture(NODE_7Z_URL, NODE_7Z_FILENAME));

  describe('Node.js Windows 7z', function () {
    it('should iterate BCJ2 archive entries', function (done) {
      var filepath = getFixturePath(NODE_7Z_FILENAME);
      var iterator = new SevenZipIterator(filepath);
      var entries: string[] = [];

      iterator.forEach(
        function (entry): undefined {
          entries.push(entry.path);
        },
        function (err) {
          if (err) {
            done(err);
            return;
          }
          // Should have parsed all entries
          assert.ok(entries.length > 2000, 'Should have at least 2000 entries, got ' + entries.length);

          // First entry should be the root directory
          assert.ok(entries[0].indexOf('node-v22') >= 0, 'First entry should contain node version');

          // Should have node.exe somewhere in the list
          var hasNodeExe = entries.some(function (e) {
            return e.indexOf('node.exe') >= 0;
          });
          assert.ok(hasNodeExe, 'Should contain node.exe');

          done();
        }
      );
    });

    it('should correctly parse large varint values in encoded header', function (done) {
      // This test specifically validates that the encoded header's packPos
      // (which is a large multi-byte varint) is correctly decoded.
      // The bug was that varints were decoded with wrong byte order.
      var filepath = getFixturePath(NODE_7Z_FILENAME);
      var iterator = new SevenZipIterator(filepath);
      var entryCount = 0;

      iterator.forEach(
        function (): undefined {
          entryCount++;
        },
        function (err) {
          if (err) {
            // If varint parsing is wrong, we'd get:
            // - "LZMA decompression failed" (wrong data position)
            // - "CRC mismatch" (decompressed from wrong position)
            done(new Error('BCJ2 archive parsing failed (likely varint bug): ' + err.message));
            return;
          }

          // Successful parsing means varints were decoded correctly
          assert.ok(entryCount > 0, 'Should have parsed entries');
          done();
        }
      );
    });
  });
});
