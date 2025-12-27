import assert from 'assert';
import fs from 'fs';
import Iterator from 'fs-iterator';
import statsSpys from 'fs-stats-spys';
import path from 'path';

import { FIXTURE_CONTENT, TARGET } from './constants.ts';

export default function validateFiles(options, _type?, callback?) {
  callback = typeof _type === 'function' ? _type : callback;
  _type = typeof _type === 'function' ? undefined : _type;

  if (typeof callback === 'function') {
    if (typeof options === 'string') options = { type: options };

    const dataPath = !options.strip ? path.join(TARGET, 'data') : TARGET;
    const spys = statsSpys();

    new Iterator(dataPath, { lstat: true }).forEach(
      (entry): void => {
        spys(entry.stats);
        if (entry.stats.isFile()) {
          const content = fs.readFileSync(entry.fullPath).toString();
          // Check that file content starts with our fixture content prefix
          assert.ok(content.indexOf(FIXTURE_CONTENT) === 0, `File content should start with fixture content prefix: ${entry.fullPath}`);
        }
      },
      (err) => {
        if (err) return callback(err);
        // Our test fixture has 4 directories (data, dir1, dir2, dir3) and 4 files
        assert.equal(spys.dir.callCount, 3, 'Expected 3 subdirectories (dir1, dir1/dir2, dir3)');
        assert.equal(spys.file.callCount, 4, 'Expected 4 files');
        callback();
      }
    );
    return;
  }
  return new Promise((resolve, reject) => validateFiles(options, _type, (err?: Error) => (err ? reject(err) : resolve(null))));
}
