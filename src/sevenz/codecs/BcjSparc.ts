// BCJ (SPARC) filter codec - converts SPARC branch instruction addresses
// This filter makes SPARC executables more compressible by LZMA
//
// SPARC is big-endian. CALL instructions use 30-bit signed offsets.
// The filter only transforms CALL instructions with specific byte patterns.
//
// Reference: https://github.com/kornelski/7z/blob/main/C/Bra.c

import { bufferFrom } from 'extract-base-iterator';
import type { Transform } from 'readable-stream';
import createBufferingDecoder from './createBufferingDecoder.ts';

/**
 * Decode SPARC BCJ filtered data
 * Reverses the BCJ transformation by converting absolute addresses back to relative
 *
 * SPARC CALL instruction matching (big-endian):
 * - First byte 0x40 and (second byte & 0xC0) == 0x00, OR
 * - First byte 0x7F and (second byte & 0xC0) == 0xC0
 *
 * @param input - SPARC BCJ filtered data
 * @param _properties - Unused for SPARC BCJ
 * @param _unpackSize - Unused for SPARC BCJ
 * @returns Unfiltered data
 */
export function decodeBcjSparc(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer {
  const output = bufferFrom(input); // Copy since we modify in place
  let pos = 0;

  // Process 4-byte aligned positions
  while (pos + 4 <= output.length) {
    const b0 = output[pos];
    const b1 = output[pos + 1];

    // Check for CALL instruction with specific byte patterns:
    // (b0 == 0x40 && (b1 & 0xC0) == 0x00) || (b0 == 0x7F && (b1 & 0xC0) == 0xC0)
    if ((b0 === 0x40 && (b1 & 0xc0) === 0x00) || (b0 === 0x7f && (b1 & 0xc0) === 0xc0)) {
      // Read 32-bit value (big-endian)
      let src = (b0 << 24) | (b1 << 16) | (output[pos + 2] << 8) | output[pos + 3];

      // Shift left by 2 (multiply by 4 for word addressing)
      src <<= 2;

      // Decoding: subtract position
      let dest = src - pos;

      // Shift right by 2
      dest >>>= 2;

      // Reconstruct with sign extension and opcode
      // (((0 - ((dest >> 22) & 1)) << 22) & 0x3FFFFFFF) | (dest & 0x3FFFFF) | 0x40000000
      const signBit = (dest >>> 22) & 1;
      const signExtend = signBit ? 0x3fc00000 : 0;
      dest = signExtend | (dest & 0x3fffff) | 0x40000000;

      // Write back (big-endian)
      output[pos] = (dest >>> 24) & 0xff;
      output[pos + 1] = (dest >>> 16) & 0xff;
      output[pos + 2] = (dest >>> 8) & 0xff;
      output[pos + 3] = dest & 0xff;
    }

    pos += 4;
  }

  return output;
}

/**
 * Create a SPARC BCJ decoder Transform stream
 */
export function createBcjSparcDecoder(properties?: Buffer, unpackSize?: number): Transform {
  return createBufferingDecoder(decodeBcjSparc, properties, unpackSize);
}
