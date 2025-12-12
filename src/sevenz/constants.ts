// 7z format constants
// Reference: https://py7zr.readthedocs.io/en/latest/archive_format.html

// 7z signature: '7z' + magic bytes
export const SEVENZ_MAGIC = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];

// Header sizes
export const SIGNATURE_HEADER_SIZE = 32;
export const START_HEADER_SIZE = 20; // Part of signature header after magic + version

// Property IDs for encoded header
export const PropertyId = {
  kEnd: 0x00,
  kHeader: 0x01,
  kArchiveProperties: 0x02,
  kAdditionalStreamsInfo: 0x03,
  kMainStreamsInfo: 0x04,
  kFilesInfo: 0x05,
  kPackInfo: 0x06,
  kUnpackInfo: 0x07,
  kSubStreamsInfo: 0x08,
  kSize: 0x09,
  kCRC: 0x0a,
  kFolder: 0x0b,
  kCodersUnpackSize: 0x0c,
  kNumUnpackStream: 0x0d,
  kEmptyStream: 0x0e,
  kEmptyFile: 0x0f,
  kAnti: 0x10,
  kName: 0x11,
  kCTime: 0x12,
  kATime: 0x13,
  kMTime: 0x14,
  kWinAttributes: 0x15,
  kComment: 0x16,
  kEncodedHeader: 0x17,
  kStartPos: 0x18,
  kDummy: 0x19,
};

// Codec IDs
// 7z uses variable-length codec IDs
// Reference: 7za i output shows hex codec IDs (e.g., 3030501 = ARM)
export const CodecId = {
  COPY: [0x00],
  DELTA: [0x03],
  LZMA: [0x03, 0x01, 0x01],
  LZMA2: [0x21],
  BCJ_X86: [0x03, 0x03, 0x01, 0x03],
  BCJ_PPC: [0x03, 0x03, 0x02, 0x05],
  BCJ_IA64: [0x03, 0x03, 0x04, 0x01],
  BCJ_ARM: [0x03, 0x03, 0x05, 0x01],
  BCJ_ARMT: [0x03, 0x03, 0x07, 0x01],
  BCJ_SPARC: [0x03, 0x03, 0x08, 0x05],
  BCJ_ARM64: [0x03, 0x03, 0x0a, 0x01],
  BCJ2: [0x03, 0x03, 0x01, 0x1b],
  PPMD: [0x03, 0x04, 0x01],
  DEFLATE: [0x04, 0x01, 0x08],
  BZIP2: [0x04, 0x02, 0x02],
  AES: [0x06, 0xf1, 0x07, 0x01],
};

// File attribute flags (Windows style, stored in FilesInfo)
export const FileAttribute = {
  READONLY: 0x01,
  HIDDEN: 0x02,
  SYSTEM: 0x04,
  DIRECTORY: 0x10,
  ARCHIVE: 0x20,
  DEVICE: 0x40,
  NORMAL: 0x80,
  TEMPORARY: 0x100,
  SPARSE_FILE: 0x200,
  REPARSE_POINT: 0x400,
  COMPRESSED: 0x800,
  OFFLINE: 0x1000,
  NOT_CONTENT_INDEXED: 0x2000,
  ENCRYPTED: 0x4000,
  UNIX_EXTENSION: 0x8000,
};

// Unix permission modes (decimal values for Node 0.8 compatibility)
export const UnixMode = {
  DIR: 16384, // 0o40000 - directory
  FILE: 32768, // 0o100000 - regular file
  SYMLINK: 40960, // 0o120000 - symbolic link
  RWXRWXRWX: 511, // 0o777
  RWXRXRX: 493, // 0o755
  RWRR: 420, // 0o644
  DEFAULT_DIR: 493, // 0o755 - rwxr-xr-x
  DEFAULT_FILE: 420, // 0o644 - rw-r--r--
};

// Error codes
export const ErrorCode = {
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  CRC_MISMATCH: 'CRC_MISMATCH',
  UNSUPPORTED_CODEC: 'UNSUPPORTED_CODEC',
  UNSUPPORTED_VERSION: 'UNSUPPORTED_VERSION',
  UNSUPPORTED_FEATURE: 'UNSUPPORTED_FEATURE',
  TRUNCATED_ARCHIVE: 'TRUNCATED_ARCHIVE',
  CORRUPT_HEADER: 'CORRUPT_HEADER',
  ENCRYPTED_ARCHIVE: 'ENCRYPTED_ARCHIVE',
  COMPRESSED_HEADER: 'COMPRESSED_HEADER',
  DECOMPRESSION_FAILED: 'DECOMPRESSION_FAILED',
};

// Error with code property
export interface CodedError extends Error {
  code: string;
}

/**
 * Create an error with a code property
 */
export function createCodedError(message: string, code: string): CodedError {
  const err = new Error(message) as CodedError;
  err.code = code;
  return err;
}
