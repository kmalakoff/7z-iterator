// This file previously contained a global Buffer.from polyfill for Node < 4.5
// That polyfill was removed because:
// 1. The source code uses compat.ts functions (bufferFrom, allocBuffer) which handle old Node
// 2. Modifying global prototypes is discouraged per the compatibility guide
// 3. Tests should work without global modifications
//
// This file is kept as an empty import point to avoid changing all test files.
