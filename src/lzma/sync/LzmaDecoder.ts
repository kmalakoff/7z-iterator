/**
 * Synchronous LZMA1 Decoder
 *
 * Decodes LZMA1 compressed data from a buffer.
 * All operations are synchronous.
 */

import { allocBufferUnsafe } from 'extract-base-iterator';
import {
  getLenToPosState,
  initBitModels,
  kEndPosModelIndex,
  kMatchMinLen,
  kNumAlignBits,
  kNumFullDistances,
  kNumLenToPosStates,
  kNumLitContextBitsMax,
  kNumPosSlotBits,
  kNumPosStatesBitsMax,
  kNumStates,
  kStartPosModelIndex,
  parseProperties,
  stateIsCharState,
  stateUpdateChar,
  stateUpdateMatch,
  stateUpdateRep,
  stateUpdateShortRep,
} from '../types.ts';
import { BitTreeDecoder, RangeDecoder, reverseDecodeFromArray } from './RangeDecoder.ts';

/**
 * Length decoder for match/rep lengths
 */
class LenDecoder {
  private choice: Uint16Array;
  private lowCoder: BitTreeDecoder[];
  private midCoder: BitTreeDecoder[];
  private highCoder: BitTreeDecoder;
  private numPosStates: number;

  constructor() {
    this.choice = initBitModels(null, 2);
    this.lowCoder = [];
    this.midCoder = [];
    this.highCoder = new BitTreeDecoder(8);
    this.numPosStates = 0;
  }

  create(numPosStates: number): void {
    for (; this.numPosStates < numPosStates; this.numPosStates++) {
      this.lowCoder[this.numPosStates] = new BitTreeDecoder(3);
      this.midCoder[this.numPosStates] = new BitTreeDecoder(3);
    }
  }

  init(): void {
    initBitModels(this.choice);
    for (let i = this.numPosStates - 1; i >= 0; i--) {
      this.lowCoder[i].init();
      this.midCoder[i].init();
    }
    this.highCoder.init();
  }

  decode(rangeDecoder: RangeDecoder, posState: number): number {
    if (rangeDecoder.decodeBit(this.choice, 0) === 0) {
      return this.lowCoder[posState].decode(rangeDecoder);
    }
    if (rangeDecoder.decodeBit(this.choice, 1) === 0) {
      return 8 + this.midCoder[posState].decode(rangeDecoder);
    }
    return 16 + this.highCoder.decode(rangeDecoder);
  }
}

/**
 * Single literal decoder (decodes one byte)
 */
class LiteralDecoder2 {
  private decoders: Uint16Array;

  constructor() {
    this.decoders = initBitModels(null, 0x300);
  }

  init(): void {
    initBitModels(this.decoders);
  }

  decodeNormal(rangeDecoder: RangeDecoder): number {
    let symbol = 1;
    do {
      symbol = (symbol << 1) | rangeDecoder.decodeBit(this.decoders, symbol);
    } while (symbol < 0x100);
    return symbol & 0xff;
  }

  decodeWithMatchByte(rangeDecoder: RangeDecoder, matchByte: number): number {
    let symbol = 1;
    do {
      const matchBit = (matchByte >> 7) & 1;
      matchByte <<= 1;
      const bit = rangeDecoder.decodeBit(this.decoders, ((1 + matchBit) << 8) + symbol);
      symbol = (symbol << 1) | bit;
      if (matchBit !== bit) {
        while (symbol < 0x100) {
          symbol = (symbol << 1) | rangeDecoder.decodeBit(this.decoders, symbol);
        }
        break;
      }
    } while (symbol < 0x100);
    return symbol & 0xff;
  }
}

/**
 * Literal decoder (array of single decoders)
 */
class LiteralDecoder {
  private numPosBits: number;
  private numPrevBits: number;
  private posMask: number;
  private coders: (LiteralDecoder2 | undefined)[];

  constructor() {
    this.numPosBits = 0;
    this.numPrevBits = 0;
    this.posMask = 0;
    this.coders = [];
  }

  create(numPosBits: number, numPrevBits: number): void {
    if (this.coders.length > 0 && this.numPrevBits === numPrevBits && this.numPosBits === numPosBits) {
      return;
    }
    this.numPosBits = numPosBits;
    this.posMask = (1 << numPosBits) - 1;
    this.numPrevBits = numPrevBits;
    this.coders = [];
  }

