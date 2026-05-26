import type { CallFn } from 'call-once-fn';
import once from 'call-once-fn';
import { type DirectoryAttributes, DirectoryEntry, type FileAttributes, type LinkAttributes, type Lock, SymbolicLinkEntry } from 'extract-base-iterator';
import path from 'path';
import FileEntry from './FileEntry.ts';
import type SevenZipIterator from './SevenZipIterator.ts';
import { UnixMode } from './sevenz/constants.ts';
import type { SevenZipEntry, SevenZipParser } from './sevenz/SevenZipParser.ts';
import type { Entry, EntryCallback } from './types.ts';

export type NextCallback = (error?: Error, entry?: Entry) => void;

/** @internal */
interface InternalIterator {
  next(): SevenZipEntry | null;
  getParser(): SevenZipParser;
}

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

export default function nextEntry<_T>(iterator: SevenZipIterator, callback: EntryCallback): void {
  const internalIter = iterator._iterator as InternalIterator | null;
  if (!internalIter) {
    callback(new Error('iterator missing'));
    return;
  }

  let entry: SevenZipEntry | null = null;
  entry = internalIter.next();

  const nextCallback = once(((err?: Error, entry?: Entry) => {
    if (entry) iterator.push(nextEntry as unknown as Parameters<typeof iterator.push>[0]);
    err ? callback(err) : callback(undefined, entry ? { done: false, value: entry } : { done: true, value: undefined as unknown as Entry });
  }) as unknown as CallFn) as unknown as NextCallback;

  if (!iterator.lock || iterator.isDone() || !entry) return callback(undefined, { done: true, value: undefined as unknown as Entry });

  if (entry.isAntiFile) {
    iterator.push(nextEntry as unknown as Parameters<typeof iterator.push>[0]);
    return callback();
  }

  // Determine type from entry
  const type = entry.type;

  const defaultMode = type === 'directory' ? UnixMode.DEFAULT_DIR : UnixMode.DEFAULT_FILE;

  // Build attributes from 7z entry
  // mtime must be timestamp (number) for FileAttributes compatibility
  const mtimeDate = entry.mtime || new Date();
  const attributes: EntryAttributesBuilder = {
    path: entry.path.split(path.sep).filter(Boolean).join(path.sep),
    basename: entry.name,
    mtime: mtimeDate.getTime(),
    mode: entry.mode !== undefined ? entry.mode : defaultMode,
  };

  switch (type) {
    case 'directory':
      attributes.type = 'directory';
      return nextCallback(undefined, new DirectoryEntry(attributes as DirectoryAttributes));

    case 'link': {
      // For symlinks, the file content IS the symlink target path
      // Read the content to get the linkpath for SymbolicLinkEntry
      const parser = internalIter.getParser();
      const stream = parser.getEntryStream(entry);

      const chunks: Buffer[] = [];

      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      stream.on('end', () => {
        const linkpath = Buffer.concat(chunks).toString('utf8');

        const linkAttributes: LinkAttributes = {
          path: attributes.path,
          mtime: attributes.mtime,
          mode: attributes.mode,
          linkpath: linkpath,
        };

        nextCallback(undefined, new SymbolicLinkEntry(linkAttributes));
      });
      stream.on('error', (streamErr: Error) => {
        nextCallback(streamErr);
      });
      return;
    }

    case 'file': {
      attributes.type = 'file';
      attributes.size = entry.size;
      const parser = internalIter.getParser();

      const stream = parser.getEntryStream(entry);
      return nextCallback(undefined, new FileEntry(attributes as FileAttributes, stream, iterator.lock as Lock, entry._canStream));
    }
  }

  return callback(new Error(`Unrecognized entry type: ${type}`));
}
