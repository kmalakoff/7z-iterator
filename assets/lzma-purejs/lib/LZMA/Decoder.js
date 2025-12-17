'use strict';
var Base = require('./Base');
var LZ = require('../LZ');
var RangeCoder = require('../RangeCoder');

var initBitModels = RangeCoder.Encoder.initBitModels;

var LenDecoder = function(){
  this._choice = initBitModels(null, 2);
  this._lowCoder = [];
  this._midCoder = [];
  this._highCoder = new RangeCoder.BitTreeDecoder(8);
  this._numPosStates = 0;
};

LenDecoder.prototype.create = function(numPosStates){
  for (; this._numPosStates < numPosStates; ++this._numPosStates){
    this._lowCoder[this._numPosStates] = new RangeCoder.BitTreeDecoder(3);
    this._midCoder[this._numPosStates] = new RangeCoder.BitTreeDecoder(3);
  }
};

LenDecoder.prototype.init = function(){
  initBitModels(this._choice);
  for (var i = this._numPosStates - 1; i >= 0; i--){
    this._lowCoder[i].init();
    this._midCoder[i].init();
  }
  this._highCoder.init();
};

LenDecoder.prototype.decode = function(rangeDecoder, posState){
  if (rangeDecoder.decodeBit(this._choice, 0) === 0){
    return this._lowCoder[posState].decode(rangeDecoder);
  }
  if (rangeDecoder.decodeBit(this._choice, 1) === 0){
    return 8 + this._midCoder[posState].decode(rangeDecoder);
  }
  return 16 + this._highCoder.decode(rangeDecoder);
};

var LiteralDecoder = function(){};

LiteralDecoder.Decoder2 = function(){
  this._decoders = initBitModels(null, 0x300);
};

LiteralDecoder.Decoder2.prototype.init = function(){
  initBitModels(this._decoders);
};

LiteralDecoder.Decoder2.prototype.decodeNormal = function(rangeDecoder){
  var symbol = 1;
  do {
    symbol = (symbol << 1) | rangeDecoder.decodeBit(this._decoders, symbol);
  } while(symbol < 0x100);
  return symbol & 0xff;
};

LiteralDecoder.Decoder2.prototype.decodeWithMatchByte = function(rangeDecoder, matchByte){
  var symbol = 1;
  do {
    var matchBit = (matchByte >> 7) & 1;
    matchByte <<= 1;
    var bit = rangeDecoder.decodeBit(this._decoders, ((1 + matchBit) << 8) + symbol);
    symbol = (symbol << 1) | bit;
    if (matchBit !== bit){
      while(symbol < 0x100){
        symbol = (symbol << 1) | rangeDecoder.decodeBit(this._decoders, symbol);
      }
      break;
    }
  } while(symbol < 0x100);
  return symbol & 0xff;
};

LiteralDecoder.prototype.create = function(numPosBits, numPrevBits){
  if (this._coders && this._numPrevBits === numPrevBits && this._numPosBits === numPosBits) return;
  this._numPosBits = numPosBits;
  this._posMask = (1 << numPosBits) - 1;
  this._numPrevBits = numPrevBits;
  // Lazy allocation: only create coders array, allocate individual coders on demand
  // This saves significant memory for archives that don't use all coder slots
  this._coders = [];
  this._coderCount = 1 << (this._numPrevBits + this._numPosBits);
};

LiteralDecoder.prototype.init = function(){
  // Only init coders that have been allocated (lazy allocation support)
  for (var i = 0; i < this._coders.length; i++){
    if (this._coders[i]) {
      this._coders[i].init();
    }
  }
};

LiteralDecoder.prototype.getDecoder = function(pos, prevByte){
  var index = ((pos & this._posMask) << this._numPrevBits) +
              ((prevByte & 0xff) >>> (8 - this._numPrevBits));
  // Lazy allocation: create coder on first access
  if (!this._coders[index]) {
    this._coders[index] = new LiteralDecoder.Decoder2();
  }
  return this._coders[index];
};