  init(): void {
    for (let i = 0; i < this.coders.length; i++) {
      if (this.coders[i]) {
        this.coders[i]?.init();
      }
    }
  }

  getDecoder(pos: number, prevByte: number): LiteralDecoder2 {
    const index = ((pos & this.posMask) << this.numPrevBits) + ((prevByte & 0xff) >>> (8 - this.numPrevBits));
    let decoder = this.coders[index];
    if (!decoder) {
      decoder = new LiteralDecoder2();
      this.coders[index] = decoder;
    }
    return decoder;
  }
}

/**
 * Output window (sliding dictionary)
 */
class OutWindow {
  private buffer: Buffer;
  private windowSize: number;
  private pos: number;

  constructor() {
    this.buffer = allocBufferUnsafe(0); // Replaced by create() before use
    this.windowSize = 0;
    this.pos = 0;
  }

  create(windowSize: number): void {
    if (!this.buffer || this.windowSize !== windowSize) {
      this.buffer = allocBufferUnsafe(windowSize);
    }
    this.windowSize = windowSize;
    this.pos = 0;
  }

  init(solid: boolean): void {
    if (!solid) {
      this.pos = 0;
    }
  }

  putByte(b: number): void {
    this.buffer[this.pos++] = b;
    if (this.pos >= this.windowSize) {
      this.pos = 0;
    }
  }

  getByte(distance: number): number {
    let pos = this.pos - distance - 1;
    if (pos < 0) {
      pos += this.windowSize;
    }
    return this.buffer[pos];
  }

  copyBlock(distance: number, len: number): void {
    let pos = this.pos - distance - 1;
    if (pos < 0) {
      pos += this.windowSize;
    }
    for (let i = 0; i < len; i++) {
      if (pos >= this.windowSize) {
        pos = 0;
      }
      this.putByte(this.buffer[pos++]);
    }
  }

  /**
   * Copy decoded data to output buffer
   */
  copyTo(output: Buffer, outputOffset: number, count: number): void {
    const srcPos = this.pos - count;
    if (srcPos < 0) {
      // Wrap around case - data spans end and beginning of buffer
      const firstPart = -srcPos;
      this.buffer.copy(output, outputOffset, this.windowSize + srcPos, this.windowSize);
      this.buffer.copy(output, outputOffset + firstPart, 0, count - firstPart);
    } else {
      this.buffer.copy(output, outputOffset, srcPos, srcPos + count);
    }
  }
}

/**
 * Synchronous LZMA1 decoder
 */
export class LzmaDecoder {
  private outWindow: OutWindow;
  private rangeDecoder: RangeDecoder;

  // Probability models
  private isMatchDecoders: Uint16Array;
  private isRepDecoders: Uint16Array;
  private isRepG0Decoders: Uint16Array;
  private isRepG1Decoders: Uint16Array;
  private isRepG2Decoders: Uint16Array;
  private isRep0LongDecoders: Uint16Array;
  private posSlotDecoder: BitTreeDecoder[];
  private posDecoders: Uint16Array;
  private posAlignDecoder: BitTreeDecoder;
  private lenDecoder: LenDecoder;
  private repLenDecoder: LenDecoder;
  private literalDecoder: LiteralDecoder;

  // Properties
  private dictionarySize: number;
  private dictionarySizeCheck: number;
  private posStateMask: number;

  // State (preserved across solid calls)
  private state: number;
  private rep0: number;
  private rep1: number;
  private rep2: number;
  private rep3: number;
  private prevByte: number;
  private totalPos: number;

  constructor() {
    this.outWindow = new OutWindow();
    this.rangeDecoder = new RangeDecoder();

    this.isMatchDecoders = initBitModels(null, kNumStates << kNumPosStatesBitsMax);
    this.isRepDecoders = initBitModels(null, kNumStates);
    this.isRepG0Decoders = initBitModels(null, kNumStates);
    this.isRepG1Decoders = initBitModels(null, kNumStates);
    this.isRepG2Decoders = initBitModels(null, kNumStates);
    this.isRep0LongDecoders = initBitModels(null, kNumStates << kNumPosStatesBitsMax);
    this.posSlotDecoder = [];
    this.posDecoders = initBitModels(null, kNumFullDistances - kEndPosModelIndex);
    this.posAlignDecoder = new BitTreeDecoder(kNumAlignBits);
    this.lenDecoder = new LenDecoder();
    this.repLenDecoder = new LenDecoder();
    this.literalDecoder = new LiteralDecoder();

    for (let i = 0; i < kNumLenToPosStates; i++) {
      this.posSlotDecoder[i] = new BitTreeDecoder(kNumPosSlotBits);
    }

    this.dictionarySize = -1;
    this.dictionarySizeCheck = -1;
    this.posStateMask = 0;

    this.state = 0;
    this.rep0 = 0;
    this.rep1 = 0;
    this.rep2 = 0;
    this.rep3 = 0;
    this.prevByte = 0;
    this.totalPos = 0;
  }

