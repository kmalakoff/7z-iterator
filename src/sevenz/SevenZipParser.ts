// SevenZipParser - Main 7z archive parser
// Handles reading archive structure and providing file streams

import { allocBuffer, crc32 } from 'extract-base-iterator';
import fs from 'fs';
import oo from 'on-one';
import { PassThrough, type Readable } from 'readable-stream';
import { decodeBcj2Multi, getCodec, getCodecName, isBcj2Codec, isCodecSupported } from './codecs/index.ts';
import { type CodedError, createCodedError, ErrorCode, FileAttribute, PropertyId, SIGNATURE_HEADER_SIZE } from './constants.ts';
import { type FileInfo, parseEncodedHeader, parseHeaderContent, parseSignatureHeader, type SignatureHeader, type StreamsInfo } from './headers.ts';
import { readNumber } from './NumberCodec.ts';

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
}

/**
 * Archive source abstraction - allows reading from file descriptor or buffer
 */
export interface ArchiveSource {
  read(position: number, length: number): Buffer;
  getSize(): number;
  close(): void;
}

/**
 * Buffer-based archive source
 */
export class BufferSource implements ArchiveSource {
  private buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  read(position: number, length: number): Buffer {
    return this.buffer.slice(position, position + length);
  }

  getSize(): number {
    return this.buffer.length;
  }

  close(): void {
    // Nothing to close for buffer
  }
}

/**
 * File descriptor based archive source
 */
export class FileSource implements ArchiveSource {
  private fd: number;
  private size: number;

  constructor(fd: number, size: number) {
    this.fd = fd;
    this.size = size;
  }

  read(position: number, length: number): Buffer {
    var buf = allocBuffer(length);
    var bytesRead = fs.readSync(this.fd, buf, 0, length, position);
    if (bytesRead < length) {
      return buf.slice(0, bytesRead);
    }
    return buf;
  }

  getSize(): number {
    return this.size;
  }

  close(): void {
    try {
      fs.closeSync(this.fd);
    } catch (_e) {
      // Ignore close errors
    }
  }
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
    var sigBuf = this.source.read(0, SIGNATURE_HEADER_SIZE);
    if (sigBuf.length < SIGNATURE_HEADER_SIZE) {
      throw createCodedError('Archive too small', ErrorCode.TRUNCATED_ARCHIVE);
    }

    this.signature = parseSignatureHeader(sigBuf);

    // Read encoded header
    var headerOffset = SIGNATURE_HEADER_SIZE + this.signature.nextHeaderOffset;
    var headerBuf = this.source.read(headerOffset, this.signature.nextHeaderSize);

    if (headerBuf.length < this.signature.nextHeaderSize) {
      throw createCodedError('Truncated header', ErrorCode.TRUNCATED_ARCHIVE);
    }

