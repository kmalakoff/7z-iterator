/**
 * FileEntry for 7z archives
 *
 * Wraps a lazy stream - decompression happens when the stream is read.
 * API consistent with zip-iterator and tar-iterator.
 */
import { type FileAttributes, FileEntry, type Lock, type NoParamCallback } from 'extract-base-iterator';
import type { ExtractOptions } from './types.ts';
export default class SevenZipFileEntry extends FileEntry {
  private lock;
  private stream;
  /**
   * Whether this entry's folder supports streaming decompression.
   */
  readonly _canStream: boolean;
  constructor(attributes: FileAttributes, stream: NodeJS.ReadableStream, lock: Lock, canStream: boolean);
  create(dest: string, callback: NoParamCallback): void;
  create(dest: string, options: ExtractOptions, callback: NoParamCallback): void;
  create(dest: string, options?: ExtractOptions): Promise<boolean>;
  _writeFile(fullPath: string, _options: ExtractOptions, callback: NoParamCallback): void;
  destroy(): void;
}
