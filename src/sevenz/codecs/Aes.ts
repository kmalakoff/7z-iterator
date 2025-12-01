// 7z AES-256-CBC codec with SHA-256 key derivation
// Implements password-based decryption for encrypted 7z archives
//
// Properties format:
//   Byte 0: bits 0-5 = NumCyclesPower (iterations = 2^NumCyclesPower)
//           bit 6 = IV present flag
//           bit 7 = Salt present flag
//   Byte 1: upper nibble = salt size extension
//           lower nibble = IV size extension
//   Following bytes: salt data, then IV data
//
// Key derivation:
//   For each round (2^NumCyclesPower times):
//     hash = SHA256(salt + password_utf16le + round_counter_8bytes)
//   Final key = first 32 bytes of accumulated hash

import crypto from 'crypto';
import { allocBuffer, bufferFrom } from 'extract-base-iterator';
import type { Transform } from 'readable-stream';
import createBufferingDecoder from './createBufferingDecoder.ts';

// Global password storage - set before decryption
var _password: string | null = null;

/**
 * Set the password for AES decryption
 */
export function setPassword(password: string | null): void {
  _password = password;
}

/**
 * Get the current password
 */
export function getPassword(): string | null {
  return _password;
}

/**
 * Parse AES properties to extract key derivation parameters
 */
function parseProperties(properties: Buffer): { numCyclesPower: number; salt: Buffer; iv: Buffer } {
  if (!properties || properties.length < 1) {
    throw new Error('AES: missing properties');
  }

  var b0 = properties[0];
  var numCyclesPower = b0 & 0x3f;

  // Check for special case: no salt/IV flags
  if ((b0 & 0xc0) === 0) {
    // No salt, no IV - use zeros
    return {
      numCyclesPower: numCyclesPower,
      salt: allocBuffer(0),
      iv: allocBuffer(16),
    };
  }

  if (properties.length < 2) {
    throw new Error('AES: properties too short');
  }

  var b1 = properties[1];

  // Calculate sizes
  // saltSize = ((b0 >> 7) & 1) + (b1 >> 4)
  // ivSize = ((b0 >> 6) & 1) + (b1 & 0x0F)
  var saltSize = ((b0 >>> 7) & 1) + (b1 >>> 4);
  var ivSize = ((b0 >>> 6) & 1) + (b1 & 0x0f);

  var expectedSize = 2 + saltSize + ivSize;
  if (properties.length < expectedSize) {
    throw new Error('AES: properties too short for salt/IV');
  }

  var salt = properties.slice(2, 2 + saltSize);
  var iv = allocBuffer(16);

  // Copy IV data (may be less than 16 bytes, rest is zeros)
  var ivData = properties.slice(2 + saltSize, 2 + saltSize + ivSize);
  for (var i = 0; i < ivData.length && i < 16; i++) {
    iv[i] = ivData[i];
  }

  return {
    numCyclesPower: numCyclesPower,
    salt: salt,
    iv: iv,
  };
}

/**
 * Convert password string to UTF-16LE buffer
 */
function passwordToUtf16LE(password: string): Buffer {
  var buf = allocBuffer(password.length * 2);
  for (var i = 0; i < password.length; i++) {
    var code = password.charCodeAt(i);
    buf[i * 2] = code & 0xff;
    buf[i * 2 + 1] = (code >>> 8) & 0xff;
  }
  return buf;
}

/**
 * Derive AES-256 key from password using 7z's SHA-256 iteration scheme
 *
 * Algorithm:
 *   For round = 0 to 2^numCyclesPower - 1:
 *     hash.update(salt)
 *     hash.update(password_utf16le)
 *     hash.update(round as 8-byte little-endian)
 *   key = hash.digest()
 */
function deriveKey(password: string, salt: Buffer, numCyclesPower: number): Buffer {
  var passwordBuf = passwordToUtf16LE(password);
  var numRounds = 2 ** numCyclesPower;

  // For special case 0x3F, don't iterate
  if (numCyclesPower === 0x3f) {
    // Direct concatenation mode
    var key = allocBuffer(32);
    var offset = 0;
    for (var j = 0; j < salt.length && offset < 32; j++) {
      key[offset++] = salt[j];
    }
    for (var k = 0; k < passwordBuf.length && offset < 32; k++) {
      key[offset++] = passwordBuf[k];
    }
    return key;
  }

  // Counter buffer (8 bytes, little-endian)
  var counter = allocBuffer(8);

  // Create hash and iterate
  var hash = crypto.createHash('sha256');

  for (var round = 0; round < numRounds; round++) {
    // Write round counter as little-endian 64-bit
    counter[0] = round & 0xff;
    counter[1] = (round >>> 8) & 0xff;
    counter[2] = (round >>> 16) & 0xff;
    counter[3] = (round >>> 24) & 0xff;
    // Upper 32 bits - for large round counts
    var high = Math.floor(round / 0x100000000);
    counter[4] = high & 0xff;
    counter[5] = (high >>> 8) & 0xff;
    counter[6] = (high >>> 16) & 0xff;
    counter[7] = (high >>> 24) & 0xff;

    hash.update(salt);
    hash.update(passwordBuf);
    hash.update(counter);
  }

  return hash.digest() as Buffer;
}

/**
 * Decode AES-256-CBC encrypted data
 *
 * @param input - Encrypted data
 * @param properties - AES properties (numCyclesPower, salt, IV)
 * @param _unpackSize - Unused
 * @returns Decrypted data
 */
export function decodeAes(input: Buffer, properties?: Buffer, _unpackSize?: number): Buffer {
  if (!_password) {
    throw new Error('AES: password required but not set');
  }

  if (!properties) {
    throw new Error('AES: properties required');
  }

  var params = parseProperties(properties);
  var key = deriveKey(_password, params.salt, params.numCyclesPower);

  // Create AES-256-CBC decipher
  var decipher = crypto.createDecipheriv('aes-256-cbc', key, params.iv);
  decipher.setAutoPadding(false); // 7z doesn't use PKCS7 padding

  // Node 0.8 returns binary strings, newer Node returns Buffers
  // Use 'binary' encoding for compatibility
  // @ts-expect-error - 'binary' encoding is deprecated but required for Node 0.8 compatibility
  var decStr = decipher.update(input, 'binary', 'binary') + decipher.final('binary');
  var decrypted = bufferFrom(decStr, 'binary' as BufferEncoding);

  return decrypted;
}

/**
 * Create an AES decoder Transform stream
 */
export function createAesDecoder(properties?: Buffer, unpackSize?: number): Transform {
  return createBufferingDecoder(decodeAes, properties, unpackSize);
}
