import assert from 'assert';
import { PassThrough } from 'extract-base-iterator';
import fs from 'fs';
import { safeRm } from 'fs-remove-compat';
import mkdirp from 'mkdirp-classic';
import path from 'path';
import streamToSource from '../../../src/lib/streamToSource.ts';
import { bufferAlloc } from '../../lib/compat.ts';
import { DATA_DIR, TMP_DIR } from '../../lib/constants.ts';
import { countOpenFdsForInode } from '../../lib/openFds.ts';
import waitFor from '../../lib/waitFor.ts';

const SCRATCH_DIR = path.join(TMP_DIR, 'stream-to-source');

function destroyWithError(stream: NodeJS.ReadableStream, err: Error): void {
  const s = stream as NodeJS.ReadableStream & { destroy?: (e?: Error) => void };
  if (typeof s.destroy === 'function') {
    s.destroy(err);
  } else {
    stream.emit('error', err);
    stream.emit('close');
  }
}

describe('streamToSource', () => {
  beforeEach((done) => {
    safeRm(SCRATCH_DIR, () => {
      mkdirp(SCRATCH_DIR, done);
    });
  });

  afterEach((done) => {
    safeRm(SCRATCH_DIR, done);
  });

  it('should copy stream to temp file and return FileSource', (done) => {
    const data = fs.readFileSync(path.join(DATA_DIR, 'copy.7z'));
    const tempPath = path.join(SCRATCH_DIR, 'success.7z');
    const src = new PassThrough();

    streamToSource(src, { tempPath }, (err, result) => {
      if (err) return done(err);
      assert.ok(result, 'Should return a SourceResult');
      assert.strictEqual(result.tempPath, tempPath);
      assert.strictEqual(result.source.getSize(), data.length);
      const sig = result.source.read(0, 6);
      const sigBuf = Buffer.isBuffer(sig) ? sig : sig.toBuffer();
      assert.strictEqual(sigBuf[0], 0x37);
      assert.strictEqual(sigBuf[1], 0x7a);
      fs.closeSync(result.fd);
      safeRm(result.tempPath, done);
    });

    src.end(data);
  });

  it('should remove temp file and close fd on source emit("error") mid-copy', (done) => {
    const data = fs.readFileSync(path.join(DATA_DIR, 'copy.7z'));
    const half = data.slice(0, Math.floor(data.length / 2));
    const tempPath = path.join(SCRATCH_DIR, 'emit-error.7z');
    const src = new PassThrough();
    let calls = 0;
    let stat: fs.Stats | null = null;

    streamToSource(src, { tempPath }, (err) => {
      calls++;
      assert.strictEqual(calls, 1, 'Callback should run once');
      assert.ok(err, 'Should receive source error');
      assert.strictEqual(err.message, 'source read error');
      assert.strictEqual(fs.existsSync(tempPath), false, 'Temp file should be removed');
      if (stat) {
        assert.strictEqual(countOpenFdsForInode(stat.dev, stat.ino), 0, 'No open fd for temp file');
      }
      done();
    });

    src.write(half);
    waitFor(
      'temp file written before emit error',
      () => {
        if (!fs.existsSync(tempPath)) return false;
        const st = fs.statSync(tempPath);
        if (st.size === 0) return false;
        stat = st;
        return true;
      },
      (waitErr) => {
        if (waitErr) return done(waitErr);
        src.emit('error', new Error('source read error'));
      }
    );
  });

  it('should remove temp file and close fd on source destroy(err) mid-copy', (done) => {
    const data = fs.readFileSync(path.join(DATA_DIR, 'copy.7z'));
    const half = data.slice(0, Math.floor(data.length / 2));
    const tempPath = path.join(SCRATCH_DIR, 'destroy-error.7z');
    const src = new PassThrough();
    let calls = 0;
    let stat: fs.Stats | null = null;

    streamToSource(src, { tempPath }, (err) => {
      calls++;
      assert.strictEqual(calls, 1, 'Callback should run once');
      assert.ok(err, 'Should receive destroy error');
      assert.strictEqual(err.message, 'source destroyed');
      assert.strictEqual(fs.existsSync(tempPath), false, 'Temp file should be removed');
      if (stat) {
        assert.strictEqual(countOpenFdsForInode(stat.dev, stat.ino), 0, 'No open fd for temp file');
      }
      done();
    });

    src.write(half);
    waitFor(
      'temp file written before destroy',
      () => {
        if (!fs.existsSync(tempPath)) return false;
        const st = fs.statSync(tempPath);
        if (st.size === 0) return false;
        stat = st;
        return true;
      },
      (waitErr) => {
        if (waitErr) return done(waitErr);
        destroyWithError(src, new Error('source destroyed'));
      }
    );
  });

  it('should remove temp file and close fd on cancel() mid-copy', (done) => {
    const data = fs.readFileSync(path.join(DATA_DIR, 'copy.7z'));
    const half = data.slice(0, Math.floor(data.length / 2));
    const tempPath = path.join(SCRATCH_DIR, 'cancel.7z');
    const src = new PassThrough();
    let cbCalled = false;
    let stat: fs.Stats | null = null;

    const handle = streamToSource(src, { tempPath }, () => {
      cbCalled = true;
    }) as unknown as { cancel?: () => void } | undefined;

    assert.ok(handle && typeof handle.cancel === 'function', 'streamToSource should return a cancel handle');

    src.write(half);
    waitFor(
      'temp file written before cancel',
      () => {
        if (!fs.existsSync(tempPath)) return false;
        const st = fs.statSync(tempPath);
        if (st.size === 0) return false;
        stat = st;
        return true;
      },
      (waitErr) => {
        if (waitErr) return done(waitErr);
        (handle as { cancel: () => void }).cancel();
        waitFor(
          'temp file and fd removed after cancel',
          () => !fs.existsSync(tempPath) && (!stat || countOpenFdsForInode(stat.dev, stat.ino) === 0),
          (cleanErr) => {
            if (cleanErr) return done(cleanErr);
            assert.strictEqual(cbCalled, false, 'Cancelled copy should not invoke callback');
            done();
          }
        );
      }
    );
  });

  it('should apply backpressure via pipe', (done) => {
    const tempPath = path.join(SCRATCH_DIR, 'backpressure.bin');
    const src = new PassThrough({ highWaterMark: 16384 });
    const chunk = bufferAlloc(65536, 0x61);
    const totalChunks = 64;
    let written = 0;
    let backpressured = false;

    streamToSource(src, { tempPath }, (err, result) => {
      if (err) return done(err);
      assert.ok(result, 'Should return result');
      assert.strictEqual(result.source.getSize(), totalChunks * chunk.length);
      assert.strictEqual(backpressured, true, 'Write to piped PassThrough should observe backpressure');
      fs.closeSync(result.fd);
      safeRm(result.tempPath, done);
    });

    function pumpChunks(): void {
      while (written < totalChunks) {
        written++;
        if (!src.write(chunk)) {
          backpressured = true;
          src.once('drain', pumpChunks);
          return;
        }
      }
      src.end();
    }

    pumpChunks();
  });
});
