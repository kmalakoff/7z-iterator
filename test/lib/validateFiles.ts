import assert from 'assert';
import fs from 'fs';
import Iterator, { type Entry } from 'fs-iterator';
import statsSpys from 'fs-stats-spys';
import path from 'path';

import { FIXTURE_CONTENT, TARGET } from './constants.ts';

type Callback = (err?: Error | null) => void;

export default function validateFiles(options: Record<string, unknown> | string, _type?: Callback | string, callback?: Callback): void | Promise<void> {
  callback = typeof _type === 'function' ? _type : callback;
  _type = typeof _type === 'function' ? undefined : _type;

  if (typeof callback === 'function') {
    const cb = callback;
    if (typeof options === 'string') options = { type: options };

    const dataPath = !options.strip ? path.join(TARGET, 'data') : TARGET;
    const spys = statsSpys();

    new Iterator(dataPath, { lstat: true }).forEach(
      (entry: Entry): void => {
        spys(entry.stats as import('fs').Stats);
        if ((entry.stats as import('fs').Stats).isFile()) {
          const content = fs.readFileSync(entry.fullPath).toString();
          // Check that file content starts with our fixture content prefix
          assert.ok(content.indexOf(FIXTURE_CONTENT) === 0, `File content should start with fixture content prefix: ${entry.fullPath}`);
        }
      },
      (err?: Error | null): void => {
        if (err) return cb(err);
        // Our test fixture has 4 directories (data, dir1, dir2, dir3) and 4 files
        assert.equal(spys.dir.callCount, 3, 'Expected 3 subdirectories (dir1, dir1/dir2, dir3)');
        assert.equal(spys.file.callCount, 4, 'Expected 4 files');
        cb();
      }
    );
    return;
  }
  return new Promise((resolve, reject) => validateFiles(options, _type as string, (err?: Error | null) => (err ? reject(err) : resolve())));
}
