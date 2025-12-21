/**
 * Synchronous LZMA2 Decoder
 *
 * LZMA2 is a container format that wraps LZMA chunks with framing.
 * Decodes LZMA2 data from a buffer.
 */

import { allocBufferUnsafe } from 'extract-base-iterator';
import { parseLzma2ChunkHeader } from '../Lzma2ChunkParser.ts';
import { type OutputSink, parseLzma2DictionarySize } from '../types.ts';
import { LzmaDecoder } from './LzmaDecoder.ts';

/**
 * Synchronous LZMA2 decoder
 */
export class Lzma2Decoder {
  private lzmaDecoder: LzmaDecoder;
  private dictionarySize: number;
  private propsSet: boolean;

  constructor(properties: Buffer | Uint8Array, outputSink?: OutputSink) {
    if (!properties || properties.length < 1) {
      throw new Error('LZMA2 requires properties byte');
    }

    this.dictionarySize = parseLzma2DictionarySize(properties[0]);
    this.lzmaDecoder = new LzmaDecoder(outputSink);
    this.lzmaDecoder.setDictionarySize(this.dictionarySize);
    this.propsSet = false;
  }

  /**
   * Reset the dictionary (for stream boundaries)
   */
  resetDictionary(): void {
    this.lzmaDecoder.resetDictionary();
  }

  /**
   * Reset all probability models (for stream boundaries)
   */
  resetProbabilities(): void {
    this.lzmaDecoder.resetProbabilities();
  }

  /**
   * Set LZMA properties
   */
  setLcLpPb(lc: number, lp: number, pb: number): boolean {
    return this.lzmaDecoder.setLcLpPb(lc, lp, pb);
  }

  /**
   * Feed uncompressed data to the dictionary (for subsequent LZMA chunks)
   */
  feedUncompressed(data: Buffer): void {
    this.lzmaDecoder.feedUncompressed(data);
  }

  /**
   * Decode raw LZMA data (used internally for LZMA2 chunks)
   * @param input - LZMA compressed data
   * @param offset - Input offset
   * @param outSize - Expected output size
   * @param solid - Use solid mode
   * @returns Decompressed data
   */
  decodeLzmaData(input: Buffer, offset: number, outSize: number, solid = false): Buffer {
    return this.lzmaDecoder.decode(input, offset, outSize, solid);
  }

  /**
   * Decode LZMA2 data with streaming output
   * @param input - LZMA2 compressed data
   * @returns Total number of bytes written to sink
   */
  decodeWithSink(input: Buffer): number {
    let totalBytes = 0;
    let offset = 0;

    while (offset < input.length) {
      const result = parseLzma2ChunkHeader(input, offset);

      if (!result.success) {
        throw new Error('Truncated LZMA2 chunk header');
      }

      const chunk = result.chunk;

      if (chunk.type === 'end') {
        break;
      }

      // Validate we have enough data for the chunk
      const dataSize = chunk.type === 'uncompressed' ? chunk.uncompSize : chunk.compSize;
      if (offset + chunk.headerSize + dataSize > input.length) {
        throw new Error(`Truncated LZMA2 ${chunk.type} data`);
      }

      // Handle dictionary reset
      if (chunk.dictReset) {
        this.lzmaDecoder.resetDictionary();
      }

      const dataOffset = offset + chunk.headerSize;

      if (chunk.type === 'uncompressed') {
        const uncompData = input.slice(dataOffset, dataOffset + chunk.uncompSize);

        // Feed uncompressed data to dictionary so subsequent LZMA chunks can reference it
        this.lzmaDecoder.feedUncompressed(uncompData);

        totalBytes += uncompData.length;
        offset = dataOffset + chunk.uncompSize;
      } else {
        // LZMA compressed chunk

        // Apply new properties if present
        if (chunk.newProps) {
          const { lc, lp, pb } = chunk.newProps;
          if (!this.lzmaDecoder.setLcLpPb(lc, lp, pb)) {
            throw new Error(`Invalid LZMA properties: lc=${lc} lp=${lp} pb=${pb}`);
          }
          this.propsSet = true;
        }

        if (!this.propsSet) {
          throw new Error('LZMA chunk without properties');
        }

        // Reset probabilities if state reset
        if (chunk.stateReset) {
          this.lzmaDecoder.resetProbabilities();
        }

        // Determine solid mode
        const useSolid = !chunk.stateReset || (chunk.stateReset && !chunk.dictReset);

        // Decode LZMA chunk directly to sink
        totalBytes += this.lzmaDecoder.decodeWithSink(input, dataOffset, chunk.uncompSize, useSolid);

        offset = dataOffset + chunk.compSize;
      }
    }

    // Flush any remaining data in the OutWindow
    this.lzmaDecoder.flushOutWindow();

    return totalBytes;
  }

