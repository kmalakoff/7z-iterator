// Stream to source conversion: writes stream to temp file for random access
import once from 'call-once-fn';
import { bufferFrom } from 'extract-base-iterator';
import fs from 'fs';
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

export type Callback = (error?: Error, result?: SourceResult) => void;

/**
 * Convert a stream to a FileSource by writing to temp file
 *
 * 7z format requires random access for header parsing, so temp file is necessary for streams.
 * Writes directly to temp file for predictable O(1) memory usage during stream consumption.
 */
export default function streamToSource(stream: NodeJS.ReadableStream, options: StreamToSourceOptions, callback: Callback): void {
  const tempPath = options.tempPath;

  const end = once(callback);

  mkdirp.sync(path.dirname(tempPath));
  const writeStream = fs.createWriteStream(tempPath);

  function onData(chunk: Buffer | string): void {
    const buf = typeof chunk === 'string' ? bufferFrom(chunk) : chunk;
    writeStream.write(buf);
  }

  function onEnd(): void {
    writeStream.end(() => {
      fs.open(tempPath, 'r', (err, fd) => {
        if (err) return end(err);
        fs.stat(tempPath, (statErr, stats) => {
          if (statErr) {
            fs.closeSync(fd);
            return end(statErr);
          }
          end(null, {
            source: new FileSource(fd, stats.size),
            fd: fd,
            tempPath: tempPath,
          });
        });
      });
    });
  }

  function onError(err: Error): void {
    writeStream.end();
    end(err);
  }

  stream.on('data', onData);
  oo(stream, ['error'], onError);
  oo(stream, ['end', 'close', 'finish'], onEnd);
}
