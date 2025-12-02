'use strict';

// Node 0.8 compatible buffer allocation
// Note: For OutWindow, zero-fill is not required since we write before reading.
// Using allocUnsafe/uninitialized buffer saves significant memory and time.
var makeBuffer = function(len) {
  if (Buffer.allocUnsafe) {
    return Buffer.allocUnsafe(len);
  }
  // Node 0.8 fallback - new Buffer() is uninitialized (fast)
  return new Buffer(len);
};

// Safe version that zero-fills (use when buffer may be read before written)
makeBuffer.safe = function(len) {
  if (Buffer.alloc) {
    return Buffer.alloc(len);
  }
  // Node 0.8 fallback
  var buf = new Buffer(len);
  buf.fill(0);
  return buf;
};

module.exports = makeBuffer;
