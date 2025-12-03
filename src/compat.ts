/**
 * Compatibility Layer for Node.js 0.8+
 * Local to this package - contains only needed functions.
 */
import os from 'os';

/**
 * os.tmpdir wrapper for Node.js 0.8+
 * - Uses native os.tmpdir on Node 0.10+
 * - Falls back to os-shim on Node 0.8
 */
var hasTmpdir = typeof os.tmpdir === 'function';

export function tmpdir(): string {
  if (hasTmpdir) {
    return os.tmpdir();
  }
  var osShim = require('os-shim');
  return osShim.tmpdir();
}
