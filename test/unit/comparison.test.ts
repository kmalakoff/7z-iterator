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
import Iterator, { type Entry as FSEntry } from 'fs-iterator';
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

// Windows archives carry no Unix permissions; each native tool picks its own default.
// On macOS both 7zz and 7z use 0o700; on Linux p7zip uses 0o755.
const NATIVE_DIR_MODE = process.platform === 'linux' ? 493 : 448;

const NATIVE_7Z_TOOLS = [
  { command: '7zz', defaultDirMode: NATIVE_DIR_MODE },
  { command: '7z', defaultDirMode: NATIVE_DIR_MODE },
];

type NativeTool = (typeof NATIVE_7Z_TOOLS)[0];

// Directory type bit (0o40000 = 16384)
const S_IFDIR = 16384;

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
  const iterator = new Iterator(dirPath, { alwaysStat: true });

  iterator.forEach(
    (entry: FSEntry): void => {
      const absolutePath = (entry as FSEntry & { absolute?: string; absolutePath?: string }).absolute || (entry as FSEntry & { absolute?: string; absolutePath?: string }).absolutePath || entry.path;
      const relativePath = path.relative(dirPath, absolutePath);
      const s = entry.stats as import('fs').Stats;

      stats[relativePath] = {
        size: s.size,
        mode: s.mode,
        mtime: s.mtime instanceof Date ? s.mtime.getTime() : 0,
        type: s.isDirectory() ? 'directory' : s.isFile() ? 'file' : s.isSymbolicLink() ? 'symlink' : 'other',
      };
    },
    { concurrency: 1024 },
    (err) => (err ? callback(err) : callback(null, stats))
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

/**
 * Find the first available native 7z tool, returning its command and known default dir mode.
 */
function findNative7z(callback: (tool: NativeTool | null) => void): void {
  let i = 0;
  function tryNext(): void {
    if (i >= NATIVE_7Z_TOOLS.length) {
      callback(null);
      return;
    }
    const tool = NATIVE_7Z_TOOLS[i++];
    exec(`which ${tool.command}`, (err) => (err ? tryNext() : callback(tool)));
  }
  tryNext();
}

describe('Comparison - 7z-iterator vs native sevenzip', () => {
  let nativeTool: NativeTool | null = null;

  before(function (done) {
    this.timeout(120000);

    findNative7z((tool) => {
      nativeTool = tool;
      if (!tool) {
        console.log('    Skipping 7z comparison tests - native 7zz/7z not available');
        done();
        return;
      }

      // Ensure .cache directory exists
      if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
      }

      // Download archive if it doesn't exist
      if (!fs.existsSync(CACHE_PATH)) {
        console.log(`Downloading ${ARCHIVE_URL}...`);
        getFile(ARCHIVE_URL, CACHE_PATH, (err) => {
          if (err) return done(err);

          console.log('Download complete');
          startExtraction();
        });
      } else {
        console.log('Using cached archive file');
        startExtraction();
      }
    });

    function startExtraction(): void {
      // Clean up previous extractions
      removeDir(SEVENZIP_EXTRACT_DIR);
      removeDir(ITERATOR_EXTRACT_DIR);

      const tool = nativeTool as NativeTool;
      // Extract with native 7z
      console.log(`Extracting with native ${tool.command}...`);
      exec(`${tool.command} x -y -o${SEVENZIP_EXTRACT_DIR} ${CACHE_PATH}`, (err, _stdout, _stderr) => {
        if (err) return done(err);

        // Extract with 7z-iterator
        console.log('Extracting with 7z-iterator...');
        const iterator = new SevenZipIterator(CACHE_PATH);
        const options = { now: new Date() };

        iterator.forEach(
          (entry, callback): void => {
            entry.create(ITERATOR_EXTRACT_DIR, options, (err) => {
              callback(err);
            });
          },
          { callbacks: true },
          (err): void => {
            if (err) return done(err);
            console.log('Both extractions complete');
            done();
          }
        );
      });
    }
  });

  it('should produce identical extraction results', function (done) {
    if (!nativeTool) {
      this.skip();
      return;
    }

    const tool = nativeTool;

    // Collect stats from both directories
    console.log(`Collecting stats from native ${tool.command} extraction...`);
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

        const sz = statsSevenZip as Record<string, FileStats>;
        const si = statsIterator as Record<string, FileStats>;

        // Find differences
        const differences: string[] = [];

        // Check for files only in native
        for (const filePath in sz) {
          if (!(filePath in si)) {
            differences.push(`File exists in native ${tool.command} but not in 7z-iterator: ${filePath}`);
          }
        }

        // Check for files only in 7z-iterator
        for (const filePath in si) {
          if (!(filePath in sz)) {
            differences.push(`File exists in 7z-iterator but not in native ${tool.command}: ${filePath}`);
          }
        }

        // Check for differences in files that exist in both
        for (const filePath in sz) {
          if (filePath in si) {
            const statNative = sz[filePath];
            const statIterator = si[filePath];

            if (statNative.type !== statIterator.type) {
              differences.push(`Type mismatch for ${filePath}: native=${statNative.type}, 7z-iterator=${statIterator.type}`);
            }

            if (statNative.size !== statIterator.size) {
              differences.push(`Size mismatch for ${filePath}: native=${statNative.size}, 7z-iterator=${statIterator.size}`);
            }

            if (statNative.mode !== statIterator.mode) {
              // Windows archives have no Unix permissions; native tools apply their own default.
              // Accept the known difference between this tool's dir default and 7z-iterator's (0o755).
              const nativeDirDefault = S_IFDIR | tool.defaultDirMode;
              const iteratorDirDefault = S_IFDIR | 493; // UnixMode.DEFAULT_DIR = 0o755
              if (!(statNative.mode === nativeDirDefault && statIterator.mode === iteratorDirDefault)) {
                differences.push(`Mode mismatch for ${filePath}: native=${statNative.mode.toString(8)}, 7z-iterator=${statIterator.mode.toString(8)}`);
              }
            }
          }
        }

        // Report any differences
        if (differences.length > 0) {
          console.error('\n=== DIFFERENCES FOUND ===');
          for (let i = 0; i < differences.length; i++) {
            console.error(differences[i]);
          }
          console.error('=========================\n');

          done(new Error(`Found ${differences.length} difference(s) between native ${tool.command} and 7z-iterator extraction`));
          return;
        }

        assert.strictEqual(Object.keys(sz).length, Object.keys(si).length, 'Should have same number of files');
        done();
      });
    });
  });
});
