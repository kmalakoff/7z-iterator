// LZMA2 codec - wrapper around lzma-purejs for LZMA2 decompression
// LZMA2 is a container format that wraps LZMA chunks with framing
//
// LZMA2 format specification:
// https://github.com/ulikunitz/xz/blob/master/doc/LZMA2.md
//
// Control byte values:
// 0x00         = End of stream
// 0x01         = Uncompressed chunk, dictionary reset
// 0x02         = Uncompressed chunk, no dictionary reset
// 0x80-0xFF    = LZMA compressed chunk (bits encode reset flags and size)
//
// Note: lzma-purejs is patched via patch-package to support LZMA2 state preservation.
// The patch adds setSolid(true/false) method to control whether state is preserved
// across code() calls.

// Import lzma-purejs - provides raw LZMA decoder (patched for LZMA2 support)
import lzmajs from 'lzma-purejs';
import type { Transform } from 'readable-stream';
import createBufferingDecoder from './createBufferingDecoder.ts';
import { createInputStream, createOutputStream } from './streams.ts';

var LzmaDecoder = lzmajs.LZMA.Decoder;

/**
 * Decode LZMA2 dictionary size from properties byte
 * Properties byte encodes dictionary size as: 2^(dictByte/2 + 12) or similar
 *
 * Per XZ spec, dictionary sizes are:
 * 0x00 = 4 KiB (2^12)
 * 0x01 = 6 KiB
 * 0x02 = 8 KiB (2^13)
 * ...
 * 0x28 = 1.5 GiB
 */
function decodeDictionarySize(propByte: number): number {
  if (propByte > 40) {
    throw new Error(`Invalid LZMA2 dictionary size property: ${propByte}`);
  }
  if (propByte === 40) {
    // Max dictionary size: 4 GiB - 1
    return 0xffffffff;
  }
  // Dictionary size = 2 | (propByte & 1) << (propByte / 2 + 11)
  var base = 2 | (propByte & 1);
  var shift = Math.floor(propByte / 2) + 11;
  return base << shift;
}

/**
 * Decode LZMA2 compressed data to buffer
 *
 * @param input - LZMA2 compressed data
 * @param properties - Properties buffer (1 byte: dictionary size)
 * @param _unpackSize - Unused (LZMA2 has internal size markers)
 * @returns Decompressed data
 */