    // Parse encoded header (may need decompression)
    try {
      var headerResult = parseEncodedHeader(headerBuf, this.signature.nextHeaderCRC);
      this.streamsInfo = headerResult.streamsInfo || null;
      this.filesInfo = headerResult.filesInfo;
    } catch (err: unknown) {
      var codedErr = err as CodedError;
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
    var offset = 1; // Skip kEncodedHeader byte

    // Should have StreamsInfo for the header itself
    var propertyId = headerBuf[offset++];
    if (propertyId !== PropertyId.kMainStreamsInfo && propertyId !== PropertyId.kPackInfo) {
      throw createCodedError('Expected StreamsInfo in encoded header', ErrorCode.CORRUPT_HEADER);
    }

    // For now, we parse the streams info from the encoded header block
    // This tells us how to decompress the actual header

    // Read pack info from the encoded header structure
    var packInfoResult = this.parseEncodedHeaderStreams(headerBuf, 1);

    // Calculate compressed header position
    // For simple archives: header is at SIGNATURE_HEADER_SIZE + packPos
    // For BCJ2/complex archives: header may be at the END of pack data area
    // The pack data area ends at nextHeaderOffset (where encoded header starts)
    var compressedStart = SIGNATURE_HEADER_SIZE + packInfoResult.packPos;
    var compressedData = this.source.read(compressedStart, packInfoResult.packSize);

    // Decompress using the specified codec
    var codec = getCodec(packInfoResult.codecId);
    var decompressedHeader: Buffer | null = null;

    // Try decompressing from the calculated position first
    try {
      decompressedHeader = codec.decode(compressedData, packInfoResult.properties, packInfoResult.unpackSize);
      // Verify CRC if present
      if (packInfoResult.unpackCRC !== undefined) {
        var actualCRC = crc32(decompressedHeader);
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
      var packAreaEnd = SIGNATURE_HEADER_SIZE + this.signature.nextHeaderOffset;
      var searchStart = packAreaEnd - packInfoResult.packSize;
      var searchEnd = Math.max(SIGNATURE_HEADER_SIZE, compressedStart - 100000);

      // Scan for LZMA data starting with 0x00 (range coder init)
      // Try each candidate and validate with CRC
      var scanChunkSize = 4096;
      searchLoop: for (var chunkStart = searchStart; chunkStart >= searchEnd; chunkStart -= scanChunkSize) {
        var chunk = this.source.read(chunkStart, scanChunkSize + packInfoResult.packSize);
        for (var i = 0; i < Math.min(chunk.length, scanChunkSize); i++) {
          if (chunk[i] === 0x00) {
            var candidateData = chunk.subarray(i, i + packInfoResult.packSize);
            if (candidateData.length === packInfoResult.packSize) {
              try {
                var candidateDecompressed = codec.decode(candidateData, packInfoResult.properties, packInfoResult.unpackSize);
                if (packInfoResult.unpackCRC !== undefined) {
                  var candCRC = crc32(candidateDecompressed);
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
    var decompOffset = 0;
    var headerId = decompressedHeader[decompOffset++];
    if (headerId !== PropertyId.kHeader) {
      throw createCodedError('Expected kHeader in decompressed header', ErrorCode.CORRUPT_HEADER);
    }

    // Parse the decompressed header using shared function from headers.ts
    var result = parseHeaderContent(decompressedHeader, decompOffset);
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
    var packPos = 0;
    var packSize = 0;
    var unpackSize = 0;
    var codecId: number[] = [];
    var properties: Buffer | undefined;
    var unpackCRC: number | undefined;

    while (offset < buf.length) {
      var propertyId = buf[offset++];

      if (propertyId === PropertyId.kEnd) {
        break;
      }

      switch (propertyId) {
        case PropertyId.kPackInfo: {
          var packPosResult = readNumber(buf, offset);
          packPos = packPosResult.value;
          offset += packPosResult.bytesRead;

          var numPackResult = readNumber(buf, offset);
          offset += numPackResult.bytesRead;

          // Read until kEnd
          while (buf[offset] !== PropertyId.kEnd) {
            if (buf[offset] === PropertyId.kSize) {
              offset++;
              var sizeResult = readNumber(buf, offset);
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
              var numFoldersResult = readNumber(buf, offset);
              offset += numFoldersResult.bytesRead;
              offset++; // external flag

              // Parse coder
              var numCodersResult = readNumber(buf, offset);
              offset += numCodersResult.bytesRead;

              var flags = buf[offset++];
              var idSize = flags & 0x0f;
              var hasAttributes = (flags & 0x20) !== 0;

              codecId = [];
              for (var i = 0; i < idSize; i++) {
                codecId.push(buf[offset++]);
              }

              if (hasAttributes) {
                var propsLenResult = readNumber(buf, offset);
                offset += propsLenResult.bytesRead;
                properties = buf.slice(offset, offset + propsLenResult.value);
                offset += propsLenResult.value;
              }
            } else if (buf[offset] === PropertyId.kCodersUnpackSize) {
              offset++;
              // Read unpack size - needed for LZMA decoder
              var unpackSizeResult = readNumber(buf, offset);
              unpackSize = unpackSizeResult.value;
              offset += unpackSizeResult.bytesRead;
            } else if (buf[offset] === PropertyId.kCRC) {
              offset++;
              var allDefined = buf[offset++];
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
      for (var i = 0; i < this.filesInfo.length; i++) {
        var file = this.filesInfo[i];
        this.entries.push(this.createEntry(file, 0, 0, 0));
      }
      return;
    }

    // Use the properly parsed numUnpackStreamsPerFolder from the archive header
    var streamsPerFolder = this.streamsInfo.numUnpackStreamsPerFolder;

    // Initialize files per folder count (for smart caching)
    for (var f = 0; f < streamsPerFolder.length; f++) {
      this.filesPerFolder[f] = streamsPerFolder[f];
      this.extractedPerFolder[f] = 0;
    }

    // Now build entries with proper folder/stream tracking
    var streamIndex = 0;
    var folderIndex = 0;
    var streamInFolder = 0;
    var folderStreamCount = streamsPerFolder[0] || 0;

    for (var j = 0; j < this.filesInfo.length; j++) {
      var fileInfo = this.filesInfo[j];

      // Get size from unpackSizes for files with streams
      var size = 0;
      if (fileInfo.hasStream && streamIndex < this.streamsInfo.unpackSizes.length) {
        size = this.streamsInfo.unpackSizes[streamIndex];
      }

      var entry = this.createEntry(fileInfo, size, folderIndex, streamInFolder);
      entry._streamIndex = streamIndex;
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
    var type: 'file' | 'directory' | 'link' = 'file';
    if (file.isDirectory) {
      type = 'directory';
    }

    // Calculate mode from Windows attributes
    var mode: number | undefined;
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
      var emptyStream = new PassThrough();
      emptyStream.end();
      return emptyStream;
    }

    if (!this.streamsInfo) {
      throw createCodedError('No streams info available', ErrorCode.CORRUPT_HEADER);
    }

    // Get folder info
    var folder = this.streamsInfo.folders[entry._folderIndex];
    if (!folder) {
      throw createCodedError('Invalid folder index', ErrorCode.CORRUPT_HEADER);
    }

    // Check codec support
    for (var i = 0; i < folder.coders.length; i++) {
      var coder = folder.coders[i];
      if (!isCodecSupported(coder.id)) {
        var codecName = getCodecName(coder.id);
        throw createCodedError(`Unsupported codec: ${codecName}`, ErrorCode.UNSUPPORTED_CODEC);
      }
    }

    // Get decompressed data for this folder (with smart caching)
    var folderIdx = entry._folderIndex;
    var data = this.getDecompressedFolder(folderIdx);

    // Calculate file offset within the decompressed block
    // For solid archives, multiple files are concatenated in the block
    var fileStart = 0;
    for (var m = 0; m < entry._streamIndexInFolder; m++) {
      // Sum sizes of all streams before this one in the folder
      var prevStreamGlobalIndex = entry._streamIndex - entry._streamIndexInFolder + m;
      fileStart += this.streamsInfo.unpackSizes[prevStreamGlobalIndex];
    }

    var fileSize = entry.size;

    // Create a PassThrough stream with the file data
    var outputStream = new PassThrough();

    // Bounds check to prevent "oob" error on older Node versions
    if (fileStart + fileSize > data.length) {
      throw createCodedError(`File data out of bounds: offset ${fileStart} + size ${fileSize} > decompressed length ${data.length}`, ErrorCode.DECOMPRESSION_FAILED);
    }

    var fileData = data.slice(fileStart, fileStart + fileSize);
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
      var emptyStream = new PassThrough();
      emptyStream.end();
      callback(null, emptyStream);
      return;
    }

    if (!this.streamsInfo) {
      callback(createCodedError('No streams info available', ErrorCode.CORRUPT_HEADER));
      return;
    }

    // Get folder info
    var folder = this.streamsInfo.folders[entry._folderIndex];
    if (!folder) {
      callback(createCodedError('Invalid folder index', ErrorCode.CORRUPT_HEADER));
      return;
    }

    // Check codec support
    for (var i = 0; i < folder.coders.length; i++) {
      var coder = folder.coders[i];
      if (!isCodecSupported(coder.id)) {
        var codecName = getCodecName(coder.id);
        callback(createCodedError(`Unsupported codec: ${codecName}`, ErrorCode.UNSUPPORTED_CODEC));
        return;
      }
    }

    // Get decompressed data for this folder using async method
    var folderIdx = entry._folderIndex;
    var streamsInfo = this.streamsInfo;

    this.getDecompressedFolderAsync(folderIdx, (err, data) => {
      if (err) return callback(err);
      if (!data) return callback(new Error('No data returned from decompression'));

      // Calculate file offset within the decompressed block
      var fileStart = 0;
      for (var m = 0; m < entry._streamIndexInFolder; m++) {
        var prevStreamGlobalIndex = entry._streamIndex - entry._streamIndexInFolder + m;
        fileStart += streamsInfo.unpackSizes[prevStreamGlobalIndex];
      }

      var fileSize = entry.size;

      // Bounds check
      if (fileStart + fileSize > data.length) {
        return callback(createCodedError(`File data out of bounds: offset ${fileStart} + size ${fileSize} > decompressed length ${data.length}`, ErrorCode.DECOMPRESSION_FAILED));
      }

      // Create a PassThrough stream with the file data
      var outputStream = new PassThrough();
      var fileData = data.slice(fileStart, fileStart + fileSize);
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
    for (var i = 0; i < folder.coders.length; i++) {
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

    var folder = this.streamsInfo.folders[folderIndex];

    // Check how many files remain in this folder
    var filesInFolder = this.filesPerFolder[folderIndex] || 1;
    var extractedFromFolder = this.extractedPerFolder[folderIndex] || 0;
    var remainingFiles = filesInFolder - extractedFromFolder;
    // Only cache if more than 1 file remains (including the current one being extracted)
    var shouldCache = remainingFiles > 1;

    // Check if this folder uses BCJ2 (requires special multi-stream handling)
    if (this.folderHasBcj2(folder)) {
      var data = this.decompressBcj2Folder(folderIndex);
      if (shouldCache) {
        this.decompressedCache[folderIndex] = data;
      }
      return data;
    }

    // Calculate packed data position
    var packPos = SIGNATURE_HEADER_SIZE + this.streamsInfo.packPos;

    // Find which pack stream this folder uses
    var packStreamIndex = 0;
    for (var j = 0; j < folderIndex; j++) {
      packStreamIndex += this.streamsInfo.folders[j].packedStreams.length;
    }

    // Calculate position of this pack stream
    for (var k = 0; k < packStreamIndex; k++) {
      packPos += this.streamsInfo.packSizes[k];
    }

    var packSize = this.streamsInfo.packSizes[packStreamIndex];

    // Read packed data
    var packedData = this.source.read(packPos, packSize);

    // Decompress through codec chain
    var data2 = packedData;
    for (var l = 0; l < folder.coders.length; l++) {
      var coderInfo = folder.coders[l];
      var codec = getCodec(coderInfo.id);
      // Get unpack size for this coder (needed by LZMA)
      var unpackSize = folder.unpackSizes[l];
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
    var self = this;

    // Check cache first
    if (this.decompressedCache[folderIndex]) {
      callback(null, this.decompressedCache[folderIndex]);
      return;
    }

    if (!this.streamsInfo) {
      callback(createCodedError('No streams info available', ErrorCode.CORRUPT_HEADER));
      return;
    }

    var folder = this.streamsInfo.folders[folderIndex];

    // Check how many files remain in this folder
    var filesInFolder = this.filesPerFolder[folderIndex] || 1;
    var extractedFromFolder = this.extractedPerFolder[folderIndex] || 0;
    var remainingFiles = filesInFolder - extractedFromFolder;
    var shouldCache = remainingFiles > 1;

    // BCJ2 requires special handling - use sync version for now
    // TODO: Add async BCJ2 support
    if (this.folderHasBcj2(folder)) {
      try {
        var data = this.decompressBcj2Folder(folderIndex);
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
    var packPos = SIGNATURE_HEADER_SIZE + this.streamsInfo.packPos;

    // Find which pack stream this folder uses
    var packStreamIndex = 0;
    for (var j = 0; j < folderIndex; j++) {
      packStreamIndex += this.streamsInfo.folders[j].packedStreams.length;
    }

    // Calculate position of this pack stream
    for (var k = 0; k < packStreamIndex; k++) {
      packPos += this.streamsInfo.packSizes[k];
    }

    var packSize = this.streamsInfo.packSizes[packStreamIndex];

    // Read packed data
    var packedData = this.source.read(packPos, packSize);

    // Create decoder stream chain and decompress
    var coders = folder.coders;
    var unpackSizes = folder.unpackSizes;

    // Helper to decompress through a single codec stream
    function decompressWithStream(input: Buffer, coderIdx: number, cb: DecompressCallback): void {
      var coderInfo = coders[coderIdx];
      var codec = getCodec(coderInfo.id);
      var decoder = codec.createDecoder(coderInfo.properties, unpackSizes[coderIdx]);

      var chunks: Buffer[] = [];
      var errorOccurred = false;

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
        if (err) {
          callback(err);
          return;
        }
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

    var folder = this.streamsInfo.folders[folderIndex];

    // Calculate starting pack position
    var packPos = SIGNATURE_HEADER_SIZE + this.streamsInfo.packPos;

    // Find which pack stream index this folder starts at
    var packStreamIndex = 0;
    for (var j = 0; j < folderIndex; j++) {
      packStreamIndex += this.streamsInfo.folders[j].packedStreams.length;
    }

    // Calculate position
    for (var k = 0; k < packStreamIndex; k++) {
      packPos += this.streamsInfo.packSizes[k];
    }

    // Read all pack streams for this folder
    var numPackStreams = folder.packedStreams.length;
    var packStreams: Buffer[] = [];
    var currentPos = packPos;

    for (var p = 0; p < numPackStreams; p++) {
      var size = this.streamsInfo.packSizes[packStreamIndex + p];
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
    var coderOutputs: { [key: number]: Buffer } = {};

    // Find the BCJ2 coder
    var bcj2CoderIndex = -1;
    for (var c = 0; c < folder.coders.length; c++) {
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
    var inputToPackStream: { [key: number]: number } = {};
    for (var pi = 0; pi < folder.packedStreams.length; pi++) {
      inputToPackStream[folder.packedStreams[pi]] = pi;
    }

    // Build output stream index -> coder mapping
    var outputToCoder: { [key: number]: number } = {};
    var totalOutputs = 0;
    for (var co = 0; co < folder.coders.length; co++) {
      var numOut = folder.coders[co].numOutStreams;
      for (var outp = 0; outp < numOut; outp++) {
        outputToCoder[totalOutputs + outp] = co;
      }
      totalOutputs += numOut;
    }

    // Decompress non-BCJ2 coders (LZMA, LZMA2)
    // We need to process in dependency order
    var processed: { [key: number]: boolean } = {};

    var processOrder = this.getCoderProcessOrder(folder, bcj2CoderIndex);

    for (var po = 0; po < processOrder.length; po++) {
      var coderIdx = processOrder[po];
      if (coderIdx === bcj2CoderIndex) continue;

      var coder = folder.coders[coderIdx];
      var codec = getCodec(coder.id);

      // Find input for this coder
      var coderInputStart = 0;
      for (var ci2 = 0; ci2 < coderIdx; ci2++) {
        coderInputStart += folder.coders[ci2].numInStreams;
      }

      // Get input data (from pack stream)
      var inputIdx = coderInputStart;
      var packStreamIdx = inputToPackStream[inputIdx];
      var inputData = packStreams[packStreamIdx];

      // Decompress
      var unpackSize = folder.unpackSizes[coderIdx];
      var outputData = codec.decode(inputData, coder.properties, unpackSize);

      // Store in coder outputs
      var coderOutputStart = 0;
      for (var co2 = 0; co2 < coderIdx; co2++) {
        coderOutputStart += folder.coders[co2].numOutStreams;
      }
      coderOutputs[coderOutputStart] = outputData;
      processed[coderIdx] = true;
    }

    // Now process BCJ2
    // BCJ2 has 4 inputs, need to map them correctly
    // Standard order: main(LZMA2 output), call(LZMA output), jump(LZMA output), range(raw pack)
    var bcj2InputStart = 0;
    for (var ci3 = 0; ci3 < bcj2CoderIndex; ci3++) {
      bcj2InputStart += folder.coders[ci3].numInStreams;
    }

    var bcj2Inputs: Buffer[] = [];
    for (var bi = 0; bi < 4; bi++) {
      var globalIdx = bcj2InputStart + bi;

      // Check if this input is bound to a coder output
      var boundOutput = -1;
      for (var bp2 = 0; bp2 < folder.bindPairs.length; bp2++) {
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
        var psIdx = inputToPackStream[globalIdx];
        bcj2Inputs.push(packStreams[psIdx]);
      }
    }

    // Get BCJ2 unpack size
    var bcj2OutputStart = 0;
    for (var co3 = 0; co3 < bcj2CoderIndex; co3++) {
      bcj2OutputStart += folder.coders[co3].numOutStreams;
    }
    var bcj2UnpackSize = folder.unpackSizes[bcj2OutputStart];

    // Memory optimization: Clear intermediate buffers to help GC
    // These are no longer needed after bcj2Inputs is built
    for (var key in coderOutputs) {
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
    var order: number[] = [];
    var processed: { [key: number]: boolean } = {};

    // Simple approach: process coders that don't depend on unprocessed outputs
    var changed = true;
    while (changed) {
      changed = false;
      for (var c = 0; c < folder.coders.length; c++) {
        if (processed[c] || c === excludeIdx) continue;

        // Check if all inputs are satisfied
        var inputStart = 0;
        for (var i = 0; i < c; i++) {
          inputStart += folder.coders[i].numInStreams;
        }

        var canProcess = true;
        for (var inp = 0; inp < folder.coders[c].numInStreams; inp++) {
          var globalIdx = inputStart + inp;
          // Check if bound to an unprocessed coder
          for (var bp = 0; bp < folder.bindPairs.length; bp++) {
            if (folder.bindPairs[bp].inIndex === globalIdx) {
              // Find which coder produces this output
              var outIdx = folder.bindPairs[bp].outIndex;
              var outStart = 0;
              for (var oc = 0; oc < folder.coders.length; oc++) {
                var numOut = folder.coders[oc].numOutStreams;
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
  var lastSlash = path.lastIndexOf('/');
  var lastBackslash = path.lastIndexOf('\\');
  var lastSep = Math.max(lastSlash, lastBackslash);
  return lastSep >= 0 ? path.slice(lastSep + 1) : path;
}
