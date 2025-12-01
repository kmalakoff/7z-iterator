// Hybrid stream handling: buffers in memory up to threshold, then switches to temp file
import once from 'call-once-fn';
import { bufferFrom } from 'extract-base-iterator';
import fs from 'fs';
import mkdirp from 'mkdirp-classic';
import oo from 'on-one';
import path from 'path';
import { BufferSource, FileSource } from '../sevenz/SevenZipParser.ts';

// Default memory threshold: 100 MB
var DEFAULT_MEMORY_THRESHOLD = 100 * 1024 * 1024;

export interface StreamToSourceOptions {
  memoryThreshold?: number;
  tempPath?: string;
}

export interface SourceResult {
  source: BufferSource | FileSource;
  fd?: number; // Set if FileSource was used (caller must close)
  tempPath?: string; // Set if temp file was created (caller must clean up)
}

export type Callback = (error?: Error, result?: SourceResult) => void;

/**
 * Convert a stream to an ArchiveSource (BufferSource for small files, FileSource for large)
 *
 * Algorithm:
 * 1. Buffer stream data in memory up to memoryThreshold
 * 2. If threshold exceeded, write all buffered data to temp file and continue streaming
 * 3. When done, return BufferSource for memory buffer or FileSource for temp file
 */
export default function streamToSource(stream: NodeJS.ReadableStream, options: StreamToSourceOptions, callback: Callback): void {
  var threshold = options.memoryThreshold !== undefined ? options.memoryThreshold : DEFAULT_MEMORY_THRESHOLD;
  var tempPath = options.tempPath;

  var chunks: Buffer[] = [];
  var totalSize = 0;
  var writeStream: fs.WriteStream | null = null;
  var useTempFile = false;

  var end = once(callback);

  function onData(chunk: Buffer | string): void {
    // Convert string chunks to Buffer
    var buf = typeof chunk === 'string' ? bufferFrom(chunk) : chunk;
    totalSize += buf.length;

    if (!useTempFile && totalSize <= threshold) {
      // Still under threshold - buffer in memory
      chunks.push(buf);
    } else if (!useTempFile) {
      // Just exceeded threshold - switch to temp file
      useTempFile = true;

      if (!tempPath) {
        end(new Error('memoryThreshold exceeded but no tempPath provided'));
        return;
      }

      mkdirp.sync(path.dirname(tempPath));
      writeStream = fs.createWriteStream(tempPath);

      // Write all buffered chunks to temp file
      for (var i = 0; i < chunks.length; i++) {
        writeStream.write(chunks[i]);
      }
      chunks = []; // Allow GC

      // Write current chunk
      writeStream.write(buf);
    } else {
      // Already using temp file - write directly
      if (writeStream) {
        writeStream.write(buf);
      }
    }
  }

  function onEnd(): void {
    if (useTempFile && writeStream && tempPath) {
      // Close write stream, then open for reading
      var filePath = tempPath; // Capture for closure
      writeStream.end(() => {
        fs.open(filePath, 'r', (err, fd) => {
          if (err) return end(err);
          fs.stat(filePath, (statErr, stats) => {
            if (statErr) {
              fs.closeSync(fd);
              return end(statErr);
            }
            end(null, {
              source: new FileSource(fd, stats.size),
              fd: fd,
              tempPath: filePath,
            });
          });
        });
      });
    } else {
      // Use memory buffer
      var fullBuffer = Buffer.concat(chunks);
      end(null, {
        source: new BufferSource(fullBuffer),
      });
    }
  }

  function onError(err: Error): void {
    // Clean up if we created a temp file
    if (writeStream) {
      writeStream.end();
    }
    end(err);
  }

  stream.on('data', onData);
  oo(stream, ['error'], onError);
  oo(stream, ['end', 'close', 'finish'], onEnd);
}
