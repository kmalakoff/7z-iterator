// 7z header parsing
// Reference: https://py7zr.readthedocs.io/en/latest/archive_format.html

import { bufferEquals, readUInt64LE, verifyCrc32Region } from 'extract-base-iterator';
import { createCodedError, ErrorCode, PropertyId, SEVENZ_MAGIC } from './constants.ts';
import { readDefinedVector, readNumber } from './NumberCodec.ts';

// Type definitions
export interface SignatureHeader {
  majorVersion: number;
  minorVersion: number;
  startHeaderCRC: number;
  nextHeaderOffset: number;
  nextHeaderSize: number;
  nextHeaderCRC: number;
}

export interface Coder {
  id: number[]; // Codec ID bytes
  numInStreams: number; // Number of input streams
  numOutStreams: number; // Number of output streams
  properties?: Buffer; // Optional codec properties
}

export interface Folder {
  coders: Coder[];
  bindPairs: { inIndex: number; outIndex: number }[];
  packedStreams: number[]; // Indices of packed streams
  unpackSizes: number[]; // Unpack size for each coder output
  unpackCRC?: number; // CRC of final unpacked data
  hasCRC: boolean;
}

export interface StreamsInfo {
  packPos: number; // Position of packed data (relative to end of signature header)
  packSizes: number[]; // Sizes of packed streams
  packCRCs?: number[]; // Optional CRCs for packed streams
  folders: Folder[]; // Decompression info
  numUnpackStreamsPerFolder: number[]; // Number of files in each folder (for solid archives)
  unpackSizes: number[]; // Size of each unpacked file
  unpackCRCs?: number[]; // Optional CRCs for unpacked files
}

export interface FileInfo {
  name: string;
  size: number;
  isDirectory: boolean;
  isAntiFile: boolean; // "Anti" items mark files to delete in delta archives
  hasStream: boolean; // False for empty files/directories
  crc?: number;
  ctime?: Date;
  atime?: Date;
  mtime?: Date;
  attributes?: number;
}

export interface ArchiveHeader {
  signature: SignatureHeader;
  streamsInfo?: StreamsInfo;
  filesInfo: FileInfo[];
}

/**
 * Parse the signature header (first 32 bytes)
 */
export function parseSignatureHeader(buf: Buffer): SignatureHeader {
  // Verify magic bytes
  if (!bufferEquals(buf, 0, SEVENZ_MAGIC)) {
    throw createCodedError('Not a valid 7z archive', ErrorCode.INVALID_SIGNATURE);
  }

  // Read version
  const majorVersion = buf[6];
  const minorVersion = buf[7];

  // Version check - we support 0.x (current is 0.4)
  if (majorVersion > 0) {
    throw createCodedError(`Unsupported 7z version: ${majorVersion}.${minorVersion}`, ErrorCode.UNSUPPORTED_VERSION);
  }

  // Read start header CRC (CRC of the next 20 bytes)
  const startHeaderCRC = buf.readUInt32LE(8);

  // Verify start header CRC
  if (!verifyCrc32Region(buf, 12, 20, startHeaderCRC)) {
    throw createCodedError('Start header CRC mismatch', ErrorCode.CRC_MISMATCH);
  }

  // Read next header location
  const nextHeaderOffset = readUInt64LE(buf, 12);
  const nextHeaderSize = readUInt64LE(buf, 20);
  const nextHeaderCRC = buf.readUInt32LE(28);

  return {
    majorVersion: majorVersion,
    minorVersion: minorVersion,
    startHeaderCRC: startHeaderCRC,
    nextHeaderOffset: nextHeaderOffset,
    nextHeaderSize: nextHeaderSize,
    nextHeaderCRC: nextHeaderCRC,
  };
}

/**
 * Parse the encoded header (metadata block at end of archive)
 */
