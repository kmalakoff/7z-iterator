import { defer } from '../../src/compat.ts';

// Poll a condition until true with no fixed duration or timeout
export default function waitFor(description: string, check: () => boolean, callback: (err?: Error) => void): void {
  function tick(): void {
    let done = false;
    try {
      done = check();
    } catch (err) {
      callback(new Error(`waitFor(${description}) failed: ${(err as Error).message}`));
      return;
    }
    if (done) {
      callback();
      return;
    }
    defer(tick);
  }
  tick();
}
