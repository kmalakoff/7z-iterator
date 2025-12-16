/**
 * Download and cache test fixtures using get-remote
 * Node 0.8 compatible
 */
import fs from 'fs';
import getFile from 'get-file-compat';
import mkdirp from 'mkdirp-classic';
import path from 'path';
import { TMP_DIR } from './constants.ts';

// Cache directory for downloaded fixtures
export const CACHE_DIR = path.join(TMP_DIR, 'fixtures');

/**
 * Download a file to the cache directory if not already present
 * @param url - URL to download from
 * @param filename - Local filename to save as
 * @param callback - Called with (err, filepath)
 */
export function downloadFixture(url: string, filename: string, callback: (err: Error | null, filepath?: string) => void): void {
  const filepath = path.join(CACHE_DIR, filename);

  // Check if already cached
  fs.stat(filepath, (statErr) => {
    if (!statErr) {
      // Already exists
      return callback(null, filepath);
    }

    // Create cache directory
    mkdirp(CACHE_DIR, (mkdirErr: Error | null) => {
      if (mkdirErr) return callback(mkdirErr);

      getFile(url, filepath, (downloadErr?: Error) => {
        if (downloadErr) return callback(downloadErr);
        callback(null, filepath);
      });
    });
  });
}

/**
 * Ensure a fixture is downloaded before tests run
 * Returns a mocha before() hook
 */
export function ensureFixture(url: string, filename: string): (done: (err?: Error) => void) => void {
  return function beforeHook(done: (err?: Error) => void): void {
    downloadFixture(url, filename, (err) => {
      done(err || undefined);
    });
  };
}

/**
 * Get the path to a cached fixture
 */
export function getFixturePath(filename: string): string {
  return path.join(CACHE_DIR, filename);
}