  /**
   * Decode LZMA2 data
   * @param input - LZMA2 compressed data
   * @param unpackSize - Expected output size (optional, for pre-allocation)
   * @returns Decompressed data
   */
  decode(input: Buffer, unpackSize?: number): Buffer {
    // Pre-allocate output buffer if size is known
    let outputBuffer: Buffer | null = null;
    let outputPos = 0;
    const outputChunks: Buffer[] = [];

    if (unpackSize && unpackSize > 0) {
      outputBuffer = allocBufferUnsafe(unpackSize);
    }

    let offset = 0;

    while (offset < input.length) {
      const result = parseLzma2ChunkHeader(input, offset);

      if (!result.success) {
        throw new Error('Truncated LZMA2 chunk header');
      }

      const chunk = result.chunk;

      if (chunk.type === 'end') {
        break;
      }

      // Validate we have enough data for the chunk
      const dataSize = chunk.type === 'uncompressed' ? chunk.uncompSize : chunk.compSize;
      if (offset + chunk.headerSize + dataSize > input.length) {
        throw new Error(`Truncated LZMA2 ${chunk.type} data`);
      }

      // Handle dictionary reset
      if (chunk.dictReset) {
        this.lzmaDecoder.resetDictionary();
      }

      const dataOffset = offset + chunk.headerSize;

      if (chunk.type === 'uncompressed') {
        const uncompData = input.slice(dataOffset, dataOffset + chunk.uncompSize);

        // Copy to output
        if (outputBuffer) {
          uncompData.copy(outputBuffer, outputPos);
          outputPos += uncompData.length;
        } else {
          outputChunks.push(uncompData);
        }

        // Feed uncompressed data to dictionary so subsequent LZMA chunks can reference it
        this.lzmaDecoder.feedUncompressed(uncompData);

        offset = dataOffset + chunk.uncompSize;
      } else {
        // LZMA compressed chunk

        // Apply new properties if present
        if (chunk.newProps) {
          const { lc, lp, pb } = chunk.newProps;
          if (!this.lzmaDecoder.setLcLpPb(lc, lp, pb)) {
            throw new Error(`Invalid LZMA properties: lc=${lc} lp=${lp} pb=${pb}`);
          }
          this.propsSet = true;
        }

        if (!this.propsSet) {
          throw new Error('LZMA chunk without properties');
        }

        // Reset probabilities if state reset
        if (chunk.stateReset) {
          this.lzmaDecoder.resetProbabilities();
        }

        // Determine solid mode - preserve dictionary if not resetting state or if only resetting state (not dict)
        const useSolid = !chunk.stateReset || (chunk.stateReset && !chunk.dictReset);

        // Decode LZMA chunk
        const chunkData = input.slice(dataOffset, dataOffset + chunk.compSize);
        const decoded = this.lzmaDecoder.decode(chunkData, 0, chunk.uncompSize, useSolid);

        // Copy to output
        if (outputBuffer) {
          decoded.copy(outputBuffer, outputPos);
          outputPos += decoded.length;
        } else {
          outputChunks.push(decoded);
        }

        offset = dataOffset + chunk.compSize;
      }
    }

    // Return pre-allocated buffer or concatenated chunks
    if (outputBuffer) {
      return outputPos < outputBuffer.length ? outputBuffer.slice(0, outputPos) : outputBuffer;
    }
    return Buffer.concat(outputChunks);
  }
}

/**
 * Decode LZMA2 data synchronously
 * @param input - LZMA2 compressed data
 * @param properties - 1-byte properties (dictionary size)
 * @param unpackSize - Expected output size (optional, autodetects if not provided)
 * @param outputSink - Optional output sink for zero-copy decoding (returns bytes written)
 * @returns Decompressed data (or bytes written if outputSink provided)
 */
export function decodeLzma2(input: Buffer, properties: Buffer | Uint8Array, unpackSize?: number, outputSink?: OutputSink): Buffer | number {
  const decoder = new Lzma2Decoder(properties, outputSink);
  if (outputSink) {
    // Zero-copy mode: write to sink during decode
    return decoder.decodeWithSink(input);
  }
  // Buffering mode: returns Buffer (zero-copy)
  return decoder.decode(input, unpackSize);
}
