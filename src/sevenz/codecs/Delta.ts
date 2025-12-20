// Delta filter codec - stores differences between consecutive bytes
// Useful for data with gradual changes (images, audio, sensor data)
//
// The Delta filter stores the difference between each byte and the byte
// N positions before it, where N is the "distance" parameter (default 1).
// This makes data with regular patterns more compressible.
//
// This implementation uses true streaming - processes data chunk by chunk
// while maintaining state between chunks.

import { allocBuffer, bufferFrom, Transform } from 'extract-base-iterator';

/**
 * Decode Delta filtered data (synchronous, for buffered use)
 * Reverses the delta transformation by adding previous values
 *
 * @param input - Delta filtered data
 * @param properties - Optional 1-byte properties (distance - 1)
 * @param _unpackSize - Unused for Delta
 * @returns Unfiltered data
 */
export function decodeDelta(input: Buffer, properties?: Buffer, _unpackSize?: number): Buffer {
  // Distance parameter: default is 1
  let distance = 1;
  if (properties && properties.length >= 1) {
    // Properties byte contains (distance - 1)
    distance = properties[0] + 1;
  }

  const output = bufferFrom(input); // Copy since we modify in place

  // State buffer for multi-byte distance
  const state: number[] = [];
  for (let i = 0; i < distance; i++) {
    state.push(0);
  }

  for (let j = 0; j < output.length; j++) {
    const idx = j % distance;
    state[idx] = (state[idx] + output[j]) & 0xff;
    output[j] = state[idx];
  }

  return output;
}

/**
 * Create a streaming Delta decoder Transform.
 * Processes data chunk by chunk, maintaining state between chunks.
 */
export function createDeltaDecoder(properties?: Buffer, _unpackSize?: number): InstanceType<typeof Transform> {
  // Distance parameter: default is 1
  let distance = 1;
  if (properties && properties.length >= 1) {
    distance = properties[0] + 1;
  }

  // State buffer for multi-byte distance
  const state: number[] = [];
  for (let i = 0; i < distance; i++) {
    state.push(0);
  }

  let byteIndex = 0;

  return new Transform({
    transform: (chunk: Buffer, _encoding: string, callback: (err?: Error | null, data?: Buffer) => void) => {
      const output = allocBuffer(chunk.length);

      for (let j = 0; j < chunk.length; j++) {
        const idx = byteIndex % distance;
        state[idx] = (state[idx] + chunk[j]) & 0xff;
        output[j] = state[idx];
        byteIndex++;
      }

      callback(null, output);
    },
  });
}