export function parseEncodedHeader(buf: Buffer, expectedCRC: number): { streamsInfo?: StreamsInfo; filesInfo: FileInfo[] } {
  // Verify CRC
  if (!verifyCrc32Region(buf, 0, buf.length, expectedCRC)) {
    throw createCodedError('Encoded header CRC mismatch', ErrorCode.CRC_MISMATCH);
  }

  let offset = 0;

  // Read property ID
  const propertyId = buf[offset++];

  // Handle kEncodedHeader - means the header itself is compressed
  if (propertyId === PropertyId.kEncodedHeader) {
    // Return indicator that we need to decompress
    throw createCodedError('Compressed header - needs decompression first', ErrorCode.COMPRESSED_HEADER);
  }

  // Should be kHeader
  if (propertyId !== PropertyId.kHeader) {
    throw createCodedError(`Expected kHeader, got ${propertyId}`, ErrorCode.CORRUPT_HEADER);
  }

  // Parse header contents (after kHeader byte)
  return parseHeaderContent(buf, offset);
}

/**
 * Parse header content (after kHeader byte has been read)
 * Used by parseEncodedHeader and for decompressed headers
 */
export function parseHeaderContent(buf: Buffer, offset: number): { streamsInfo?: StreamsInfo; filesInfo: FileInfo[] } {
  const result: { streamsInfo?: StreamsInfo; filesInfo: FileInfo[] } = {
    filesInfo: [],
  };

  // Parse header contents
  while (offset < buf.length) {
    const propertyId = buf[offset++];

    if (propertyId === PropertyId.kEnd) {
      break;
    }

    switch (propertyId) {
      case PropertyId.kArchiveProperties:
        offset = skipArchiveProperties(buf, offset);
        break;
      case PropertyId.kAdditionalStreamsInfo:
        // Additional streams - skip for now
        offset = skipStreamsInfo(buf, offset);
        break;
      case PropertyId.kMainStreamsInfo: {
        const streamsResult = parseStreamsInfo(buf, offset);
        result.streamsInfo = streamsResult.info;
        offset = streamsResult.offset;
        break;
      }
      case PropertyId.kFilesInfo: {
        const filesResult = parseFilesInfo(buf, offset);
        result.filesInfo = filesResult.files;
        offset = filesResult.offset;
        break;
      }
      default:
        throw createCodedError(`Unknown property ID in header: ${propertyId}`, ErrorCode.CORRUPT_HEADER);
    }
  }

  return result;
}

/**
 * Parse StreamsInfo block
 */
function parseStreamsInfo(buf: Buffer, offset: number): { info: StreamsInfo; offset: number } {
  const info: StreamsInfo = {
    packPos: 0,
    packSizes: [],
    folders: [],
    numUnpackStreamsPerFolder: [],
    unpackSizes: [],
  };

  while (offset < buf.length) {
    const propertyId = buf[offset++];

    if (propertyId === PropertyId.kEnd) {
      break;
    }

    switch (propertyId) {
      case PropertyId.kPackInfo: {
        const packResult = parsePackInfo(buf, offset);
        info.packPos = packResult.packPos;
        info.packSizes = packResult.packSizes;
        info.packCRCs = packResult.packCRCs;
        offset = packResult.offset;
        break;
      }
      case PropertyId.kUnpackInfo: {
        const unpackResult = parseUnpackInfo(buf, offset);
        info.folders = unpackResult.folders;
        offset = unpackResult.offset;
        break;
      }
      case PropertyId.kSubStreamsInfo: {
        const subResult = parseSubStreamsInfo(buf, offset, info.folders);
        info.numUnpackStreamsPerFolder = subResult.numUnpackStreamsPerFolder;
        info.unpackSizes = subResult.unpackSizes;
        info.unpackCRCs = subResult.unpackCRCs;
        offset = subResult.offset;
        break;
      }
      default:
        throw createCodedError(`Unknown property ID in StreamsInfo: ${propertyId}`, ErrorCode.CORRUPT_HEADER);
    }
  }

  // If no SubStreamsInfo, each folder produces one file
  if (info.unpackSizes.length === 0 && info.folders.length > 0) {
    for (let i = 0; i < info.folders.length; i++) {
      const folder = info.folders[i];
      // Get the final unpack size (last coder's output)
      const finalSize = folder.unpackSizes[folder.unpackSizes.length - 1];
      info.unpackSizes.push(finalSize);
      info.numUnpackStreamsPerFolder.push(1);
    }
  }

  return { info: info, offset: offset };
}

/**
 * Parse PackInfo block
 */
