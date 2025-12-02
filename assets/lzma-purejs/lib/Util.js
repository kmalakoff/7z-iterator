'use strict';
var LZMA = require('./LZMA');
var Stream = require('./Stream');

var coerceInputStream = function(input) {
  if ('readByte' in input) { return input; }
  var inputStream = new Stream();
  inputStream.pos = 0;
  inputStream.size = input.length;
  inputStream.readByte = function() {
      return this.eof() ? -1 : input[this.pos++];
  };
  inputStream.read = function(buffer, bufOffset, length) {
    var bytesRead = 0;
    while (bytesRead < length && this.pos < input.length) {
      buffer[bufOffset++] = input[this.pos++];
      bytesRead++;
    }
    return bytesRead;
  };
  inputStream.seek = function(pos) { this.pos = pos; };
  inputStream.eof = function() { return this.pos >= input.length; };
  return inputStream;
};

var coerceOutputStream = function(output) {
  var outputStream = new Stream();
  var resizeOk = true;
  if (output) {
    if (typeof(output)==='number') {
      outputStream.buffer = Buffer.alloc(output);
      resizeOk = false;
    } else if ('writeByte' in output) {
      return output;
    } else {
      outputStream.buffer = output;
      resizeOk = false;
    }
  } else {
    outputStream.buffer = Buffer.alloc(16384);
  }
  outputStream.pos = 0;
  outputStream.writeByte = function(_byte) {
    if (resizeOk && this.pos >= this.buffer.length) {
      var newBuffer = Buffer.alloc(this.buffer.length*2);
      this.buffer.copy(newBuffer);
      this.buffer = newBuffer;
    }
    this.buffer[this.pos++] = _byte;
  };
  outputStream.getBuffer = function() {
    if (this.pos !== this.buffer.length) {
      if (!resizeOk)
        throw new TypeError('outputsize does not match decoded input');
      var newBuffer = Buffer.alloc(this.pos);
      this.buffer.copy(newBuffer, 0, 0, this.pos);
      this.buffer = newBuffer;
    }
    return this.buffer;
  };
  outputStream._coerced = true;
  return outputStream;
};

var Util = {};

Util.decompress = function(properties, inStream, outStream, outSize){
  var decoder = new LZMA.Decoder();
  if (!decoder.setDecoderProperties(properties)) {
    throw new Error("Incorrect stream properties");
  }
  if (!decoder.code(inStream, outStream, outSize)) {
    throw new Error("Error in data stream");
  }
  return true;
};

Util.decompressFile = function(inStream, outStream){
  var decoder = new LZMA.Decoder(), i, mult;
  inStream = coerceInputStream(inStream);
  if (!decoder.setDecoderPropertiesFromStream(inStream)) {
    throw new Error("Incorrect stream properties");
  }
  var outSizeLo = 0;
  for (i=0, mult=1; i<4; i++, mult*=256) {
    outSizeLo += (inStream.readByte() * mult);
  }
  var outSizeHi = 0;
  for (i=0, mult=1; i<4; i++, mult*=256) {
    outSizeHi += (inStream.readByte() * mult);
  }
  var outSize = outSizeLo + (outSizeHi * 0x100000000);
  if (outSizeLo === 0xFFFFFFFF && outSizeHi === 0xFFFFFFFF) {
    outSize = -1;
  } else if (outSizeHi >= 0x200000) {
    outSize = -1;
  }
  if (outSize >= 0 && !outStream) { outStream = outSize; }
  outStream = coerceOutputStream(outStream);
  if (!decoder.code(inStream, outStream, outSize)) {
    throw new Error("Error in data stream");
  }
  return ('getBuffer' in outStream) ? outStream.getBuffer() : true;
};

Util.compress = function(inStream, outStream, props, progress){
  throw new Error("Compression not supported - decoder only");
};

Util.compressFile = function(inStream, outStream, props, progress) {
  throw new Error("Compression not supported - decoder only");
};

module.exports = Util;
