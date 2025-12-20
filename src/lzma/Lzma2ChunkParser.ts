/**
 * LZMA2 Chunk Parser
 *
 * Shared parsing logic for LZMA2 chunk headers.
 * Used by both synchronous and streaming decoders.
 *
 * LZMA2 control byte ranges:
 * 0x00         = End of stream
 * 0x01         = Uncompressed chunk, dictionary reset
 * 0x02         = Uncompressed chunk, no dictionary reset
 * 0x80-0x9F    = LZMA chunk, no reset (solid mode)
 * 0xA0-0xBF    = LZMA chunk, reset state (probabilities)
 * 0xC0-0xDF    = LZMA chunk, reset state + new properties
 * 0xE0-0xFF    = LZMA chunk, reset dictionary + state + new properties
 */

/**
 * LZMA properties extracted from chunk header
 */
export interface LzmaChunkProps {
  lc: number;
  lp: number;
  pb: number;
}

/**
 * Parsed LZMA2 chunk information
 */
export interface Lzma2Chunk {
  /** Chunk type */
  type: 'end' | 'uncompressed' | 'lzma';
  /** Total bytes consumed by header (including control byte) */
  headerSize: number;
  /** Whether to reset dictionary */
  dictReset: boolean;
  /** Whether to reset state/probabilities */
  stateReset: boolean;
  /** New LZMA properties (only for control >= 0xC0) */
  newProps: LzmaChunkProps | null;
  /** Uncompressed data size */
  uncompSize: number;
  /** Compressed data size (0 for uncompressed chunks) */
  compSize: number;
}

/**
 * Result of parsing attempt
 */
export type ParseResult = { success: true; chunk: Lzma2Chunk } | { success: false; needBytes: number };

/**
 * Parse an LZMA2 chunk header
 *
 * @param input - Input buffer
 * @param offset - Offset to start parsing
 * @returns Parsed chunk info or number of bytes needed
 */
export function parseLzma2ChunkHeader(input: Buffer, offset: number): ParseResult {
  if (offset >= input.length) {
    return { success: false, needBytes: 1 };
  }

  const control = input[offset];

  // End of stream
  if (control === 0x00) {
    return {
      success: true,
      chunk: {
        type: 'end',
        headerSize: 1,
        dictReset: false,
        stateReset: false,
        newProps: null,
        uncompSize: 0,
        compSize: 0,
      },
    };
  }

  // Uncompressed chunk
  if (control === 0x01 || control === 0x02) {
    // Need 3 bytes: control + 2 size bytes
    if (offset + 3 > input.length) {
      return { success: false, needBytes: 3 - (input.length - offset) };
    }

    const uncompSize = ((input[offset + 1] << 8) | input[offset + 2]) + 1;

    return {
      success: true,
      chunk: {
        type: 'uncompressed',
        headerSize: 3,
        dictReset: control === 0x01,
        stateReset: false,
        newProps: null,
        uncompSize,
        compSize: 0,
      },
    };
  }

  // LZMA compressed chunk
  if (control >= 0x80) {
    const hasNewProps = control >= 0xc0;
    const minHeaderSize = hasNewProps ? 6 : 5; // control + 2 uncomp + 2 comp + (1 props)

    if (offset + minHeaderSize > input.length) {
      return { success: false, needBytes: minHeaderSize - (input.length - offset) };
    }

    // Parse sizes
    const uncompHigh = control & 0x1f;
    const uncompSize = ((uncompHigh << 16) | (input[offset + 1] << 8) | input[offset + 2]) + 1;
    const compSize = ((input[offset + 3] << 8) | input[offset + 4]) + 1;

    // Parse properties if present
    let newProps: LzmaChunkProps | null = null;
    if (hasNewProps) {
      const propsByte = input[offset + 5];
      const lc = propsByte % 9;
      const remainder = ~~(propsByte / 9);
      const lp = remainder % 5;
      const pb = ~~(remainder / 5);
      newProps = { lc, lp, pb };
    }

    return {
      success: true,
      chunk: {
        type: 'lzma',
        headerSize: minHeaderSize,
        dictReset: control >= 0xe0,
        stateReset: control >= 0xa0,
        newProps,
        uncompSize,
        compSize,
      },
    };
  }

  // Invalid control byte
  throw new Error(`Invalid LZMA2 control byte: 0x${control.toString(16)}`);
}

/** Result type for hasCompleteChunk with totalSize included on success */
export type CompleteChunkResult = { success: true; chunk: Lzma2Chunk; totalSize: number } | { success: false; needBytes: number };

/**
 * Check if we have enough data for the complete chunk (header + data)
 */
export function hasCompleteChunk(input: Buffer, offset: number): CompleteChunkResult {
  const result = parseLzma2ChunkHeader(input, offset);

  if (result.success === false) {
    return { success: false, needBytes: result.needBytes };
  }

  const { chunk } = result;
  const dataSize = chunk.type === 'uncompressed' ? chunk.uncompSize : chunk.compSize;
  const totalSize = chunk.headerSize + dataSize;

  if (offset + totalSize > input.length) {
    return { success: false, needBytes: totalSize - (input.length - offset) };
  }

  return { success: true, chunk, totalSize };
}
