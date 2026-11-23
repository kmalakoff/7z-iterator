// Stream to source conversion: writes stream to temp file for random access
import type { CallFn } from 'call-once-fn';
import once from 'call-once-fn';
import { destroyStream, waitForAccess } from 'extract-base-iterator';
import { safeRm } from 'fs-remove-compat';
import fs from 'graceful-fs';
import mkdirp from 'mkdirp-classic';
import oo from 'on-one';
import path from 'path';
import { FileSource } from '../sevenz/SevenZipParser.ts';

export interface StreamToSourceOptions {
  tempPath: string;
}

export interface SourceResult {
  source: FileSource;
  fd: number; // Caller must close
  tempPath: string; // Caller must clean up
}

export interface StreamToSourceHandle {
  cancel: () => void;
}

export type Callback = (error?: Error | null, result?: SourceResult) => void;

/**
 * Convert a stream to a FileSource by writing to a temp file.
 *
 * 7z format requires random access for header parsing, so a temp file is necessary for streams.
 */
export default function streamToSource(stream: NodeJS.ReadableStream, options: StreamToSourceOptions, callback: Callback): StreamToSourceHandle {
  const tempPath = options.tempPath;
  const end = once(callback as unknown as CallFn) as unknown as Callback;

  mkdirp.sync(path.dirname(tempPath));
  const writeStream = fs.createWriteStream(tempPath);

  let settled = false;
  let streamEnded = false;
  let wsOpened = false;
  let wsClosed = false;
  let openFd: number | null = null;

  writeStream.once('open', () => {
    wsOpened = true;
  });
  writeStream.once('close', () => {
    wsClosed = true;
  });

  function cleanupTemp(afterClose?: () => void): void {
    const s = stream as NodeJS.ReadableStream & { unpipe?: (dest?: NodeJS.WritableStream) => void };
    if (typeof s.unpipe === 'function') s.unpipe(writeStream);
    if (openFd !== null) {
      const fd = openFd;
      openFd = null;
      try {
        fs.closeSync(fd);
      } catch (_e) {
        // Already closed
      }
    }
    // Suppress late EBADF on Node 0.8 after destroying an active WriteStream
    writeStream.on('error', () => {});

    let cleaned = false;
    function finishCleanup(): void {
      if (cleaned) return;
      cleaned = true;
      safeRm(tempPath, () => {
        if (afterClose) afterClose();
      });
    }

    if (wsClosed) {
      finishCleanup();
    } else {
      writeStream.once('close', finishCleanup);
      destroyStream(writeStream);
      // Node 0.10-0.12 WriteStream.destroy() before 'open' does not close the fd once it opens
      const ws = writeStream as fs.WriteStream & { close?: () => void; closed?: boolean; fd?: number | null };
      if (!wsOpened && !wsClosed && typeof ws.close === 'function') {
        writeStream.once('open', () => {
          if (!wsClosed && !ws.closed && ws.fd !== null && typeof ws.close === 'function') ws.close();
        });
      }
    }
  }

  stream.once('end', () => {
    streamEnded = true;
  });

  // Keep error listener attached so Node 0.8 Stream.prototype.pipe sees listeners('error').length > 0
  stream.on('error', (err: Error) => {
    if (settled) return;
    settled = true;
    cleanupTemp(() => end(err));
  });

  oo(writeStream, ['error', 'finish', 'close'], ((wsErr?: Error) => {
    if (settled) return;
    if (wsErr) {
      settled = true;
      cleanupTemp(() => end(wsErr));
      return;
    }
    if (!streamEnded) {
      settled = true;
      cleanupTemp(() => end(new Error('Stream closed prematurely')));
      return;
    }
    waitForAccess(tempPath, (accessErr) => {
      if (settled) {
        cleanupTemp();
        return;
      }
      if (accessErr) {
        settled = true;
        cleanupTemp(() => end(accessErr));
        return;
      }
      fs.open(tempPath, 'r', (openErr, fd) => {
        if (settled) {
          if (!openErr && fd !== undefined) {
            try {
              fs.closeSync(fd);
            } catch (_e) {
              // Already closed
            }
          }
          cleanupTemp();
          return;
        }
        if (openErr) {
          settled = true;
          cleanupTemp(() => end(openErr));
          return;
        }
        openFd = fd;
        fs.stat(tempPath, (statErr, stats) => {
          if (settled) {
            cleanupTemp();
            return;
          }
          if (statErr) {
            settled = true;
            cleanupTemp(() => end(statErr));
            return;
          }
          settled = true;
          openFd = null;
          end(undefined, {
            source: new FileSource(fd, stats.size),
            fd: fd,
            tempPath: tempPath,
          });
        });
      });
    });
  }) as unknown as CallFn);

  stream.pipe(writeStream);

  return {
    cancel: () => {
      if (settled) return;
      settled = true;
      cleanupTemp();
    },
  };
}
