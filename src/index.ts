// LZMA decoders for external use

export type { OutputSink } from './lzma/index.ts';
export {
  createLzma2Decoder,
  createLzmaDecoder,
  decodeLzma,
  decodeLzma2,
  detectFormat,
  Lzma2Decoder,
  LzmaDecoder,
} from './lzma/index.ts';
export { default } from './SevenZipIterator.ts';
export * from './types.ts';
export { createXZDecoder, decodeXZ } from './xz/Decoder.ts';
