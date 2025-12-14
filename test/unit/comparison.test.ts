/**
 * Comparison test between native sevenzip and 7z-iterator
 *
 * This test downloads a real-world 7z file (Node.js Windows distribution) and compares
 * the extracted results between system 7z and 7z-iterator to verify they
 * produce identical output.
 */

import SevenZipIterator from '7z-iterator';
import assert from 'assert';
import { exec } from 'child_process';
import fs from 'fs';
import Iterator from 'fs-iterator';
import { rmSync } from 'fs-remove-compat';
import getFile from 'get-file-compat';
import path from 'path';
import { TMP_DIR } from '../lib/constants.ts';

// Test configuration
const ARCHIVE_URL = 'https://nodejs.org/dist/v24.12.0/node-v24.12.0-win-x64.7z';
const CACHE_DIR = path.join(process.cwd(), '.cache');
const CACHE_PATH = path.join(CACHE_DIR, 'node-v24.12.0-win-x64.7z');
const SEVENZIP_EXTRACT_DIR = path.join(TMP_DIR, 'sevenzip');
const ITERATOR_EXTRACT_DIR = path.join(TMP_DIR, '7z-iterator');

/**
 * Interface for file stats collected from directory tree
 */
interface FileStats {
  size: number;
  mode: number;
  mtime: number;
  type: 'directory' | 'file' | 'symlink' | 'other';
}

/**
 * Collect file stats from a directory tree
 * Returns a map of relative paths to their FileStats
 */
function collectStats(dirPath: string, callback: (err: Error | null, stats?: Record<string, FileStats>) => void): void {
  const stats: Record<string, FileStats> = {};
  const iterator = new Iterator(dirPath);

  iterator.forEach(
    (entry): undefined => {
      // Calculate relative path from dirPath
      const absolutePath = entry.absolute || entry.absolutePath || entry.path;
      const relativePath = path.relative(dirPath, absolutePath);

      stats[relativePath] = {
        size: entry.stats.size,
        mode: entry.stats.mode,
        mtime: entry.stats.mtime instanceof Date ? entry.stats.mtime.getTime() : 0,
        type: entry.stats.isDirectory() ? 'directory' : entry.stats.isFile() ? 'file' : entry.stats.isSymbolicLink() ? 'symlink' : 'other',
      };
    },
    { concurrency: 1024 },
    (err) => {
      if (err) {
        callback(err);
      } else {
        callback(null, stats);
      }
    }
  );
}

/**
 * Remove directory if it exists
 */
function removeDir(dirPath: string): void {
  if (fs.existsSync(dirPath)) {
    rmSync(dirPath, { recursive: true, force: true });
  }
}

describe('Comparison - 7z-iterator vs native sevenzip', () => {
  let hasComparison = false;

  before((done) => {
    // Ensure .cache directory exists
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    // Download archive if it doesn't exist
    if (!fs.existsSync(CACHE_PATH)) {
      console.log(`Downloading ${ARCHIVE_URL}...`);
      getFile(ARCHIVE_URL, CACHE_PATH, (err) => {
        if (err) {
          done(err);
          return;
        }
        console.log('Download complete');
        startExtraction();
      });
    } else {
      console.log('Using cached archive file');
      startExtraction();
    }

    function startExtraction(): void {
      // Clean up previous extractions
      removeDir(SEVENZIP_EXTRACT_DIR);
      removeDir(ITERATOR_EXTRACT_DIR);

      // Extract with native 7zz
      console.log('Extracting with native 7zz...');
      exec(`7zz x -y -o${SEVENZIP_EXTRACT_DIR} ${CACHE_PATH}`, (err, _stdout, _stderr) => {
        hasComparison = !err;
        if (err) {
          done();
          return;
        }

        // Extract with 7z-iterator
        console.log('Extracting with 7z-iterator...');
        const iterator = new SevenZipIterator(CACHE_PATH);
        const options = { now: new Date() };

        iterator.forEach(
          (entry, callback): undefined => {
            entry.create(ITERATOR_EXTRACT_DIR, options, (err) => {
              callback(err);
            });
          },
          { callbacks: true },
          (err): undefined => {
            if (err) {
              done(err);
            } else {
              console.log('Both extractions complete');
              done();
            }
          }
        );
      });
    }
  });

  it('should produce identical extraction results', (done) => {
    if (!hasComparison) {
      done();
      return;
    }

    // Collect stats from both directories
    console.log('Collecting stats from native 7zz extraction...');
    collectStats(SEVENZIP_EXTRACT_DIR, (err1, statsSevenZip) => {
      if (err1) {
        done(err1);
        return;
      }

      console.log('Collecting stats from 7z-iterator extraction...');
      collectStats(ITERATOR_EXTRACT_DIR, (err2, statsIterator) => {
        if (err2) {
          done(err2);
          return;
        }

        // Find differences
        const differences: string[] = [];

        // Check for files only in native 7zz
        for (const path in statsSevenZip) {
          if (!(path in statsIterator)) {
            differences.push(`File exists in native 7zz but not in 7z-iterator: ${path}`);
          }
        }

        // Check for files only in 7z-iterator
        for (const path in statsIterator) {
          if (!(path in statsSevenZip)) {
            differences.push(`File exists in 7z-iterator but not in native 7zz: ${path}`);
          }
        }

        // Check for differences in files that exist in both
        for (const path in statsSevenZip) {
          if (path in statsIterator) {
            const statSevenZip = statsSevenZip[path];
            const statIterator = statsIterator[path];

            if (statSevenZip.type !== statIterator.type) {
              differences.push(`Type mismatch for ${path}: native=${statSevenZip.type}, 7z-iterator=${statIterator.type}`);
            }

            if (statSevenZip.size !== statIterator.size) {
              differences.push(`Size mismatch for ${path}: native=${statSevenZip.size}, 7z-iterator=${statIterator.size}`);
            }

            // Check mode (permissions), but allow for minor differences due to umask
            const modeDiff = Math.abs(statSevenZip.mode - statIterator.mode);
            if (modeDiff > 0o22) {
              // Allow up to umask differences (typically 0o022)
              differences.push(`Mode mismatch for ${path}: native=${statSevenZip.mode.toString(8)}, 7z-iterator=${statIterator.mode.toString(8)}`);
            }
          }
        }

        // Report any differences
        if (differences.length > 0) {
          console.error('\n=== DIFFERENCES FOUND ===');
          for (const diff of differences) {
            console.error(diff);
          }
          console.error('=========================\n');

          done(new Error(`Found ${differences.length} difference(s) between native 7zz and 7z-iterator extraction`));
          return;
        }

        assert.strictEqual(Object.keys(statsSevenZip).length, Object.keys(statsIterator).length, 'Should have same number of files');
        done();
      });
    });
  });
});
