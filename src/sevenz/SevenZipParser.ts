/**
 * SevenZipParser - Main 7z archive parser
 *
 * Handles reading archive structure and providing file streams.
 *
 * Parser Flow:
 * 1. Read signature header (32 bytes) to get header location
 * 2. Read encoded header from nextHeaderOffset
 * 3. If header is compressed, decompress it first
 * 4. Parse streams info (folder structure, pack positions)
 * 5. Parse files info (names, sizes, attributes)
 * 6. Build entry list for iteration
 *
 * Decompression:
 * - 7z uses "folders" as decompression units
 * - Solid archives: multiple files share one folder (decompress once)
 * - Non-solid: one file per folder
 * - Supports LZMA, LZMA2, COPY, BCJ2, and other codecs
 */

import once from 'call-once-fn';
import { crc32, PassThrough } from 'extract-base-iterator';
import type Stream from 'stream';
import { defer } from '../lib/defer.ts';
import type { ArchiveSource } from './ArchiveSource.ts';
import { type Codec, decodeBcj2Multi, getCodec, getCodecName, isBcj2Codec, isCodecSupported } from './codecs/index.ts';
import { FolderStreamSplitter } from './FolderStreamSplitter.ts';

type Readable = Stream.Readable;

import { type CodedError, createCodedError, ErrorCode, FileAttribute, PropertyId, SIGNATURE_HEADER_SIZE } from './constants.ts';
import { type FileInfo, parseEncodedHeader, parseHeaderContent, parseSignatureHeader, type SignatureHeader, type StreamsInfo } from './headers.ts';
import { readNumber } from './NumberCodec.ts';

// Re-export for backwards compatibility
export { type ArchiveSource, BufferSource, FileSource } from './ArchiveSource.ts';

// Entry type for iteration
export interface SevenZipEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'link';
  size: number;
  mtime?: Date;
  atime?: Date;
  ctime?: Date;
  mode?: number;
  isAntiFile: boolean;
  // Internal tracking
  _folderIndex: number;
  _streamIndex: number; // Global stream index
  _streamIndexInFolder: number; // Stream index within folder (for solid archives)
  _hasStream: boolean;
  _crc?: number; // Expected CRC32 for this file (if present in archive)
  _canStream: boolean; // Whether this entry's folder supports streaming decompression
}

/** Callback for operations that don't return data */
export type VoidCallback = (error: Error | null) => void;
type BufferCallback = (error: Error | null, data?: Buffer) => void;

/**
 * SevenZipParser - parses 7z archives and provides entry iteration
 */
export class SevenZipParser {
  private source: ArchiveSource;
  private signature: SignatureHeader | null = null;
  private streamsInfo: StreamsInfo | null = null;
  private filesInfo: FileInfo[] = [];
  private entries: SevenZipEntry[] = [];
  private parsed = false;
  // Smart cache for decompressed solid blocks
  // Only caches when multiple files share a block, releases when last file extracted
  private decompressedCache: { [key: number]: Buffer } = {};
  // Track files per folder and how many have been extracted
  private filesPerFolder: { [key: number]: number } = {};
  private extractedPerFolder: { [key: number]: number } = {};
  // Splitter cache for multi-file folder streaming (Phase 2)
  private folderSplitters: { [key: number]: FolderStreamSplitter } = {};
  private pendingFolders: { [key: number]: BufferCallback[] } = {};

  constructor(source: ArchiveSource) {
    this.source = source;
  }

  private decodeWithCodec(codec: Codec, input: Buffer, properties: Buffer | undefined, unpackSize: number | undefined, callback: BufferCallback): void {
    const done = once(callback);
    try {
      codec.decode(input, properties, unpackSize, (err, result) => {
        if (err) return done(err);
        if (!result) return done(createCodedError('Decoder returned no data', ErrorCode.DECOMPRESSION_FAILED));
        done(null, result);
      });
    } catch (err) {
      done(err as Error);
    }
  }

