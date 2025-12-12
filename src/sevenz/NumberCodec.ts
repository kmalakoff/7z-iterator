// Variable-length integer encoding for 7z format
// Reference: https://py7zr.readthedocs.io/en/latest/archive_format.html
//
// 7z uses a space-efficient encoding where the first byte determines length:
// 0xxxxxxx                    -> 1 byte  (0-127)
// 10xxxxxx xxxxxxxx           -> 2 bytes (0-16383)
// 110xxxxx + 2 bytes          -> 3 bytes
// 1110xxxx + 3 bytes          -> 4 bytes
// 11110xxx + 4 bytes          -> 5 bytes
// 111110xx + 5 bytes          -> 6 bytes
// 1111110x + 6 bytes          -> 7 bytes
// 11111110 + 7 bytes          -> 8 bytes
// 11111111 + 8 bytes          -> 9 bytes (full 64-bit)
//
// NOTE: Returns JavaScript number which is accurate up to 2^53 - 1 (~9 PB).
// This covers all practical file sizes.

import { readUInt64LE } from 'extract-base-iterator';

export interface NumberReadResult {
  value: number;
  bytesRead: number;
}

/**
 * Read a variable-length encoded number from a buffer
 * Uses 7z's variable-length uint64 encoding where the first byte indicates
 * how many additional bytes follow based on its value:
 * - 0x00-0x7F: 0 extra bytes (7 bits of data)
 * - 0x80-0xBF: 1 extra byte (14 bits of data)
 * - 0xC0-0xDF: 2 extra bytes (21 bits of data)
 * - 0xE0-0xEF: 3 extra bytes (28 bits of data)
 * - etc.
 * - 0xFF: 8 extra bytes (full 64-bit value)
 *
 * @param buf - Buffer containing encoded number
 * @param offset - Offset to start reading from
 * @returns Object with value and number of bytes consumed
 */
export function readNumber(buf: Buffer, offset: number): NumberReadResult {
  const firstByte = buf[offset];

  // Special case: 0xFF means 8 extra bytes (full 64-bit value)
  if (firstByte === 0xff) {
    return {
      value: readUInt64LE(buf, offset + 1),
      bytesRead: 9,
    };
  }

  // Determine number of extra bytes based on first byte value thresholds
  // This matches the 7z format specification
  let extraBytes = 0;
  let mask = 0x80;

  if (firstByte <= 0x7f) {
    extraBytes = 0;
    mask = 0x80;
  } else if (firstByte <= 0xbf) {
    extraBytes = 1;
    mask = 0x40;
  } else if (firstByte <= 0xdf) {
    extraBytes = 2;
    mask = 0x20;
  } else if (firstByte <= 0xef) {
    extraBytes = 3;
    mask = 0x10;
  } else if (firstByte <= 0xf7) {
    extraBytes = 4;
    mask = 0x08;
  } else if (firstByte <= 0xfb) {
    extraBytes = 5;
    mask = 0x04;
  } else if (firstByte <= 0xfd) {
    extraBytes = 6;
    mask = 0x02;
  } else {
    // 0xFE
    extraBytes = 7;
    mask = 0x01;
  }

  // Get high part from first byte (bits below the length indicator)
  const highPart = firstByte & (mask - 1);

  // Read extra bytes as LITTLE-ENDIAN
  let value = 0;
  for (let i = 0; i < extraBytes; i++) {
    value += buf[offset + 1 + i] * 256 ** i;
  }

  // Combine: value + (highPart << (extraBytes * 8))
  value += highPart * 256 ** extraBytes;

  return {
    value: value,
    bytesRead: 1 + extraBytes,
  };
}

/**
 * Read a raw 64-bit little-endian number (used in some fixed-size fields)
 * @param buf - Buffer containing the number
 * @param offset - Offset to start reading from
 * @returns The number value
 */
export function readRawNumber(buf: Buffer, offset: number): number {
  return readUInt64LE(buf, offset);
}

/**
 * Calculate the encoded size of a number
 * @param value - The number to encode
 * @returns Number of bytes needed to encode the value
 */
export function encodedSize(value: number): number {
  if (value < 0x80) return 1; // 7 bits
  if (value < 0x4000) return 2; // 14 bits
  if (value < 0x200000) return 3; // 21 bits
  if (value < 0x10000000) return 4; // 28 bits
  if (value < 0x800000000) return 5; // 35 bits
  if (value < 0x40000000000) return 6; // 42 bits
  if (value < 0x2000000000000) return 7; // 49 bits
  // 2^56 = 72057594037927936 (use calculated value to avoid precision loss)
  if (value < 72057594037927936) return 8; // 56 bits
  return 9; // 64 bits
}

/**
 * Read a boolean encoded as a single byte
 * @param buf - Buffer to read from
 * @param offset - Offset to read from
 * @returns true if byte is non-zero
 */
export function readBoolean(buf: Buffer, offset: number): boolean {
  return buf[offset] !== 0;
}

/**
 * Read a "defined" bitmask for an array of items.
 * Used when some items in a list have optional values.
 *
 * Format: If "allDefined" byte is 0, a bitmask follows indicating which items have values.
 * If "allDefined" byte is non-zero, all items are defined.
 *
 * @param buf - Buffer to read from
 * @param offset - Offset to start reading
 * @param count - Number of items
 * @returns Object with defined array and bytes consumed
 */
export function readDefinedVector(buf: Buffer, offset: number, count: number): { defined: boolean[]; bytesRead: number } {
  const allDefined = buf[offset] !== 0;
  let bytesRead = 1;
  const defined: boolean[] = [];

  if (allDefined) {
    // All items are defined
    for (let i = 0; i < count; i++) {
      defined.push(true);
    }
  } else {
    // Read bitmask
    const bitsNeeded = count;
    const bytesNeeded = Math.ceil(bitsNeeded / 8);

    for (let byteIdx = 0; byteIdx < bytesNeeded; byteIdx++) {
      const byte = buf[offset + 1 + byteIdx];
      for (let bit = 7; bit >= 0 && defined.length < count; bit--) {
        defined.push((byte & (1 << bit)) !== 0);
      }
    }
    bytesRead += bytesNeeded;
  }

  return { defined: defined, bytesRead: bytesRead };
}

/**
 * Read an array of variable-length numbers
 * @param buf - Buffer to read from
 * @param offset - Offset to start reading
 * @param count - Number of items to read
 * @returns Object with values array and bytes consumed
 */
export function readNumberArray(buf: Buffer, offset: number, count: number): { values: number[]; bytesRead: number } {
  const values: number[] = [];
  let totalBytesRead = 0;

  for (let i = 0; i < count; i++) {
    const result = readNumber(buf, offset + totalBytesRead);
    values.push(result.value);
    totalBytesRead += result.bytesRead;
  }

  return { values: values, bytesRead: totalBytesRead };
}
