// BCJ2 (x86-64) filter codec - advanced branch/call/jump converter
// BCJ2 uses 4 input streams and arithmetic (range) coding for better compression
// Reference: LZMA SDK Bcj2.c
//
// Stream layout:
//   Stream 0: Main data (contains literals and branch opcode markers)
//   Stream 1: CALL addresses (for 0xE8 instructions)
//   Stream 2: JUMP addresses (for 0xE9 instructions)
//   Stream 3: Range coder data (probability decisions)

import { allocBuffer } from 'extract-base-iterator';
import type { Transform } from 'stream';
import createBufferingDecoder from './createBufferingDecoder.ts';

// Range coder constants
const kTopValue = 1 << 24;
const kNumBitModelTotalBits = 11;
const kBitModelTotal = 1 << kNumBitModelTotalBits;
const kNumMoveBits = 5;

// Number of probability models:
// Index 0: conditional jumps (0x0F 0x80-0x8F)
// Index 1: JMP (0xE9)
// Indices 2-257: CALL (0xE8), indexed by previous byte
const kNumProbs = 258;

/**
 * Range decoder state
 */
interface RangeDecoder {
  range: number;
  code: number;
  stream: Buffer;
  pos: number;
}

/**
 * Initialize range decoder
 */
function initRangeDecoder(stream: Buffer): RangeDecoder {
  const rd: RangeDecoder = {
    range: 0xffffffff,
    code: 0,
    stream: stream,
    pos: 0,
  };

  // Initialize code from first 5 bytes
  for (let i = 0; i < 5; i++) {
    rd.code = (rd.code << 8) | (rd.pos < stream.length ? stream[rd.pos++] : 0);
  }

  return rd;
}

/**
 * Decode a single bit using probability model
 */
function decodeBit(rd: RangeDecoder, prob: number[], probIndex: number): number {
  const ttt = prob[probIndex];
  const bound = (rd.range >>> kNumBitModelTotalBits) * ttt;

  let symbol: number;
  if (rd.code >>> 0 < bound >>> 0) {
    rd.range = bound;
    prob[probIndex] = (ttt + ((kBitModelTotal - ttt) >>> kNumMoveBits)) | 0;
    symbol = 0;
  } else {
    rd.range = (rd.range - bound) >>> 0;
    rd.code = (rd.code - bound) >>> 0;
    prob[probIndex] = (ttt - (ttt >>> kNumMoveBits)) | 0;
    symbol = 1;
  }

  // Normalize
  if (rd.range < kTopValue) {
    rd.range = (rd.range << 8) >>> 0;
    rd.code = ((rd.code << 8) | (rd.pos < rd.stream.length ? rd.stream[rd.pos++] : 0)) >>> 0;
  }

  return symbol;
}

/**
 * BCJ2 multi-stream decoder
 * Takes 4 pre-decompressed streams and combines them
 */
