// Streaming decompression tests (Phase 1)
// Tests for the new streaming decompression infrastructure

import SevenZipIterator, { type FileEntry } from '7z-iterator';
import assert from 'assert';
import fs from 'fs';
import { safeRm } from 'fs-remove-compat';
import mkdirp from 'mkdirp-classic';
import path from 'path';
import Pinkie from 'pinkie-promise';
import { BufferSource, FileSource, SevenZipParser } from '../../src/sevenz/index.ts';
import { arrayFind } from '../lib/compat.ts';
import { DATA_DIR, TARGET } from '../lib/constants.ts';

// Helper to check if entry is a FileEntry with _canStream
function isStreamableFileEntry(entry: { type: string; _canStream?: boolean }): entry is FileEntry & { _canStream: boolean } {
  return entry.type === 'file' && typeof entry._canStream === 'boolean';
}

describe('streaming', () => {
  (() => {
    // patch and restore promise for Node 0.8
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
    safeRm(TARGET, () => {
      mkdirp(TARGET, callback);
    });
  });

  afterEach((callback) => {
    safeRm(TARGET, callback);
  });

  describe('_canStream attribute', () => {
    it('should mark BZip2 entries as streamable', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'bzip2.7z'));
      const entries: { path: string; _canStream: boolean }[] = [];

      iterator.forEach(
        (entry): void => {
          if (isStreamableFileEntry(entry)) {
            entries.push({ path: entry.path, _canStream: entry._canStream });
          }
        },
        (err) => {
          if (err) return done(err);

          // BZip2 should be streamable
          const fileEntry = arrayFind(entries, (e) => e.path.indexOf('.txt') >= 0);
          assert.ok(fileEntry, 'Should have a file entry');
          assert.strictEqual(fileEntry._canStream, true, 'BZip2 entries should be streamable');
          done();
        }
      );
    });

    it('should mark Deflate entries as streamable', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'deflate.7z'));
      const entries: { path: string; _canStream: boolean }[] = [];

      iterator.forEach(
        (entry): void => {
          if (isStreamableFileEntry(entry)) {
            entries.push({ path: entry.path, _canStream: entry._canStream });
          }
        },
        (err) => {
          if (err) return done(err);

          // Deflate should be streamable after Phase 0 rewrite
          const fileEntry = arrayFind(entries, (e) => e.path.indexOf('.txt') >= 0);
          assert.ok(fileEntry, 'Should have a file entry');
          assert.strictEqual(fileEntry._canStream, true, 'Deflate entries should be streamable');
          done();
        }
      );
    });

    it('should mark LZMA2 entries as streamable', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'lzma2.7z'));
      const entries: { path: string; _canStream: boolean }[] = [];

      iterator.forEach(
        (entry): void => {
          if (isStreamableFileEntry(entry)) {
            entries.push({ path: entry.path, _canStream: entry._canStream });
          }
        },
        (err) => {
          if (err) return done(err);

          // LZMA2 is now streamable (Phase 5)
          assert.ok(entries.length > 0, 'Should have file entries');
          for (let i = 0; i < entries.length; i++) {
            assert.strictEqual(entries[i]._canStream, true, 'LZMA2 entries should be streamable');
          }
          done();
        }
      );
    });

    it('should mark BCJ+LZMA2 entries as streamable', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'bcj.7z'));
      const entries: { path: string; _canStream: boolean }[] = [];

      iterator.forEach(
        (entry): void => {
          if (isStreamableFileEntry(entry)) {
            entries.push({ path: entry.path, _canStream: entry._canStream });
          }
        },
        (err) => {
          if (err) return done(err);

          // BCJ+LZMA2 chain is now streamable (both codecs support streaming)
          assert.ok(entries.length > 0, 'Should have file entries');
          for (let i = 0; i < entries.length; i++) {
            assert.strictEqual(entries[i]._canStream, true, 'BCJ+LZMA2 entries should be streamable');
          }
          done();
        }
      );
    });
  });

  describe('getEntryStreamStreaming', () => {
    it('should stream BZip2 single-file folder', (done) => {
      const archivePath = path.join(DATA_DIR, 'bzip2.7z');
      const fd = fs.openSync(archivePath, 'r');
      const stats = fs.statSync(archivePath);
      const source = new FileSource(fd, stats.size);
      const parser = new SevenZipParser(source);
      parser.parse((parseErr) => {
        if (parseErr) {
          parser.close();
          done(parseErr);
          return;
        }

        const entries = parser.getEntries();
        const fileEntry = arrayFind(entries, (e) => e.type === 'file');
        assert.ok(fileEntry, 'Should have a file entry');
        assert.ok(parser.canStreamFolder(fileEntry._folderIndex), 'BZip2 folder should be streamable');

        parser
          .getEntryStreamStreaming(fileEntry)
          .then((stream) => {
            const chunks: Buffer[] = [];
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('end', () => {
              const content = Buffer.concat(chunks).toString('utf8').trim();
              assert.strictEqual(content, 'Test file with BZip2 compression', 'Should stream correct content');
              parser.close();
              done();
            });
            stream.on('error', (err) => {
              parser.close();
              done(err);
            });
          })
          .catch((err) => {
            parser.close();
            done(err);
          });
      });
    });

    it('should stream Deflate single-file folder', (done) => {
      const archivePath = path.join(DATA_DIR, 'deflate.7z');
      const fd = fs.openSync(archivePath, 'r');
      const stats = fs.statSync(archivePath);
      const source = new FileSource(fd, stats.size);
      const parser = new SevenZipParser(source);
      parser.parse((parseErr) => {
        if (parseErr) {
          parser.close();
          done(parseErr);
          return;
        }

        const entries = parser.getEntries();
        const fileEntry = arrayFind(entries, (e) => e.type === 'file');
        assert.ok(fileEntry, 'Should have a file entry');
        assert.ok(parser.canStreamFolder(fileEntry._folderIndex), 'Deflate folder should be streamable');

        parser
          .getEntryStreamStreaming(fileEntry)
          .then((stream) => {
            const chunks: Buffer[] = [];
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('end', () => {
              const content = Buffer.concat(chunks).toString('utf8').trim();
              assert.strictEqual(content, 'Test file with Deflate compression', 'Should stream correct content');
              parser.close();
              done();
            });
            stream.on('error', (err) => {
              parser.close();
              done(err);
            });
          })
          .catch((err) => {
            parser.close();
            done(err);
          });
      });
    });

    it('should stream LZMA2 single-file folder', (done) => {
      const archivePath = path.join(DATA_DIR, 'lzma2.7z');
      const fd = fs.openSync(archivePath, 'r');
      const stats = fs.statSync(archivePath);
      const source = new FileSource(fd, stats.size);
      const parser = new SevenZipParser(source);
      parser.parse((parseErr) => {
        if (parseErr) {
          parser.close();
          done(parseErr);
          return;
        }

        const entries = parser.getEntries();
        const fileEntry = arrayFind(entries, (e) => e.type === 'file');
        assert.ok(fileEntry, 'Should have a file entry');
        assert.ok(parser.canStreamFolder(fileEntry._folderIndex), 'LZMA2 folder should be streamable');

        parser
          .getEntryStreamStreaming(fileEntry)
          .then((stream) => {
            const chunks: Buffer[] = [];
            stream.on('data', (chunk: Buffer) => chunks.push(chunk));
            stream.on('end', () => {
              const content = Buffer.concat(chunks).toString('utf8').trim();
              assert.ok(content.indexOf('// Test fixture file') === 0, 'Should get correct content via streaming');
              parser.close();
              done();
            });
            stream.on('error', (err) => {
              parser.close();
              done(err);
            });
          })
          .catch((err) => {
            parser.close();
            done(err);
          });
      });
    });
  });

  describe('createReadStream', () => {
    it('should create readable stream from FileSource', (done) => {
      const archivePath = path.join(DATA_DIR, 'bzip2.7z');
      const fd = fs.openSync(archivePath, 'r');
      const stats = fs.statSync(archivePath);
      const source = new FileSource(fd, stats.size);

      // Read first 6 bytes (7z signature)
      const stream = source.createReadStream(0, 6);
      const chunks: Buffer[] = [];

      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        const data = Buffer.concat(chunks);
        assert.strictEqual(data.length, 6, 'Should read 6 bytes');
        // 7z magic: 0x37 0x7a 0xbc 0xaf 0x27 0x1c
        assert.strictEqual(data[0], 0x37, 'First byte should be 0x37');
        assert.strictEqual(data[1], 0x7a, 'Second byte should be 0x7a');
        source.close();
        done();
      });
      stream.on('error', (err) => {
        source.close();
        done(err);
      });
    });

    it('should create readable stream from BufferSource', (done) => {
      const archivePath = path.join(DATA_DIR, 'bzip2.7z');
      const buffer = fs.readFileSync(archivePath);
      const source = new BufferSource(buffer);

      // Read first 6 bytes (7z signature)
      const stream = source.createReadStream(0, 6);
      const chunks: Buffer[] = [];

      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('end', () => {
        const data = Buffer.concat(chunks);
        assert.strictEqual(data.length, 6, 'Should read 6 bytes');
        // 7z magic: 0x37 0x7a 0xbc 0xaf 0x27 0x1c
        assert.strictEqual(data[0], 0x37, 'First byte should be 0x37');
        assert.strictEqual(data[1], 0x7a, 'Second byte should be 0x7a');
        source.close();
        done();
      });
      stream.on('error', (err) => {
        source.close();
        done(err);
      });
    });
  });

  describe('canStreamFolder', () => {
    it('should return true for BZip2 folder', (done) => {
      const archivePath = path.join(DATA_DIR, 'bzip2.7z');
      const fd = fs.openSync(archivePath, 'r');
      const stats = fs.statSync(archivePath);
      const source = new FileSource(fd, stats.size);
      const parser = new SevenZipParser(source);
      parser.parse((parseErr) => {
        if (parseErr) {
          parser.close();
          done(parseErr);
          return;
        }

        const entries = parser.getEntries();
        const fileEntry = arrayFind(entries, (e) => e.type === 'file');
        assert.ok(fileEntry, 'Should have file entry');
        assert.strictEqual(parser.canStreamFolder(fileEntry._folderIndex), true, 'BZip2 should be streamable');

        parser.close();
        done();
      });
    });

    it('should return true for Deflate folder', (done) => {
      const archivePath = path.join(DATA_DIR, 'deflate.7z');
      const fd = fs.openSync(archivePath, 'r');
      const stats = fs.statSync(archivePath);
      const source = new FileSource(fd, stats.size);
      const parser = new SevenZipParser(source);
      parser.parse((parseErr) => {
        if (parseErr) {
          parser.close();
          done(parseErr);
          return;
        }

        const entries = parser.getEntries();
        const fileEntry = arrayFind(entries, (e) => e.type === 'file');
        assert.ok(fileEntry, 'Should have file entry');
        assert.strictEqual(parser.canStreamFolder(fileEntry._folderIndex), true, 'Deflate should be streamable');

        parser.close();
        done();
      });
    });

    it('should return true for LZMA2 folder', (done) => {
      const archivePath = path.join(DATA_DIR, 'lzma2.7z');
      const fd = fs.openSync(archivePath, 'r');
      const stats = fs.statSync(archivePath);
      const source = new FileSource(fd, stats.size);
      const parser = new SevenZipParser(source);
      parser.parse((parseErr) => {
        if (parseErr) {
          parser.close();
          done(parseErr);
          return;
        }

        const entries = parser.getEntries();
        const fileEntry = arrayFind(entries, (e) => e.type === 'file');
        assert.ok(fileEntry, 'Should have file entry');
        assert.strictEqual(parser.canStreamFolder(fileEntry._folderIndex), true, 'LZMA2 should be streamable');

        parser.close();
        done();
      });
    });
  });

  describe('FolderStreamSplitter (multi-file solid)', () => {
    it('should stream solid BZip2 archive with multiple files', (done) => {
      const archivePath = path.join(DATA_DIR, 'solid-bzip2.7z');
      const fd = fs.openSync(archivePath, 'r');
      const stats = fs.statSync(archivePath);
      const source = new FileSource(fd, stats.size);
      const parser = new SevenZipParser(source);
      parser.parse((parseErr) => {
        if (parseErr) {
          parser.close();
          done(parseErr);
          return;
        }

        const entries = parser.getEntries();
        const fileEntries = [];
        for (let i = 0; i < entries.length; i++) {
          if (entries[i].type === 'file') {
            fileEntries.push(entries[i]);
          }
        }

        assert.ok(fileEntries.length >= 2, 'Should have at least 2 file entries');

        const folderIndex = fileEntries[0]._folderIndex;
        for (let i = 1; i < fileEntries.length; i++) {
          assert.strictEqual(fileEntries[i]._folderIndex, folderIndex, 'All files should be in same folder (solid)');
        }

        assert.ok(parser.canStreamFolder(folderIndex), 'Solid BZip2 folder should be streamable');

        const contents: { [key: string]: string } = {};
        let pending = fileEntries.length;

        fileEntries.sort((a, b) => a._streamIndexInFolder - b._streamIndexInFolder);

        for (let i = 0; i < fileEntries.length; i++) {
          const entry = fileEntries[i];
          parser
            .getEntryStreamStreaming(entry)
            .then((stream) => {
              const chunks: Buffer[] = [];
              stream.on('data', (chunk: Buffer) => chunks.push(chunk));
              stream.on('end', () => {
                contents[entry.name] = Buffer.concat(chunks).toString('utf8').trim();
                pending--;
                if (pending === 0) {
                  assert.strictEqual(contents['file1.txt'], 'File 1 content - this is the first file', 'Should read first file');
                  assert.strictEqual(contents['file2.txt'], 'File 2 content - this is the second file with more text', 'Should read second file');
                  parser.close();
                  done();
                }
              });
              stream.on('error', (err) => {
                parser.close();
                done(err);
              });
            })
            .catch((err) => {
              parser.close();
              done(err);
            });
        }
      });
    });

    it('should stream solid Deflate archive with multiple files', (done) => {
      const archivePath = path.join(DATA_DIR, 'solid-deflate.7z');
      const fd = fs.openSync(archivePath, 'r');
      const stats = fs.statSync(archivePath);
      const source = new FileSource(fd, stats.size);
      const parser = new SevenZipParser(source);
      parser.parse((parseErr) => {
        if (parseErr) {
          parser.close();
          done(parseErr);
          return;
        }

        const entries = parser.getEntries();
        const fileEntries = [];
        for (let i = 0; i < entries.length; i++) {
          if (entries[i].type === 'file') {
            fileEntries.push(entries[i]);
          }
        }

        assert.ok(fileEntries.length >= 2, 'Should have at least 2 file entries');

        const folderIndex = fileEntries[0]._folderIndex;
        for (let i = 1; i < fileEntries.length; i++) {
          assert.strictEqual(fileEntries[i]._folderIndex, folderIndex, 'All files should be in same folder (solid)');
        }

        assert.ok(parser.canStreamFolder(folderIndex), 'Solid Deflate folder should be streamable');

        const contents: { [key: string]: string } = {};
        let pending = fileEntries.length;

        fileEntries.sort((a, b) => a._streamIndexInFolder - b._streamIndexInFolder);

        for (let i = 0; i < fileEntries.length; i++) {
          const entry = fileEntries[i];
          parser
            .getEntryStreamStreaming(entry)
            .then((stream) => {
              const chunks: Buffer[] = [];
              stream.on('data', (chunk: Buffer) => chunks.push(chunk));
              stream.on('end', () => {
                contents[entry.name] = Buffer.concat(chunks).toString('utf8');
                pending--;
                if (pending === 0) {
                  const paths = [];
                  for (const p in contents) {
                    paths.push(p);
                  }
                  assert.ok(paths.length >= 2, 'Should have streamed at least 2 files');

                  for (let j = 0; j < paths.length; j++) {
                    assert.ok(contents[paths[j]].length > 0, `File ${paths[j]} should have content`);
                  }

                  parser.close();
                  done();
                }
              });
              stream.on('error', (err) => {
                parser.close();
                done(err);
              });
            })
            .catch((err) => {
              parser.close();
              done(err);
            });
        }
      });
    });

    it('should verify file contents match expected in solid archive', (done) => {
      const archivePath = path.join(DATA_DIR, 'solid-bzip2.7z');
      const fd = fs.openSync(archivePath, 'r');
      const stats = fs.statSync(archivePath);
      const source = new FileSource(fd, stats.size);
      const parser = new SevenZipParser(source);
      parser.parse((parseErr) => {
        if (parseErr) {
          parser.close();
          done(parseErr);
          return;
        }

        const entries = parser.getEntries();
        const fileEntries = [];
        for (let i = 0; i < entries.length; i++) {
          if (entries[i].type === 'file') {
            fileEntries.push(entries[i]);
          }
        }

        fileEntries.sort((a, b) => a._streamIndexInFolder - b._streamIndexInFolder);

        const expectedContents: { [key: string]: string } = {
          '.tmp/solid-test/file1.txt': 'File 1 content - this is the first file\n',
          '.tmp/solid-test/file2.txt': 'File 2 content - this is the second file with more text\n',
          '.tmp/solid-test/file3.txt': 'File 3 content - third file\n',
        };

        const actualContents: { [key: string]: string } = {};
        let pending = fileEntries.length;

        for (let i = 0; i < fileEntries.length; i++) {
          const entry = fileEntries[i];
          parser
            .getEntryStreamStreaming(entry)
            .then((stream) => {
              const chunks: Buffer[] = [];
              stream.on('data', (chunk: Buffer) => chunks.push(chunk));
              stream.on('end', () => {
                actualContents[entry.path] = Buffer.concat(chunks).toString('utf8');
                pending--;
                if (pending === 0) {
                  for (const filePath in expectedContents) {
                    assert.strictEqual(actualContents[filePath], expectedContents[filePath], `Content mismatch for ${filePath}`);
                  }
                  parser.close();
                  done();
                }
              });
              stream.on('error', (err) => {
                parser.close();
                done(err);
              });
            })
            .catch((err) => {
              parser.close();
              done(err);
            });
        }
      });
    });
  });

  describe('High-level API', () => {
    it('canStream should return true for BZip2 archive', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'bzip2.7z'));
      let canStreamResult: boolean | null = null;

      iterator.forEach(
        () => {
          // Check canStream during iteration (before iterator is destroyed)
          if (canStreamResult === null) {
            canStreamResult = iterator.canStream();
          }
        },
        (err) => {
          if (err) return done(err);

          assert.strictEqual(canStreamResult, true, 'BZip2 archive should be streamable');
          done();
        }
      );
    });

    it('canStream should return true for Deflate archive', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'deflate.7z'));
      let canStreamResult: boolean | null = null;

      iterator.forEach(
        () => {
          // Check canStream during iteration (before iterator is destroyed)
          if (canStreamResult === null) {
            canStreamResult = iterator.canStream();
          }
        },
        (err) => {
          if (err) return done(err);

          assert.strictEqual(canStreamResult, true, 'Deflate archive should be streamable');
          done();
        }
      );
    });

    it('canStream should return true for LZMA2 archive', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'lzma2.7z'));
      let canStreamResult: boolean | null = null;

      iterator.forEach(
        () => {
          // Check canStream during iteration (before iterator is destroyed)
          if (canStreamResult === null) {
            canStreamResult = iterator.canStream();
          }
        },
        (err) => {
          if (err) return done(err);

          assert.strictEqual(canStreamResult, true, 'LZMA2 archive should be streamable');
          done();
        }
      );
    });

    it('getStreamingOrder should return entries sorted by folder and stream index', (done) => {
      const iterator = new SevenZipIterator(path.join(DATA_DIR, 'solid-bzip2.7z'));
      let ordered: ReturnType<typeof iterator.getStreamingOrder> = [];

      iterator.forEach(
        () => {
          // Get streaming order during iteration (before iterator is destroyed)
          if (ordered.length === 0) {
            ordered = iterator.getStreamingOrder();
          }
        },
        (err) => {
          if (err) return done(err);

          assert.ok(ordered.length >= 3, 'Should have at least 3 entries');

          // Verify entries are sorted by folder index, then stream index
          for (let i = 1; i < ordered.length; i++) {
            const prev = ordered[i - 1];
            const curr = ordered[i];

            if (prev._folderIndex === curr._folderIndex) {
              assert.ok(prev._streamIndexInFolder <= curr._streamIndexInFolder, 'Entries in same folder should be sorted by stream index');
            } else {
              assert.ok(prev._folderIndex < curr._folderIndex, 'Entries should be sorted by folder index');
            }
          }

          done();
        }
      );
    });
  });
});
