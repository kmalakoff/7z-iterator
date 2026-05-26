export declare const SEVENZ_MAGIC: number[];
export declare const SIGNATURE_HEADER_SIZE = 32;
export declare const START_HEADER_SIZE = 20;
export declare const PropertyId: {
  kEnd: number;
  kHeader: number;
  kArchiveProperties: number;
  kAdditionalStreamsInfo: number;
  kMainStreamsInfo: number;
  kFilesInfo: number;
  kPackInfo: number;
  kUnpackInfo: number;
  kSubStreamsInfo: number;
  kSize: number;
  kCRC: number;
  kFolder: number;
  kCodersUnpackSize: number;
  kNumUnpackStream: number;
  kEmptyStream: number;
  kEmptyFile: number;
  kAnti: number;
  kName: number;
  kCTime: number;
  kATime: number;
  kMTime: number;
  kWinAttributes: number;
  kComment: number;
  kEncodedHeader: number;
  kStartPos: number;
  kDummy: number;
};
export declare const CodecId: {
  COPY: number[];
  DELTA: number[];
  LZMA: number[];
  LZMA2: number[];
  BCJ_X86: number[];
  BCJ_PPC: number[];
  BCJ_IA64: number[];
  BCJ_ARM: number[];
  BCJ_ARMT: number[];
  BCJ_SPARC: number[];
  BCJ_ARM64: number[];
  BCJ2: number[];
  PPMD: number[];
  DEFLATE: number[];
  BZIP2: number[];
  AES: number[];
};
export declare const FileAttribute: {
  READONLY: number;
  HIDDEN: number;
  SYSTEM: number;
  DIRECTORY: number;
  ARCHIVE: number;
  DEVICE: number;
  NORMAL: number;
  TEMPORARY: number;
  SPARSE_FILE: number;
  REPARSE_POINT: number;
  COMPRESSED: number;
  OFFLINE: number;
  NOT_CONTENT_INDEXED: number;
  ENCRYPTED: number;
  UNIX_EXTENSION: number;
};
export declare const UnixMode: {
  DIR: number;
  FILE: number;
  SYMLINK: number;
  RWXRWXRWX: number;
  RWXRXRX: number;
  RWRR: number;
  DEFAULT_DIR: number;
  DEFAULT_FILE: number;
};
export declare const ErrorCode: {
  INVALID_SIGNATURE: string;
  CRC_MISMATCH: string;
  UNSUPPORTED_CODEC: string;
  UNSUPPORTED_VERSION: string;
  UNSUPPORTED_FEATURE: string;
  TRUNCATED_ARCHIVE: string;
  CORRUPT_ARCHIVE: string;
  CORRUPT_HEADER: string;
  ENCRYPTED_ARCHIVE: string;
  COMPRESSED_HEADER: string;
  DECOMPRESSION_FAILED: string;
};
export interface CodedError extends Error {
  code: string;
}
/**
 * Create an error with a code property
 */
export declare function createCodedError(message: string, code: string): CodedError;