  /**
   * Set dictionary size
   */
  setDictionarySize(dictionarySize: number): boolean {
    if (dictionarySize < 0) return false;
    if (this.dictionarySize !== dictionarySize) {
      this.dictionarySize = dictionarySize;
      this.dictionarySizeCheck = Math.max(dictionarySize, 1);
      this.outWindow.create(Math.max(this.dictionarySizeCheck, 1 << 12));
    }
    return true;
  }

  /**
   * Set lc, lp, pb properties
   */
  setLcLpPb(lc: number, lp: number, pb: number): boolean {
    if (lc > kNumLitContextBitsMax || lp > 4 || pb > kNumPosStatesBitsMax) {
      return false;
    }
    const numPosStates = 1 << pb;
    this.literalDecoder.create(lp, lc);
    this.lenDecoder.create(numPosStates);
    this.repLenDecoder.create(numPosStates);
    this.posStateMask = numPosStates - 1;
    return true;
  }

  /**
   * Set decoder properties from 5-byte buffer
   */
  setDecoderProperties(properties: Buffer | Uint8Array): boolean {
    const props = parseProperties(properties);
    if (!this.setLcLpPb(props.lc, props.lp, props.pb)) return false;
    return this.setDictionarySize(props.dictionarySize);
  }

  /**
   * Initialize probability tables
   */
  private initProbabilities(): void {
    initBitModels(this.isMatchDecoders);
    initBitModels(this.isRepDecoders);
    initBitModels(this.isRepG0Decoders);
    initBitModels(this.isRepG1Decoders);
    initBitModels(this.isRepG2Decoders);
    initBitModels(this.isRep0LongDecoders);
    initBitModels(this.posDecoders);
    this.literalDecoder.init();
    for (let i = kNumLenToPosStates - 1; i >= 0; i--) {
      this.posSlotDecoder[i].init();
    }
    this.lenDecoder.init();
    this.repLenDecoder.init();
    this.posAlignDecoder.init();
  }

  /**
   * Reset probabilities only (for LZMA2 state reset)
   */
  resetProbabilities(): void {
    this.initProbabilities();
    this.state = 0;
    this.rep0 = 0;
    this.rep1 = 0;
    this.rep2 = 0;
    this.rep3 = 0;
  }

  /**
   * Reset dictionary position (for LZMA2 dictionary reset)
   */
  resetDictionary(): void {
    this.outWindow.init(false);
    this.totalPos = 0;
  }

  /**
   * Feed uncompressed data into the dictionary (for LZMA2 uncompressed chunks)
   * This updates the sliding window so subsequent LZMA chunks can reference this data.
   */
  feedUncompressed(data: Buffer): void {
    for (let i = 0; i < data.length; i++) {
      this.outWindow.putByte(data[i]);
    }
    this.totalPos += data.length;
    if (data.length > 0) {
      this.prevByte = data[data.length - 1];
    }
  }

