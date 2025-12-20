// BCJ (ARM Thumb) filter codec - converts ARM Thumb branch instruction addresses
// This filter makes ARM Thumb executables more compressible by LZMA
//
// ARM Thumb uses 16-bit instructions, but BL (branch with link) spans two 16-bit words.
// The filter converts relative addresses to absolute during compression.
//
// Reference: https://github.com/kornelski/7z/blob/main/C/Bra.c

import { bufferFrom } from 'extract-base-iterator';
import type { Transform } from 'stream';
import createBufferingDecoder from './createBufferingDecoder.ts';

/**
 * Decode ARM Thumb BCJ filtered data
 * Reverses the BCJ transformation by converting absolute addresses back to relative
 *
 * ARM Thumb BL instruction format (2 x 16-bit):
 * - First half-word: 1111 0xxx xxxx xxxx (high bits of offset)
 * - Second half-word: 1111 1xxx xxxx xxxx (low bits of offset)
 *
 * @param input - ARM Thumb BCJ filtered data
 * @param _properties - Unused for ARM Thumb BCJ
 * @param _unpackSize - Unused for ARM Thumb BCJ
 * @returns Unfiltered data
 */
export function decodeBcjArmt(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer {
  const output = bufferFrom(input); // Copy since we modify in place
  let pos = 0;

  // Process 2-byte aligned positions
  while (pos + 4 <= output.length) {
    // Read two 16-bit values (little-endian)
    const w0 = output[pos] | (output[pos + 1] << 8);
    const w1 = output[pos + 2] | (output[pos + 3] << 8);

    // Check for BL instruction pair:
    // First word: 0xF000-0xF7FF (1111 0xxx xxxx xxxx)
    // Second word: 0xF800-0xFFFF (1111 1xxx xxxx xxxx)
    if ((w0 & 0xf800) === 0xf000 && (w1 & 0xf800) === 0xf800) {
      // Extract and combine the offset parts
      // High 11 bits from w0, low 11 bits from w1
      const hi = w0 & 0x7ff;
      const lo = w1 & 0x7ff;

      // Combine into 22-bit offset (in half-words)
      let addr = (hi << 11) | lo;

      // Sign-extend 22-bit to 32-bit
      if (addr & 0x200000) {
        addr |= 0xffc00000;
      }

      // Convert absolute to relative:
      // Subtract current position (in half-words, so divide by 2)
      // Thumb PC is 2 half-words (4 bytes) ahead
      const relAddr = addr - (pos >>> 1);

      // Write back
      const newHi = (relAddr >>> 11) & 0x7ff;
      const newLo = relAddr & 0x7ff;

      output[pos] = newHi & 0xff;
      output[pos + 1] = 0xf0 | ((newHi >>> 8) & 0x07);
      output[pos + 2] = newLo & 0xff;
      output[pos + 3] = 0xf8 | ((newLo >>> 8) & 0x07);

      pos += 4;
    } else {
      pos += 2;
    }
  }

  return output;
}

/**
 * Create an ARM Thumb BCJ decoder Transform stream
 */
export function createBcjArmtDecoder(properties?: Buffer, unpackSize?: number): Transform {
  return createBufferingDecoder(decodeBcjArmt, properties, unpackSize);
}