  /**
   * Parse the archive structure
   * Must be called before iterating entries
   */
  parse(callback?: VoidCallback): Promise<void> | void {
    if (this.parsed) {
      if (typeof callback === 'function') {
        callback(null);
        return;
      }
      if (typeof Promise === 'undefined') {
        return;
      }
      return Promise.resolve();
    }

    const executor = (done: VoidCallback): void => {
      this.parseInternal(done);
    };

    if (typeof callback === 'function') {
      executor(callback);
      return;
    }

    if (typeof Promise === 'undefined') {
      throw new Error('Promises are not available in this runtime. Please provide a callback to parse().');
    }

    return new Promise<void>((resolve, reject) => {
      executor((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });
  }

  private parseInternal(callback: VoidCallback): void {
    if (this.parsed) {
      callback(null);
      return;
    }

    let signature: SignatureHeader;
    let headerBuf: Buffer;

    try {
      const sigBuf = this.source.read(0, SIGNATURE_HEADER_SIZE);
      if (sigBuf.length < SIGNATURE_HEADER_SIZE) {
        callback(createCodedError('Archive too small', ErrorCode.TRUNCATED_ARCHIVE));
        return;
      }
      signature = parseSignatureHeader(sigBuf);
      this.signature = signature;

      const headerOffset = SIGNATURE_HEADER_SIZE + signature.nextHeaderOffset;
      headerBuf = this.source.read(headerOffset, signature.nextHeaderSize);
      if (headerBuf.length < signature.nextHeaderSize) {
        callback(createCodedError('Truncated header', ErrorCode.TRUNCATED_ARCHIVE));
        return;
      }
    } catch (err) {
      callback(err as Error);
      return;
    }

    const finalize = (): void => {
      try {
        this.buildEntries();
        this.parsed = true;
        callback(null);
      } catch (err) {
        callback(err as Error);
      }
    };

    try {
      const headerResult = parseEncodedHeader(headerBuf, this.signature?.nextHeaderCRC ?? 0);
      this.streamsInfo = headerResult.streamsInfo || null;
      this.filesInfo = headerResult.filesInfo;
      finalize();
    } catch (err) {
      const codedErr = err as CodedError;
      if (codedErr && codedErr.code === ErrorCode.COMPRESSED_HEADER) {
        this.handleCompressedHeader(headerBuf, (headerErr) => {
          if (headerErr) {
            callback(headerErr);
            return;
          }
          finalize();
        });
      } else {
        callback(err as Error);
      }
    }
  }

  /**
   * Handle compressed header (kEncodedHeader)
   */
  private handleCompressedHeader(headerBuf: Buffer, callback: VoidCallback): void {
    // Parse the encoded header info to get decompression parameters
    let offset = 1; // Skip kEncodedHeader byte

    const propertyId = headerBuf[offset++];
    if (propertyId !== PropertyId.kMainStreamsInfo && propertyId !== PropertyId.kPackInfo) {
      callback(createCodedError('Expected StreamsInfo in encoded header', ErrorCode.CORRUPT_HEADER));
      return;
    }

    let packInfoResult: ReturnType<SevenZipParser['parseEncodedHeaderStreams']>;
    try {
      packInfoResult = this.parseEncodedHeaderStreams(headerBuf, 1);
    } catch (err) {
      callback(err as Error);
      return;
    }

    const codec = getCodec(packInfoResult.codecId);
    const candidates: Buffer[] = [];

    const compressedStart = SIGNATURE_HEADER_SIZE + packInfoResult.packPos;
    candidates.push(this.source.read(compressedStart, packInfoResult.packSize));

    if (this.signature) {
      const packAreaEnd = SIGNATURE_HEADER_SIZE + this.signature.nextHeaderOffset;
      const searchStart = packAreaEnd - packInfoResult.packSize;
      const searchEnd = Math.max(SIGNATURE_HEADER_SIZE, compressedStart - 100000);
      const scanChunkSize = 4096;
      for (let chunkStart = searchStart; chunkStart >= searchEnd; chunkStart -= scanChunkSize) {
        const chunk = this.source.read(chunkStart, scanChunkSize + packInfoResult.packSize);
        const limit = Math.min(chunk.length, scanChunkSize);
        for (let i = 0; i < limit; i++) {
          if (chunk[i] === 0x00) {
            const end = i + packInfoResult.packSize;
            if (end <= chunk.length) {
              const candidateData = chunk.slice(i, end);
              if (candidateData.length === packInfoResult.packSize) {
                candidates.push(candidateData);
              }
            }
          }
        }
      }
    }

    const tryCandidate = (index: number): void => {
      if (index >= candidates.length) {
        callback(createCodedError('Failed to decompress header - could not find valid LZMA data', ErrorCode.CORRUPT_HEADER));
        return;
      }

      this.decodeWithCodec(codec, candidates[index], packInfoResult.properties, packInfoResult.unpackSize, (err, decompressed) => {
        if (err || !decompressed) {
          tryCandidate(index + 1);
          return;
        }
        if (packInfoResult.unpackCRC !== undefined) {
          const actualCRC = crc32(decompressed);
          if (actualCRC !== packInfoResult.unpackCRC) {
            tryCandidate(index + 1);
            return;
          }
        }
        this.parseDecompressedHeader(decompressed, callback);
      });
    };

    tryCandidate(0);
  }

  private parseDecompressedHeader(decompressedHeader: Buffer, callback: VoidCallback): void {
    let decompOffset = 0;
    const headerId = decompressedHeader[decompOffset++];
    if (headerId !== PropertyId.kHeader) {
      callback(createCodedError('Expected kHeader in decompressed header', ErrorCode.CORRUPT_HEADER));
      return;
    }

    try {
      const result = parseHeaderContent(decompressedHeader, decompOffset);
      this.streamsInfo = result.streamsInfo || null;
      this.filesInfo = result.filesInfo;
      callback(null);
    } catch (err) {
      callback(err as Error);
    }
  }

  /**
   * Parse streams info from encoded header block
   * This is a simplified parser for the header's own compression info
   */
  private parseEncodedHeaderStreams(
    buf: Buffer,
    offset: number
  ): {
    packPos: number;
    packSize: number;
    unpackSize: number;
    codecId: number[];
    properties?: Buffer;
    unpackCRC?: number;
  } {
    // This is a simplified parser for the encoded header's own streams info
    let packPos = 0;
    let packSize = 0;
    let unpackSize = 0;
    let codecId: number[] = [];
    let properties: Buffer | undefined;
    let unpackCRC: number | undefined;

    while (offset < buf.length) {
      const propertyId = buf[offset++];

      if (propertyId === PropertyId.kEnd) {
        break;
      }

      switch (propertyId) {
        case PropertyId.kPackInfo: {
          const packPosResult = readNumber(buf, offset);
          packPos = packPosResult.value;
          offset += packPosResult.bytesRead;

          const numPackResult = readNumber(buf, offset);
          offset += numPackResult.bytesRead;

          // Read until kEnd
          while (buf[offset] !== PropertyId.kEnd) {
            if (buf[offset] === PropertyId.kSize) {
              offset++;
              const sizeResult = readNumber(buf, offset);
              packSize = sizeResult.value;
              offset += sizeResult.bytesRead;
            } else {
              offset++;
            }
          }
          offset++; // Skip kEnd
          break;
        }

        case PropertyId.kUnpackInfo:
          // Find folder/coder info
          while (offset < buf.length && buf[offset] !== PropertyId.kEnd) {
            if (buf[offset] === PropertyId.kFolder) {
              offset++;
              const numFoldersResult = readNumber(buf, offset);
              offset += numFoldersResult.bytesRead;
              offset++; // external flag

              // Parse coder
              const numCodersResult = readNumber(buf, offset);
              offset += numCodersResult.bytesRead;

              const flags = buf[offset++];
              const idSize = flags & 0x0f;
              const hasAttributes = (flags & 0x20) !== 0;

              codecId = [];
              for (let i = 0; i < idSize; i++) {
                codecId.push(buf[offset++]);
              }

              if (hasAttributes) {
                const propsLenResult = readNumber(buf, offset);
                offset += propsLenResult.bytesRead;
                properties = buf.slice(offset, offset + propsLenResult.value);
                offset += propsLenResult.value;
              }
            } else if (buf[offset] === PropertyId.kCodersUnpackSize) {
              offset++;
              // Read unpack size - needed for LZMA decoder
              const unpackSizeResult = readNumber(buf, offset);
              unpackSize = unpackSizeResult.value;
              offset += unpackSizeResult.bytesRead;
            } else if (buf[offset] === PropertyId.kCRC) {
              offset++;
              const allDefined = buf[offset++];
              if (allDefined) {
                unpackCRC = buf.readUInt32LE(offset);
                offset += 4;
              }
            } else {
              offset++;
            }
          }
          if (buf[offset] === PropertyId.kEnd) offset++;
          break;
      }
    }

    return { packPos: packPos, packSize: packSize, unpackSize: unpackSize, codecId: codecId, properties: properties, unpackCRC: unpackCRC };
  }

  /**
   * Build the entries list from parsed file info
   */
  private buildEntries(): void {
    this.entries = [];

    if (!this.streamsInfo) {
      // No streams info - just create entries from file info
      for (let i = 0; i < this.filesInfo.length; i++) {
        const file = this.filesInfo[i];
        this.entries.push(this.createEntry(file, 0, 0, 0));
      }
      return;
    }

    // Use the properly parsed numUnpackStreamsPerFolder from the archive header
    const streamsPerFolder = this.streamsInfo.numUnpackStreamsPerFolder;

    // Initialize files per folder count (for smart caching)
    for (let f = 0; f < streamsPerFolder.length; f++) {
      this.filesPerFolder[f] = streamsPerFolder[f];
      this.extractedPerFolder[f] = 0;
    }

    // Now build entries with proper folder/stream tracking
    let streamIndex = 0;
    let folderIndex = 0;
    let streamInFolder = 0;
    let folderStreamCount = streamsPerFolder[0] || 0;

    for (let j = 0; j < this.filesInfo.length; j++) {
      const fileInfo = this.filesInfo[j];

      // Get size from unpackSizes for files with streams
      let size = 0;
      if (fileInfo.hasStream && streamIndex < this.streamsInfo.unpackSizes.length) {
        size = this.streamsInfo.unpackSizes[streamIndex];
      }

      const entry = this.createEntry(fileInfo, size, folderIndex, streamInFolder);
      entry._streamIndex = streamIndex;
      // Set CRC if available
      if (fileInfo.hasStream && this.streamsInfo.unpackCRCs && this.streamsInfo.unpackCRCs[streamIndex] !== undefined) {
        entry._crc = this.streamsInfo.unpackCRCs[streamIndex];
      }
      this.entries.push(entry);

      // Advance stream tracking for files with streams
      if (fileInfo.hasStream) {
        streamIndex++;
        streamInFolder++;

        // Check if we've exhausted streams in this folder
        if (streamInFolder >= folderStreamCount) {
          folderIndex++;
          streamInFolder = 0;
          folderStreamCount = streamsPerFolder[folderIndex] || 0;
        }
      }
    }

    // Set _canStream for all entries now that we have complete folder info
    // This must be done after all entries are built because canStreamFolder
    // relies on the folder structure being fully parsed
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i];
      if (entry._hasStream && entry._folderIndex >= 0) {
        entry._canStream = this.canStreamFolder(entry._folderIndex);
      }
    }
  }

