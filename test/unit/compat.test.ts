import assert from 'assert';
import { allocBuffer, allocBufferUnsafe, bufferCompare, bufferEquals, bufferFrom, readUInt64LE, writeUInt64LE } from 'extract-base-iterator';

describe('compat', () => {
  describe('allocBuffer', () => {
    it('should allocate zero-filled buffer', () => {
      var buf = allocBuffer(10);
      assert.equal(buf.length, 10);
      for (var i = 0; i < buf.length; i++) {
        assert.equal(buf[i], 0);
      }
    });
  });

  describe('allocBufferUnsafe', () => {
    it('should allocate buffer of specified size', () => {
      var buf = allocBufferUnsafe(10);
      assert.equal(buf.length, 10);
    });
  });

  describe('bufferFrom', () => {
    it('should create buffer from string', () => {
      var buf = bufferFrom('hello', 'utf8');
      assert.equal(buf.toString('utf8'), 'hello');
    });

    it('should create buffer from array', () => {
      var buf = bufferFrom([0x48, 0x65, 0x6c, 0x6c, 0x6f]);
      assert.equal(buf.toString('utf8'), 'Hello');
    });
  });

  describe('bufferCompare', () => {
    it('should return 0 for equal buffers', () => {
      var a = bufferFrom([1, 2, 3]);
      var b = bufferFrom([1, 2, 3]);
      assert.equal(bufferCompare(a, b), 0);
    });

    it('should return negative for a < b', () => {
      var a = bufferFrom([1, 2, 3]);
      var b = bufferFrom([1, 2, 4]);
      assert.ok(bufferCompare(a, b) < 0);
    });

    it('should return positive for a > b', () => {
      var a = bufferFrom([1, 2, 4]);
      var b = bufferFrom([1, 2, 3]);
      assert.ok(bufferCompare(a, b) > 0);
    });

    it('should compare regions', () => {
      var source = bufferFrom([0, 1, 2, 3, 0]);
      var target = bufferFrom([0, 1, 2, 3, 0]);
      assert.equal(bufferCompare(source, target, 1, 4, 1, 4), 0);
    });
  });

  describe('bufferEquals', () => {
    it('should return true for matching bytes', () => {
      var buf = bufferFrom([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
      var expected = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c];
      assert.equal(bufferEquals(buf, 0, expected), true);
    });

    it('should return false for non-matching bytes', () => {
      var buf = bufferFrom([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]);
      var expected = [0x37, 0x7a, 0xbc, 0x00, 0x27, 0x1c];
      assert.equal(bufferEquals(buf, 0, expected), false);
    });

    it('should work with offset', () => {
      var buf = bufferFrom([0x00, 0x00, 0x37, 0x7a]);
      var expected = [0x37, 0x7a];
      assert.equal(bufferEquals(buf, 2, expected), true);
    });
  });

  describe('readUInt64LE', () => {
    it('should read small values', () => {
      var buf = allocBuffer(8);
      buf.writeUInt32LE(42, 0);
      buf.writeUInt32LE(0, 4);
      assert.equal(readUInt64LE(buf, 0), 42);
    });

    it('should read values up to 32 bits', () => {
      var buf = allocBuffer(8);
      buf.writeUInt32LE(0xffffffff, 0);
      buf.writeUInt32LE(0, 4);
      assert.equal(readUInt64LE(buf, 0), 0xffffffff);
    });

    it('should read values larger than 32 bits', () => {
      var buf = allocBuffer(8);
      buf.writeUInt32LE(0, 0);
      buf.writeUInt32LE(1, 4);
      assert.equal(readUInt64LE(buf, 0), 0x100000000);
    });
  });

  describe('writeUInt64LE', () => {
    it('should write small values', () => {
      var buf = allocBuffer(8);
      writeUInt64LE(buf, 42, 0);
      assert.equal(buf.readUInt32LE(0), 42);
      assert.equal(buf.readUInt32LE(4), 0);
    });

    it('should round-trip with readUInt64LE', () => {
      var buf = allocBuffer(8);
      var value = 12345678901234;
      writeUInt64LE(buf, value, 0);
      assert.equal(readUInt64LE(buf, 0), value);
    });
  });
});
