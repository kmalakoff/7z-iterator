// BCJ (x86) filter codec - converts x86 CALL/JMP relative addresses
// This is a simple filter that makes executables more compressible by LZMA
//
// BCJ transforms relative addresses in x86 CALL (0xE8) and JMP (0xE9) instructions
// to absolute addresses, which creates more repetitive patterns for compression.
//
// Reference: https://github.com/jljusten/LZMA-SDK/blob/master/C/Bra86.c

import { bufferFrom } from 'extract-base-iterator';
import type { Transform } from 'readable-stream';
import createBufferingDecoder from './createBufferingDecoder.ts';

/**
 * Decode BCJ (x86) filtered data
 * Reverses the BCJ transformation by converting absolute addresses back to relative
 *
 * @param input - BCJ filtered data
 * @param _properties - Unused for BCJ
 * @param _unpackSize - Unused for BCJ
 * @returns Unfiltered data
 */
export function decodeBcj(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer {
  // BCJ filter state
  var pos = 0;
  var prevMask = 0;
  var output = bufferFrom(input); // Copy since we modify in place

  while (pos < output.length - 4) {
    var b = output[pos];

    // Check for CALL (0xE8) or JMP (0xE9) opcode
    if (b !== 0xe8 && b !== 0xe9) {
      pos++;
      prevMask = 0;
      continue;
    }

    // Check mask to avoid false positives in data
    var offset = pos + 5;
    if (offset > output.length) {
      break;
    }

    // Skip if in masked region (previous conversion affected this area)
    if ((prevMask & 1) !== 0) {
      prevMask = (prevMask >> 1) | 4;
      pos++;
      continue;
    }

    // Read the 32-bit address (little-endian)
    var addr = output[pos + 1] | (output[pos + 2] << 8) | (output[pos + 3] << 16) | ((output[pos + 4] << 24) >>> 0);

    // Check if this looks like a converted address
    // High byte should be 0x00 or 0xFF for typical code
    var highByte = output[pos + 4];

    if (highByte === 0x00 || highByte === 0xff) {
      // Convert absolute to relative
      var newAddr: number;
      if (highByte === 0x00) {
        // Positive offset - subtract position
        newAddr = addr - pos;
      } else {
        // Negative offset (0xFF high byte)
        newAddr = addr + pos;
      }

      // Write back as little-endian
      output[pos + 1] = newAddr & 0xff;
      output[pos + 2] = (newAddr >>> 8) & 0xff;
      output[pos + 3] = (newAddr >>> 16) & 0xff;
      output[pos + 4] = (newAddr >>> 24) & 0xff;

      pos += 5;
      prevMask = 0;
    } else {
      pos++;
      prevMask = 0;
    }
  }

  return output;
}

/**
 * Create a BCJ decoder Transform stream
 */
export function createBcjDecoder(properties?: Buffer, unpackSize?: number): Transform {
  return createBufferingDecoder(decodeBcj, properties, unpackSize);
}
