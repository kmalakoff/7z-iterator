import SevenZipIterator from '7z-iterator';
import assert from 'assert';
import fs from 'fs';
import { safeRm } from 'fs-remove-compat';
import mkdirp from 'mkdirp-classic';
import path from 'path';
import { arrayFind, stringEndsWith } from '../lib/compat.ts';
import { DATA_DIR, TARGET } from '../lib/constants.ts';

describe('fixtures', () => {
  beforeEach((callback) => {
    // Clean only the target directory, not the entire .tmp (preserve downloaded fixtures cache)
    safeRm(TARGET, () => {
      mkdirp(TARGET, callback);
    });
  });

  afterEach((callback) => {
    safeRm(TARGET, callback);
  });

  describe('empty.7z', () => {
    it('should iterate empty archive', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'empty.7z'));
      const entries = [];
      iterator.forEach(
        (entry): undefined => {
          entries.push(entry);
        },
        (err) => {
          if (err) {
            done(err);
            return;
          }
          // Empty archive has 1 empty directory
          assert.equal(entries.length, 1);
          assert.equal(entries[0].type, 'directory');
          done();
        }
      );
    });

    it('should extract empty archive', (done) => {
      const options = { now: new Date() };
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'empty.7z'));
      iterator.forEach(
        (entry, callback) => {
          entry.create(TARGET, options, callback);
        },
        { callbacks: true },
        (err) => {
          if (err) {
            done(err);
            return;
          }
          done();
        }
      );
    });
  });

  describe('unicode.7z', () => {
    it('should iterate unicode filenames', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'unicode.7z'));
      const entries = [];
      iterator.forEach(
        (entry): undefined => {
          entries.push({ path: entry.path, type: entry.type });
        },
        (err) => {
          if (err) {
            done(err);
            return;
          }
          // Should have dirs and files with unicode names
          assert.ok(entries.length >= 3, 'Should have at least 3 entries');

          // Check for unicode characters in paths
          const paths = entries.map((e) => e.path).join('|');
          assert.ok(paths.indexOf('日本語') >= 0 || paths.indexOf('中文') >= 0, 'Should contain unicode directory names');
          done();
        }
      );
    });

    it('should extract unicode filenames', (done) => {
      const options = { now: new Date() };
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'unicode.7z'));
      iterator.forEach(
        (entry, callback) => {
          entry.create(TARGET, options, callback);
        },
        { callbacks: true },
        (err) => {
          if (err) {
            done(err);
            return;
          }
          done();
        }
      );
    });
  });

  describe('corrupted-crc.7z', () => {
    it('should detect CRC error during extraction', (done) => {
      const options = { now: new Date() };
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'corrupted-crc.7z'));
      let errorOccurred = false;

      iterator.forEach(
        (entry, callback) => {
          entry.create(TARGET, options, (err) => {
            if (err) {
              errorOccurred = true;
              // CRC error is expected - continue to see if we catch it
            }
            callback(err);
          });
        },
        { callbacks: true },
        (err) => {
          // Should have an error due to CRC mismatch
          assert.ok(err || errorOccurred, 'Should detect CRC corruption');
          done();
        }
      );
    });
  });

  describe('truncated.7z', () => {
    it('should fail on truncated archive', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'truncated.7z'));
      iterator.forEach(
        (_entry): undefined => {
          // Should not get here
          assert.ok(false, 'Should not iterate truncated archive');
        },
        (err) => {
          // Should have an error due to truncation
          assert.ok(err, 'Should fail on truncated archive');
          done();
        }
      );
    });
  });

  describe('truncated-signature.7z', () => {
    it('should fail on truncated signature header', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'truncated-signature.7z'));
      iterator.forEach(
        (_entry): undefined => {
          // Should not get here
          assert.ok(false, 'Should not iterate archive with truncated signature');
        },
        (err) => {
          // Should fail because signature header is incomplete (< 32 bytes)
          assert.ok(err, 'Should fail on truncated signature');
          assert.ok(err.message.indexOf('small') >= 0 || err.message.indexOf('truncated') >= 0 || err.message.indexOf('TRUNCATED') >= 0, `Error should indicate truncation: ${err.message}`);
          done();
        }
      );
    });
  });

  describe('truncated-header.7z', () => {
    it('should fail on truncated encoded header', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'truncated-header.7z'));
      iterator.forEach(
        (_entry): undefined => {
          // Should not get here
          assert.ok(false, 'Should not iterate archive with truncated header');
        },
        (err) => {
          // Should fail because encoded header is missing/truncated
          assert.ok(err, 'Should fail on truncated encoded header');
          done();
        }
      );
    });
  });

  describe('lzma2.7z (Phase 2 - LZMA2 codec)', () => {
    it('should iterate LZMA2 archive entries', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'lzma2.7z'));
      const entries: { path: string; type: string }[] = [];
      iterator.forEach(
        (entry): undefined => {
          entries.push({ path: entry.path, type: entry.type });
        },
        (err): undefined => {
          if (err) {
            done(err);
            return;
          }
          // Verify structure
          assert.ok(entries.length >= 4, 'Should have entries');
          done();
        }
      );
    });

    it('should extract LZMA2 archive', (done) => {
      const options = { now: new Date() };
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'lzma2.7z'));
      iterator.forEach(
        (entry, callback) => {
          entry.create(TARGET, options, callback);
        },
        { callbacks: true },
        (err): undefined => {
          if (err) {
            done(err);
            return;
          }
          done();
        }
      );
    });

    it('should extract solid archive with correct file contents (Phase 3)', (done) => {
      // lzma2.7z is a solid archive - multiple files share one compressed block
      // Each file should have unique content
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'lzma2.7z'));
      const filePaths: string[] = [];

      iterator.forEach(
        (entry, callback) => {
          if (entry.type === 'file') {
            filePaths.push(entry.path);
          }
          entry.create(TARGET, {}, callback);
        },
        { callbacks: true, concurrency: 1 },
        (err): undefined => {
          if (err) {
            done(err);
            return;
          }

          // Read extracted file contents
          const fileContents: string[] = [];
          for (let i = 0; i < filePaths.length; i++) {
            const content = fs.readFileSync(path.join(TARGET, filePaths[i]), 'utf8').trim();
            fileContents.push(content);
          }

          // Verify we have 4 files
          assert.equal(fileContents.length, 4, 'Should have 4 files');

          // Check that all files have different content (solid archive test)
          // Use object as set for Node 0.8 compatibility
          const seen: { [key: string]: boolean } = {};
          let uniqueCount = 0;
          for (let j = 0; j < fileContents.length; j++) {
            if (!seen[fileContents[j]]) {
              seen[fileContents[j]] = true;
              uniqueCount++;
            }
          }
          assert.equal(uniqueCount, 4, 'Each file should have unique content (solid archive)');

          // Verify expected content format
          for (let k = 0; k < fileContents.length; k++) {
            assert.ok(fileContents[k].indexOf('// Test fixture file') === 0, `File should contain test fixture: ${fileContents[k]}`);
          }

          done();
        }
      );
    });
  });

  describe('lzma1.7z (Phase 4 - LZMA1 codec)', () => {
    it('should iterate LZMA1 archive entries', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'lzma1.7z'));
      const entries: { path: string; type: string }[] = [];
      iterator.forEach(
        (entry): undefined => {
          entries.push({ path: entry.path, type: entry.type });
        },
        (err): undefined => {
          if (err) {
            done(err);
            return;
          }
          assert.equal(entries.length, 2, 'Should have 2 files');
          done();
        }
      );
    });

    it('should extract LZMA1 archive with correct content', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'lzma1.7z'));
      const filePaths: string[] = [];

      iterator.forEach(
        (entry, callback) => {
          if (entry.type === 'file') {
            filePaths.push(entry.path);
          }
          entry.create(TARGET, {}, callback);
        },
        { callbacks: true },
        (err): undefined => {
          if (err) {
            done(err);
            return;
          }

          // Verify file contents
          for (let i = 0; i < filePaths.length; i++) {
            const content = fs.readFileSync(path.join(TARGET, filePaths[i]), 'utf8').trim();
            assert.ok(content.indexOf('// LZMA1 fixture file') === 0, `File should contain LZMA1 fixture: ${content}`);
          }

          done();
        }
      );
    });
  });

  describe('bcj.7z (Phase 4 - BCJ x86 filter)', () => {
    it('should extract BCJ+LZMA2 archive', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'bcj.7z'));
      let extractedPath = '';

      iterator.forEach(
        (entry, callback) => {
          if (entry.type === 'file') {
            extractedPath = entry.path;
          }
          entry.create(TARGET, {}, callback);
        },
        { callbacks: true },
        (err): undefined => {
          if (err) {
            done(err);
            return;
          }

          // Verify extracted content
          const content = fs.readFileSync(path.join(TARGET, extractedPath), 'utf8');
          assert.ok(content.indexOf('#!/bin/bash') === 0, 'Should extract shell script');
          assert.ok(content.indexOf('Test executable') > 0, 'Should contain test string');

          done();
        }
      );
    });
  });

  describe('delta.7z (Phase 4 - Delta filter)', () => {
    it('should extract Delta+LZMA2 archive', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'delta.7z'));
      let extractedPath = '';

      iterator.forEach(
        (entry, callback) => {
          if (entry.type === 'file') {
            extractedPath = entry.path;
          }
          entry.create(TARGET, {}, callback);
        },
        { callbacks: true },
        (err): undefined => {
          if (err) {
            done(err);
            return;
          }

          // Verify extracted content - delta.7z contains test.dat
          const content = fs.readFileSync(path.join(TARGET, extractedPath));
          assert.equal(content.length, 16, 'Should have 16 bytes');
          // Verify known content: AAABBBCCC followed by bytes 0x01-0x06 and 0x0a
          const expected = 'AAABBBCCC';
          assert.equal(content.slice(0, 9).toString(), expected, 'Should start with AAABBBCCC');

          done();
        }
      );
    });
  });

  describe('deflate.7z (Deflate codec)', () => {
    it('should extract Deflate compressed archive', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'deflate.7z'));
      let extractedPath = '';

      iterator.forEach(
        (entry, callback) => {
          if (entry.type === 'file') {
            extractedPath = entry.path;
          }
          entry.create(TARGET, {}, callback);
        },
        { callbacks: true },
        (err): undefined => {
          if (err) {
            done(err);
            return;
          }

          // Verify extracted content
          const content = fs.readFileSync(path.join(TARGET, extractedPath), 'utf8').trim();
          assert.equal(content, 'Test file with Deflate compression', 'Should extract Deflate content');

          done();
        }
      );
    });
  });

  describe('bzip2.7z (BZip2 codec)', () => {
    it('should extract BZip2 compressed archive', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'bzip2.7z'));
      let extractedPath = '';

      iterator.forEach(
        (entry, callback) => {
          if (entry.type === 'file') {
            extractedPath = entry.path;
          }
          entry.create(TARGET, {}, callback);
        },
        { callbacks: true },
        (err): undefined => {
          if (err) {
            done(err);
            return;
          }

          // Verify extracted content
          const content = fs.readFileSync(path.join(TARGET, extractedPath), 'utf8').trim();
          assert.equal(content, 'Test file with BZip2 compression', 'Should extract BZip2 content');

          done();
        }
      );
    });
  });

  describe('longpath.7z (paths > 260 chars)', () => {
    // Windows MAX_PATH is 260 chars. This tests that long paths are handled correctly.
    it('should iterate archive with long paths (> 260 chars)', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'longpath.7z'));
      const entries: { path: string; type: string }[] = [];

      iterator.forEach(
        (entry): undefined => {
          entries.push({ path: entry.path, type: entry.type });
        },
        (err) => {
          if (err) {
            done(err);
            return;
          }

          // Should have 7 entries (6 directories + 1 file)
          assert.equal(entries.length, 7, 'Should have 7 entries');

          // Find the deepest file
          const fileEntry = arrayFind(entries, (e) => e.type === 'file');
          assert.ok(fileEntry, 'Should have a file entry');
          assert.ok(fileEntry.path.length > 260, `Path should be > 260 chars, got ${fileEntry.path.length}`);
          assert.ok(stringEndsWith(fileEntry.path, 'test.txt'), 'Should end with test.txt');

          done();
        }
      );
    });

    it('should extract archive with long paths', (done) => {
      const options = { now: new Date() };
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'longpath.7z'));
      let deepFilePath = '';

      iterator.forEach(
        (entry, callback) => {
          if (entry.type === 'file') {
            deepFilePath = entry.path;
          }
          entry.create(TARGET, options, callback);
        },
        { callbacks: true },
        (err) => {
          if (err) {
            done(err);
            return;
          }

          // Verify the deep file was extracted correctly
          const extractedPath = path.join(TARGET, deepFilePath);
          assert.ok(fs.existsSync(extractedPath), 'Deep file should exist');
          const content = fs.readFileSync(extractedPath, 'utf8');
          assert.equal(content.trim(), 'deep content', 'Content should match');

          done();
        }
      );
    });
  });

  describe('symlink.7z (Unix symlinks)', () => {
    // Uses fast-extract fixture which has proper symlink mode bits (S_IFLNK = 0xA000)
    it('should detect symlinks with correct linkpath', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'symlink.7z'));
      const symlinks: { path: string; type: string; linkpath?: string }[] = [];

      iterator.forEach(
        (entry): undefined => {
          if (entry.type === 'symlink') {
            const linkpath = (entry as { linkpath?: string }).linkpath;
            symlinks.push({ path: entry.path, type: entry.type, linkpath: linkpath });
          }
        },
        (err) => {
          if (err) {
            done(err);
            return;
          }

          // Should have 5 symlinks
          assert.equal(symlinks.length, 5, 'Should have 5 symlinks');

          // Check one symlink has correct linkpath
          const symlink1 = arrayFind(symlinks, (e) => e.path === 'data/symlink1');
          assert.ok(symlink1, 'Should have data/symlink1');
          assert.equal(symlink1.type, 'symlink', 'Should be detected as symlink');
          assert.equal(symlink1.linkpath, 'fixture.js', 'Should have correct linkpath');

          // Check relative symlink
          const nestedSymlink = arrayFind(symlinks, (e) => e.path === 'data/dir1/dir2/symlink1');
          assert.ok(nestedSymlink, 'Should have nested symlink');
          assert.equal(nestedSymlink.linkpath, '../fixture.js', 'Should have relative linkpath');

          done();
        }
      );
    });

    it('should extract symlinks as actual symlinks', (done) => {
      const options = { now: new Date() };
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'symlink.7z'));
      const symlinks: string[] = [];
      const files: string[] = [];
      const dirs: string[] = [];

      // Collect entries first, then create in order: dirs, files, symlinks
      // This ensures symlink targets exist before symlinks are created
      iterator.forEach(
        (entry): undefined => {
          if (entry.type === 'symlink') {
            symlinks.push(entry.path);
          } else if (entry.type === 'file') {
            files.push(entry.path);
          } else if (entry.type === 'directory') {
            dirs.push(entry.path);
          }
        },
        (err) => {
          if (err) {
            done(err);
            return;
          }

          // Create directories first, then files, then symlinks
          const iterator2 = new SevenZipIterator(path.join(DATA_DIR, 'symlink.7z'));
          iterator2.forEach(
            (entry, callback) => {
              // Skip symlinks on first pass
              if (entry.type === 'symlink') {
                callback();
                return;
              }
              entry.create(TARGET, options, callback);
            },
            { callbacks: true },
            (err2) => {
              if (err2) {
                done(err2);
                return;
              }

              // Now create symlinks (targets exist)
              const iterator3 = new SevenZipIterator(path.join(DATA_DIR, 'symlink.7z'));
              iterator3.forEach(
                (entry, callback) => {
                  if (entry.type !== 'symlink') {
                    callback();
                    return;
                  }
                  entry.create(TARGET, options, callback);
                },
                { callbacks: true },
                (err3): undefined => {
                  if (err3) {
                    done(err3);
                    return;
                  }

                  // Verify symlinks were created
                  for (let i = 0; i < symlinks.length; i++) {
                    const symlinkPath = path.join(TARGET, symlinks[i]);
                    const stats = fs.lstatSync(symlinkPath);
                    assert.ok(stats.isSymbolicLink(), `${symlinks[i]} should be a symlink`);
                  }

                  done();
                }
              );
            }
          );
        }
      );
    });
  });

  describe('encrypted.7z (AES-256 encryption)', () => {
    it('should extract encrypted archive with correct password', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'encrypted.7z'), { password: 'test123' });
      let extractedPath = '';

      iterator.forEach(
        (entry, callback) => {
          if (entry.type === 'file') {
            extractedPath = entry.path;
          }
          entry.create(TARGET, {}, callback);
        },
        { callbacks: true },
        (err): undefined => {
          if (err) {
            done(err);
            return;
          }

          // Verify extracted content
          const content = fs.readFileSync(path.join(TARGET, extractedPath), 'utf8').trim();
          assert.equal(content, 'secret content', 'Should extract encrypted content');

          done();
        }
      );
    });

    it('should fail with wrong password', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'encrypted.7z'), { password: 'wrong' });

      iterator.forEach(
        (entry, callback) => {
          entry.create(TARGET, {}, callback);
        },
        { callbacks: true },
        (err): undefined => {
          // Should fail with wrong password - either error or corrupted data
          assert.ok(err, 'Should fail with wrong password');
          done();
        }
      );
    });

    it('should fail without password', (done) => {
      // No password provided - should clear any previously set password
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'encrypted.7z'));

      iterator.forEach(
        (entry, callback) => {
          entry.create(TARGET, {}, callback);
        },
        { callbacks: true },
        (err): undefined => {
          // Should fail without password
          assert.ok(err, 'Should fail without password');
          assert.ok(err.message.indexOf('password') >= 0, 'Error should mention password');
          done();
        }
      );
    });
  });

  describe('arm.7z (ARM BCJ filter)', () => {
    it('should extract ARM BCJ filtered archive', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'arm.7z'));
      let extractedPath = '';

      iterator.forEach(
        (entry, callback) => {
          if (entry.type === 'file') {
            extractedPath = entry.path;
          }
          entry.create(TARGET, {}, callback);
        },
        { callbacks: true },
        (err): undefined => {
          if (err) {
            done(err);
            return;
          }

          const content = fs.readFileSync(path.join(TARGET, extractedPath), 'utf8').trim();
          assert.equal(content, 'BCJ ARM filter test content', 'Should extract ARM BCJ content');
          done();
        }
      );
    });
  });

  describe('arm64.7z (ARM64/ARMT BCJ filter)', () => {
    it('should extract ARM64 BCJ filtered archive', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'arm64.7z'));
      let extractedPath = '';

      iterator.forEach(
        (entry, callback) => {
          if (entry.type === 'file') {
            extractedPath = entry.path;
          }
          entry.create(TARGET, {}, callback);
        },
        { callbacks: true },
        (err): undefined => {
          if (err) {
            done(err);
            return;
          }

          const content = fs.readFileSync(path.join(TARGET, extractedPath), 'utf8').trim();
          assert.equal(content, 'BCJ ARM64 filter test content', 'Should extract ARM64 BCJ content');
          done();
        }
      );
    });
  });

  describe('ppc.7z (PowerPC BCJ filter)', () => {
    it('should extract PowerPC BCJ filtered archive', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'ppc.7z'));
      let extractedPath = '';

      iterator.forEach(
        (entry, callback) => {
          if (entry.type === 'file') {
            extractedPath = entry.path;
          }
          entry.create(TARGET, {}, callback);
        },
        { callbacks: true },
        (err): undefined => {
          if (err) {
            done(err);
            return;
          }

          const content = fs.readFileSync(path.join(TARGET, extractedPath), 'utf8').trim();
          assert.equal(content, 'BCJ PowerPC filter test content', 'Should extract PowerPC BCJ content');
          done();
        }
      );
    });
  });

  describe('ia64.7z (IA64 BCJ filter)', () => {
    it('should extract IA64 BCJ filtered archive', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'ia64.7z'));
      let extractedPath = '';

      iterator.forEach(
        (entry, callback) => {
          if (entry.type === 'file') {
            extractedPath = entry.path;
          }
          entry.create(TARGET, {}, callback);
        },
        { callbacks: true },
        (err): undefined => {
          if (err) {
            done(err);
            return;
          }

          const content = fs.readFileSync(path.join(TARGET, extractedPath), 'utf8').trim();
          assert.equal(content, 'BCJ IA64 filter test content', 'Should extract IA64 BCJ content');
          done();
        }
      );
    });
  });

  describe('sparc.7z (SPARC BCJ filter)', () => {
    it('should extract SPARC BCJ filtered archive', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'sparc.7z'));
      let extractedPath = '';

      iterator.forEach(
        (entry, callback) => {
          if (entry.type === 'file') {
            extractedPath = entry.path;
          }
          entry.create(TARGET, {}, callback);
        },
        { callbacks: true },
        (err): undefined => {
          if (err) {
            done(err);
            return;
          }

          const content = fs.readFileSync(path.join(TARGET, extractedPath), 'utf8').trim();
          assert.equal(content, 'BCJ SPARC filter test content', 'Should extract SPARC BCJ content');
          done();
        }
      );
    });
  });
});
