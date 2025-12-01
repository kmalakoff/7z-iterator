// SevenZipParser - Main 7z archive parser
// Handles reading archive structure and providing file streams

import { allocBuffer, crc32 } from 'extract-base-iterator';
import fs from 'fs';
import { PassThrough, type Readable } from 'readable-stream';
import { getCodec, getCodecName, isCodecSupported } from './codecs/index.ts';
import { type CodedError, createCodedError, ErrorCode, FileAttribute, PropertyId, SIGNATURE_HEADER_SIZE } from './constants.ts';
import { type FileInfo, parseEncodedHeader, parseHeaderContent, parseSignatureHeader, type SignatureHeader, type StreamsInfo } from './headers.ts';
import { readNumber } from './NumberCodec.ts';

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
  // Cache for decompressed solid blocks (folderIndex -> decompressed data)
  private decompressedCache: { [key: number]: Buffer } = {};

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

    // Read the compressed header data
    var compressedStart = SIGNATURE_HEADER_SIZE + packInfoResult.packPos;
    var compressedData = this.source.read(compressedStart, packInfoResult.packSize);

    // Decompress using the specified codec
    var codec = getCodec(packInfoResult.codecId);
    var decompressedHeader = codec.decode(compressedData, packInfoResult.properties, packInfoResult.unpackSize);

    // Verify CRC if present
    if (packInfoResult.unpackCRC !== undefined) {
      var actualCRC = crc32(decompressedHeader);
      if (actualCRC !== packInfoResult.unpackCRC) {
        throw createCodedError('Decompressed header CRC mismatch', ErrorCode.CRC_MISMATCH);
      }
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

    // Get decompressed data for this folder (with caching for solid archives)
    var data = this.getDecompressedFolder(entry._folderIndex);

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
    var fileData = data.slice(fileStart, fileStart + fileSize);
    outputStream.end(fileData);

    return outputStream;
  }

  /**
   * Get decompressed data for a folder, with caching for solid archives
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
    var data = packedData;
    for (var l = 0; l < folder.coders.length; l++) {
      var coderInfo = folder.coders[l];
      var codec = getCodec(coderInfo.id);
      // Get unpack size for this coder (needed by LZMA)
      var unpackSize = folder.unpackSizes[l];
      data = codec.decode(data, coderInfo.properties, unpackSize);
    }

    // Cache for solid archives (when multiple files share a folder)
    this.decompressedCache[folderIndex] = data;

    return data;
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
