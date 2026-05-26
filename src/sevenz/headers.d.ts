export interface SignatureHeader {
  majorVersion: number;
  minorVersion: number;
  startHeaderCRC: number;
  nextHeaderOffset: number;
  nextHeaderSize: number;
  nextHeaderCRC: number;
}
export interface Coder {
  id: number[];
  numInStreams: number;
  numOutStreams: number;
  properties?: Buffer;
}
export interface Folder {
  coders: Coder[];
  bindPairs: {
    inIndex: number;
    outIndex: number;
  }[];
  packedStreams: number[];
  unpackSizes: number[];
  unpackCRC?: number;
  hasCRC: boolean;
}
export interface StreamsInfo {
  packPos: number;
  packSizes: number[];
  packCRCs?: number[];
  folders: Folder[];
  numUnpackStreamsPerFolder: number[];
  unpackSizes: number[];
  unpackCRCs?: number[];
}
export interface FileInfo {
  name: string;
  size: number;
  isDirectory: boolean;
  isAntiFile: boolean;
  hasStream: boolean;
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
export declare function parseSignatureHeader(buf: Buffer): SignatureHeader;
/**
 * Parse the encoded header (metadata block at end of archive)
 */
export declare function parseEncodedHeader(
  buf: Buffer,
  expectedCRC: number
): {
  streamsInfo?: StreamsInfo;
  filesInfo: FileInfo[];
};
/**
 * Parse header content (after kHeader byte has been read)
 * Used by parseEncodedHeader and for decompressed headers
 */
export declare function parseHeaderContent(
  buf: Buffer,
  offset: number
): {
  streamsInfo?: StreamsInfo;
  filesInfo: FileInfo[];
};
