import '../lib/polyfills.ts';
import assert from 'assert';
import { bufferFrom } from 'extract-base-iterator';
import { encodedSize, readDefinedVector, readNumber, readNumberArray } from '../../src/sevenz/NumberCodec.ts';

describe('NumberCodec', () => {
  describe('readNumber', () => {
    it('should read single-byte values (0-127)', () => {
      var buf = bufferFrom([0x00]);
      var result = readNumber(buf, 0);
      assert.equal(result.value, 0);
      assert.equal(result.bytesRead, 1);

      buf = bufferFrom([0x7f]);
      result = readNumber(buf, 0);
      assert.equal(result.value, 127);
      assert.equal(result.bytesRead, 1);

      buf = bufferFrom([0x01]);
      result = readNumber(buf, 0);
      assert.equal(result.value, 1);
      assert.equal(result.bytesRead, 1);
    });

    it('should read two-byte values', () => {
      // 0x80 indicates 1 extra byte
      // 10xxxxxx xxxxxxxx
      var buf = bufferFrom([0x80, 0x00]);
      var result = readNumber(buf, 0);
      assert.equal(result.value, 0);
      assert.equal(result.bytesRead, 2);

      buf = bufferFrom([0x80, 0x80]);
      result = readNumber(buf, 0);
      assert.equal(result.value, 128);
      assert.equal(result.bytesRead, 2);

      // Max 2-byte value: 0xBF 0xFF = 0x3FFF = 16383
      buf = bufferFrom([0xbf, 0xff]);
      result = readNumber(buf, 0);
      assert.equal(result.value, 16383);
      assert.equal(result.bytesRead, 2);
    });

    it('should read three-byte values', () => {
      // 110xxxxx + 2 bytes
      var buf = bufferFrom([0xc0, 0x00, 0x00]);
      var result = readNumber(buf, 0);
      assert.equal(result.value, 0);
      assert.equal(result.bytesRead, 3);
    });

    it('should read at specified offset', () => {
      var buf = bufferFrom([0xff, 0xff, 0x42, 0x00]);
      var result = readNumber(buf, 2);
      assert.equal(result.value, 66); // 0x42
      assert.equal(result.bytesRead, 1);
    });
  });

  describe('encodedSize', () => {
    it('should return 1 for values 0-127', () => {
      assert.equal(encodedSize(0), 1);
      assert.equal(encodedSize(127), 1);
    });

    it('should return 2 for values 128-16383', () => {
      assert.equal(encodedSize(128), 2);
      assert.equal(encodedSize(16383), 2);
    });

    it('should return correct size for larger values', () => {
      assert.equal(encodedSize(16384), 3);
      assert.equal(encodedSize(1000000), 3);
    });
  });

  describe('readDefinedVector', () => {
    it('should read all-defined vector', () => {
      // First byte non-zero means all defined
      var buf = bufferFrom([0x01]);
      var result = readDefinedVector(buf, 0, 5);
      assert.equal(result.bytesRead, 1);
      assert.equal(result.defined.length, 5);
      assert.ok(result.defined.every((d) => d === true));
    });

    it('should read bitmask vector', () => {
      // First byte 0 means bitmask follows
      // 0b10101000 = 0xA8 means: defined, not, defined, not, defined, not, not, not
      var buf = bufferFrom([0x00, 0xa8]);
      var result = readDefinedVector(buf, 0, 5);
      assert.equal(result.bytesRead, 2);
      assert.deepEqual(result.defined, [true, false, true, false, true]);
    });
  });

  describe('readNumberArray', () => {
    it('should read array of numbers', () => {
      var buf = bufferFrom([0x01, 0x02, 0x03]);
      var result = readNumberArray(buf, 0, 3);
      assert.deepEqual(result.values, [1, 2, 3]);
      assert.equal(result.bytesRead, 3);
    });
  });
});