var Decoder = function(){
  this._outWindow = new LZ.OutWindow();
  this._rangeDecoder = new RangeCoder.Decoder();
  this._isMatchDecoders = initBitModels(null, Base.kNumStates << Base.kNumPosStatesBitsMax);
  this._isRepDecoders = initBitModels(null, Base.kNumStates);
  this._isRepG0Decoders = initBitModels(null, Base.kNumStates);
  this._isRepG1Decoders = initBitModels(null, Base.kNumStates);
  this._isRepG2Decoders = initBitModels(null, Base.kNumStates);
  this._isRep0LongDecoders = initBitModels(null, Base.kNumStates << Base.kNumPosStatesBitsMax);
  this._posSlotDecoder = [];
  this._posDecoders = initBitModels(null, Base.kNumFullDistances - Base.kEndPosModelIndex);
  this._posAlignDecoder = new RangeCoder.BitTreeDecoder(Base.kNumAlignBits);
  this._lenDecoder = new LenDecoder();
  this._repLenDecoder = new LenDecoder();
  this._literalDecoder = new LiteralDecoder();
  this._dictionarySize = -1;
  this._dictionarySizeCheck = -1;
  this._posStateMask = 0;

  // LZMA2 state preservation
  this._state = 0;
  this._rep0 = 0;
  this._rep1 = 0;
  this._rep2 = 0;
  this._rep3 = 0;
  this._prevByte = 0;
  this._nowPos64 = 0;
  this._solid = false;

  for (var i = 0; i < Base.kNumLenToPosStates; i++){
    this._posSlotDecoder[i] = new RangeCoder.BitTreeDecoder(Base.kNumPosSlotBits);
  }
};

Decoder.prototype.setSolid = function(solid) {
  this._solid = solid;
};

Decoder.prototype.resetProbabilities = function() {
  // Reset probability tables (same as init() but without dictionary/stream reset)
  // Used for LZMA2 control bytes 0xa0-0xdf (state reset without dictionary reset)
  initBitModels(this._isMatchDecoders);
  initBitModels(this._isRepDecoders);
  initBitModels(this._isRepG0Decoders);
  initBitModels(this._isRepG1Decoders);
  initBitModels(this._isRepG2Decoders);
  initBitModels(this._isRep0LongDecoders);
  initBitModels(this._posDecoders);
  this._literalDecoder.init();
  for (var i = this._posSlotDecoder.length - 1; i >= 0; i--) {
    this._posSlotDecoder[i].init();
  }
  this._lenDecoder.init();
  this._repLenDecoder.init();
  this._posAlignDecoder.init();
  // Reset state variables
  this._state = 0;
  this._rep0 = 0;
  this._rep1 = 0;
  this._rep2 = 0;
  this._rep3 = 0;
  // DO NOT reset _nowPos64, _prevByte, or dictionary
};

Decoder.prototype.setDictionarySize = function(dictionarySize){
  if (dictionarySize < 0) return false;
  if (this._dictionarySize !== dictionarySize){
    this._dictionarySize = dictionarySize;
    this._dictionarySizeCheck = Math.max(this._dictionarySize, 1);
    this._outWindow.create(Math.max(this._dictionarySizeCheck, (1 << 12)));
  }
  return true;
};

Decoder.prototype.setLcLpPb = function(lc, lp, pb){
  if (lc > Base.kNumLitContextBitsMax || lp > 4 || pb > Base.kNumPosStatesBitsMax) return false;
  var numPosStates = 1 << pb;
  this._literalDecoder.create(lp, lc);
  this._lenDecoder.create(numPosStates);
  this._repLenDecoder.create(numPosStates);
  this._posStateMask = numPosStates - 1;
  return true;
};

Decoder.prototype.init = function(){
  this._outWindow.init(false);
  initBitModels(this._isMatchDecoders);
  initBitModels(this._isRepDecoders);
  initBitModels(this._isRepG0Decoders);
  initBitModels(this._isRepG1Decoders);
  initBitModels(this._isRepG2Decoders);
  initBitModels(this._isRep0LongDecoders);
  initBitModels(this._posDecoders);
  this._literalDecoder.init();
  for (var i = Base.kNumLenToPosStates - 1; i >= 0; i--){
    this._posSlotDecoder[i].init();
  }
  this._lenDecoder.init();
  this._repLenDecoder.init();
  this._posAlignDecoder.init();
  this._rangeDecoder.init();
};

