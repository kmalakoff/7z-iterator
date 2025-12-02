// BCJ (IA64/Itanium) filter codec - converts IA64 branch instruction addresses
// This filter makes IA64 executables more compressible by LZMA
//
// IA64 uses 128-bit instruction bundles with 3 instructions per bundle.
// Branch instructions use 21-bit signed offsets (in bundles).
//
// Reference: https://github.com/kornelski/7z/blob/main/C/Bra.c

import { bufferFrom } from 'extract-base-iterator';
import type { Transform } from 'readable-stream';
import createBufferingDecoder from './createBufferingDecoder.ts';

// IA64 branch instruction slot mask
// Each bundle has a 5-bit template and 3 x 41-bit instruction slots
var kBranchTable = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 4, 4, 6, 6, 0, 0, 7, 7, 4, 4, 0, 0, 4, 4, 0, 0];

/**
 * Decode IA64 BCJ filtered data
 * Reverses the BCJ transformation by converting absolute addresses back to relative
 *
 * @param input - IA64 BCJ filtered data
 * @param _properties - Unused for IA64 BCJ
 * @param _unpackSize - Unused for IA64 BCJ
 * @returns Unfiltered data
 */
export function decodeBcjIa64(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer {
  var output = bufferFrom(input); // Copy since we modify in place
  var pos = 0;

  // Process 16-byte aligned bundles
  while (pos + 16 <= output.length) {
    // Get template (low 5 bits of first byte)
    var template = output[pos] & 0x1f;
    var mask = kBranchTable[template];

    // Check each instruction slot (3 slots per bundle)
    for (var slot = 0; slot < 3; slot++) {
      if ((mask & (1 << slot)) === 0) {
        continue;
      }

      // Calculate bit position for this slot
      // Slot 0: bits 5-45, Slot 1: bits 46-86, Slot 2: bits 87-127
      var bitPos = 5 + slot * 41;
      var bytePos = bitPos >>> 3;
      var bitOffset = bitPos & 7;

      // Read 8 bytes to get the instruction (may span bytes)
      // We need at least 6 bytes for a 41-bit instruction
      if (pos + bytePos + 6 > output.length) {
        break;
      }

      // Extract instruction bytes
      var instr0 = output[pos + bytePos];
      var instr1 = output[pos + bytePos + 1];
      var instr2 = output[pos + bytePos + 2];
      var instr3 = output[pos + bytePos + 3];
      var instr4 = output[pos + bytePos + 4];
      var instr5 = output[pos + bytePos + 5];

      // Build instruction value (we only need the immediate field)
      // The immediate is in bits 13-32 of the instruction (20 bits)
      // Plus bit 36 as the sign bit

      // For decoding, we extract the address that was encoded and convert back
      var instrLo = (instr0 >>> bitOffset) | (instr1 << (8 - bitOffset)) | (instr2 << (16 - bitOffset)) | (instr3 << (24 - bitOffset));

      var instrHi = (instr4 >>> bitOffset) | (instr5 << (8 - bitOffset));

      // Check opcode for branch (opcode 4 or 5 in bits 37-40)
      var opcode = (instrHi >>> (37 - 32 - bitOffset)) & 0xf;
      if (opcode !== 4 && opcode !== 5) {
        continue;
      }

      // Extract 21-bit immediate (bits 13-32 + sign bit 36)
      var imm20 = (instrLo >>> 13) & 0xfffff;
      var sign = (instrHi >>> (36 - 32)) & 1;

      // Combine into 21-bit signed value
      var addr = imm20 | (sign << 20);
      if (sign) {
        addr |= 0xffe00000; // Sign-extend
      }

      // Convert absolute to relative: subtract current position (in bundles)
      var relAddr = addr - (pos >>> 4);

      // Write back
      var newImm20 = relAddr & 0xfffff;
      var newSign = (relAddr >>> 20) & 1;

      // Clear old immediate and write new one
      instrLo = (instrLo & ~(0xfffff << 13)) | (newImm20 << 13);
      instrHi = (instrHi & ~(1 << (36 - 32))) | (newSign << (36 - 32));

      // Write back bytes
      output[pos + bytePos] = (output[pos + bytePos] & ((1 << bitOffset) - 1)) | ((instrLo & 0xff) << bitOffset);
      output[pos + bytePos + 1] = (instrLo >>> (8 - bitOffset)) & 0xff;
      output[pos + bytePos + 2] = (instrLo >>> (16 - bitOffset)) & 0xff;
      output[pos + bytePos + 3] = (instrLo >>> (24 - bitOffset)) & 0xff;
      output[pos + bytePos + 4] = ((instrLo >>> (32 - bitOffset)) & ((1 << bitOffset) - 1)) | ((instrHi & 0xff) << bitOffset);
      output[pos + bytePos + 5] = (output[pos + bytePos + 5] & ~((1 << bitOffset) - 1)) | ((instrHi >>> (8 - bitOffset)) & ((1 << bitOffset) - 1));
    }

    pos += 16;
  }

  return output;
}

/**
 * Create an IA64 BCJ decoder Transform stream
 */
export function createBcjIa64Decoder(properties?: Buffer, unpackSize?: number): Transform {
  return createBufferingDecoder(decodeBcjIa64, properties, unpackSize);
}
