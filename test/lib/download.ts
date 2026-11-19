/** Download and verify persistent test artifacts. Node 0.8 compatible. */

import getFile from 'get-file-compat';
import path from 'path';
import { stagedCache, verifySha256 } from 'staged-cache';
import { CACHE_DIR } from './constants.ts';

export interface DownloadedArtifact {
  url: string;
  filename: string;
  version: string;
  license: string;
  provenance: string;
  sha256: string;
}

/** Download an artifact into the shared cache; a valid copy is reused, anything else is built, verified and renamed into place. */
export function downloadFixture(artifact: DownloadedArtifact, callback: (err?: Error | null, filepath?: string) => void): void {
  stagedCache(
    path.join(CACHE_DIR, artifact.filename),
    {
      verify: verifySha256(artifact.sha256),
      build: (staging: string, cb: (err?: Error | null) => void) => {
        getFile(artifact.url, staging, (err: Error | null, res?: { statusCode?: number }) => {
          cb(err || (res && res.statusCode !== 200 ? new Error(`HTTP ${res.statusCode}: ${artifact.url}`) : null));
        });
      },
    },
    callback
  );
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