function parsePackInfo(buf: Buffer, offset: number): { packPos: number; packSizes: number[]; packCRCs?: number[]; offset: number } {
  // Pack position
  const packPosResult = readNumber(buf, offset);
  const packPos = packPosResult.value;
  offset += packPosResult.bytesRead;

  // Number of pack streams
  const numPackResult = readNumber(buf, offset);
  const numPackStreams = numPackResult.value;
  offset += numPackResult.bytesRead;

  const packSizes: number[] = [];
  let packCRCs: number[] | undefined;

  while (offset < buf.length) {
    const propertyId = buf[offset++];

    if (propertyId === PropertyId.kEnd) {
      break;
    }

    if (propertyId === PropertyId.kSize) {
      for (let i = 0; i < numPackStreams; i++) {
        const sizeResult = readNumber(buf, offset);
        packSizes.push(sizeResult.value);
        offset += sizeResult.bytesRead;
      }
    } else if (propertyId === PropertyId.kCRC) {
      packCRCs = [];
      const definedResult = readDefinedVector(buf, offset, numPackStreams);
      offset += definedResult.bytesRead;
      for (let j = 0; j < numPackStreams; j++) {
        if (definedResult.defined[j]) {
          packCRCs.push(buf.readUInt32LE(offset));
          offset += 4;
        } else {
          packCRCs.push(0);
        }
      }
    }
  }

  return { packPos: packPos, packSizes: packSizes, packCRCs: packCRCs, offset: offset };
}

/**
 * Parse UnpackInfo block
 */
function parseUnpackInfo(buf: Buffer, offset: number): { folders: Folder[]; offset: number } {
  const folders: Folder[] = [];

  while (offset < buf.length) {
    const propertyId = buf[offset++];

    if (propertyId === PropertyId.kEnd) {
      break;
    }

    if (propertyId === PropertyId.kFolder) {
      // Number of folders
      const numFoldersResult = readNumber(buf, offset);
      const numFolders = numFoldersResult.value;
      offset += numFoldersResult.bytesRead;

      // External flag
      const external = buf[offset++];
      if (external !== 0) {
        throw createCodedError('External folders not supported', ErrorCode.CORRUPT_HEADER);
      }

      // Parse each folder
      for (let i = 0; i < numFolders; i++) {
        const folderResult = parseFolder(buf, offset);
        folders.push(folderResult.folder);
        offset = folderResult.offset;
      }
    } else if (propertyId === PropertyId.kCodersUnpackSize) {
      // Unpack sizes for each coder output
      for (let j = 0; j < folders.length; j++) {
        const folder = folders[j];
        folder.unpackSizes = [];
        // One unpack size per coder output stream
        let numOutputs = 0;
        for (let k = 0; k < folder.coders.length; k++) {
          numOutputs += folder.coders[k].numOutStreams;
        }
        for (let l = 0; l < numOutputs; l++) {
          const sizeResult = readNumber(buf, offset);
          folder.unpackSizes.push(sizeResult.value);
          offset += sizeResult.bytesRead;
        }
      }
    } else if (propertyId === PropertyId.kCRC) {
      // CRCs for folders
      const definedResult = readDefinedVector(buf, offset, folders.length);
      offset += definedResult.bytesRead;
      for (let m = 0; m < folders.length; m++) {
        folders[m].hasCRC = definedResult.defined[m];
        if (definedResult.defined[m]) {
          folders[m].unpackCRC = buf.readUInt32LE(offset);
          offset += 4;
        }
      }
    }
  }

  return { folders: folders, offset: offset };
}

/**
 * Parse a single Folder structure
 */
