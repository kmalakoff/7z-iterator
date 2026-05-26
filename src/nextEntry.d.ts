import type SevenZipIterator from './SevenZipIterator.ts';
import type { Entry, EntryCallback } from './types.ts';
export type NextCallback = (error?: Error, entry?: Entry) => void;
export default function nextEntry<_T>(iterator: SevenZipIterator, callback: EntryCallback): void;
