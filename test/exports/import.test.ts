import BaseIterator, { DirectoryEntry, FileEntry, LinkEntry, SymbolicLinkEntry } from '7z-iterator';
import assert from 'assert';

describe('exports .ts', () => {
  it('signature', () => {
    assert.ok(BaseIterator);
    assert.ok(DirectoryEntry);
    assert.ok(FileEntry);
    assert.ok(LinkEntry);
    assert.ok(SymbolicLinkEntry);
  });
});
