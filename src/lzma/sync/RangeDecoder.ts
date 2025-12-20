/**
 * Synchronous Range Decoder for LZMA
 *
 * Decodes arithmetic-coded bits from a buffer.
 * All operations are synchronous - for streaming use the async version.
 */

import { allocBuffer } from 'extract-base-iterator';

/**
 * Range decoder for synchronous buffer-based LZMA decoding
 */
export class RangeDecoder {
  private input: Buffer;
  private pos: number;
  private code: number;
  private range: number;

  constructor() {
    this.input = allocBuffer(0); // Replaced by setInput() before use
    this.pos = 0;
    this.code = 0;
    this.range = 0;
  }

  /**
   * Set input buffer and initialize decoder state
   */
  setInput(input: Buffer, offset = 0): void {
    this.input = input;
    this.pos = offset;
    this.init();
  }

  /**
   * Initialize range decoder (reads first 5 bytes)
   */
  private init(): void {
    this.code = 0;
    this.range = -1; // 0xFFFFFFFF as signed int

    // First byte is ignored (should be 0)
    this.pos++;

    // Read 4 bytes into code
    for (let i = 0; i < 4; i++) {
      this.code = (this.code << 8) | this.input[this.pos++];
    }
  }

  /**
   * Get current position in input buffer
   */
  getPosition(): number {
    return this.pos;
  }

  /**
   * Normalize range if needed (read more bytes)
   */
  private normalize(): void {
    if ((this.range & 0xff000000) === 0) {
      this.code = (this.code << 8) | this.input[this.pos++];
      this.range <<= 8;
    }
  }

  /**
   * Decode a single bit using probability model
   * @param probs - Probability array
   * @param index - Index into probability array
   * @returns Decoded bit (0 or 1)
   */
  decodeBit(probs: Uint16Array, index: number): number {
    const prob = probs[index];
    const newBound = (this.range >>> 11) * prob;

    if ((this.code ^ 0x80000000) < (newBound ^ 0x80000000)) {
      this.range = newBound;
      probs[index] += (2048 - prob) >>> 5;
      this.normalize();
      return 0;
    }
    this.range -= newBound;
    this.code -= newBound;
    probs[index] -= prob >>> 5;
    this.normalize();
    return 1;
  }

  /**
   * Decode direct bits (not probability-based)
   * @param numTotalBits - Number of bits to decode
   * @returns Decoded value
   */
  decodeDirectBits(numTotalBits: number): number {
    let result = 0;
    for (let i = numTotalBits; i > 0; i--) {
      this.range >>>= 1;
      const t = (this.code - this.range) >>> 31;
      this.code -= this.range & (t - 1);
      result = (result << 1) | (1 - t);
      this.normalize();
    }
    return result;
  }
}

/**
 * Bit tree decoder for multi-bit symbols
 */
export class BitTreeDecoder {
  private numBitLevels: number;
  private models: Uint16Array;

  constructor(numBitLevels: number) {
    this.numBitLevels = numBitLevels;
    this.models = new Uint16Array(1 << numBitLevels);
    this.init();
  }

  /**
   * Initialize probability models
   */
  init(): void {
    for (let i = 0; i < this.models.length; i++) {
      this.models[i] = 1024; // kProbInitValue
    }
  }

  /**
   * Decode a symbol (forward bit order)
   */
  decode(rangeDecoder: RangeDecoder): number {
    let m = 1;
    for (let i = this.numBitLevels; i > 0; i--) {
      m = (m << 1) | rangeDecoder.decodeBit(this.models, m);
    }
    return m - (1 << this.numBitLevels);
  }

  /**
   * Decode a symbol (reverse bit order)
   */
  reverseDecode(rangeDecoder: RangeDecoder): number {
    let m = 1;
    let symbol = 0;
    for (let i = 0; i < this.numBitLevels; i++) {
      const bit = rangeDecoder.decodeBit(this.models, m);
      m = (m << 1) | bit;
      symbol |= bit << i;
    }
    return symbol;
  }
}

/**
 * Static reverse decode from external probability array
 */
export function reverseDecodeFromArray(models: Uint16Array, startIndex: number, rangeDecoder: RangeDecoder, numBitLevels: number): number {
  let m = 1;
  let symbol = 0;
  for (let i = 0; i < numBitLevels; i++) {
    const bit = rangeDecoder.decodeBit(models, startIndex + m);
    m = (m << 1) | bit;
    symbol |= bit << i;
  }
  return symbol;
}
