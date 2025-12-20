// BCJ (x86) filter codec - converts x86 CALL/JMP relative addresses
// This is a simple filter that makes executables more compressible by LZMA
//
// BCJ transforms relative addresses in x86 CALL (0xE8) and JMP (0xE9) instructions
// to absolute addresses, which creates more repetitive patterns for compression.
//
// Reference: https://github.com/jljusten/LZMA-SDK/blob/master/C/Bra86.c
//
// This implementation uses true streaming - processes data chunk by chunk
// while buffering incomplete instructions across chunk boundaries.

import { allocBuffer, bufferFrom, Transform } from 'extract-base-iterator';

/**
 * Decode BCJ (x86) filtered data (synchronous, for buffered use)
 * Reverses the BCJ transformation by converting absolute addresses back to relative
 *
 * @param input - BCJ filtered data
 * @param _properties - Unused for BCJ
 * @param _unpackSize - Unused for BCJ
 * @returns Unfiltered data
 */
export function decodeBcj(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer {
  // BCJ filter state
  let pos = 0;
  let prevMask = 0;
  const output = bufferFrom(input); // Copy since we modify in place

  while (pos < output.length - 4) {
    const b = output[pos];

    // Check for CALL (0xE8) or JMP (0xE9) opcode
    if (b !== 0xe8 && b !== 0xe9) {
      pos++;
      prevMask = 0;
      continue;
    }

    // Check mask to avoid false positives in data
    const offset = pos + 5;
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
    const addr = output[pos + 1] | (output[pos + 2] << 8) | (output[pos + 3] << 16) | ((output[pos + 4] << 24) >>> 0);

    // Check if this looks like a converted address
    // High byte should be 0x00 or 0xFF for typical code
    const highByte = output[pos + 4];

    if (highByte === 0x00 || highByte === 0xff) {
      // Convert absolute to relative
      let newAddr: number;
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
 * Create a streaming BCJ decoder Transform.
 * Processes data chunk by chunk, buffering incomplete instructions.
 */
export function createBcjDecoder(_properties?: Buffer, _unpackSize?: number): InstanceType<typeof Transform> {
  // State that persists across chunks
  let globalPos = 0; // Position in the overall stream
  let prevMask = 0;
  let pending: Buffer | null = null; // Bytes pending from previous chunk

  const transform = new Transform({
    transform: (chunk: Buffer, _encoding: string, callback: (err?: Error | null, data?: Buffer) => void) => {
      // Combine pending bytes with new chunk
      let data: Buffer;
      if (pending && pending.length > 0) {
        data = Buffer.concat([pending, chunk]);
      } else {
        data = chunk;
      }

      // We need at least 5 bytes to process an instruction
      // Keep the last 4 bytes as pending in case an instruction spans chunks
      const safeEnd = data.length - 4;
      if (safeEnd <= 0) {
        // Not enough data yet, keep it all pending
        pending = data;
        callback(null, allocBuffer(0));
        return;
      }

      const output = bufferFrom(data.slice(0, safeEnd)); // Copy the portion we'll process
      pending = data.slice(safeEnd); // Keep last 4 bytes for next chunk

      let localPos = 0;
      while (localPos < output.length) {
        const b = output[localPos];

        // Check for CALL (0xE8) or JMP (0xE9) opcode
        if (b !== 0xe8 && b !== 0xe9) {
          localPos++;
          globalPos++;
          prevMask = 0;
          continue;
        }

        // Check if we have enough bytes for the full instruction
        if (localPos + 5 > output.length + pending.length) {
          // Not enough bytes - need to wait for more data
          // This shouldn't happen with our safeEnd calculation, but be safe
          break;
        }

        // Skip if in masked region
        if ((prevMask & 1) !== 0) {
          prevMask = (prevMask >> 1) | 4;
          localPos++;
          globalPos++;
          continue;
        }

        // Get the 4 address bytes (might span into pending)
        let addr: number;
        let highByte: number;
        if (localPos + 5 <= output.length) {
          addr = output[localPos + 1] | (output[localPos + 2] << 8) | (output[localPos + 3] << 16) | ((output[localPos + 4] << 24) >>> 0);
          highByte = output[localPos + 4];
        } else {
          // Address spans output and pending - shouldn't happen with safeEnd
          localPos++;
          globalPos++;
          prevMask = 0;
          continue;
        }

        if (highByte === 0x00 || highByte === 0xff) {
          // Convert absolute to relative
          let newAddr: number;
          if (highByte === 0x00) {
            newAddr = addr - globalPos;
          } else {
            newAddr = addr + globalPos;
          }

          // Write back as little-endian
          output[localPos + 1] = newAddr & 0xff;
          output[localPos + 2] = (newAddr >>> 8) & 0xff;
          output[localPos + 3] = (newAddr >>> 16) & 0xff;
          output[localPos + 4] = (newAddr >>> 24) & 0xff;

          localPos += 5;
          globalPos += 5;
          prevMask = 0;
        } else {
          localPos++;
          globalPos++;
          prevMask = 0;
        }
      }

      callback(null, output);
    },
    flush: function (this: InstanceType<typeof Transform>, callback: (err?: Error | null) => void) {
      // Output any remaining pending bytes
      if (pending && pending.length > 0) {
        // Process the final bytes - no need to worry about spanning
        const output = bufferFrom(pending);
        // Don't convert anything in the final bytes since we can't know
        // if they're complete instructions
        this.push(output);
      }
      callback(null);
    },
  });

  return transform;
}