function parseFolder(buf: Buffer, offset: number): { folder: Folder; offset: number } {
  // Number of coders
  const numCodersResult = readNumber(buf, offset);
  const numCoders = numCodersResult.value;
  offset += numCodersResult.bytesRead;

  const coders: Coder[] = [];
  let numInStreamsTotal = 0;
  let numOutStreamsTotal = 0;

  for (let i = 0; i < numCoders; i++) {
    const flags = buf[offset++];
    const idSize = flags & 0x0f;
    const isComplex = (flags & 0x10) !== 0;
    const hasAttributes = (flags & 0x20) !== 0;

    // Read codec ID
    const id: number[] = [];
    for (let j = 0; j < idSize; j++) {
      id.push(buf[offset++]);
    }

    let numInStreams = 1;
    let numOutStreams = 1;

    if (isComplex) {
      const inResult = readNumber(buf, offset);
      numInStreams = inResult.value;
      offset += inResult.bytesRead;

      const outResult = readNumber(buf, offset);
      numOutStreams = outResult.value;
      offset += outResult.bytesRead;
    }

    let properties: Buffer | undefined;
    if (hasAttributes) {
      const propsLenResult = readNumber(buf, offset);
      offset += propsLenResult.bytesRead;
      properties = buf.slice(offset, offset + propsLenResult.value);
      offset += propsLenResult.value;
    }

    coders.push({
      id: id,
      numInStreams: numInStreams,
      numOutStreams: numOutStreams,
      properties: properties,
    });

    numInStreamsTotal += numInStreams;
    numOutStreamsTotal += numOutStreams;
  }

  // Bind pairs
  const numBindPairs = numOutStreamsTotal - 1;
  const bindPairs: { inIndex: number; outIndex: number }[] = [];

  for (let k = 0; k < numBindPairs; k++) {
    const inIndexResult = readNumber(buf, offset);
    offset += inIndexResult.bytesRead;

    const outIndexResult = readNumber(buf, offset);
    offset += outIndexResult.bytesRead;

    bindPairs.push({
      inIndex: inIndexResult.value,
      outIndex: outIndexResult.value,
    });
  }

  // Packed stream indices
  const numPackedStreams = numInStreamsTotal - numBindPairs;
  const packedStreams: number[] = [];

  if (numPackedStreams === 1) {
    // Find the unbound input stream
    for (let m = 0; m < numInStreamsTotal; m++) {
      let isBound = false;
      for (let n = 0; n < bindPairs.length; n++) {
        if (bindPairs[n].inIndex === m) {
          isBound = true;
          break;
        }
      }
      if (!isBound) {
        packedStreams.push(m);
        break;
      }
    }
  } else {
    for (let p = 0; p < numPackedStreams; p++) {
      const indexResult = readNumber(buf, offset);
      packedStreams.push(indexResult.value);
      offset += indexResult.bytesRead;
    }
  }

  return {
    folder: {
      coders: coders,
      bindPairs: bindPairs,
      packedStreams: packedStreams,
      unpackSizes: [],
      hasCRC: false,
    },
    offset: offset,
  };
}

/**
 * Parse SubStreamsInfo block
 */
function parseSubStreamsInfo(buf: Buffer, offset: number, folders: Folder[]): { numUnpackStreamsPerFolder: number[]; unpackSizes: number[]; unpackCRCs?: number[]; offset: number } {
  const numUnpackStreamsPerFolder: number[] = [];
  const unpackSizes: number[] = [];
  let unpackCRCs: number[] | undefined;

  // Default: 1 file per folder
  for (let i = 0; i < folders.length; i++) {
    numUnpackStreamsPerFolder.push(1);
  }

  while (offset < buf.length) {
    const propertyId = buf[offset++];

    if (propertyId === PropertyId.kEnd) {
      break;
    }

    if (propertyId === PropertyId.kNumUnpackStream) {
      for (let j = 0; j < folders.length; j++) {
        const numResult = readNumber(buf, offset);
        numUnpackStreamsPerFolder[j] = numResult.value;
        offset += numResult.bytesRead;
      }
    } else if (propertyId === PropertyId.kSize) {
      for (let k = 0; k < folders.length; k++) {
        const numStreams = numUnpackStreamsPerFolder[k];
        if (numStreams === 0) continue;

        // Read sizes for all but last stream in folder (last is calculated)
        let remaining = folders[k].unpackSizes[folders[k].unpackSizes.length - 1];
        for (let l = 0; l < numStreams - 1; l++) {
          const sizeResult = readNumber(buf, offset);
          unpackSizes.push(sizeResult.value);
          remaining -= sizeResult.value;
          offset += sizeResult.bytesRead;
        }
        // Last stream size is remainder
        unpackSizes.push(remaining);
      }
    } else if (propertyId === PropertyId.kCRC) {
      // Count files that need CRC
      let numFiles = 0;
      for (let m = 0; m < folders.length; m++) {
        const numStreamsInFolder = numUnpackStreamsPerFolder[m];
        // Only count if folder doesn't have CRC or has multiple streams
        if (!folders[m].hasCRC || numStreamsInFolder > 1) {
          numFiles += numStreamsInFolder;
        }
      }

      unpackCRCs = [];
      const definedResult = readDefinedVector(buf, offset, numFiles);
      offset += definedResult.bytesRead;
      for (let n = 0; n < numFiles; n++) {
        if (definedResult.defined[n]) {
          unpackCRCs.push(buf.readUInt32LE(offset));
          offset += 4;
        } else {
          unpackCRCs.push(0);
        }
      }
    }
  }

  // If no sizes specified, use folder unpack sizes
  if (unpackSizes.length === 0) {
    for (let p = 0; p < folders.length; p++) {
      const folder = folders[p];
      unpackSizes.push(folder.unpackSizes[folder.unpackSizes.length - 1]);
    }
  }

  return { numUnpackStreamsPerFolder: numUnpackStreamsPerFolder, unpackSizes: unpackSizes, unpackCRCs: unpackCRCs, offset: offset };
}

