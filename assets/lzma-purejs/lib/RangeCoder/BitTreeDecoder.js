'use strict';
var Encoder = require('./Encoder');

var BitTreeDecoder = function(numBitLevels){
  this._numBitLevels = numBitLevels;
  this.init();
};

BitTreeDecoder.prototype.init = function(){
  this._models = Encoder.initBitModels(null, 1 << this._numBitLevels);
};

BitTreeDecoder.prototype.decode = function(rangeDecoder){
  var m = 1;
  for (var i = this._numBitLevels; i > 0; i--){
    m = (m << 1) | rangeDecoder.decodeBit(this._models, m);
  }
  return m - (1 << this._numBitLevels);
};

BitTreeDecoder.prototype.reverseDecode = function(rangeDecoder){
  var m = 1, symbol = 0;
  for (var i = 0; i < this._numBitLevels; i++){
    var bit = rangeDecoder.decodeBit(this._models, m);
    m = (m << 1) | bit;
    symbol |= (bit << i);
  }
  return symbol;
};

BitTreeDecoder.reverseDecode = function(models, startIndex, rangeDecoder, numBitLevels) {
  var m = 1, symbol = 0;
  for (var i = 0; i < numBitLevels; i++){
    var bit = rangeDecoder.decodeBit(models, startIndex + m);
    m = (m << 1) | bit;
    symbol |= (bit << i);
  }
  return symbol;
};

module.exports = BitTreeDecoder;