export function decodeLzma2(input: Buffer, properties?: Buffer, _unpackSize?: number): Buffer {
  if (!properties || properties.length < 1) {
    throw new Error('LZMA2 requires properties byte');
  }

  var dictSize = decodeDictionarySize(properties[0]);
  var output: Buffer[] = [];
  var offset = 0;

  // LZMA decoder instance - reused across chunks
  // The decoder is patched via patch-package to support setSolid() for LZMA2 state preservation
  // The decoder also has _nowPos64 which tracks cumulative position for rep0 validation
  // and _prevByte which is used for literal decoder context selection
  var decoder = new LzmaDecoder() as InstanceType<typeof LzmaDecoder> & {
    setSolid: (solid: boolean) => void;
    _nowPos64: number;
    _prevByte: number;
  };
  decoder.setDictionarySize(dictSize);

  // Access internal _outWindow for dictionary management
  // We need to preserve dictionary state across LZMA2 chunks
  type OutWindowType = {
    _buffer: Buffer;
    _pos: number;
    _streamPos: number;
    _windowSize: number;
    init: (solid: boolean) => void;
  };
  var outWindow = (decoder as unknown as { _outWindow: OutWindowType })._outWindow;

  // Track current LZMA properties (lc, lp, pb)
  var propsSet = false;

  while (offset < input.length) {
    var control = input[offset++];

    if (control === 0x00) {
      // End of LZMA2 stream
      break;
    }

    if (control === 0x01 || control === 0x02) {
      // Uncompressed chunk
      // 0x01 = dictionary reset + uncompressed
      // 0x02 = uncompressed (no reset)

      // Handle dictionary reset for 0x01
      if (control === 0x01) {
        outWindow._pos = 0;
        outWindow._streamPos = 0;
        decoder._nowPos64 = 0;
      }

      if (offset + 2 > input.length) {
        throw new Error('Truncated LZMA2 uncompressed chunk header');
      }

      // Size is big-endian, 16-bit, value + 1
      var uncompSize = ((input[offset] << 8) | input[offset + 1]) + 1;
      offset += 2;

      if (offset + uncompSize > input.length) {
        throw new Error('Truncated LZMA2 uncompressed data');
      }

      // Get the uncompressed data
      var uncompData = input.slice(offset, offset + uncompSize);

      // Copy uncompressed data to output
      output.push(uncompData);

      // Also update the decoder's internal dictionary so subsequent LZMA chunks can reference it
      // The decoder needs to track this data for LZ77 back-references
      // We write directly to _buffer to avoid flush() which requires _stream to be set
      // We must also update _streamPos to match _pos so that flush() doesn't try to write
      for (var i = 0; i < uncompData.length; i++) {
        outWindow._buffer[outWindow._pos++] = uncompData[i];
        // Handle circular buffer wrap-around
        if (outWindow._pos >= outWindow._windowSize) {
          outWindow._pos = 0;
        }
      }
      // Keep _streamPos in sync so flush() doesn't try to write these bytes
      // (they're already in our output buffer)
      outWindow._streamPos = outWindow._pos;

      // Update decoder's cumulative position so subsequent LZMA chunks have correct rep0 validation
      decoder._nowPos64 += uncompSize;

      // Update prevByte for literal decoder context in subsequent LZMA chunks
      decoder._prevByte = uncompData[uncompData.length - 1];

      offset += uncompSize;
    } else if (control >= 0x80) {
      // LZMA compressed chunk
      // Control byte format (bits 7-0):
      // Bit 7: always 1 for LZMA chunk
      // Bits 6-5: reset mode (00=nothing, 01=state, 10=state+props, 11=all)
      // Bits 4-0: high 5 bits of uncompressed size - 1

      // Control byte ranges (based on bits 6-5):
      // 0x80-0x9F (00): no reset - continue existing state (solid mode)
      // 0xA0-0xBF (01): reset state only
      // 0xC0-0xDF (10): reset state + new properties
      // 0xE0-0xFF (11): reset dictionary + state + new properties
      var resetState = control >= 0xa0;
      var newProps = control >= 0xc0;
      var dictReset = control >= 0xe0;
      var useSolidMode = !resetState;

      // Handle dictionary reset for control bytes 0xE0-0xFF
      if (dictReset) {
        outWindow._pos = 0;
        outWindow._streamPos = 0;
      }

      if (offset + 4 > input.length) {
        throw new Error('Truncated LZMA2 LZMA chunk header');
      }

      // Uncompressed size: 5 bits from control + 16 bits from next 2 bytes + 1
      var uncompHigh = control & 0x1f;
      var uncompSize2 = ((uncompHigh << 16) | (input[offset] << 8) | input[offset + 1]) + 1;
      offset += 2;

      // Compressed size: 16 bits + 1
      var compSize = ((input[offset] << 8) | input[offset + 1]) + 1;
      offset += 2;

      // If new properties, read 1-byte LZMA properties
      if (newProps) {
        if (offset >= input.length) {
          throw new Error('Truncated LZMA2 properties byte');
        }
        var propsByte = input[offset++];

        // Properties byte: pb * 45 + lp * 9 + lc
        // where pb, lp, lc are LZMA parameters
        var lc = propsByte % 9;
        var remainder = Math.floor(propsByte / 9);
        var lp = remainder % 5;
        var pb = Math.floor(remainder / 5);

        if (!decoder.setLcLpPb(lc, lp, pb)) {
          throw new Error(`Invalid LZMA properties: lc=${lc} lp=${lp} pb=${pb}`);
        }
        propsSet = true;
      }

      if (!propsSet) {
        throw new Error('LZMA chunk without properties');
      }

      if (offset + compSize > input.length) {
        throw new Error('Truncated LZMA2 compressed data');
      }

      // Decode LZMA chunk
      var inStream = createInputStream(input, offset, compSize);
      var outStream = createOutputStream();

      // Set solid mode based on control byte - this preserves state across code() calls
      decoder.setSolid(useSolidMode);

      // Decode the chunk
      var success = decoder.code(inStream, outStream, uncompSize2);
      if (!success) {
        throw new Error('LZMA decompression failed');
      }

      output.push(outStream.toBuffer());

      offset += compSize;
    } else {
      throw new Error(`Invalid LZMA2 control byte: 0x${control.toString(16)}`);
    }
  }

  return Buffer.concat(output);
}

/**
 * Create an LZMA2 decoder Transform stream
 */
export function createLzma2Decoder(properties?: Buffer, unpackSize?: number): Transform {
  return createBufferingDecoder(decodeLzma2, properties, unpackSize);
}
