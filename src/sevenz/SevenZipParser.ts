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

import { crc32 } from 'extract-base-iterator';
import oo from 'on-one';
import Stream from 'stream';
import type { ArchiveSource } from './ArchiveSource.ts';
import { decodeBcj2Multi, getCodec, getCodecName, isBcj2Codec, isCodecSupported } from './codecs/index.ts';

// Use native streams when available, readable-stream only for Node 0.x
const major = +process.versions.node.split('.')[0];
let PassThrough: typeof Stream.PassThrough;
if (major > 0) {
  PassThrough = Stream.PassThrough;
} else {
  PassThrough = require('readable-stream').PassThrough;
}
type Readable = Stream.Readable;

import { type CodedError, createCodedError, ErrorCode, FileAttribute, PropertyId, SIGNATURE_HEADER_SIZE } from './constants.ts';
import { type FileInfo, parseEncodedHeader, parseHeaderContent, parseSignatureHeader, type SignatureHeader, type StreamsInfo } from './headers.ts';
import { readNumber } from './NumberCodec.ts';

// Re-export for backwards compatibility
export { type ArchiveSource, BufferSource, FileSource } from './ArchiveSource.ts';

// Callback type for async operations
type DecompressCallback = (err: Error | null, data?: Buffer) => void;

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
   * Get a readable stream for an entry's content
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

    // Get decompressed data for this folder (with smart caching)
    const folderIdx = entry._folderIndex;
    const data = this.getDecompressedFolder(folderIdx);

    // Calculate file offset within the decompressed block
    // For solid archives, multiple files are concatenated in the block
    let fileStart = 0;
    for (let m = 0; m < entry._streamIndexInFolder; m++) {
      // Sum sizes of all streams before this one in the folder
      const prevStreamGlobalIndex = entry._streamIndex - entry._streamIndexInFolder + m;
      fileStart += this.streamsInfo.unpackSizes[prevStreamGlobalIndex];
    }

    const fileSize = entry.size;

    // Create a PassThrough stream with the file data
    const outputStream = new PassThrough();

    // Bounds check to prevent "oob" error on older Node versions
    if (fileStart + fileSize > data.length) {
      throw createCodedError(`File data out of bounds: offset ${fileStart} + size ${fileSize} > decompressed length ${data.length}`, ErrorCode.DECOMPRESSION_FAILED);
    }

    const fileData = data.slice(fileStart, fileStart + fileSize);

    // Verify CRC if present
    if (entry._crc !== undefined) {
      const actualCRC = crc32(fileData);
      if (actualCRC !== entry._crc) {
        throw createCodedError(`CRC mismatch for ${entry.path}: expected ${entry._crc.toString(16)}, got ${actualCRC.toString(16)}`, ErrorCode.CRC_MISMATCH);
      }
    }

    outputStream.end(fileData);

    // Track extraction and release cache when all files from this folder are done
    this.extractedPerFolder[folderIdx] = (this.extractedPerFolder[folderIdx] || 0) + 1;
    if (this.extractedPerFolder[folderIdx] >= this.filesPerFolder[folderIdx]) {
      // All files from this folder extracted, release cache
      delete this.decompressedCache[folderIdx];
    }

    return outputStream;
  }

  /**
   * Get a readable stream for an entry's content (callback-based async version)
   * Uses streaming decompression for non-blocking I/O
   */
  getEntryStreamAsync(entry: SevenZipEntry, callback: (err: Error | null, stream?: Readable) => void): void {
    if (!entry._hasStream || entry.type === 'directory') {
      // Return empty stream for directories and empty files
      const emptyStream = new PassThrough();
      emptyStream.end();
      callback(null, emptyStream);
      return;
    }

    if (!this.streamsInfo) {
      callback(createCodedError('No streams info available', ErrorCode.CORRUPT_HEADER));
      return;
    }

    // Get folder info
    const folder = this.streamsInfo.folders[entry._folderIndex];
    if (!folder) {
      callback(createCodedError('Invalid folder index', ErrorCode.CORRUPT_HEADER));
      return;
    }

    // Check codec support
    for (let i = 0; i < folder.coders.length; i++) {
      const coder = folder.coders[i];
      if (!isCodecSupported(coder.id)) {
        const codecName = getCodecName(coder.id);
        callback(createCodedError(`Unsupported codec: ${codecName}`, ErrorCode.UNSUPPORTED_CODEC));
        return;
      }
    }

    // Get decompressed data for this folder using async method
    const folderIdx = entry._folderIndex;
    const streamsInfo = this.streamsInfo;

    this.getDecompressedFolderAsync(folderIdx, (err, data) => {
      if (err) return callback(err);
      if (!data) return callback(new Error('No data returned from decompression'));

      // Calculate file offset within the decompressed block
      let fileStart = 0;
      for (let m = 0; m < entry._streamIndexInFolder; m++) {
        const prevStreamGlobalIndex = entry._streamIndex - entry._streamIndexInFolder + m;
        fileStart += streamsInfo.unpackSizes[prevStreamGlobalIndex];
      }

      const fileSize = entry.size;

      // Bounds check
      if (fileStart + fileSize > data.length) {
        return callback(createCodedError(`File data out of bounds: offset ${fileStart} + size ${fileSize} > decompressed length ${data.length}`, ErrorCode.DECOMPRESSION_FAILED));
      }

      // Create a PassThrough stream with the file data
      const outputStream = new PassThrough();
      const fileData = data.slice(fileStart, fileStart + fileSize);

      // Verify CRC if present
      if (entry._crc !== undefined) {
        const actualCRC = crc32(fileData);
        if (actualCRC !== entry._crc) {
          return callback(createCodedError(`CRC mismatch for ${entry.path}: expected ${entry._crc.toString(16)}, got ${actualCRC.toString(16)}`, ErrorCode.CRC_MISMATCH));
        }
      }

      outputStream.end(fileData);

      // Track extraction and release cache when all files from this folder are done
      this.extractedPerFolder[folderIdx] = (this.extractedPerFolder[folderIdx] || 0) + 1;
      if (this.extractedPerFolder[folderIdx] >= this.filesPerFolder[folderIdx]) {
        delete this.decompressedCache[folderIdx];
      }

      callback(null, outputStream);
    });
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

    // Read packed data
    const packedData = this.source.read(packPos, packSize);

    // Decompress through codec chain
    let data2 = packedData;
    for (let l = 0; l < folder.coders.length; l++) {
      const coderInfo = folder.coders[l];
      const codec = getCodec(coderInfo.id);
      // Get unpack size for this coder (needed by LZMA)
      const unpackSize = folder.unpackSizes[l];
      data2 = codec.decode(data2, coderInfo.properties, unpackSize);
    }

    // Cache only if more files remain in this folder
    if (shouldCache) {
      this.decompressedCache[folderIndex] = data2;
    }

    return data2;
  }

  /**
   * Get decompressed data for a folder using streaming (callback-based async)
   * Uses createDecoder() streams for non-blocking decompression
   */
  private getDecompressedFolderAsync(folderIndex: number, callback: DecompressCallback): void {
    const self = this;

    // Check cache first
    if (this.decompressedCache[folderIndex]) return callback(null, this.decompressedCache[folderIndex]);

    if (!this.streamsInfo) {
      callback(createCodedError('No streams info available', ErrorCode.CORRUPT_HEADER));
      return;
    }

    const folder = this.streamsInfo.folders[folderIndex];

    // Check how many files remain in this folder
    const filesInFolder = this.filesPerFolder[folderIndex] || 1;
    const extractedFromFolder = this.extractedPerFolder[folderIndex] || 0;
    const remainingFiles = filesInFolder - extractedFromFolder;
    const shouldCache = remainingFiles > 1;

    // BCJ2 requires special handling - use sync version for now
    // TODO: Add async BCJ2 support
    if (this.folderHasBcj2(folder)) {
      try {
        const data = this.decompressBcj2Folder(folderIndex);
        if (shouldCache) {
          this.decompressedCache[folderIndex] = data;
        }
        callback(null, data);
      } catch (err) {
        callback(err as Error);
      }
      return;
    }

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

    // Read packed data
    const packedData = this.source.read(packPos, packSize);

    // Create decoder stream chain and decompress
    const coders = folder.coders;
    const unpackSizes = folder.unpackSizes;

    // Helper to decompress through a single codec stream
    function decompressWithStream(input: Buffer, coderIdx: number, cb: DecompressCallback): void {
      const coderInfo = coders[coderIdx];
      const codec = getCodec(coderInfo.id);
      const decoder = codec.createDecoder(coderInfo.properties, unpackSizes[coderIdx]);

      const chunks: Buffer[] = [];
      let errorOccurred = false;

      decoder.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      oo(decoder, ['error', 'end', 'close', 'finish'], (err?: Error) => {
        if (errorOccurred) return;
        if (err) {
          errorOccurred = true;
          return cb(err);
        }
        cb(null, Buffer.concat(chunks));
      });

      // Write input data to decoder and signal end
      decoder.end(input);
    }

    // Chain decompression through all codecs
    function decompressChain(input: Buffer, idx: number): void {
      if (idx >= coders.length) {
        // All done - cache and return
        if (shouldCache) {
          self.decompressedCache[folderIndex] = input;
        }
        callback(null, input);
        return;
      }

      decompressWithStream(input, idx, (err, output) => {
        if (err) return callback(err);
        decompressChain(output as Buffer, idx + 1);
      });
    }

    // Start the chain
    decompressChain(packedData, 0);
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