  /**
   * Decode LZMA data
   * @param input - Compressed input buffer
   * @param inputOffset - Offset into input buffer
   * @param outSize - Expected output size
   * @param solid - If true, preserve state from previous decode
   * @returns Decompressed data
   */
  decode(input: Buffer, inputOffset: number, outSize: number, solid = false): Buffer {
    this.rangeDecoder.setInput(input, inputOffset);

    if (!solid) {
      this.outWindow.init(false);
      this.initProbabilities();
      this.state = 0;
      this.rep0 = 0;
      this.rep1 = 0;
      this.rep2 = 0;
      this.rep3 = 0;
      this.prevByte = 0;
      this.totalPos = 0;
    } else {
      // Solid mode: preserve dictionary state but reinitialize range decoder
      this.outWindow.init(true);
    }

    const output = allocBufferUnsafe(outSize);
    let outPos = 0;
    let cumPos = this.totalPos;

    while (outPos < outSize) {
      const posState = cumPos & this.posStateMask;

      if (this.rangeDecoder.decodeBit(this.isMatchDecoders, (this.state << kNumPosStatesBitsMax) + posState) === 0) {
        // Literal
        const decoder2 = this.literalDecoder.getDecoder(cumPos, this.prevByte);
        if (!stateIsCharState(this.state)) {
          this.prevByte = decoder2.decodeWithMatchByte(this.rangeDecoder, this.outWindow.getByte(this.rep0));
        } else {
          this.prevByte = decoder2.decodeNormal(this.rangeDecoder);
        }
        this.outWindow.putByte(this.prevByte);
        output[outPos++] = this.prevByte;
        this.state = stateUpdateChar(this.state);
        cumPos++;
      } else {
        // Match or rep
        let len: number;

        if (this.rangeDecoder.decodeBit(this.isRepDecoders, this.state) === 1) {
          // Rep match
          len = 0;
          if (this.rangeDecoder.decodeBit(this.isRepG0Decoders, this.state) === 0) {
            if (this.rangeDecoder.decodeBit(this.isRep0LongDecoders, (this.state << kNumPosStatesBitsMax) + posState) === 0) {
              this.state = stateUpdateShortRep(this.state);
              len = 1;
            }
          } else {
            let distance: number;
            if (this.rangeDecoder.decodeBit(this.isRepG1Decoders, this.state) === 0) {
              distance = this.rep1;
            } else {
              if (this.rangeDecoder.decodeBit(this.isRepG2Decoders, this.state) === 0) {
                distance = this.rep2;
              } else {
                distance = this.rep3;
                this.rep3 = this.rep2;
              }
              this.rep2 = this.rep1;
            }
            this.rep1 = this.rep0;
            this.rep0 = distance;
          }
          if (len === 0) {
            len = kMatchMinLen + this.repLenDecoder.decode(this.rangeDecoder, posState);
            this.state = stateUpdateRep(this.state);
          }
        } else {
          // Normal match
          this.rep3 = this.rep2;
          this.rep2 = this.rep1;
          this.rep1 = this.rep0;
          len = kMatchMinLen + this.lenDecoder.decode(this.rangeDecoder, posState);
          this.state = stateUpdateMatch(this.state);

          const posSlot = this.posSlotDecoder[getLenToPosState(len)].decode(this.rangeDecoder);
          if (posSlot >= kStartPosModelIndex) {
            const numDirectBits = (posSlot >> 1) - 1;
            this.rep0 = (2 | (posSlot & 1)) << numDirectBits;
            if (posSlot < kEndPosModelIndex) {
              this.rep0 += reverseDecodeFromArray(this.posDecoders, this.rep0 - posSlot - 1, this.rangeDecoder, numDirectBits);
            } else {
              this.rep0 += this.rangeDecoder.decodeDirectBits(numDirectBits - kNumAlignBits) << kNumAlignBits;
              this.rep0 += this.posAlignDecoder.reverseDecode(this.rangeDecoder);
              if (this.rep0 < 0) {
                if (this.rep0 === -1) break; // End marker
                throw new Error('LZMA: Invalid distance');
              }
            }
          } else {
            this.rep0 = posSlot;
          }
        }

        if (this.rep0 >= cumPos || this.rep0 >= this.dictionarySizeCheck) {
          throw new Error('LZMA: Invalid distance');
        }

        // Copy match bytes
        for (let i = 0; i < len; i++) {
          const b = this.outWindow.getByte(this.rep0);
          this.outWindow.putByte(b);
          output[outPos++] = b;
        }
        cumPos += len;
        this.prevByte = this.outWindow.getByte(0);
      }
    }

    this.totalPos = cumPos;
    return output;
  }
}

/**
 * Decode LZMA1 data synchronously
 * @param input - Compressed data (without 5-byte properties header)
 * @param properties - 5-byte LZMA properties
 * @param outSize - Expected output size
 * @returns Decompressed data
 */
export function decodeLzma(input: Buffer, properties: Buffer | Uint8Array, outSize: number): Buffer {
  const decoder = new LzmaDecoder();
  decoder.setDecoderProperties(properties);
  return decoder.decode(input, 0, outSize, false);
}