  /**
   * Create an entry from file info
   */
  private createEntry(file: FileInfo, size: number, folderIndex: number, streamInFolder: number): SevenZipEntry {
    // Determine entry type
    // Note: 7z format doesn't natively support symlinks. p7zip with -snl stores
    // symlinks as regular files with the target path as content.
    let type: 'file' | 'directory' | 'link' = 'file';
    if (file.isDirectory) {
      type = 'directory';
    }

    // Calculate mode from Windows attributes
    let mode: number | undefined;
    if (file.attributes !== undefined) {
      // Check for Unix extension bit
      if ((file.attributes & FileAttribute.UNIX_EXTENSION) !== 0) {
        mode = (file.attributes >>> 16) & 0xffff;
        // Check for symlink (S_IFLNK = 0xA000)
        // Note: Most 7z implementations don't preserve symlink mode bits
        if ((mode & 0xf000) === 0xa000) {
          type = 'link';
        }
      } else if (file.isDirectory) {
        mode = 493; // 0o755
      } else {
        mode = 420; // 0o644
      }
    }

    return {
      name: getBaseName(file.name),
      path: file.name,
      type: type,
      size: size,
      mtime: file.mtime,
      atime: file.atime,
      ctime: file.ctime,
      mode: mode,
      isAntiFile: file.isAntiFile,
      _folderIndex: folderIndex,
      _streamIndex: 0, // Set by caller
      _streamIndexInFolder: streamInFolder,
      _hasStream: file.hasStream,
      _canStream: false, // Set after parsing completes when canStreamFolder is available
    };
  }

  /**
   * Get the list of entries
   */
  getEntries(): SevenZipEntry[] {
    if (!this.parsed) {
      throw new Error('SevenZipParser has not been parsed yet. Call parse(callback) before accessing entries.');
    }
    return this.entries;
  }

