/** Download and verify persistent test artifacts. Node 0.8 compatible. */

import crypto from 'crypto';
import fs from 'fs';
import getFile from 'get-file-compat';
import mkdirp from 'mkdirp-classic';
import path from 'path';
import { TMP_DIR } from './constants.ts';

export const CACHE_DIR = path.join(TMP_DIR, 'cache');

export interface DownloadedArtifact {
  url: string;
  filename: string;
  version: string;
  license: string;
  provenance: string;
  sha256: string;
}

/** Download an artifact, verify it, and publish it with a rename. */
function removeFile(filepath: string, callback: (err: Error | null) => void): void {
  fs.unlink(filepath, (err) => callback(err || null));
}

function cleanPartial(filepath: string, originalErr: Error, callback: (err: Error) => void): void {
  removeFile(filepath, () => callback(originalErr));
}

function verifyFile(filepath: string, expectedHash: string, callback: (err: Error | null, valid?: boolean) => void): void {
  const hash = crypto.createHash('sha256');
  const stream = fs.createReadStream(filepath);
  let completed = false;
  function finish(err: Error | null, valid?: boolean): void {
    if (completed) return;
    completed = true;
    callback(err, valid);
  }
  stream.on('data', (chunk) => hash.update(chunk));
  stream.on('error', (err: Error) => finish(err));
  stream.on('end', () => finish(null, hash.digest('hex') === expectedHash));
}

export function downloadFixture(artifact: DownloadedArtifact, callback: (err: Error | null, filepath?: string) => void): void {
  const filepath = path.join(CACHE_DIR, artifact.filename);
  fs.stat(filepath, (statErr) => {
    if (!statErr) {
      return verifyFile(filepath, artifact.sha256, (verifyErr, valid) => {
        if (verifyErr) return callback(verifyErr);
        if (valid) return callback(null, filepath);
        removeFile(filepath, (removeErr) => {
          if (removeErr) return callback(removeErr);
          downloadFresh();
        });
      });
    }
    downloadFresh();

    function downloadFresh(): void {
      mkdirp(CACHE_DIR, (mkdirErr: Error | null) => {
        if (mkdirErr) return callback(mkdirErr);
        const partialPath = `${filepath}.partial-${process.pid}-${Date.now()}`;
        getFile(artifact.url, partialPath, (downloadErr: Error | null) => {
          if (downloadErr) return cleanPartial(partialPath, downloadErr, callback);
          verifyFile(partialPath, artifact.sha256, (verifyErr, valid) => {
            if (verifyErr) return cleanPartial(partialPath, verifyErr, callback);
            if (!valid) return cleanPartial(partialPath, new Error(`SHA-256 mismatch for ${artifact.filename}`), callback);
            fs.rename(partialPath, filepath, (renameErr) => {
              if (!renameErr) return callback(null, filepath);
              cleanPartial(partialPath, renameErr, callback);
            });
          });
        });
      });
    }
  });
}

/**
 * Ensure an artifact is downloaded before tests run.
 */
export function ensureFixture(artifact: DownloadedArtifact): (done: (err?: Error | null) => void) => void {
  return function beforeHook(done: (err?: Error | null) => void): void {
    downloadFixture(artifact, (err) => {
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