/**
 * Parse FilesInfo block
 */
function parseFilesInfo(buf: Buffer, offset: number): { files: FileInfo[]; offset: number } {
  // Number of files
  const numFilesResult = readNumber(buf, offset);
  const numFiles = numFilesResult.value;
  offset += numFilesResult.bytesRead;

  // Initialize files array
  const files: FileInfo[] = [];
  for (let i = 0; i < numFiles; i++) {
    files.push({
      name: '',
      size: 0,
      isDirectory: false,
      isAntiFile: false,
      hasStream: true,
    });
  }

  let emptyStreamFlags: boolean[] = [];
  let emptyFileFlags: boolean[] = [];

  while (offset < buf.length) {
    const propertyId = buf[offset++];

    if (propertyId === PropertyId.kEnd) {
      break;
    }

    // Read property size
    const propSizeResult = readNumber(buf, offset);
    const propSize = propSizeResult.value;
    offset += propSizeResult.bytesRead;

    const propEnd = offset + propSize;

    switch (propertyId) {
      case PropertyId.kEmptyStream:
        emptyStreamFlags = readBoolVector(buf, offset, numFiles);
        // Mark files that don't have streams
        for (let j = 0; j < numFiles; j++) {
          files[j].hasStream = !emptyStreamFlags[j];
        }
        break;

      case PropertyId.kEmptyFile: {
        let numEmptyStreams = 0;
        for (let k = 0; k < emptyStreamFlags.length; k++) {
          if (emptyStreamFlags[k]) numEmptyStreams++;
        }
        emptyFileFlags = readBoolVector(buf, offset, numEmptyStreams);
        break;
      }

      case PropertyId.kAnti: {
        let numAnti = 0;
        for (let l = 0; l < emptyStreamFlags.length; l++) {
          if (emptyStreamFlags[l]) numAnti++;
        }
        const antiFlags = readBoolVector(buf, offset, numAnti);
        let antiIdx = 0;
        for (let m = 0; m < numFiles; m++) {
          if (emptyStreamFlags[m]) {
            files[m].isAntiFile = antiFlags[antiIdx++];
          }
        }
        break;
      }

      case PropertyId.kName:
        offset = parseFileNames(buf, offset, files);
        break;

      case PropertyId.kCTime:
        offset = parseFileTimes(buf, offset, files, 'ctime');
        break;

      case PropertyId.kATime:
        offset = parseFileTimes(buf, offset, files, 'atime');
        break;

      case PropertyId.kMTime:
        offset = parseFileTimes(buf, offset, files, 'mtime');
        break;

      case PropertyId.kWinAttributes:
        offset = parseAttributes(buf, offset, files);
        break;

      case PropertyId.kDummy:
        // Skip dummy bytes
        break;

      default:
        // Skip unknown properties
        break;
    }

    offset = propEnd;
  }

  // Determine directories from empty stream + not empty file
  let emptyIdx = 0;
  for (let n = 0; n < numFiles; n++) {
    if (emptyStreamFlags[n]) {
      // Empty stream - could be directory or empty file
      if (emptyIdx < emptyFileFlags.length && emptyFileFlags[emptyIdx]) {
        files[n].isDirectory = false; // Empty file
      } else {
        files[n].isDirectory = true; // Directory
      }
      emptyIdx++;
    }
  }

  return { files: files, offset: offset };
}

