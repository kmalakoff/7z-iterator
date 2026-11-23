// Compatibility layer for Node.js 0.8+

// Yield to I/O: setImmediate (Node 0.10+) or setTimeout fallback (Node 0.8)
export const defer: (fn: () => void) => void = typeof setImmediate === 'function' ? setImmediate : (fn) => setTimeout(fn, 0);
