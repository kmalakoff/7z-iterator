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
import SevenZipIterator from '7z-iterator';
import assert from 'assert';
import { allocBuffer } from 'extract-base-iterator';
import fs from 'fs';
import mkdirp from 'mkdirp-classic';
import path from 'path';
import rimraf2 from 'rimraf2';
import { stringEndsWith } from '../lib/compat.ts';
import { ensureFixture, getFixturePath } from '../lib/download.ts';

// Node.js Windows x64 7z archive - uses LZMA2:26 LZMA:20 BCJ2 codecs
var NODE_7Z_URL = 'https://nodejs.org/dist/v22.12.0/node-v22.12.0-win-x64.7z';
var NODE_7Z_FILENAME = 'node-v22.12.0-win-x64.7z';
var _EXPECTED_ENTRY_COUNT = 2721; // Number of entries in the archive

describe('BCJ2 archives (large varints)', () => {
  // Download the fixture before running tests (cached after first download)
  before(ensureFixture(NODE_7Z_URL, NODE_7Z_FILENAME));

  describe('Node.js Windows 7z', () => {
    it('should iterate BCJ2 archive entries', (done) => {
      var filepath = getFixturePath(NODE_7Z_FILENAME);
      var iterator = new SevenZipIterator(filepath);
      var entries: string[] = [];

      iterator.forEach(
        (entry): undefined => {
          entries.push(entry.path);
        },
        (err) => {
          if (err) {
            done(err);
            return;
          }
          // Should have parsed all entries
          assert.ok(entries.length > 2000, `Should have at least 2000 entries, got ${entries.length}`);

          // First entry should be the root directory
          assert.ok(entries[0].indexOf('node-v22') >= 0, 'First entry should contain node version');

          // Should have node.exe somewhere in the list
          var hasNodeExe = entries.some((e) => e.indexOf('node.exe') >= 0);
          assert.ok(hasNodeExe, 'Should contain node.exe');

          done();
        }
      );
    });

    it('should correctly parse large varint values in encoded header', (done) => {
      // This test specifically validates that the encoded header's packPos
      // (which is a large multi-byte varint) is correctly decoded.
      // The bug was that varints were decoded with wrong byte order.
      var filepath = getFixturePath(NODE_7Z_FILENAME);
      var iterator = new SevenZipIterator(filepath);
      var entryCount = 0;

      iterator.forEach(
        (): undefined => {
          entryCount++;
        },
        (err) => {
          if (err) {
            // If varint parsing is wrong, we'd get:
            // - "LZMA decompression failed" (wrong data position)
            // - "CRC mismatch" (decompressed from wrong position)
            done(new Error(`BCJ2 archive parsing failed (likely varint bug): ${err.message}`));
            return;
          }

          // Successful parsing means varints were decoded correctly
          assert.ok(entryCount > 0, 'Should have parsed entries');
          done();
        }
      );
    });

    it('should extract file content from BCJ2 archive', function (done) {
      // Extracting 80MB file takes a while on older Node versions
      this.timeout(120000);
      // This test validates that BCJ2-compressed file content can be extracted.
      // BCJ2 splits data into 4 streams (main + 3 call/jump streams) and requires
      // special decoding before LZMA decompression.
      // Note: Only node.exe uses BCJ2 compression in this archive
      var filepath = getFixturePath(NODE_7Z_FILENAME);
      var iterator = new SevenZipIterator(filepath);
      var targetDir = path.join(path.dirname(filepath), 'bcj2-extract-test');

      // Clean up before test
      rimraf2(targetDir, { disableGlob: true }, () => {
        mkdirp(targetDir, (err) => {
          if (err) return done(err);

          // Find and extract node.exe (it's the BCJ2-compressed file)
          var extracted = false;
          iterator.forEach(
            (entry, callback): undefined => {
              // Look for node.exe - this is the only BCJ2-compressed file
              if (stringEndsWith(entry.path, 'node.exe')) {
                extracted = true;
                entry.create(targetDir, { strip: 1 }, callback);
              } else {
                callback();
              }
            },
            { callbacks: true, concurrency: 1 },
            (err) => {
              if (err) {
                // Clean up and report error
                rimraf2(targetDir, { disableGlob: true }, () => {
                  done(new Error(`BCJ2 file extraction failed: ${err.message}`));
                });
                return;
              }

              if (!extracted) {
                rimraf2(targetDir, { disableGlob: true }, () => {
                  done(new Error('node.exe file not found in archive'));
                });
                return;
              }

              // Verify the extracted file exists and has expected size
              var exePath = path.join(targetDir, 'node.exe');
              fs.stat(exePath, (err, stats) => {
                if (err) {
                  rimraf2(targetDir, { disableGlob: true }, () => {
                    done(new Error(`Extracted node.exe file not found: ${err.message}`));
                  });
                  return;
                }

                // node.exe should be around 80MB
                try {
                  assert.ok(stats.size > 80000000, `node.exe should be large, got ${stats.size} bytes`);

                  // Read first few bytes and verify it's a PE executable (MZ header)
                  var fd = fs.openSync(exePath, 'r');
                  var buf = allocBuffer(2);
                  fs.readSync(fd, buf, 0, 2, 0);
                  fs.closeSync(fd);

                  assert.equal(buf[0], 0x4d, 'First byte should be M');
                  assert.equal(buf[1], 0x5a, 'Second byte should be Z');

                  // Clean up after successful verification
                  rimraf2(targetDir, { disableGlob: true }, () => {
                    done();
                  });
                } catch (e) {
                  rimraf2(targetDir, { disableGlob: true }, () => {
                    done(e);
                  });
                }
              });
            }
          );
        });
      });
    });
  });
});
