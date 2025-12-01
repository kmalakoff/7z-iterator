import once from 'call-once-fn';
import { type DirectoryAttributes, DirectoryEntry, type FileAttributes, type LinkAttributes, SymbolicLinkEntry } from 'extract-base-iterator';
import compact from 'lodash.compact';
import path from 'path';
import FileEntry from './FileEntry.ts';
import type SevenZipIterator from './SevenZipIterator.ts';
import type { SevenZipEntry } from './sevenz/SevenZipParser.ts';
import type { Entry, EntryCallback } from './types.ts';

export type NextCallback = (error?: Error, entry?: Entry) => undefined;

// Entry attributes object that gets mutated in switch - union of possible shapes
// mtime is number for FileAttributes compatibility (timestamp in ms)
type EntryAttributesBuilder = {
  path: string;
  basename: string;
  mtime: number;
  mode: number;
  type?: 'file' | 'directory';
  size?: number;
};

export default function nextEntry<_T>(iterator: SevenZipIterator, callback: EntryCallback): undefined {
  if (!iterator.iterator) {
    callback(new Error('iterator missing'));
    return;
  }

  var entry: SevenZipEntry | null = null;
  entry = iterator.iterator.next();

  var nextCallback = once((err?: Error, entry?: Entry) => {
    // keep processing
    if (entry) iterator.push(nextEntry);
    err ? callback(err) : callback(null, entry ? { done: false, value: entry } : { done: true, value: null });
  }) as NextCallback;

  // done: signal iteration is complete
  if (iterator.isDone() || !entry) return callback(null, { done: true, value: null });

  // Skip anti-files (these mark files to delete in delta archives)
  if (entry.isAntiFile) {
    iterator.push(nextEntry);
    return callback(null, null);
  }

  // Determine type from entry
  var type = entry.type;

  // Default modes (decimal values for Node 0.8 compatibility)
  // 0o755 = 493, 0o644 = 420
  var defaultMode = type === 'directory' ? 493 : 420;

  // Build attributes from 7z entry
  // mtime must be timestamp (number) for FileAttributes compatibility
  var mtimeDate = entry.mtime || new Date();
  var attributes: EntryAttributesBuilder = {
    path: compact(entry.path.split(path.sep)).join(path.sep),
    basename: entry.name,
    mtime: mtimeDate.getTime(),
    mode: entry.mode !== undefined ? entry.mode : defaultMode,
  };

  switch (type) {
    case 'directory':
      attributes.type = 'directory';
      return nextCallback(null, new DirectoryEntry(attributes as DirectoryAttributes));

    case 'link': {
      // For symlinks, the file content IS the symlink target path
      // Read the content to get the linkpath for SymbolicLinkEntry
      var parser = iterator.iterator.getParser();
      var stream = parser.getEntryStream(entry);
      var chunks: Buffer[] = [];

      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      stream.on('end', () => {
        var linkpath = Buffer.concat(chunks).toString('utf8');

        var linkAttributes: LinkAttributes = {
          path: attributes.path,
          mtime: attributes.mtime,
          mode: attributes.mode,
          linkpath: linkpath,
        };

        nextCallback(null, new SymbolicLinkEntry(linkAttributes));
      });
      stream.on('error', (err: Error) => {
        nextCallback(err);
      });
      return;
    }

    case 'file': {
      attributes.type = 'file';
      attributes.size = entry.size;
      var parser2 = iterator.iterator.getParser();
      return nextCallback(null, new FileEntry(attributes as FileAttributes, entry, parser2, iterator.lock));
    }
  }

  return callback(new Error(`Unrecognized entry type: ${type}`));
}
