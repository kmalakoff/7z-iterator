/**
 * Compatibility Layer for Node.js 0.8+
 * Local to this package - contains only needed functions.
 */

/**
 * Buffer.from wrapper for Node.js 0.8+
 * - Uses native Buffer.from on Node 4.5+ / ES2015+
 * - Falls back to new Buffer() constructor on Node 0.8-4.4
 */
const hasBufferFrom = typeof Buffer.from === 'function' && Buffer.from !== Uint8Array.from;

export function bufferFrom(data: string | number[] | Buffer | Uint8Array, encoding?: BufferEncoding): Buffer {
  if (hasBufferFrom) {
    if (typeof data === 'string') {
      return Buffer.from(data, encoding);
    }
    return Buffer.from(data as number[] | Buffer);
  }
  // Node 0.8-4.4 fallback using deprecated Buffer constructor
  // biome-ignore lint/suspicious/noExplicitAny: Buffer constructor signature changed between Node versions
  return new (Buffer as any)(data, encoding);
}

/**
 * Buffer.alloc wrapper for Node.js 0.8+
 * - Uses native Buffer.alloc on Node 4.5+ / ES2015+
 * - Falls back to new Buffer() on Node 0.8-4.4
 */
const hasBufferAlloc = typeof Buffer.alloc === 'function';

export function bufferAlloc(size: number, fill?: number | string | Buffer, encoding?: BufferEncoding): Buffer {
  if (hasBufferAlloc) {
    return Buffer.alloc(size, fill, encoding);
  }
  // Node 0.8-4.4 fallback
  // biome-ignore lint/suspicious/noExplicitAny: Buffer constructor signature changed between Node versions
  const buf = new (Buffer as any)(size);
  if (fill !== undefined) {
    if (typeof encoding === 'string') {
      buf.fill(fill, encoding);
    } else {
      buf.fill(fill);
    }
  } else {
    buf.fill(0);
  }
  return buf;
}

/**
 * Array.prototype.find wrapper for Node.js 0.8+
 * - Uses native find on Node 4.0+ / ES2015+
 * - Falls back to loop on Node 0.8-3.x
 */
const hasArrayFind = typeof Array.prototype.find === 'function';

export function arrayFind<T>(arr: T[], predicate: (item: T) => boolean): T | undefined {
  if (hasArrayFind) {
    return arr.find(predicate);
  }
  for (let i = 0; i < arr.length; i++) {
    if (predicate(arr[i])) {
      return arr[i];
    }
  }
  return undefined;
}

/**
 * String.prototype.endsWith wrapper for Node.js 0.8+
 * - Uses native endsWith on Node 4.0+ / ES2015+
 * - Falls back to indexOf on Node 0.8-3.x
 */
const hasEndsWith = typeof String.prototype.endsWith === 'function';
export function stringEndsWith(str: string, search: string, position?: number): boolean {
  if (hasEndsWith) return str.endsWith(search, position);
  const len = position === undefined ? str.length : position;
  return str.lastIndexOf(search) === len - search.length;
}
