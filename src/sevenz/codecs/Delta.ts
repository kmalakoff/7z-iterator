// Delta filter codec - stores differences between consecutive bytes
// Useful for data with gradual changes (images, audio, sensor data)
//
// The Delta filter stores the difference between each byte and the byte
// N positions before it, where N is the "distance" parameter (default 1).
// This makes data with regular patterns more compressible.

import { bufferFrom } from 'extract-base-iterator';
import type { Transform } from 'readable-stream';
import createBufferingDecoder from './createBufferingDecoder.ts';

/**
 * Decode Delta filtered data
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
  const state = new Array(distance);
  for (let i = 0; i < distance; i++) {
    state[i] = 0;
  }

  for (let j = 0; j < output.length; j++) {
    const idx = j % distance;
    state[idx] = (state[idx] + output[j]) & 0xff;
    output[j] = state[idx];
  }

  return output;
}

/**
 * Create a Delta decoder Transform stream
 */
export function createDeltaDecoder(properties?: Buffer, unpackSize?: number): Transform {
  return createBufferingDecoder(decodeDelta, properties, unpackSize);
}
