// BCJ (ARM64/AArch64) filter codec - converts ARM64 branch instruction addresses
// This filter makes ARM64 executables more compressible by LZMA
//
// ARM64 uses 32-bit fixed-width instructions. Branch instructions use 26-bit signed offsets.
//
// Reference: https://github.com/kornelski/7z/blob/main/C/Bra.c

import { bufferFrom } from 'extract-base-iterator';
import type { Transform } from 'stream';
import createBufferingDecoder from './createBufferingDecoder.ts';

/**
 * Decode ARM64 BCJ filtered data
 * Reverses the BCJ transformation by converting absolute addresses back to relative
 *
 * ARM64 B/BL instruction format (little-endian):
 * - 4 bytes aligned
 * - B: opcode 0x14 (000101xx)
 * - BL: opcode 0x94 (100101xx)
 * - Bits 0-25 are 26-bit signed offset (in words)
 *
 * @param input - ARM64 BCJ filtered data
 * @param _properties - Unused for ARM64 BCJ
 * @param _unpackSize - Unused for ARM64 BCJ
 * @returns Unfiltered data
 */
export function decodeBcjArm64(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer {
  const output = bufferFrom(input); // Copy since we modify in place
  let pos = 0;

  // Process 4-byte aligned positions
  while (pos + 4 <= output.length) {
    // Read 32-bit value (little-endian)
    let instr = output[pos] | (output[pos + 1] << 8) | (output[pos + 2] << 16) | ((output[pos + 3] << 24) >>> 0);

    // Check for B/BL instruction: (instr & 0x7C000000) === 0x14000000
    // This matches both B (0x14000000) and BL (0x94000000)
    if ((instr & 0x7c000000) === 0x14000000) {
      // Extract 26-bit offset
      let addr = instr & 0x03ffffff;

      // Sign-extend 26-bit to 32-bit
      if (addr & 0x02000000) {
        addr |= 0xfc000000;
      }

      // Convert absolute to relative: subtract current position (in words)
      const relAddr = addr - (pos >>> 2);

      // Clear old offset and write new one, preserve opcode
      instr = (instr & 0xfc000000) | (relAddr & 0x03ffffff);

      // Write back (little-endian)
      output[pos] = instr & 0xff;
      output[pos + 1] = (instr >>> 8) & 0xff;
      output[pos + 2] = (instr >>> 16) & 0xff;
      output[pos + 3] = (instr >>> 24) & 0xff;
    }

    pos += 4;
  }

  return output;
}

/**
 * Create an ARM64 BCJ decoder Transform stream
 */
export function createBcjArm64Decoder(properties?: Buffer, unpackSize?: number): Transform {
  return createBufferingDecoder(decodeBcjArm64, properties, unpackSize);
}
