'use strict';

var MAX32 = 0xFFFFFFFF;
var MAX24 = 0x00FFFFFF;
var MAX8  = 0x000000FF;
var MASK24= 0xFF000000;

var kNumBitModelTotalBits = 11;
var kBitModelTotal = (1 << kNumBitModelTotalBits);
var kNumMoveBits = 5;
var kNumMoveReducingBits = 2;
var kNumBitPriceShiftBits = 6;

var Encoder = function(stream){
  this.init();
  if (stream) { this.setStream(stream); }
};
Encoder.prototype.setStream = function(stream) { this._stream = stream; };
Encoder.prototype.releaseStream = function() { this._stream = null; };
Encoder.prototype.init = function() {
  this._position = 0;
  this.low = 0;
  this.range = MAX32;
  this._cacheSize = 1;
  this._cache = 0;
};
Encoder.prototype.flushData = function() {
  for (var i=0; i<5; i++) { this.shiftLow(); }
};
Encoder.prototype.flushStream = function() {
  if (this._stream.flush) { this._stream.flush(); }
};
Encoder.prototype.shiftLow = function() {
  var overflow = (this.low > MAX32) ? 1 : 0;
  if (this.low < MASK24 || overflow) {
    this._position += this._cacheSize;
    var temp = this._cache;
    do {
      this._stream.writeByte((temp + overflow) & MAX8);
      temp = MAX8;
    } while (--this._cacheSize !== 0);
    this._cache = this.low >>> 24;
  }
  this._cacheSize++;
  this.low = (this.low & MAX24) * 256;
};
Encoder.prototype.encodeDirectBits = function(v, numTotalBits) {
  var mask = 1 << (numTotalBits-1);
  for (var i = numTotalBits - 1; i >= 0; i--, mask>>>=1) {
    this.range >>>= 1;
    if (v & mask) { this.low += this.range; }
    if (this.range <= MAX24) {
      this.range *= 256;
      this.shiftLow();
    }
  }
};
Encoder.prototype.getProcessedSizeAdd = function() {
  return this._cacheSize + this._position + 4;
};
Encoder.initBitModels = function(probs, len) {
  if (len && !probs) {
    probs = typeof(Uint16Array)!=='undefined' ? new Uint16Array(len) : new Array(len);
  }
  for (var i=0; i < probs.length; i++) { probs[i] = (kBitModelTotal >>> 1); }
  return probs;
};
Encoder.prototype.encode = function(probs, index, symbol) {
  var prob = probs[index];
  var newBound = (this.range >>> kNumBitModelTotalBits) * prob;
  if (symbol === 0) {
    this.range = newBound;
    probs[index] = prob + ((kBitModelTotal - prob) >>> kNumMoveBits);
  } else {
    this.low += newBound;
    this.range -= newBound;
    probs[index] = prob - (prob >>> kNumMoveBits);
  }
  if (this.range <= MAX24) {
    this.range *= 256;
    this.shiftLow();
  }
};

var ProbPrices = typeof(Uint32Array)!=='undefined' ?
  new Uint32Array(kBitModelTotal >>> kNumMoveReducingBits) : [];
(function() {
  var kNumBits = (kNumBitModelTotalBits - kNumMoveReducingBits);
  for (var i = kNumBits - 1; i >= 0; i--) {
    var start = 1 << (kNumBits - i - 1);
    var end = 1 << (kNumBits - i);
    for (var j = start; j < end; j++) {
      ProbPrices[j] = (i << kNumBitPriceShiftBits) +
        (((end - j) << kNumBitPriceShiftBits) >>> (kNumBits - i - 1));
    }
  }
})();

Encoder.getPrice = function(prob, symbol) {
  return ProbPrices[(((prob - symbol) ^ ((-symbol))) & (kBitModelTotal - 1)) >>> kNumMoveReducingBits];
};
Encoder.getPrice0 = function(prob) { return ProbPrices[prob >>> kNumMoveReducingBits]; };
Encoder.getPrice1 = function(prob) { return ProbPrices[(kBitModelTotal - prob) >>> kNumMoveReducingBits]; };
Encoder.kNumBitPriceShiftBits = kNumBitPriceShiftBits;

module.exports = Encoder;
