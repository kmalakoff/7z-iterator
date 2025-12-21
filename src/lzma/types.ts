/**
 * LZMA Types and Constants
 *
 * Shared types, constants, and state transition functions for LZMA decoding.
 * Based on the LZMA SDK specification.
 */

// LZMA State Machine Constants
export const kNumRepDistances = 4;
export const kNumStates = 12;

// Position slot constants
export const kNumPosSlotBits = 6;
export const kDicLogSizeMin = 0;
export const kNumLenToPosStatesBits = 2;
export const kNumLenToPosStates = 1 << kNumLenToPosStatesBits; // 4

// Match length constants
export const kMatchMinLen = 2;
export const kNumLowLenBits = 3;
export const kNumMidLenBits = 3;
export const kNumHighLenBits = 8;
export const kNumLowLenSymbols = 1 << kNumLowLenBits; // 8
export const kNumMidLenSymbols = 1 << kNumMidLenBits; // 8
export const kNumLenSymbols = kNumLowLenSymbols + kNumMidLenSymbols + (1 << kNumHighLenBits); // 272
export const kMatchMaxLen = kMatchMinLen + kNumLenSymbols - 1; // 273

// Alignment constants
export const kNumAlignBits = 4;
export const kAlignTableSize = 1 << kNumAlignBits; // 16
export const kAlignMask = kAlignTableSize - 1; // 15

// Position model constants
export const kStartPosModelIndex = 4;
export const kEndPosModelIndex = 14;
export const kNumPosModels = kEndPosModelIndex - kStartPosModelIndex; // 10
export const kNumFullDistances = 1 << (kEndPosModelIndex >>> 1); // 128

// Literal/pos state constants
export const kNumLitPosStatesBitsEncodingMax = 4;
export const kNumLitContextBitsMax = 8;
export const kNumPosStatesBitsMax = 4;
export const kNumPosStatesMax = 1 << kNumPosStatesBitsMax; // 16
export const kNumPosStatesBitsEncodingMax = 4;
export const kNumPosStatesEncodingMax = 1 << kNumPosStatesBitsEncodingMax; // 16

// Range coder probability constants
export const kNumBitModelTotalBits = 11;
export const kBitModelTotal = 1 << kNumBitModelTotalBits; // 2048
export const kNumMoveBits = 5;
export const kProbInitValue = kBitModelTotal >>> 1; // 1024

/**
 * State transition: after literal byte
 */
export function stateUpdateChar(state: number): number {
  if (state < 4) return 0;
  if (state < 10) return state - 3;
  return state - 6;
}

/**
 * State transition: after match
 */
export function stateUpdateMatch(state: number): number {
  return state < 7 ? 7 : 10;
}

/**
 * State transition: after rep (repeated match)
 */
export function stateUpdateRep(state: number): number {
  return state < 7 ? 8 : 11;
}

/**
 * State transition: after short rep
 */
export function stateUpdateShortRep(state: number): number {
  return state < 7 ? 9 : 11;
}

/**
 * Check if state indicates previous symbol was a character (literal)
 */
export function stateIsCharState(state: number): boolean {
  return state < 7;
}

/**
 * Get length-to-position state index
 */
export function getLenToPosState(len: number): number {
  len -= kMatchMinLen;
  return len < kNumLenToPosStates ? len : kNumLenToPosStates - 1;
}

/**
 * Initialize probability array with default values
 * @param probs - Array to initialize (or null to create new)
 * @param count - Number of probabilities
 * @returns Initialized probability array
 */
export function initBitModels(probs: Uint16Array | null, count?: number): Uint16Array {
  if (probs === null) {
    if (count === undefined) {
      throw new Error('count required when probs is null');
    }
    probs = new Uint16Array(count);
  }
  for (let i = 0; i < probs.length; i++) {
    probs[i] = kProbInitValue;
  }
  return probs;
}

/**
 * LZMA properties parsed from the 5-byte header
 */
export interface LzmaProperties {
  /** Literal context bits (0-8) */
  lc: number;
  /** Literal pos bits (0-4) */
  lp: number;
  /** Pos bits (0-4) */
  pb: number;
  /** Dictionary size in bytes */
  dictionarySize: number;
}

/**
 * Parse LZMA properties from a 5-byte buffer
 */
export function parseProperties(properties: Buffer | Uint8Array): LzmaProperties {
  if (properties.length < 5) {
    throw new Error('LZMA properties must be at least 5 bytes');
  }

  const d = properties[0] & 0xff;
  const lc = d % 9;
  const remainder = ~~(d / 9);
  const lp = remainder % 5;
  const pb = ~~(remainder / 5);

  if (lc > kNumLitContextBitsMax || lp > 4 || pb > kNumPosStatesBitsMax) {
    throw new Error('Invalid LZMA properties');
  }

  let dictionarySize = 0;
  for (let i = 0; i < 4; i++) {
    dictionarySize |= (properties[1 + i] & 0xff) << (i * 8);
  }

  return { lc, lp, pb, dictionarySize };
}

/**
 * LZMA2 control byte meanings
 */
export const LZMA2_CONTROL = {
  END: 0x00,
  UNCOMPRESSED_RESET_DIC: 0x01,
  UNCOMPRESSED: 0x02,
  LZMA_RESET_STATE_NEW_PROP: 0xe0,
} as const;

/**
 * Check if LZMA2 control byte indicates reset state (new properties)
 */
export function lzma2NeedsNewProps(control: number): boolean {
  return control >= 0xe0;
}

/**
 * Check if LZMA2 control byte indicates reset probabilities
 */
export function lzma2NeedsResetProbs(control: number): boolean {
  return control >= 0xa0;
}

/**
 * Check if LZMA2 control byte indicates uncompressed chunk
 */
export function lzma2IsUncompressed(control: number): boolean {
  return control < 0x80;
}

/**
 * Parse LZMA2 dictionary size from property byte
 */
export function parseLzma2DictionarySize(prop: number): number {
  if (prop > 40) {
    throw new Error('Invalid LZMA2 dictionary size property');
  }
  if (prop === 40) {
    return 0xffffffff;
  }
  const base = 2 | (prop & 1);
  const exp = (prop >>> 1) + 11;
  return base << exp;
}

/**
 * Output sink interface for fast streaming decode
 * Can be a Buffer (with write method) or a stream with write() method
 */
export interface OutputSink {
  write(buffer: Buffer): void;
}