export function decodeBcj2Multi(streams: Buffer[], _properties?: Buffer, unpackSize?: number): Buffer {
  if (streams.length !== 4) {
    throw new Error(`BCJ2 requires 4 input streams, got ${streams.length}`);
  }

  // Stream assignment (based on 7z bind pair convention):
  // streams[0] = main data (after LZMA2)
  // streams[1] = call stream (after LZMA)
  // streams[2] = jump stream (after LZMA)
  // streams[3] = range coder stream (uncompressed)
  const mainStream = streams[0];
  const callStream = streams[1];
  const jumpStream = streams[2];
  const rcStream = streams[3];

  // Output buffer
  const outSize = unpackSize || mainStream.length + callStream.length + jumpStream.length;
  const output = allocBuffer(outSize);
  let outPos = 0;

  // Stream positions
  let mainPos = 0;
  let callPos = 0;
  let jumpPos = 0;

  // Initialize range decoder
  const rd = initRangeDecoder(rcStream);

  // Initialize probability models
  const probs: number[] = [];
  for (let i = 0; i < kNumProbs; i++) {
    probs.push(kBitModelTotal >>> 1);
  }

  // Track previous byte for probability context
  let prevByte = 0;

  // Instruction pointer for address conversion
  let ip = 0;

  while (outPos < outSize && mainPos < mainStream.length) {
    const b = mainStream[mainPos++];

    // Check for branch opcodes
    if (b === 0xe8 || b === 0xe9) {
      // CALL (0xE8) or JMP (0xE9)
      // Use range decoder to check if this should be processed
      // Probability index: E8 uses 2 + prevByte, E9 uses 1
      const probIndex = b === 0xe8 ? 2 + prevByte : 1;
      const isMatch = decodeBit(rd, probs, probIndex);

      if (outPos >= outSize) break;
      output[outPos++] = b;
      ip++;

      if (isMatch) {
        // Read 4-byte address from appropriate stream
        const addrStream = b === 0xe8 ? callStream : jumpStream;
        const addrPos = b === 0xe8 ? callPos : jumpPos;

        if (addrPos + 4 > addrStream.length) {
          // Not enough data, copy remaining
          break;
        }

        // Check if we have room for 4 address bytes
        if (outPos + 4 > outSize) break;

        // Read as big-endian (BCJ2 stores addresses big-endian)
        let addr = (addrStream[addrPos] << 24) | (addrStream[addrPos + 1] << 16) | (addrStream[addrPos + 2] << 8) | addrStream[addrPos + 3];

        if (b === 0xe8) {
          callPos += 4;
        } else {
          jumpPos += 4;
        }

        // Convert absolute to relative address
        addr = (addr - (ip + 4)) | 0;

        // Write as little-endian
        output[outPos++] = addr & 0xff;
        output[outPos++] = (addr >>> 8) & 0xff;
        output[outPos++] = (addr >>> 16) & 0xff;
        output[outPos++] = (addr >>> 24) & 0xff;
        ip += 4;

        prevByte = (addr >>> 24) & 0xff;
      } else {
        prevByte = b;
      }
    } else if (b === 0x0f && mainPos < mainStream.length) {
      // Potential conditional jump (0x0F 0x8x)
      if (outPos >= outSize) break;
      output[outPos++] = b;
      ip++;

      const b2 = mainStream[mainPos];
      if ((b2 & 0xf0) === 0x80) {
        // Conditional jump
        mainPos++;
        // Probability index 0 for conditional jumps (since b2 != 0xE8 and b2 != 0xE9)
        const probIndex2 = 0;
        const isMatch2 = decodeBit(rd, probs, probIndex2);

        if (outPos >= outSize) break;
        output[outPos++] = b2;
        ip++;

        if (isMatch2) {
          // Read 4-byte address from jump stream
          if (jumpPos + 4 > jumpStream.length) {
            break;
          }

          // Check if we have room for 4 address bytes
          if (outPos + 4 > outSize) break;

          let addr2 = (jumpStream[jumpPos] << 24) | (jumpStream[jumpPos + 1] << 16) | (jumpStream[jumpPos + 2] << 8) | jumpStream[jumpPos + 3];
          jumpPos += 4;

          // Convert absolute to relative
          addr2 = (addr2 - (ip + 4)) | 0;

          // Write as little-endian
          output[outPos++] = addr2 & 0xff;
          output[outPos++] = (addr2 >>> 8) & 0xff;
          output[outPos++] = (addr2 >>> 16) & 0xff;
          output[outPos++] = (addr2 >>> 24) & 0xff;
          ip += 4;

          prevByte = (addr2 >>> 24) & 0xff;
        } else {
          prevByte = b2;
        }
      } else {
        prevByte = b;
      }
    } else {
      // Regular byte
      if (outPos >= outSize) break;
      output[outPos++] = b;
      ip++;
      prevByte = b;
    }
  }

  // Return only the used portion
  return outPos < output.length ? output.slice(0, outPos) : output;
}

/**
 * Single-buffer decode (for API compatibility)
 * Note: BCJ2 requires multi-stream, this throws
 */
export function decodeBcj2(_input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer {
  throw new Error('BCJ2 requires multi-stream decoding - use decodeBcj2Multi');
}

/**
 * Create a BCJ2 decoder Transform stream
 * Note: BCJ2 requires multi-stream, this is for API compatibility
 */
export function createBcj2Decoder(_properties?: Buffer, _unpackSize?: number): Transform {
  return createBufferingDecoder(decodeBcj2, _properties, _unpackSize);
}