Decoder.prototype.code = function(inStream, outStream, outSize){
  var chunkPos = 0, posState, decoder2, len, distance, posSlot, numDirectBits;
  this._rangeDecoder.setStream(inStream);
  this._outWindow.setStream(outStream);

  if (!this._solid) {
    this.init();
    this._state = Base.stateInit();
    this._rep0 = 0;
    this._rep1 = 0;
    this._rep2 = 0;
    this._rep3 = 0;
    this._prevByte = 0;
    this._nowPos64 = 0;
  } else {
    this._outWindow.init(true);
    this._rangeDecoder.init();
  }
  var cumPos = this._nowPos64;

  while(outSize < 0 || chunkPos < outSize){
    posState = cumPos & this._posStateMask;
    if (this._rangeDecoder.decodeBit(this._isMatchDecoders, (this._state << Base.kNumPosStatesBitsMax) + posState) === 0){
      decoder2 = this._literalDecoder.getDecoder(cumPos, this._prevByte);
      if (!Base.stateIsCharState(this._state)){
        this._prevByte = decoder2.decodeWithMatchByte(this._rangeDecoder, this._outWindow.getByte(this._rep0));
      } else {
        this._prevByte = decoder2.decodeNormal(this._rangeDecoder);
      }
      this._outWindow.putByte(this._prevByte);
      this._state = Base.stateUpdateChar(this._state);
      chunkPos++; cumPos++;
    } else {
      if (this._rangeDecoder.decodeBit(this._isRepDecoders, this._state) === 1){
        len = 0;
        if (this._rangeDecoder.decodeBit(this._isRepG0Decoders, this._state) === 0){
          if (this._rangeDecoder.decodeBit(this._isRep0LongDecoders, (this._state << Base.kNumPosStatesBitsMax) + posState) === 0){
            this._state = Base.stateUpdateShortRep(this._state);
            len = 1;
          }
        } else {
          if (this._rangeDecoder.decodeBit(this._isRepG1Decoders, this._state) === 0){
            distance = this._rep1;
          } else {
            if (this._rangeDecoder.decodeBit(this._isRepG2Decoders, this._state) === 0){
              distance = this._rep2;
            } else {
              distance = this._rep3;
              this._rep3 = this._rep2;
            }
            this._rep2 = this._rep1;
          }
          this._rep1 = this._rep0;
          this._rep0 = distance;
        }
        if (len === 0){
          len = Base.kMatchMinLen + this._repLenDecoder.decode(this._rangeDecoder, posState);
          this._state = Base.stateUpdateRep(this._state);
        }
      } else {
        this._rep3 = this._rep2;
        this._rep2 = this._rep1;
        this._rep1 = this._rep0;
        len = Base.kMatchMinLen + this._lenDecoder.decode(this._rangeDecoder, posState);
        this._state = Base.stateUpdateMatch(this._state);
        posSlot = this._posSlotDecoder[Base.getLenToPosState(len)].decode(this._rangeDecoder);
        if (posSlot >= Base.kStartPosModelIndex){
          numDirectBits = (posSlot >> 1) - 1;
          this._rep0 = (2 | (posSlot & 1)) << numDirectBits;
          if (posSlot < Base.kEndPosModelIndex){
            this._rep0 += RangeCoder.BitTreeDecoder.reverseDecode(this._posDecoders,
                this._rep0 - posSlot - 1, this._rangeDecoder, numDirectBits);
          } else {
            this._rep0 += this._rangeDecoder.decodeDirectBits(numDirectBits - Base.kNumAlignBits) << Base.kNumAlignBits;
            this._rep0 += this._posAlignDecoder.reverseDecode(this._rangeDecoder);
            if (this._rep0 < 0){
              if (this._rep0 === -1) break;
              return false;
            }
          }
        } else {
          this._rep0 = posSlot;
        }
      }
      if (this._rep0 >= cumPos || this._rep0 >= this._dictionarySizeCheck) return false;
      this._outWindow.copyBlock(this._rep0, len);
      chunkPos += len; cumPos += len;
      this._prevByte = this._outWindow.getByte(0);
    }
  }
  this._nowPos64 = cumPos;
  this._outWindow.flush();
  this._outWindow.releaseStream();
  this._rangeDecoder.releaseStream();
  return true;
};

Decoder.prototype.setDecoderProperties = function(properties){
  if (properties.length < 5) return false;
  var value = properties[0] & 0xFF;
  var lc = value % 9;
  value = ~~(value / 9);
  var lp = value % 5;
  var pb = ~~(value / 5);
  if (!this.setLcLpPb(lc, lp, pb)) return false;
  var dictionarySize = 0;
  for (var i = 0, shift = 1; i < 4; i++, shift *= 256){
    dictionarySize += (properties[1+i] & 0xFF) * shift;
  }
  return this.setDictionarySize(dictionarySize);
};

Decoder.prototype.setDecoderPropertiesFromStream = function(stream) {
  var buffer = [];
  for (var i = 0; i < 5; i++) { buffer[i] = stream.readByte(); }
  return this.setDecoderProperties(buffer);
};

module.exports = Decoder;
