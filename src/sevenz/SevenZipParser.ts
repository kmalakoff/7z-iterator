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

import { crc32, PassThrough } from 'extract-base-iterator';
import type Stream from 'stream';
import type { ArchiveSource } from './ArchiveSource.ts';
import { decodeBcj2Multi, getCodec, getCodecName, isBcj2Codec, isCodecSupported } from './codecs/index.ts';
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

  constructor(source: ArchiveSource) {
    this.source = source;
  }

  /**
   * Parse the archive structure
   * Must be called before iterating entries
   */
  parse(): void {
    if (this.parsed) return;

    // Read signature header
    const sigBuf = this.source.read(0, SIGNATURE_HEADER_SIZE);
    if (sigBuf.length < SIGNATURE_HEADER_SIZE) {
      throw createCodedError('Archive too small', ErrorCode.TRUNCATED_ARCHIVE);
    }

    this.signature = parseSignatureHeader(sigBuf);

    // Read encoded header
    const headerOffset = SIGNATURE_HEADER_SIZE + this.signature.nextHeaderOffset;
    const headerBuf = this.source.read(headerOffset, this.signature.nextHeaderSize);

    if (headerBuf.length < this.signature.nextHeaderSize) {
      throw createCodedError('Truncated header', ErrorCode.TRUNCATED_ARCHIVE);
    }

    // Parse encoded header (may need decompression)
    try {
      const headerResult = parseEncodedHeader(headerBuf, this.signature.nextHeaderCRC);
      this.streamsInfo = headerResult.streamsInfo || null;
      this.filesInfo = headerResult.filesInfo;
    } catch (err: unknown) {
      const codedErr = err as CodedError;
      if (codedErr && codedErr.code === ErrorCode.COMPRESSED_HEADER) {
        // Header is compressed - need to decompress first
        this.handleCompressedHeader(headerBuf);
      } else {
        throw err;
      }
    }

    // Build entries list
    this.buildEntries();
    this.parsed = true;
  }

  /**
   * Handle compressed header (kEncodedHeader)
   */
  private handleCompressedHeader(headerBuf: Buffer): void {
    // Parse the encoded header info to get decompression parameters
    let offset = 1; // Skip kEncodedHeader byte

    // Should have StreamsInfo for the header itself
    const propertyId = headerBuf[offset++];
    if (propertyId !== PropertyId.kMainStreamsInfo && propertyId !== PropertyId.kPackInfo) {
      throw createCodedError('Expected StreamsInfo in encoded header', ErrorCode.CORRUPT_HEADER);
    }

    // For now, we parse the streams info from the encoded header block
    // This tells us how to decompress the actual header

    // Read pack info from the encoded header structure
    const packInfoResult = this.parseEncodedHeaderStreams(headerBuf, 1);

    // Calculate compressed header position
    // For simple archives: header is at SIGNATURE_HEADER_SIZE + packPos
    // For BCJ2/complex archives: header may be at the END of pack data area
    // The pack data area ends at nextHeaderOffset (where encoded header starts)
    const compressedStart = SIGNATURE_HEADER_SIZE + packInfoResult.packPos;
    const compressedData = this.source.read(compressedStart, packInfoResult.packSize);

    // Decompress using the specified codec
    const codec = getCodec(packInfoResult.codecId);
    let decompressedHeader: Buffer | null = null;

    // Try decompressing from the calculated position first
    try {
      decompressedHeader = codec.decode(compressedData, packInfoResult.properties, packInfoResult.unpackSize);
      // Verify CRC if present
      if (packInfoResult.unpackCRC !== undefined) {
        const actualCRC = crc32(decompressedHeader);
        if (actualCRC !== packInfoResult.unpackCRC) {
          decompressedHeader = null; // CRC mismatch, need to search
        }
      }
    } catch {
      decompressedHeader = null; // Decompression failed, need to search
    }

    // If initial decompression failed, search for the correct position as a fallback
    // This handles edge cases where packPos doesn't point directly to header pack data
    if (decompressedHeader === null && this.signature) {
      const packAreaEnd = SIGNATURE_HEADER_SIZE + this.signature.nextHeaderOffset;
      const searchStart = packAreaEnd - packInfoResult.packSize;
      const searchEnd = Math.max(SIGNATURE_HEADER_SIZE, compressedStart - 100000);

      // Scan for LZMA data starting with 0x00 (range coder init)
      // Try each candidate and validate with CRC
      const scanChunkSize = 4096;
      searchLoop: for (let chunkStart = searchStart; chunkStart >= searchEnd; chunkStart -= scanChunkSize) {
        const chunk = this.source.read(chunkStart, scanChunkSize + packInfoResult.packSize);
        for (let i = 0; i < Math.min(chunk.length, scanChunkSize); i++) {
          if (chunk[i] === 0x00) {
            const candidateData = chunk.subarray(i, i + packInfoResult.packSize);
            if (candidateData.length === packInfoResult.packSize) {
              try {
                const candidateDecompressed = codec.decode(candidateData, packInfoResult.properties, packInfoResult.unpackSize);
                if (packInfoResult.unpackCRC !== undefined) {
                  const candCRC = crc32(candidateDecompressed);
                  if (candCRC === packInfoResult.unpackCRC) {
                    decompressedHeader = candidateDecompressed;
                    break searchLoop;
                  }
                } else {
                  decompressedHeader = candidateDecompressed;
                  break searchLoop;
                }
              } catch {
                // Decompression failed, continue searching
              }
            }
          }
        }
      }
    }

    if (decompressedHeader === null) {
      throw createCodedError('Failed to decompress header - could not find valid LZMA data', ErrorCode.CORRUPT_HEADER);
    }

    // Now parse the decompressed header
    // It should start with kHeader
    let decompOffset = 0;
    const headerId = decompressedHeader[decompOffset++];
    if (headerId !== PropertyId.kHeader) {
      throw createCodedError('Expected kHeader in decompressed header', ErrorCode.CORRUPT_HEADER);
    }

    // Parse the decompressed header using shared function from headers.ts
    const result = parseHeaderContent(decompressedHeader, decompOffset);
    this.streamsInfo = result.streamsInfo || null;
    this.filesInfo = result.filesInfo;
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
      this.parse();
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
        setTimeout(() => {
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
        }, 0);
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
        setTimeout(() => {
          if (destroyed) return;

          try {
            const data = this.getDecompressedFolder(folderIdx);

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
          } catch (err) {
            if (!destroyed) {
              stream.destroy(err as Error);
            }
          }
        }, 0);
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
  private getDecompressedFolder(folderIndex: number): Buffer {
    // Check cache first
    if (this.decompressedCache[folderIndex]) {
      return this.decompressedCache[folderIndex];
    }

    if (!this.streamsInfo) {
      throw createCodedError('No streams info available', ErrorCode.CORRUPT_HEADER);
    }

    const folder = this.streamsInfo.folders[folderIndex];

    // Check how many files remain in this folder
    const filesInFolder = this.filesPerFolder[folderIndex] || 1;
    const extractedFromFolder = this.extractedPerFolder[folderIndex] || 0;
    const remainingFiles = filesInFolder - extractedFromFolder;
    // Only cache if more than 1 file remains (including the current one being extracted)
    const shouldCache = remainingFiles > 1;

    // Check if this folder uses BCJ2 (requires special multi-stream handling)
    if (this.folderHasBcj2(folder)) {
      const data = this.decompressBcj2Folder(folderIndex);
      if (shouldCache) {
        this.decompressedCache[folderIndex] = data;
      }
      return data;
    }

    // Calculate packed data position
    // Use Math.max to prevent 32-bit signed overflow
    const signedHeaderSize = SIGNATURE_HEADER_SIZE;
    const signedPackPos = this.streamsInfo.packPos;
    let packPos = Math.max(signedHeaderSize, 0) + Math.max(signedPackPos, 0);

    // Find which pack stream this folder uses
    let packStreamIndex = 0;
    for (let j = 0; j < folderIndex; j++) {
      packStreamIndex += this.streamsInfo.folders[j].packedStreams.length;
    }

    // Calculate position of this pack stream - PREVENT OVERFLOW
    for (let k = 0; k < packStreamIndex; k++) {
      const size = this.streamsInfo.packSizes[k];
      if (packPos + size < packPos) {
        throw createCodedError(`Pack position overflow at index ${k}`, ErrorCode.CORRUPT_ARCHIVE);
      }
      packPos += size;
    }

    const packSize = this.streamsInfo.packSizes[packStreamIndex];

    // Validate pack size to prevent overflow
    // Upper bound is Number.MAX_SAFE_INTEGER (2^53-1 = 9PB) - safe for all realistic archives
    if (packSize < 0 || packSize > Number.MAX_SAFE_INTEGER) {
      throw createCodedError(`Invalid pack size: ${packSize}`, ErrorCode.CORRUPT_ARCHIVE);
    }

    if (packPos < 0 || packPos > Number.MAX_SAFE_INTEGER) {
      throw createCodedError(`Invalid pack position: ${packPos}`, ErrorCode.CORRUPT_ARCHIVE);
    }

    // Read packed data
    const packedData = this.source.read(packPos, packSize);

    // Decompress through codec chain
    let data2 = packedData;
    for (let l = 0; l < folder.coders.length; l++) {
      const coderInfo = folder.coders[l];
      const codec = getCodec(coderInfo.id);
      // Get unpack size for this coder (needed by LZMA)
      const unpackSize = folder.unpackSizes[l];
      // Validate unpack size to prevent overflow
      if (unpackSize < 0 || unpackSize > Number.MAX_SAFE_INTEGER) {
        throw createCodedError(`Invalid unpack size: ${unpackSize}`, ErrorCode.CORRUPT_ARCHIVE);
      }
      data2 = codec.decode(data2, coderInfo.properties, unpackSize);
    }

    // Cache only if more files remain in this folder
    if (shouldCache) {
      this.decompressedCache[folderIndex] = data2;
    }

    return data2;
  }

  /**
   * Decompress a BCJ2 folder with multi-stream handling
   * BCJ2 uses 4 input streams: main, call, jump, range coder
   */
  private decompressBcj2Folder(folderIndex: number): Buffer {
    if (!this.streamsInfo) {
      throw createCodedError('No streams info available', ErrorCode.CORRUPT_HEADER);
    }

    const folder = this.streamsInfo.folders[folderIndex];

    // Calculate starting pack position
    let packPos = SIGNATURE_HEADER_SIZE + this.streamsInfo.packPos;

    // Find which pack stream index this folder starts at
    let packStreamIndex = 0;
    for (let j = 0; j < folderIndex; j++) {
      packStreamIndex += this.streamsInfo.folders[j].packedStreams.length;
    }

    // Calculate position
    for (let k = 0; k < packStreamIndex; k++) {
      packPos += this.streamsInfo.packSizes[k];
    }

    // Read all pack streams for this folder
    const numPackStreams = folder.packedStreams.length;
    const packStreams: Buffer[] = [];
    let currentPos = packPos;

    for (let p = 0; p < numPackStreams; p++) {
      const size = this.streamsInfo.packSizes[packStreamIndex + p];
      packStreams.push(this.source.read(currentPos, size));
      currentPos += size;
    }

    // Build a map of coder outputs
    // For BCJ2, typical structure is:
    //   Coder 0: LZMA2 (main stream) - 1 in, 1 out
    //   Coder 1: LZMA (call stream) - 1 in, 1 out
    //   Coder 2: LZMA (jump stream) - 1 in, 1 out
    //   Coder 3: BCJ2 - 4 in, 1 out
    // Pack streams map to: coder inputs not bound to other coder outputs

    // First, decompress each non-BCJ2 coder
    const coderOutputs: { [key: number]: Buffer } = {};

    // Find the BCJ2 coder
    let bcj2CoderIndex = -1;
    for (let c = 0; c < folder.coders.length; c++) {
      if (isBcj2Codec(folder.coders[c].id)) {
        bcj2CoderIndex = c;
        break;
      }
    }

    if (bcj2CoderIndex === -1) {
      throw createCodedError('BCJ2 coder not found in folder', ErrorCode.CORRUPT_HEADER);
    }

    // Build input stream index -> pack stream mapping
    // folder.packedStreams tells us which input indices are unbound and their order
    const inputToPackStream: { [key: number]: number } = {};
    for (let pi = 0; pi < folder.packedStreams.length; pi++) {
      inputToPackStream[folder.packedStreams[pi]] = pi;
    }

    // Build output stream index -> coder mapping
    const outputToCoder: { [key: number]: number } = {};
    let totalOutputs = 0;
    for (let co = 0; co < folder.coders.length; co++) {
      const numOut = folder.coders[co].numOutStreams;
      for (let outp = 0; outp < numOut; outp++) {
        outputToCoder[totalOutputs + outp] = co;
      }
      totalOutputs += numOut;
    }

    // Decompress non-BCJ2 coders (LZMA, LZMA2)
    // We need to process in dependency order
    const processed: { [key: number]: boolean } = {};

    const processOrder = this.getCoderProcessOrder(folder, bcj2CoderIndex);

    for (let po = 0; po < processOrder.length; po++) {
      const coderIdx = processOrder[po];
      if (coderIdx === bcj2CoderIndex) continue;

      const coder = folder.coders[coderIdx];
      const codec = getCodec(coder.id);

      // Find input for this coder
      let coderInputStart = 0;
      for (let ci2 = 0; ci2 < coderIdx; ci2++) {
        coderInputStart += folder.coders[ci2].numInStreams;
      }

      // Get input data (from pack stream)
      const inputIdx = coderInputStart;
      const packStreamIdx = inputToPackStream[inputIdx];
      const inputData = packStreams[packStreamIdx];

      // Decompress
      const unpackSize = folder.unpackSizes[coderIdx];
      const outputData = codec.decode(inputData, coder.properties, unpackSize);

      // Store in coder outputs
      let coderOutputStart = 0;
      for (let co2 = 0; co2 < coderIdx; co2++) {
        coderOutputStart += folder.coders[co2].numOutStreams;
      }
      coderOutputs[coderOutputStart] = outputData;
      processed[coderIdx] = true;
    }

    // Now process BCJ2
    // BCJ2 has 4 inputs, need to map them correctly
    // Standard order: main(LZMA2 output), call(LZMA output), jump(LZMA output), range(raw pack)
    let bcj2InputStart = 0;
    for (let ci3 = 0; ci3 < bcj2CoderIndex; ci3++) {
      bcj2InputStart += folder.coders[ci3].numInStreams;
    }

    const bcj2Inputs: Buffer[] = [];
    for (let bi = 0; bi < 4; bi++) {
      const globalIdx = bcj2InputStart + bi;

      // Check if this input is bound to a coder output
      let boundOutput = -1;
      for (let bp2 = 0; bp2 < folder.bindPairs.length; bp2++) {
        if (folder.bindPairs[bp2].inIndex === globalIdx) {
          boundOutput = folder.bindPairs[bp2].outIndex;
          break;
        }
      }

      if (boundOutput >= 0) {
        // Get from coder outputs
        bcj2Inputs.push(coderOutputs[boundOutput]);
      } else {
        // Get from pack streams
        const psIdx = inputToPackStream[globalIdx];
        bcj2Inputs.push(packStreams[psIdx]);
      }
    }

    // Get BCJ2 unpack size
    let bcj2OutputStart = 0;
    for (let co3 = 0; co3 < bcj2CoderIndex; co3++) {
      bcj2OutputStart += folder.coders[co3].numOutStreams;
    }
    const bcj2UnpackSize = folder.unpackSizes[bcj2OutputStart];

    // Memory optimization: Clear intermediate buffers to help GC
    // These are no longer needed after bcj2Inputs is built
    for (const key in coderOutputs) {
      delete coderOutputs[key];
    }
    // Clear packStreams array (allows GC to free compressed data)
    packStreams.length = 0;

    // Decode BCJ2
    return decodeBcj2Multi(bcj2Inputs, undefined, bcj2UnpackSize);
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
