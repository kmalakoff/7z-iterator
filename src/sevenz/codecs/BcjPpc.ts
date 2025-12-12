// BCJ (PowerPC) filter codec - converts PowerPC branch instruction addresses
// This filter makes PowerPC executables more compressible by LZMA
//
// PowerPC is big-endian. Branch instructions use 26-bit signed offsets.
//
// Reference: https://github.com/kornelski/7z/blob/main/C/Bra.c

import { bufferFrom } from 'extract-base-iterator';
import type { Transform } from 'readable-stream';
import createBufferingDecoder from './createBufferingDecoder.ts';

/**
 * Decode PowerPC BCJ filtered data
 * Reverses the BCJ transformation by converting absolute addresses back to relative
 *
 * PowerPC B/BL instruction format (big-endian):
 * - 4 bytes aligned
 * - Opcode 0x48 in high byte with AA=0, LK=1 (0x48000001 mask 0xFC000003)
 * - Bits 6-29 are 24-bit signed offset (in words)
 *
 * @param input - PowerPC BCJ filtered data
 * @param _properties - Unused for PowerPC BCJ
 * @param _unpackSize - Unused for PowerPC BCJ
 * @returns Unfiltered data
 */
export function decodeBcjPpc(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer {
  const output = bufferFrom(input); // Copy since we modify in place
  let pos = 0;

  // Process 4-byte aligned positions
  while (pos + 4 <= output.length) {
    // Read 32-bit value (big-endian)
    let instr = (output[pos] << 24) | (output[pos + 1] << 16) | (output[pos + 2] << 8) | output[pos + 3];

    // Check for B/BL instruction: (instr & 0xFC000003) === 0x48000001
    if ((instr & 0xfc000003) === 0x48000001) {
      // Extract 26-bit offset (bits 2-27, the LI field)
      let addr = instr & 0x03fffffc;

      // Sign-extend 26-bit to 32-bit
      if (addr & 0x02000000) {
        addr |= 0xfc000000;
      }

      // Convert absolute to relative: subtract current position
      const relAddr = addr - pos;

      // Clear old offset and write new one
      instr = (instr & 0xfc000003) | (relAddr & 0x03fffffc);

      // Write back (big-endian)
      output[pos] = (instr >>> 24) & 0xff;
      output[pos + 1] = (instr >>> 16) & 0xff;
      output[pos + 2] = (instr >>> 8) & 0xff;
      output[pos + 3] = instr & 0xff;
    }
    pos += 4;
  }

  return output;
}

/**
 * Create a PowerPC BCJ decoder Transform stream
 */
export function createBcjPpcDecoder(properties?: Buffer, unpackSize?: number): Transform {
  return createBufferingDecoder(decodeBcjPpc, properties, unpackSize);
}
