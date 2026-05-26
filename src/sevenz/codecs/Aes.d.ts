import type { Transform } from 'stream';
/**
 * Set the password for AES decryption
 */
export declare function setPassword(password: string | null): void;
/**
 * Get the current password
 */
export declare function getPassword(): string | null;
/**
 * Decode AES-256-CBC encrypted data
 *
 * @param input - Encrypted data
 * @param properties - AES properties (numCyclesPower, salt, IV)
 * @param _unpackSize - Unused
 * @returns Decrypted data
 */
export declare function decodeAes(input: Buffer, properties?: Buffer, _unpackSize?: number): Buffer;
/**
 * Create an AES decoder Transform stream
 */
export declare function createAesDecoder(properties?: Buffer, unpackSize?: number): Transform;
