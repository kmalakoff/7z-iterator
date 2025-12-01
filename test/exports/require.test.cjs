const assert = require('assert');
const TarIterator = require('7z-iterator');

describe('exports .cjs', () => {
  it('signature', () => {
    assert.ok(TarIterator);
    assert.ok(TarIterator.DirectoryEntry);
    assert.ok(TarIterator.FileEntry);
    assert.ok(TarIterator.LinkEntry);
    assert.ok(TarIterator.SymbolicLinkEntry);
  });
});
