'use strict';

// Node 0.8 compatible buffer allocation
var makeBuffer = function(len) {
  if (Buffer.alloc) {
    return Buffer.alloc(len);
  }
  // Node 0.8 fallback
  var buf = new Buffer(len);
  buf.fill(0);
  return buf;
};

module.exports = makeBuffer;