  /**
   * Get a readable stream for an entry's content.
   * Returns immediately - decompression happens when data is read (proper streaming).
   * Uses true streaming for codecs that support it, buffered for others.
   */
  getEntryStream(entry: SevenZipEntry): Readable {
    if (!entry._hasStream || entry.type === 'directory') {
      // Return empty stream for directories and empty files
      const emptyStream = new PassThrough();
      emptyStream.end();
      return emptyStream;
    }

    if (!this.streamsInfo) {
      throw createCodedError('No streams info available', ErrorCode.CORRUPT_HEADER);
    }

    // Get folder info
    const folder = this.streamsInfo.folders[entry._folderIndex];
    if (!folder) {
      throw createCodedError('Invalid folder index', ErrorCode.CORRUPT_HEADER);
    }

    // Check codec support
    for (let i = 0; i < folder.coders.length; i++) {
      const coder = folder.coders[i];
      if (!isCodecSupported(coder.id)) {
        const codecName = getCodecName(coder.id);
        throw createCodedError(`Unsupported codec: ${codecName}`, ErrorCode.UNSUPPORTED_CODEC);
      }
    }

    // Use true streaming for single-file folders that support it.
    // Multi-file folders use buffered approach because streaming requires
    // accessing files in order, which doesn't work with concurrent extraction.
    const filesInFolder = this.filesPerFolder[entry._folderIndex] || 1;
    if (entry._canStream && filesInFolder === 1) {
      return this._getEntryStreamStreaming(entry);
    }
    return this._getEntryStreamBuffered(entry);
  }

  /**
   * True streaming: data flows through without buffering entire folder.
   * Only used for single-file folders with streamable codecs (BZip2, Deflate, LZMA2).
   */
  private _getEntryStreamStreaming(entry: SevenZipEntry): Readable {
    let started = false;
    let destroyed = false;
    let folderStream: ReturnType<typeof this.streamFolder> | null = null;

    const stream = new PassThrough();

    const originalRead = stream._read.bind(stream);
    stream._read = (size: number) => {
      if (!started && !destroyed) {
        started = true;
        defer(() => {
          if (destroyed) return;

          try {
            let crcValue = 0;
            const verifyCrc = entry._crc !== undefined;
            folderStream = this.streamFolder(entry._folderIndex);

            folderStream.output.on('data', (chunk: Buffer) => {
              if (destroyed) return;
              if (verifyCrc) {
                crcValue = crc32(chunk, crcValue);
              }
              if (!stream.write(chunk)) {
                folderStream?.pause();
                stream.once('drain', () => folderStream?.resume());
              }
            });

            folderStream.output.on('end', () => {
              if (destroyed) return;
              if (verifyCrc && crcValue !== entry._crc) {
                stream.destroy(createCodedError(`CRC mismatch for ${entry.path}: expected ${entry._crc?.toString(16)}, got ${crcValue.toString(16)}`, ErrorCode.CRC_MISMATCH));
                return;
              }
              stream.end();
              this.extractedPerFolder[entry._folderIndex] = (this.extractedPerFolder[entry._folderIndex] || 0) + 1;
            });

            folderStream.output.on('error', (err: Error) => {
              if (!destroyed) stream.destroy(err);
            });
          } catch (err) {
            if (!destroyed) {
              stream.destroy(err as Error);
            }
          }
        });
      }
      return originalRead(size);
    };

    // Override destroy to clean up folder stream
    // IMPORTANT: Emit error synchronously BEFORE calling original destroy.
    // On older Node, destroy() emits 'finish' and 'end' before 'error',
    // which causes piped streams to complete successfully before the error fires.
    const streamWithDestroy = stream as NodeJS.ReadableStream & { destroy?: (err?: Error) => NodeJS.ReadableStream };
    const originalDestroy = typeof streamWithDestroy.destroy === 'function' ? streamWithDestroy.destroy.bind(stream) : null;
    streamWithDestroy.destroy = (err?: Error) => {
      destroyed = true;
      if (err) stream.emit('error', err);
      if (folderStream) folderStream.destroy();
      if (originalDestroy) return originalDestroy();
      return stream;
    };

    return stream;
  }

  /**
   * Buffered extraction: decompress entire folder, slice out file.
   * Used for codecs that don't support incremental streaming (LZMA1, BCJ2).
   */
  private _getEntryStreamBuffered(entry: SevenZipEntry): Readable {
    if (!this.streamsInfo) {
      throw createCodedError('No streams info available', ErrorCode.CORRUPT_HEADER);
    }
    const streamsInfo = this.streamsInfo;
    const folderIdx = entry._folderIndex;
    let started = false;
    let destroyed = false;

    const stream = new PassThrough();

    const originalRead = stream._read.bind(stream);
    stream._read = (size: number) => {
      if (!started && !destroyed) {
        started = true;
        defer(() => {
          if (destroyed) return;

          this.getDecompressedFolder(folderIdx, (err, data) => {
            if (destroyed) return;
            if (err || !data) {
              stream.destroy(err || createCodedError('Unable to decompress folder', ErrorCode.DECOMPRESSION_FAILED));
              return;
            }

            try {
              let fileStart = 0;
              for (let m = 0; m < entry._streamIndexInFolder; m++) {
                const prevStreamGlobalIndex = entry._streamIndex - entry._streamIndexInFolder + m;
                fileStart += streamsInfo.unpackSizes[prevStreamGlobalIndex];
              }

              const fileSize = entry.size;

              if (fileStart + fileSize > data.length) {
                stream.destroy(createCodedError(`File data out of bounds: offset ${fileStart} + size ${fileSize} > decompressed length ${data.length}`, ErrorCode.DECOMPRESSION_FAILED));
                return;
              }

              const fileData = data.slice(fileStart, fileStart + fileSize);

              if (entry._crc !== undefined) {
                const actualCRC = crc32(fileData);
                if (actualCRC !== entry._crc) {
                  stream.destroy(createCodedError(`CRC mismatch for ${entry.path}: expected ${entry._crc.toString(16)}, got ${actualCRC.toString(16)}`, ErrorCode.CRC_MISMATCH));
                  return;
                }
              }

              this.extractedPerFolder[folderIdx] = (this.extractedPerFolder[folderIdx] || 0) + 1;
              if (this.extractedPerFolder[folderIdx] >= this.filesPerFolder[folderIdx]) {
                delete this.decompressedCache[folderIdx];
              }

              if (!destroyed) {
                stream.push(fileData);
                stream.push(null);
              }
            } catch (decodeErr) {
              stream.destroy(decodeErr as Error);
            }
          });
        });
      }
      return originalRead(size);
    };

    // Override destroy to set destroyed flag
    // IMPORTANT: Emit error synchronously BEFORE calling original destroy.
    // On older Node, destroy() emits 'finish' and 'end' before 'error',
    // which causes piped streams to complete successfully before the error fires.
    const streamWithDestroy = stream as NodeJS.ReadableStream & { destroy?: (err?: Error) => NodeJS.ReadableStream };
    const originalDestroy = typeof streamWithDestroy.destroy === 'function' ? streamWithDestroy.destroy.bind(stream) : null;
    streamWithDestroy.destroy = (err?: Error) => {
      destroyed = true;
      if (err) stream.emit('error', err);
      if (originalDestroy) return originalDestroy();
      return stream;
    };

    return stream;
  }

