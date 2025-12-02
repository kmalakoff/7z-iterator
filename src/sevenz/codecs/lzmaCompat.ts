/**
 * LZMA compatibility layer - uses native lzma when available, falls back to lzma-purejs
 *
 * lzma-native provides native liblzma bindings with rawDecoder support.
 * This gives significant performance improvements on Node.js 8+ while
 * maintaining compatibility with Node.js 0.8+ via lzma-purejs fallback.
 *
 * The native decoder uses Node.js streams which integrate naturally with
 * the callback-based async pattern used throughout the iterator libraries.
 */

import Module from 'module';
import type { Transform } from 'readable-stream';

var _require = typeof require === 'undefined' ? Module.createRequire(import.meta.url) : require;

// Try to load lzma-native (only on Node 10+ where ES6 class syntax is supported)
// Note: We must check the version BEFORE requiring because syntax errors during
// module parsing cannot be caught by try/catch
var lzmaNative: typeof import('lzma-native') | null = null;
var _hasNativeLzmaLib = false;
var major = +process.versions.node.split('.')[0];

if (major >= 10) {
  try {
    lzmaNative = _require('lzma-native');
    // Verify rawDecoder support
    _hasNativeLzmaLib = lzmaNative !== null && typeof lzmaNative.createStream === 'function';
  } catch (_e) {
    // lzma-native not available - will use lzma-purejs
  }
}

// Export whether native lzma is available for streaming
export var hasNativeLzma = _hasNativeLzmaLib;

/**
 * Create a native LZMA2 decoder stream
 * Returns a Transform stream that decodes LZMA2 data
 *
 * @param dictSize - Dictionary size
 * @returns Transform stream for decoding, or null if native not available
 */
export function createNativeLzma2Decoder(dictSize?: number): Transform | null {
  if (!lzmaNative) {
    return null;
  }

  var filterOpts: { id: string; dict_size?: number } = {
    id: lzmaNative.FILTER_LZMA2,
  };

  if (dictSize !== undefined) {
    filterOpts.dict_size = dictSize;
  }

  return lzmaNative.createStream('rawDecoder', {
    filters: [filterOpts],
  }) as unknown as Transform;
}

/**
 * Create a native LZMA1 decoder stream
 * Returns a Transform stream that decodes LZMA1 data
 *
 * Note: Native LZMA1 decoder disabled due to LZMA_BUF_ERROR issues with
 * lzma-native's rawDecoder for LZMA1. Falls back to lzma-purejs which
 * handles 7z's LZMA1 format correctly. LZMA2 native works fine.
 *
 * @param _lc - Literal context bits (0-8)
 * @param _lp - Literal position bits (0-4)
 * @param _pb - Position bits (0-4)
 * @param _dictSize - Dictionary size
 * @returns null - always falls back to pure JS decoder
 */
export function createNativeLzma1Decoder(_lc: number, _lp: number, _pb: number, _dictSize: number): Transform | null {
  // Native LZMA1 disabled - lzma-native's rawDecoder has issues with 7z's LZMA1 format
  // (LZMA_BUF_ERROR: No progress is possible)
  // LZMA2 native works correctly and is more common in modern 7z files
  return null;
}
