import { type Transform } from 'extract-base-iterator';
/**
 * Create a Copy decoder stream
 * Simply passes through data unchanged
 */
export declare function createCopyDecoder(): InstanceType<typeof Transform>;
/**
 * Decode a buffer using Copy codec (no-op)
 * @param input - Input buffer
 * @param _properties - Unused
 * @param _unpackSize - Unused
 * @returns Same buffer (no transformation)
 */
export declare function decodeCopy(input: Buffer, _properties?: Buffer, _unpackSize?: number): Buffer;
