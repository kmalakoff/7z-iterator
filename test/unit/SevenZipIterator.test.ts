import SevenZipIterator, { type Entry } from '7z-iterator';
import assert from 'assert';
import { PassThrough, tmpdir } from 'extract-base-iterator';
import fs from 'fs';
import { safeRm } from 'fs-remove-compat';
import path from 'path';
import { DATA_DIR, TARGET } from '../lib/constants.ts';
import { countOpenFdsForInode } from '../lib/openFds.ts';
import waitFor from '../lib/waitFor.ts';

function listTempFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir);
}

function findNewFiles(dir: string, before: string[]): string[] {
  const after = listTempFiles(dir);
  const added: string[] = [];
  for (let i = 0; i < after.length; i++) {
    if (before.indexOf(after[i]) < 0) added.push(after[i]);
  }
  return added;
}

function destroyWithError(stream: NodeJS.ReadableStream, err: Error): void {
  const s = stream as NodeJS.ReadableStream & { destroy?: (e?: Error) => void };
  if (typeof s.destroy === 'function') {
    s.destroy(err);
  } else {
    stream.emit('error', err);
    stream.emit('close');
  }
}

describe('SevenZipIterator', () => {
  const tempDir = path.join(tmpdir(), '7z-iterator');
  let createdFiles: string[] = [];

  beforeEach(() => {
    createdFiles = [];
  });

  afterEach((done) => {
    let i = 0;
    function next(): void {
      if (i >= createdFiles.length) return done();
      safeRm(createdFiles[i++], () => next());
    }
    next();
  });

  describe('stream-source cleanup', () => {
    it('should leave 0 temp files and 0 open temp fds on source emit("error") mid-copy', (done) => {
      const data = fs.readFileSync(path.join(DATA_DIR, 'copy.7z'));
      const half = data.slice(0, Math.floor(data.length / 2));
      const before = listTempFiles(tempDir);
      const src = new PassThrough();
      let tempPath = '';
      let stat: fs.Stats | null = null;

      const iterator = new SevenZipIterator(src);
      iterator.forEach(
        (entry: Entry, cb: (err?: Error | null) => void) => {
          entry.create(TARGET, {}, cb);
        },
        { callbacks: true },
        (err) => {
          assert.ok(err, 'Iteration should fail with stream error');
          assert.strictEqual(err.message, 'stream emit error');
          assert.strictEqual(findNewFiles(tempDir, before).length, 0, 'Should leave 0 temp files');
          if (stat) {
            assert.strictEqual(countOpenFdsForInode(stat.dev, stat.ino), 0, 'Should leave 0 open temp fds');
          }
          done();
        }
      );

      src.write(half);
      waitFor(
        'iterator temp file created',
        () => {
          const added = findNewFiles(tempDir, before);
          if (added.length === 0) return false;
          const candidate = path.join(tempDir, added[0]);
          if (!fs.existsSync(candidate)) return false;
          const st = fs.statSync(candidate);
          if (st.size === 0) return false;
          tempPath = candidate;
          createdFiles.push(tempPath);
          stat = st;
          return true;
        },
        (waitErr) => {
          if (waitErr) return done(waitErr);
          src.emit('error', new Error('stream emit error'));
        }
      );
    });

    it('should leave 0 temp files and 0 open temp fds on source destroy(err) mid-copy', (done) => {
      const data = fs.readFileSync(path.join(DATA_DIR, 'copy.7z'));
      const half = data.slice(0, Math.floor(data.length / 2));
      const before = listTempFiles(tempDir);
      const src = new PassThrough();
      let tempPath = '';
      let stat: fs.Stats | null = null;

      const iterator = new SevenZipIterator(src);
      iterator.forEach(
        (entry: Entry, cb: (err?: Error | null) => void) => {
          entry.create(TARGET, {}, cb);
        },
        { callbacks: true },
        (err) => {
          assert.ok(err, 'Iteration should fail with destroy error');
          assert.strictEqual(err.message, 'stream destroy error');
          assert.strictEqual(findNewFiles(tempDir, before).length, 0, 'Should leave 0 temp files');
          if (stat) {
            assert.strictEqual(countOpenFdsForInode(stat.dev, stat.ino), 0, 'Should leave 0 open temp fds');
          }
          done();
        }
      );

      src.write(half);
      waitFor(
        'iterator temp file created',
        () => {
          const added = findNewFiles(tempDir, before);
          if (added.length === 0) return false;
          const candidate = path.join(tempDir, added[0]);
          if (!fs.existsSync(candidate)) return false;
          const st = fs.statSync(candidate);
          if (st.size === 0) return false;
          tempPath = candidate;
          createdFiles.push(tempPath);
          stat = st;
          return true;
        },
        (waitErr) => {
          if (waitErr) return done(waitErr);
          destroyWithError(src, new Error('stream destroy error'));
        }
      );
    });

    it('should leave 0 temp files and 0 open temp fds on iterator.destroy() mid-copy', (done) => {
      const data = fs.readFileSync(path.join(DATA_DIR, 'copy.7z'));
      const half = data.slice(0, Math.floor(data.length / 2));
      const before = listTempFiles(tempDir);
      const src = new PassThrough();
      let tempPath = '';
      let stat: fs.Stats | null = null;

      const iterator = new SevenZipIterator(src);
      iterator.forEach(
        (entry: Entry, cb: (err?: Error | null) => void) => {
          entry.create(TARGET, {}, cb);
        },
        { callbacks: true },
        () => {}
      );

      src.write(half);
      waitFor(
        'iterator temp file created',
        () => {
          const added = findNewFiles(tempDir, before);
          if (added.length === 0) return false;
          const candidate = path.join(tempDir, added[0]);
          if (!fs.existsSync(candidate)) return false;
          const st = fs.statSync(candidate);
          if (st.size === 0) return false;
          tempPath = candidate;
          createdFiles.push(tempPath);
          stat = st;
          return true;
        },
        (waitErr) => {
          if (waitErr) return done(waitErr);
          iterator.destroy();
          waitFor('iterator temp file and fd cleaned up after destroy', () => findNewFiles(tempDir, before).length === 0 && (!stat || countOpenFdsForInode(stat.dev, stat.ino) === 0), done);
        }
      );
    });
  });
});