/**
 * Read a boolean vector (bit-packed)
 */
function readBoolVector(buf: Buffer, offset: number, count: number): boolean[] {
  const result: boolean[] = [];
  let byteIdx = 0;
  let bitMask = 0x80;

  for (let i = 0; i < count; i++) {
    result.push((buf[offset + byteIdx] & bitMask) !== 0);
    bitMask = bitMask >>> 1;
    if (bitMask === 0) {
      bitMask = 0x80;
      byteIdx++;
    }
  }

  return result;
}

/**
 * Parse file names (UTF-16LE encoded)
 */
function parseFileNames(buf: Buffer, offset: number, files: FileInfo[]): number {
  // External flag
  const external = buf[offset++];
  if (external !== 0) {
    throw createCodedError('External file names not supported', ErrorCode.CORRUPT_HEADER);
  }

  // Names are UTF-16LE, null-terminated
  for (let i = 0; i < files.length; i++) {
    const nameChars: number[] = [];
    while (offset < buf.length) {
      const charCode = buf.readUInt16LE(offset);
      offset += 2;
      if (charCode === 0) break;
      nameChars.push(charCode);
    }
    files[i].name = String.fromCharCode.apply(null, nameChars);
  }

  return offset;
}

/**
 * Parse file times (Windows FILETIME format)
 */
function parseFileTimes(buf: Buffer, offset: number, files: FileInfo[], timeType: 'ctime' | 'atime' | 'mtime'): number {
  // Read defined vector (allDefined byte + optional bitmask)
  const definedResult = readDefinedVector(buf, offset, files.length);
  offset += definedResult.bytesRead;

  // External flag - 0x00 means data follows inline, non-zero means external stream
  const external = buf[offset++];
  if (external !== 0) {
    throw createCodedError('External file times not supported', ErrorCode.UNSUPPORTED_FEATURE);
  }

  // Read times
  for (let i = 0; i < files.length; i++) {
    if (definedResult.defined[i]) {
      const filetime = readUInt64LE(buf, offset);
      offset += 8;
      // Convert FILETIME (100ns since 1601) to JavaScript Date
      // FILETIME epoch: 1601-01-01
      // JS Date epoch: 1970-01-01
      // Difference: 11644473600 seconds
      const ms = filetime / 10000 - 11644473600000;
      files[i][timeType] = new Date(ms);
    }
  }

  return offset;
}

/**
 * Parse Windows file attributes
 */
function parseAttributes(buf: Buffer, offset: number, files: FileInfo[]): number {
  // Read defined vector (allDefined byte + optional bitmask)
  const definedResult = readDefinedVector(buf, offset, files.length);
  offset += definedResult.bytesRead;

  // External flag - 0x00 means data follows inline, non-zero means external stream
  const external = buf[offset++];
  if (external !== 0) {
    throw createCodedError('External file attributes not supported', ErrorCode.UNSUPPORTED_FEATURE);
  }

  // Read attributes
  for (let i = 0; i < files.length; i++) {
    if (definedResult.defined[i]) {
      files[i].attributes = buf.readUInt32LE(offset);
      offset += 4;
    }
  }

  return offset;
}

/**
 * Skip archive properties block
 */
function skipArchiveProperties(buf: Buffer, offset: number): number {
  while (offset < buf.length) {
    const propertyId = buf[offset++];
    if (propertyId === PropertyId.kEnd) {
      break;
    }
    const sizeResult = readNumber(buf, offset);
    offset += sizeResult.bytesRead + sizeResult.value;
  }
  return offset;
}

/**
 * Skip streams info block (for additional streams)
 */
function skipStreamsInfo(buf: Buffer, offset: number): number {
  while (offset < buf.length) {
    const propertyId = buf[offset++];
    if (propertyId === PropertyId.kEnd) {
      break;
    }
    // For nested structures, recurse
    if (propertyId === PropertyId.kPackInfo || propertyId === PropertyId.kUnpackInfo || propertyId === PropertyId.kSubStreamsInfo) {
      offset = skipStreamsInfo(buf, offset);
    }
  }
  return offset;
}
