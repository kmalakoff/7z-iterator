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
export declare function readNumber(buf: Buffer, offset: number): NumberReadResult;
/**
 * Read a raw 64-bit little-endian number (used in some fixed-size fields)
 * @param buf - Buffer containing the number
 * @param offset - Offset to start reading from
 * @returns The number value
 */
export declare function readRawNumber(buf: Buffer, offset: number): number;
/**
 * Calculate the encoded size of a number
 * @param value - The number to encode
 * @returns Number of bytes needed to encode the value
 */
export declare function encodedSize(value: number): number;
/**
 * Read a boolean encoded as a single byte
 * @param buf - Buffer to read from
 * @param offset - Offset to read from
 * @returns true if byte is non-zero
 */
export declare function readBoolean(buf: Buffer, offset: number): boolean;
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
export declare function readDefinedVector(
  buf: Buffer,
  offset: number,
  count: number
): {
  defined: boolean[];
  bytesRead: number;
};
/**
 * Read an array of variable-length numbers
 * @param buf - Buffer to read from
 * @param offset - Offset to start reading
 * @param count - Number of items to read
 * @returns Object with values array and bytes consumed
 */
export declare function readNumberArray(
  buf: Buffer,
  offset: number,
  count: number
): {
  values: number[];
  bytesRead: number;
};