  /**
   * Check if a folder uses BCJ2 codec
   */
  private folderHasBcj2(folder: { coders: { id: number[] }[] }): boolean {
    for (let i = 0; i < folder.coders.length; i++) {
      if (isBcj2Codec(folder.coders[i].id)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Get decompressed data for a folder, with smart caching for solid archives
   * Only caches when multiple files share a block, releases when last file extracted
   */
  private getDecompressedFolder(folderIndex: number, callback: BufferCallback): void {
    if (this.decompressedCache[folderIndex]) {
      callback(null, this.decompressedCache[folderIndex]);
      return;
    }

    if (this.pendingFolders[folderIndex]) {
      this.pendingFolders[folderIndex].push(callback);
      return;
    }

    if (!this.streamsInfo) {
      callback(createCodedError('No streams info available', ErrorCode.CORRUPT_HEADER));
      return;
    }

    this.pendingFolders[folderIndex] = [callback];

    this.decodeFolderData(folderIndex, (err, data) => {
      const waiters = this.pendingFolders[folderIndex] || [];
      delete this.pendingFolders[folderIndex];

      if (err || !data) {
        for (let i = 0; i < waiters.length; i++) {
          waiters[i](err || createCodedError('Decoder returned no data', ErrorCode.DECOMPRESSION_FAILED));
        }
        return;
      }

      if (this.shouldCacheFolder(folderIndex)) {
        this.decompressedCache[folderIndex] = data;
      }

      for (let i = 0; i < waiters.length; i++) {
        waiters[i](null, data);
      }
    });
  }

  private shouldCacheFolder(folderIndex: number): boolean {
    const filesInFolder = this.filesPerFolder[folderIndex] || 1;
    const extractedFromFolder = this.extractedPerFolder[folderIndex] || 0;
    return filesInFolder - extractedFromFolder > 1;
  }

  private decodeFolderData(folderIndex: number, callback: BufferCallback): void {
    if (!this.streamsInfo) {
      callback(createCodedError('No streams info available', ErrorCode.CORRUPT_HEADER));
      return;
    }

    const folder = this.streamsInfo.folders[folderIndex];
    if (!folder) {
      callback(createCodedError('Invalid folder index', ErrorCode.CORRUPT_HEADER));
      return;
    }

    if (this.folderHasBcj2(folder)) {
      this.decompressBcj2Folder(folderIndex, callback);
      return;
    }

    const packDataResult = this.readPackedData(folderIndex);
    if (packDataResult instanceof Error) {
      callback(packDataResult);
      return;
    }

    this.decodeFolderCoders(folder, packDataResult, 0, callback);
  }

  private readPackedData(folderIndex: number): Buffer | Error {
    if (!this.streamsInfo) {
      return createCodedError('No streams info available', ErrorCode.CORRUPT_HEADER);
    }

    const folder = this.streamsInfo.folders[folderIndex];
    if (!folder) {
      return createCodedError('Invalid folder index', ErrorCode.CORRUPT_HEADER);
    }

    const signedHeaderSize = SIGNATURE_HEADER_SIZE;
    const signedPackPos = this.streamsInfo.packPos;
    let packPos = Math.max(signedHeaderSize, 0) + Math.max(signedPackPos, 0);

    let packStreamIndex = 0;
    for (let j = 0; j < folderIndex; j++) {
      packStreamIndex += this.streamsInfo.folders[j].packedStreams.length;
    }

    for (let k = 0; k < packStreamIndex; k++) {
      const size = this.streamsInfo.packSizes[k];
      if (packPos + size < packPos) {
        return createCodedError(`Pack position overflow at index ${k}`, ErrorCode.CORRUPT_ARCHIVE);
      }
      packPos += size;
    }

    const packSize = this.streamsInfo.packSizes[packStreamIndex];
    if (packSize < 0 || packSize > Number.MAX_SAFE_INTEGER) {
      return createCodedError(`Invalid pack size: ${packSize}`, ErrorCode.CORRUPT_ARCHIVE);
    }

    if (packPos < 0 || packPos > Number.MAX_SAFE_INTEGER) {
      return createCodedError(`Invalid pack position: ${packPos}`, ErrorCode.CORRUPT_ARCHIVE);
    }

    return this.source.read(packPos, packSize);
  }

  private decodeFolderCoders(folder: { coders: { id: number[]; properties?: Buffer }[]; unpackSizes: number[] }, input: Buffer, index: number, callback: BufferCallback): void {
    if (index >= folder.coders.length) {
      callback(null, input);
      return;
    }

    const coderInfo = folder.coders[index];
    const codec = getCodec(coderInfo.id);
    const unpackSize = folder.unpackSizes[index];
    if (unpackSize < 0 || unpackSize > Number.MAX_SAFE_INTEGER) {
      callback(createCodedError(`Invalid unpack size: ${unpackSize}`, ErrorCode.CORRUPT_ARCHIVE));
      return;
    }

    this.decodeWithCodec(codec, input, coderInfo.properties, unpackSize, (err, output) => {
      if (err || !output) {
        callback(err || createCodedError('Decoder returned no data', ErrorCode.DECOMPRESSION_FAILED));
        return;
      }
      this.decodeFolderCoders(folder, output, index + 1, callback);
    });
  }

  /**
   * Decompress a BCJ2 folder with multi-stream handling
   * BCJ2 uses 4 input streams: main, call, jump, range coder
   */
  private decompressBcj2Folder(folderIndex: number, callback: BufferCallback): void {
    if (!this.streamsInfo) {
      callback(createCodedError('No streams info available', ErrorCode.CORRUPT_HEADER));
      return;
    }

    const folder = this.streamsInfo.folders[folderIndex];
    if (!folder) {
      callback(createCodedError('Invalid folder index', ErrorCode.CORRUPT_HEADER));
      return;
    }

    let packPos = SIGNATURE_HEADER_SIZE + this.streamsInfo.packPos;
    let packStreamIndex = 0;
    for (let j = 0; j < folderIndex; j++) {
      packStreamIndex += this.streamsInfo.folders[j].packedStreams.length;
    }
    for (let k = 0; k < packStreamIndex; k++) {
      packPos += this.streamsInfo.packSizes[k];
    }

    const numPackStreams = folder.packedStreams.length;
    const packStreams: Buffer[] = [];
    let currentPos = packPos;
    for (let p = 0; p < numPackStreams; p++) {
      const size = this.streamsInfo.packSizes[packStreamIndex + p];
      packStreams.push(this.source.read(currentPos, size));
      currentPos += size;
    }

    const coderOutputs: { [key: number]: Buffer } = {};
    let bcj2CoderIndex = -1;
    for (let c = 0; c < folder.coders.length; c++) {
      if (isBcj2Codec(folder.coders[c].id)) {
        bcj2CoderIndex = c;
        break;
      }
    }
    if (bcj2CoderIndex === -1) {
      callback(createCodedError('BCJ2 coder not found in folder', ErrorCode.CORRUPT_HEADER));
      return;
    }

    const inputToPackStream: { [key: number]: number } = {};
    for (let pi = 0; pi < folder.packedStreams.length; pi++) {
      inputToPackStream[folder.packedStreams[pi]] = pi;
    }

    const processOrder = this.getCoderProcessOrder(folder, bcj2CoderIndex);

    const processNext = (orderIndex: number): void => {
      if (orderIndex >= processOrder.length) {
        this.finishBcj2Decode(folder, bcj2CoderIndex, coderOutputs, inputToPackStream, packStreams, callback);
        return;
      }

      const coderIdx = processOrder[orderIndex];
      if (coderIdx === bcj2CoderIndex) {
        processNext(orderIndex + 1);
        return;
      }

      const coder = folder.coders[coderIdx];
      const codec = getCodec(coder.id);

      let coderInputStart = 0;
      for (let ci2 = 0; ci2 < coderIdx; ci2++) {
        coderInputStart += folder.coders[ci2].numInStreams;
      }
      const inputIdx = coderInputStart;
      const packStreamIdx = inputToPackStream[inputIdx];
      const inputData = packStreams[packStreamIdx];
      const unpackSize = folder.unpackSizes[coderIdx];

      this.decodeWithCodec(codec, inputData, coder.properties, unpackSize, (err, outputData) => {
        if (err || !outputData) {
          callback(err || createCodedError('Decoder returned no data', ErrorCode.DECOMPRESSION_FAILED));
          return;
        }

        let coderOutputStart = 0;
        for (let co2 = 0; co2 < coderIdx; co2++) {
          coderOutputStart += folder.coders[co2].numOutStreams;
        }
        coderOutputs[coderOutputStart] = outputData;
        processNext(orderIndex + 1);
      });
    };

    processNext(0);
  }

  private finishBcj2Decode(
    folder: { coders: { id: number[]; numInStreams: number; numOutStreams: number; properties?: Buffer }[]; bindPairs: { inIndex: number; outIndex: number }[]; unpackSizes: number[] },
    bcj2CoderIndex: number,
    coderOutputs: { [key: number]: Buffer },
    inputToPackStream: { [key: number]: number },
    packStreams: Buffer[],
    callback: BufferCallback
  ): void {
    let bcj2InputStart = 0;
    for (let ci3 = 0; ci3 < bcj2CoderIndex; ci3++) {
      bcj2InputStart += folder.coders[ci3].numInStreams;
    }

    const bcj2Inputs: Buffer[] = [];
    for (let bi = 0; bi < 4; bi++) {
      const globalIdx = bcj2InputStart + bi;
      let boundOutput = -1;
      for (let bp2 = 0; bp2 < folder.bindPairs.length; bp2++) {
        if (folder.bindPairs[bp2].inIndex === globalIdx) {
          boundOutput = folder.bindPairs[bp2].outIndex;
          break;
        }
      }

      if (boundOutput >= 0) {
        bcj2Inputs.push(coderOutputs[boundOutput]);
      } else {
        const psIdx = inputToPackStream[globalIdx];
        bcj2Inputs.push(packStreams[psIdx]);
      }
    }

    let bcj2OutputStart = 0;
    for (let co3 = 0; co3 < bcj2CoderIndex; co3++) {
      bcj2OutputStart += folder.coders[co3].numOutStreams;
    }
    const bcj2UnpackSize = folder.unpackSizes[bcj2OutputStart];

    try {
      const result = decodeBcj2Multi(bcj2Inputs, undefined, bcj2UnpackSize);
      callback(null, result);
    } catch (err) {
      callback(err as Error);
    } finally {
      for (const key in coderOutputs) {
        delete coderOutputs[key];
      }
      packStreams.length = 0;
    }
  }

  /**
   * Get processing order for coders (dependency order)
   */
  private getCoderProcessOrder(folder: { coders: { numInStreams: number; numOutStreams: number }[]; bindPairs: { inIndex: number; outIndex: number }[] }, excludeIdx: number): number[] {
    const order: number[] = [];
    const processed: { [key: number]: boolean } = {};

    // Simple approach: process coders that don't depend on unprocessed outputs
    let changed = true;
    while (changed) {
      changed = false;
      for (let c = 0; c < folder.coders.length; c++) {
        if (processed[c] || c === excludeIdx) continue;

        // Check if all inputs are satisfied
        let inputStart = 0;
        for (let i = 0; i < c; i++) {
          inputStart += folder.coders[i].numInStreams;
        }

        let canProcess = true;
        for (let inp = 0; inp < folder.coders[c].numInStreams; inp++) {
          const globalIdx = inputStart + inp;
          // Check if bound to an unprocessed coder
          for (let bp = 0; bp < folder.bindPairs.length; bp++) {
            if (folder.bindPairs[bp].inIndex === globalIdx) {
              // Find which coder produces this output
              const outIdx = folder.bindPairs[bp].outIndex;
              let outStart = 0;
              for (let oc = 0; oc < folder.coders.length; oc++) {
                const numOut = folder.coders[oc].numOutStreams;
                if (outIdx < outStart + numOut) {
                  if (!processed[oc] && oc !== excludeIdx) {
                    canProcess = false;
                  }
                  break;
                }
                outStart += numOut;
              }
            }
          }
        }

        if (canProcess) {
          order.push(c);
          processed[c] = true;
          changed = true;
        }
      }
    }

    return order;
  }

  /**
   * Close the parser and release resources
   */
  close(): void {
    if (this.source) {
      this.source.close();
    }
  }

  // ============================================================
  // STREAMING METHODS (Phase 1+)
  // ============================================================

  /**
   * Check if a codec supports true streaming decompression.
   *
   * Only codecs that process data incrementally (not buffering entire input) qualify.
   * @param codecId - The codec ID as an array of bytes
   * @returns true if the codec can stream
   */
  private codecSupportsStreaming(codecId: number[]): boolean {
    // Convert to string key for comparison
    const key = codecId.map((b) => b.toString(16).toUpperCase()).join('-');

    // BZip2 - unbzip2-stream processes blocks incrementally
    if (key === '4-2-2') return true;

    // Copy/Store - PassThrough, obviously streams
    if (key === '0') return true;

    // Deflate - now uses zlib.createInflateRaw() which streams
    if (key === '4-1-8') return true;

    // Delta - now uses streaming Transform (Phase 2.5)
    if (key === '3') return true;

    // BCJ x86 - now uses streaming Transform (Phase 3.5)
    if (key === '3-3-1-3') return true;

    // BCJ ARM - now uses streaming Transform (Phase 3.5)
    if (key === '3-3-1-5') return true;

    // LZMA2 - now uses streaming Transform (Phase 5)
    if (key === '21') return true;

    // LZMA - still buffer-based (TODO: Phase 5 continuation)
    // Other BCJ variants (ARM64, ARMT, IA64, PPC, SPARC) - still buffer-based
    // BCJ2 - multi-stream architecture, never streamable
    return false;
  }

  /**
   * Check if a folder can be streamed (vs buffered).
   *
   * Streaming is possible when ALL codecs in the chain support streaming.
   * BCJ2 folders are never streamable due to their 4-stream architecture.
   *
   * @param folderIndex - Index of the folder to check
   * @returns true if the folder can be streamed
   */
  canStreamFolder(folderIndex: number): boolean {
    if (!this.streamsInfo) return false;

    const folder = this.streamsInfo.folders[folderIndex];
    if (!folder) return false;

    // BCJ2 requires special multi-stream handling - not streamable
    if (this.folderHasBcj2(folder)) {
      return false;
    }

    // Check if ALL codecs in chain support streaming
    for (let i = 0; i < folder.coders.length; i++) {
      if (!this.codecSupportsStreaming(folder.coders[i].id)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Stream a folder's decompression.
   *
   * Creates a pipeline: packed data → codec decoders → output stream
   *
   * @param folderIndex - Index of folder to decompress
   * @returns Object with output stream and control methods
   */
  streamFolder(folderIndex: number): {
    output: Readable;
    pause: () => void;
    resume: () => void;
    destroy: (err?: Error) => void;
  } {
    if (!this.streamsInfo) {
      throw createCodedError('No streams info available', ErrorCode.CORRUPT_HEADER);
    }

    if (!this.canStreamFolder(folderIndex)) {
      throw createCodedError('Folder does not support streaming', ErrorCode.UNSUPPORTED_CODEC);
    }

    const folder = this.streamsInfo.folders[folderIndex];

    // Calculate packed data position
    let packPos = SIGNATURE_HEADER_SIZE + this.streamsInfo.packPos;

    // Find which pack stream this folder uses
    let packStreamIndex = 0;
    for (let j = 0; j < folderIndex; j++) {
      packStreamIndex += this.streamsInfo.folders[j].packedStreams.length;
    }

    // Calculate position of this pack stream
    for (let k = 0; k < packStreamIndex; k++) {
      packPos += this.streamsInfo.packSizes[k];
    }

    const packSize = this.streamsInfo.packSizes[packStreamIndex];

    // Create readable stream from packed data
    const packedStream = this.source.createReadStream(packPos, packSize);

    // Build codec pipeline
    let stream: Readable = packedStream;
    const decoders: Stream.Transform[] = [];

    for (let i = 0; i < folder.coders.length; i++) {
      const coderInfo = folder.coders[i];
      const codec = getCodec(coderInfo.id);
      const unpackSize = folder.unpackSizes[i];
      const decoder = codec.createDecoder(coderInfo.properties, unpackSize);
      decoders.push(decoder);
      stream = stream.pipe(decoder);
    }

    return {
      output: stream,
      pause: () => packedStream.pause(),
      resume: () => packedStream.resume(),
      destroy: (err?: Error) => {
        // Check for destroy method existence (not available in Node 4 and earlier)
        const ps = packedStream as NodeJS.ReadableStream & { destroy?: (err?: Error) => void };
        if (typeof ps.destroy === 'function') ps.destroy(err);
        for (let i = 0; i < decoders.length; i++) {
          const d = decoders[i] as NodeJS.ReadableStream & { destroy?: (err?: Error) => void };
          if (typeof d.destroy === 'function') d.destroy(err);
        }
      },
    };
  }

  /**
   * Get a streaming entry stream (Promise-based API).
   *
   * For streamable folders: Returns a true streaming decompression
   * For non-streamable folders: Falls back to buffered extraction
   *
   * @param entry - The entry to get stream for
   * @returns Promise resolving to readable stream
   */
  async getEntryStreamStreaming(entry: SevenZipEntry): Promise<Readable> {
    if (!entry._hasStream || entry.type === 'directory') {
      const emptyStream = new PassThrough();
      emptyStream.end();
      return emptyStream;
    }

    const folderIndex = entry._folderIndex;

    // Fall back to buffered if not streamable
    if (!this.canStreamFolder(folderIndex)) {
      return this.getEntryStream(entry);
    }

    const filesInFolder = this.filesPerFolder[folderIndex] || 1;

    if (filesInFolder === 1) {
      // Single file - direct streaming
      return this.getEntryStreamDirect(entry);
    }
    // Multi-file folders use FolderStreamSplitter (Phase 2)
    return this.getEntryStreamFromSplitter(entry);
  }

  /**
   * Direct streaming for single-file folders.
   * Pipes folder decompression directly to output with CRC verification.
   */
  private getEntryStreamDirect(entry: SevenZipEntry): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const outputStream = new PassThrough();
      let crcValue = 0;
      const verifyCrc = entry._crc !== undefined;

      try {
        const folderStream = this.streamFolder(entry._folderIndex);

        folderStream.output.on('data', (chunk: Buffer) => {
          if (verifyCrc) {
            crcValue = crc32(chunk, crcValue);
          }

          // Handle backpressure
          if (!outputStream.write(chunk)) {
            folderStream.pause();
            outputStream.once('drain', () => folderStream.resume());
          }
        });

        folderStream.output.on('end', () => {
          // Verify CRC
          if (verifyCrc && crcValue !== entry._crc) {
            const err = createCodedError(`CRC mismatch for ${entry.path}: expected ${entry._crc?.toString(16)}, got ${crcValue.toString(16)}`, ErrorCode.CRC_MISMATCH);
            outputStream.destroy(err);
            return;
          }

          outputStream.end();

          // Track extraction
          this.extractedPerFolder[entry._folderIndex] = (this.extractedPerFolder[entry._folderIndex] || 0) + 1;
        });

        folderStream.output.on('error', (err: Error) => {
          outputStream.destroy(err);
        });

        resolve(outputStream);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Get stream from folder splitter (for multi-file folders).
   * Creates splitter on first access, reuses for subsequent files in same folder.
   */
  private getEntryStreamFromSplitter(entry: SevenZipEntry): Promise<Readable> {
    return new Promise((resolve, reject) => {
      const folderIndex = entry._folderIndex;

      // Get or create splitter for this folder
      let splitter = this.folderSplitters[folderIndex];

      if (!splitter) {
        // Create new splitter with file sizes and CRCs
        const folderInfo = this.getFolderFileInfo(folderIndex);

        splitter = new FolderStreamSplitter({
          fileSizes: folderInfo.fileSizes,
          verifyCrc: true,
          expectedCrcs: folderInfo.expectedCrcs,
        });

        this.folderSplitters[folderIndex] = splitter;

        // Start streaming the folder
        let folderStream: ReturnType<typeof this.streamFolder>;
        try {
          folderStream = this.streamFolder(folderIndex);
        } catch (err) {
          delete this.folderSplitters[folderIndex];
          reject(err);
          return;
        }

        folderStream.output.on('data', (chunk: Buffer) => {
          // Handle backpressure from splitter
          if (!splitter?.write(chunk)) {
            folderStream.pause();
            splitter?.onDrain(() => {
              folderStream.resume();
            });
          }
        });

        folderStream.output.on('end', () => {
          splitter?.end();
          delete this.folderSplitters[folderIndex];
        });

        folderStream.output.on('error', (_err: Error) => {
          splitter?.end();
          delete this.folderSplitters[folderIndex];
        });
      }

      // Get this entry's stream from splitter
      try {
        const fileStream = splitter.getFileStream(entry._streamIndexInFolder);

        // Track extraction when stream ends
        fileStream.on('end', () => {
          this.extractedPerFolder[folderIndex] = (this.extractedPerFolder[folderIndex] || 0) + 1;
        });

        resolve(fileStream);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Get file sizes and CRCs for all files in a folder (in stream order).
   * Used by FolderStreamSplitter to know file boundaries.
   */
  private getFolderFileInfo(folderIndex: number): {
    fileSizes: number[];
    expectedCrcs: (number | undefined)[];
  } {
    const fileSizes: number[] = [];
    const expectedCrcs: (number | undefined)[] = [];

    // Collect entries in this folder, sorted by stream index
    const folderEntries: SevenZipEntry[] = [];
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i];
      if (e._folderIndex === folderIndex && e._hasStream) {
        folderEntries.push(e);
      }
    }

    // Sort by stream index within folder
    folderEntries.sort((a, b) => a._streamIndexInFolder - b._streamIndexInFolder);

    for (let i = 0; i < folderEntries.length; i++) {
      const entry = folderEntries[i];
      fileSizes.push(entry.size);
      expectedCrcs.push(entry._crc);
    }

    return { fileSizes: fileSizes, expectedCrcs: expectedCrcs };
  }
}

/**
 * Get base name from a path
 */
function getBaseName(path: string): string {
  const lastSlash = path.lastIndexOf('/');
  const lastBackslash = path.lastIndexOf('\\');
  const lastSep = Math.max(lastSlash, lastBackslash);
  return lastSep >= 0 ? path.slice(lastSep + 1) : path;
}
