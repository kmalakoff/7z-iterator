// BCJ (ARM 32-bit) filter codec - converts ARM branch instruction addresses
// This filter makes ARM executables more compressible by LZMA
//
// ARM branch instructions (BL) use relative addressing. The filter converts
// these to absolute addresses during compression, and back during decompression.
//
// Reference: https://github.com/kornelski/7z/blob/main/C/Bra.c

import { bufferFrom } from 'extract-base-iterator';
import type { Transform } from 'readable-stream';
import createBufferingDecoder from './createBufferingDecoder.ts';

/**
 * Decode ARM BCJ filtered data
 * Reverses the BCJ transformation by converting absolute addresses back to relative
 *
 * ARM BL instruction format:
 * - 4 bytes aligned
 * - Byte pattern: XX XX XX EB (where EB = 0xEB opcode for BL)
 * - Lower 24 bits are signed offset (in words, not bytes)
 *
 * @param input - ARM BCJ filtered data
 * @param _properties - Unused for ARM BCJ
 * @param _unpackSize - Unused for ARM BCJ
 * @returns Unfiltered data
 */
export function decodeBcjArm(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer {
  const output = bufferFrom(input); // Copy since we modify in place
  let pos = 0;

  // Process 4-byte aligned positions
  while (pos + 4 <= output.length) {
    // Check for BL instruction: byte 3 is 0xEB
    if (output[pos + 3] === 0xeb) {
      // Read 24-bit address (little-endian in bytes 0-2)
      let addr = output[pos] | (output[pos + 1] << 8) | (output[pos + 2] << 16);

      // Sign-extend 24-bit to 32-bit
      if (addr & 0x800000) {
        addr |= 0xff000000;
      }

      // Convert absolute to relative:
      // Subtract current position (in words, so divide by 4)
      // ARM PC is 2 words (8 bytes) ahead during execution
      const relAddr = addr - (pos >>> 2);

      // Write back lower 24 bits
      output[pos] = relAddr & 0xff;
      output[pos + 1] = (relAddr >>> 8) & 0xff;
      output[pos + 2] = (relAddr >>> 16) & 0xff;
    }
    pos += 4;
  }

  return output;
}

/**
 * Create an ARM BCJ decoder Transform stream
 */
export function createBcjArmDecoder(properties?: Buffer, unpackSize?: number): Transform {
  return createBufferingDecoder(decodeBcjArm, properties, unpackSize);
}
