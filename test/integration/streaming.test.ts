// Streaming decompression tests (Phase 1)
// Tests for the new streaming decompression infrastructure

import SevenZipIterator, { type Entry, type FileEntry } from '7z-iterator';
import assert from 'assert';
import { crc32, Writable } from 'extract-base-iterator';
import fs from 'fs';
import { safeRm } from 'fs-remove-compat';
import mkdirp from 'mkdirp-classic';
import path from 'path';
import Pinkie from 'pinkie-promise';
import { defer } from '../../src/lib/defer.ts';
import { BufferSource, FileSource, type SevenZipEntry, SevenZipParser } from '../../src/sevenz/index.ts';
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
        (entry: Entry): void => {
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
        (entry: Entry): void => {
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
        (entry: Entry): void => {
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
        (entry: Entry): void => {
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

    // Parses a source and gives the first (or every) file entry to the callback
    function withParser(source: FileSource | BufferSource, callback: (parser: SevenZipParser, files: SevenZipEntry[]) => void, done: (err?: Error) => void) {
      const parser = new SevenZipParser(source);
      parser.parse((parseErr) => {
        if (parseErr) {
          parser.close();
          done(parseErr);
          return;
        }
        const files: SevenZipEntry[] = [];
        const entries = parser.getEntries();
        for (let i = 0; i < entries.length; i++) {
          if (entries[i].type === 'file') files.push(entries[i]);
        }
        callback(parser, files);
      });
    }

    function openFile(name: string): FileSource {
      const archivePath = path.join(DATA_DIR, name);
      return new FileSource(fs.openSync(archivePath, 'r'), fs.statSync(archivePath).size);
    }

    // Calls back once the event loop has turned the given number of times
    function turns(count: number, callback: () => void) {
      if (count <= 0) return callback();
      defer(() => turns(count - 1, callback));
    }

    // Collects the bytes and the order of 'error', 'end' and 'finish'. Calls back on the first 'error' or 'end', after a few loop turns
    // so any event that follows it is recorded too: Node 12 and older emit nothing after 'end' (no 'close'), so there is no later event to wait for.
    function collect(stream: NodeJS.ReadableStream, callback: (result: { data: Buffer; events: string[]; error?: Error & { code?: string } }) => void) {
      const chunks: Buffer[] = [];
      const events: string[] = [];
      let error: (Error & { code?: string }) | undefined;
      let settling = false;
      const settle = () => {
        if (settling) return;
        settling = true;
        turns(3, () => callback({ data: Buffer.concat(chunks), events, error }));
      };
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.on('finish', () => events.push('finish'));
      stream.on('end', () => {
        events.push('end');
        settle();
      });
      stream.on('error', (err: Error) => {
        events.push('error');
        if (!error) error = err;
        settle();
      });
    }

    // An error is reported once, and the stream neither finishes nor ends before or after it
    function assertOnlyError(events: string[]) {
      assert.strictEqual(events.join(','), 'error', 'Should report one error and nothing else');
    }

    // Success is reported as one 'end', with no error
    function assertEnded(events: string[]) {
      assert.strictEqual(events.filter((e) => e !== 'finish').join(','), 'end', 'Should end once without an error');
    }

    // The same faults through both single-file entry streams: getEntryStreamStreaming, and getEntryStream, which the iterator uses for every file entry
    const entryStreams: { name: string; open: (parser: SevenZipParser, entry: SevenZipEntry) => Promise<NodeJS.ReadableStream> }[] = [
      { name: 'getEntryStreamStreaming', open: (parser, entry) => parser.getEntryStreamStreaming(entry) },
      { name: 'getEntryStream', open: (parser, entry) => new Promise((resolve) => resolve(parser.getEntryStream(entry))) },
    ];
    entryStreams.forEach(({ name, open }) => {
      describe(name, () => {
        it('should report CRC mismatch on a single-file folder', (done) => {
          withParser(
            openFile('corrupted-crc.7z'),
            (parser, files) => {
              let pending = files.length;
              let mismatches = 0;
              let ends = 0;
              files.forEach((file) => {
                open(parser, file)
                  .then((stream) => {
                    collect(stream, (result) => {
                      if (result.error) {
                        assert.strictEqual(result.error.code, 'CRC_MISMATCH');
                        assertOnlyError(result.events);
                        mismatches++;
                      } else {
                        assertEnded(result.events);
                        ends++;
                      }
                      if (--pending === 0) {
                        parser.close();
                        assert.strictEqual(mismatches, 1, 'Exactly one entry has a bad CRC');
                        assert.strictEqual(ends, files.length - 1);
                        done();
                      }
                    });
                  })
                  .catch((err) => {
                    parser.close();
                    done(err);
                  });
              });
            },
            done
          );
        });

        it('should pass a decoder error to the stream', (done) => {
          // deflate.7z with one byte inverted in the packed data's block header (packed data starts after the 32-byte signature header).
          // BZip2 is not used: its decoder throws an uncaught error for archives under about 900 KB of packed data.
          const archive = fs.readFileSync(path.join(DATA_DIR, 'deflate.7z'));
          archive[32 + 2] = archive[32 + 2] ^ 0xff;

          withParser(
            new BufferSource(archive),
            (parser, files) => {
              open(parser, files[0])
                .then((stream) => {
                  collect(stream, (result) => {
                    parser.close();
                    assert.ok(result.error, 'Should emit the decoder error');
                    assert.strictEqual(result.error.message, 'invalid stored block lengths');
                    assertOnlyError(result.events);
                    done();
                  });
                })
                .catch((err) => {
                  parser.close();
                  done(err);
                });
            },
            done
          );
        });

        // Fixture recipe (test/data/large-bzip2.7z): 7z a -m0=bzip2 -ms=off large-bzip2.7z large.txt
        // where large.txt is the 150000 lines 'line ' + (i % 1000) + '\n' for i = 0..149999 (about 1 MB)
        it('should deliver every byte to a slow consumer', (done) => {
          let expected = '';
          for (let i = 0; i < 150000; i++) expected += `line ${i % 1000}\n`;

          withParser(
            openFile('large-bzip2.7z'),
            (parser, files) => {
              open(parser, files[0])
                .then((stream) => {
                  const chunks: Buffer[] = [];
                  const slow = new Writable({ highWaterMark: 1 });
                  slow._write = (chunk: Buffer, _encoding: string, callback: (err?: Error) => void) => {
                    chunks.push(chunk);
                    defer(callback);
                  };
                  stream.on('error', (err) => {
                    parser.close();
                    done(err);
                  });
                  slow.on('finish', () => {
                    parser.close();
                    assert.strictEqual(Buffer.concat(chunks).toString('utf8'), expected);
                    done();
                  });
                  stream.pipe(slow);
                })
                .catch((err) => {
                  parser.close();
                  done(err);
                });
            },
            done
          );
        });

        // Fixture recipe (test/data/large-deflate.7z): 7z a -m0=deflate -ms=off large-deflate.7z random.bin
        // where random.bin is 300000 bytes from xorshift32 (x = 123456789; x ^= x << 13; x ^= x >>> 17; x ^= x << 5; byte = x & 255).
        // It does not compress, so the packed data spans several 64 KB reads.

        // Fixture recipe (test/data/large-output-deflate.7z): 7z a -m0=deflate -ms=off large-output-deflate.7z text.txt
        // where text.txt is the 500000 lines 'line ' + (i % 1000) + '\n' (4.4 MB), so a small packed stream decodes to many chunks.

        // Wraps a real source and counts the bytes its packed read streams push
        function countingSource(inner: FileSource | BufferSource) {
          const stats = { pushed: 0, packed: [] as (NodeJS.ReadableStream & { destroyed?: boolean })[] };
          const source = {
            read: (position: number, length: number) => inner.read(position, length),
            getSize: () => inner.getSize(),
            close: () => inner.close(),
            createReadStream: (offset: number, length: number) => {
              const packed = inner.createReadStream(offset, length);
              stats.packed.push(packed);
              const push = packed.push;
              packed.push = (chunk: Buffer | null) => {
                if (chunk) stats.pushed += chunk.length;
                return push.call(packed, chunk);
              };
              return packed;
            },
          };
          return { source, stats };
        }

        it('should not read the packed data before the consumer reads', (done) => {
          const counted = countingSource(openFile('large-deflate.7z'));
          withParser(
            counted.source as unknown as FileSource,
            (parser, files) => {
              open(parser, files[0])
                .then((stream) => {
                  turns(20, () => {
                    const before = counted.stats.pushed;
                    stream.on('data', () => {});
                    stream.on('end', () => {
                      parser.close();
                      assert.strictEqual(before, 0, 'Nothing should be read before the first read');
                      assert.ok(counted.stats.pushed > 0, 'Should read once the consumer reads');
                      done();
                    });
                  });
                })
                .catch((err) => {
                  parser.close();
                  done(err);
                });
            },
            done
          );
        });

        // Records 'error', 'end', 'finish' and 'close' in order
        function recordEvents(stream: NodeJS.ReadableStream) {
          const events: string[] = [];
          ['error', 'end', 'finish', 'close'].forEach((name) => {
            stream.on(name, () => events.push(name));
          });
          return events;
        }

        it('should stop reading the packed data after destroy', (done) => {
          const counted = countingSource(openFile('large-deflate.7z'));
          withParser(
            counted.source as unknown as FileSource,
            (parser, files) => {
              open(parser, files[0])
                .then((stream) => {
                  const events = recordEvents(stream);
                  stream.once('data', () => {
                    const atDestroy = counted.stats.pushed;
                    stream.once('close', () => {
                      parser.close();
                      assert.strictEqual(events.join(','), 'close');
                      assert.strictEqual(counted.stats.packed.length, 1);
                      assert.strictEqual(counted.stats.packed[0].destroyed, true, 'Should destroy the packed stream');
                      assert.strictEqual(counted.stats.pushed - atDestroy, 0, `Should stop reading after destroy, read ${counted.stats.pushed - atDestroy} more bytes`);
                      done();
                    });
                    (stream as unknown as { destroy: () => void }).destroy();
                  });
                })
                .catch((err) => {
                  parser.close();
                  done(err);
                });
            },
            done
          );
        });

        it('should report one close and no end or finish on a plain destroy', (done) => {
          withParser(
            openFile('deflate.7z'),
            (parser, files) => {
              open(parser, files[0])
                .then((stream) => {
                  const events = recordEvents(stream);
                  stream.once('close', () => {
                    // let a second 'close' or a late 'end' arrive: there is no later event to wait for
                    turns(3, () => {
                      parser.close();
                      assert.strictEqual(events.join(','), 'close', 'Should report one close and nothing else');
                      done();
                    });
                  });
                  (stream as unknown as { destroy: () => void }).destroy();
                })
                .catch((err) => {
                  parser.close();
                  done(err);
                });
            },
            done
          );
        });

        it('should not pile up listeners for a late, slow consumer', (done) => {
          const warnings: string[] = [];
          const onWarning = (warning: Error) => {
            if (warning.name === 'MaxListenersExceededWarning') warnings.push(warning.message);
          };
          process.on('warning', onWarning);

          withParser(
            openFile('large-output-deflate.7z'),
            (parser, files) => {
              open(parser, files[0])
                .then((stream) => {
                  let maxDrain = 0;
                  let received = 0;
                  const startSlow = () => {
                    const slow = new Writable({ highWaterMark: 1 });
                    slow._write = (chunk: Buffer, _encoding: string, callback: (err?: Error) => void) => {
                      received += chunk.length;
                      maxDrain = Math.max(maxDrain, stream.listeners('drain').length);
                      defer(callback);
                    };
                    slow.on('finish', () => {
                      parser.close();
                      // warnings are emitted on process.nextTick, so let them arrive
                      turns(2, () => {
                        process.removeListener('warning', onWarning);
                        assert.strictEqual(received, files[0].size);
                        assert.strictEqual(warnings.join('; '), '', 'Should not warn about listeners');
                        assert.ok(maxDrain <= 2, `drain listeners should stay bounded, saw ${maxDrain}`);
                        done();
                      });
                    });
                    stream.pipe(slow);
                  };
                  // the consumer arrives late, then reads slowly
                  turns(50, () => {
                    maxDrain = stream.listeners('drain').length;
                    startSlow();
                  });
                })
                .catch((err) => {
                  parser.close();
                  process.removeListener('warning', onWarning);
                  done(err);
                });
            },
            done
          );
        });

        it('should report a read error on the packed data as one error', (done) => {
          withParser(
            openFile('large-deflate.7z'),
            (parser, files) => {
              open(parser, files[0])
                .then((stream) => {
                  collect(stream, (result) => {
                    assertOnlyError(result.events);
                    // the error code is not asserted: Node reports it, and old Node on Windows reports "OK" for a read on a closed file
                    assert.ok(result.error instanceof Error, 'Should emit the read error');
                    done();
                  });
                  // closing the archive while its packed data is still being read makes the next read fail
                  stream.once('data', () => parser.close());
                })
                .catch((err) => {
                  parser.close();
                  done(err);
                });
            },
            done
          );
        });

        it('should report an error in a middle stage of the decoder chain as one error', (done) => {
          // bcj.7z is LZMA2 then BCJ: an invalid LZMA2 control byte at the start of the packed data fails the first decoder of two
          const archive = fs.readFileSync(path.join(DATA_DIR, 'bcj.7z'));
          archive[32] = 0x03;

          withParser(
            new BufferSource(archive),
            (parser, files) => {
              assert.strictEqual(parser.canStreamFolder(files[0]._folderIndex), true);
              open(parser, files[0])
                .then((stream) => {
                  collect(stream, (result) => {
                    parser.close();
                    assert.ok(result.error, 'Should emit the decoder error');
                    assert.strictEqual(result.error.message, 'Invalid LZMA2 control byte: 0x3');
                    assertOnlyError(result.events);
                    done();
                  });
                })
                .catch((err) => {
                  parser.close();
                  done(err);
                });
            },
            done
          );
        });

        // Fixture recipe (test/data/plain-header-lzma2.7z): 7z a -m0=lzma2 -ms=off -mhc=off -mtm=off -mtc=off -mta=off plain-header-lzma2.7z lzma2.txt
        // where lzma2.txt is 'Test file with LZMA2 and a plain header\n'. Its header is not compressed, so a coder property can be changed in place.
        it('should report a broken decoder setting as an error on the stream', (done) => {
          const archive = fs.readFileSync(path.join(DATA_DIR, 'plain-header-lzma2.7z'));
          const headerStart = 32 + archive.readUInt32LE(12);
          const headerSize = archive.readUInt32LE(20);
          // the LZMA2 coder record: flags 0x21, id 0x21, one property byte (the dictionary size), then that byte
          let at = -1;
          for (let i = headerStart; i < headerStart + headerSize - 3 && at < 0; i++) {
            if (archive[i] === 0x21 && archive[i + 1] === 0x21 && archive[i + 2] === 1) at = i + 3;
          }
          assert.ok(at > 0, 'Should find the LZMA2 property byte');
          archive[at] = 41; // dictionary size properties above 40 are invalid
          archive.writeUInt32LE(crc32(archive.slice(headerStart, headerStart + headerSize)) >>> 0, 28);
          archive.writeUInt32LE(crc32(archive.slice(12, 32)) >>> 0, 8);

          withParser(
            new BufferSource(archive),
            (parser, files) => {
              open(parser, files[0])
                .then((stream) => {
                  collect(stream, (result) => {
                    parser.close();
                    assert.ok(result.error, 'Should emit the setting error');
                    assert.strictEqual(result.error.message, 'Invalid LZMA2 dictionary size property');
                    assertOnlyError(result.events);
                    done();
                  });
                })
                .catch((err) => {
                  parser.close();
                  done(err);
                });
            },
            done
          );
        });
      });
    });
  });

  describe('iterator single-file folders', () => {
    it('should report an error in a middle stage of the decoder chain to create, once', (done) => {
      // bcj.7z is LZMA2 then BCJ: an invalid LZMA2 control byte at the start of the packed data fails the first decoder of two
      const archive = fs.readFileSync(path.join(DATA_DIR, 'bcj.7z'));
      archive[32] = 0x03;
      const archivePath = path.join(TARGET, 'bad-bcj.7z');
      fs.writeFileSync(archivePath, archive);

      const createErrors: Error[] = [];
      const iterator = new SevenZipIterator(archivePath);
      iterator.forEach(
        (entry, callback) => {
          entry.create(path.join(TARGET, 'out'), {}, (err) => {
            if (err) createErrors.push(err);
            callback(err);
          });
        },
        { callbacks: true },
        (err) => {
          // let any second report arrive before counting
          defer(() => {
            assert.ok(err, 'Should fail the iteration');
            assert.strictEqual(err.message, 'Invalid LZMA2 control byte: 0x3');
            assert.strictEqual(createErrors.length, 1, 'create should report the error once');
            done();
          });
        }
      );
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
