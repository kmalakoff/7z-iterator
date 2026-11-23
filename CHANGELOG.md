# Changelog

All notable changes to 7z-iterator are documented here.

## [2.2.14] - 2026-11-22

### Fixed

- Entries in single-file folders (non-solid archives, streamable codecs) no longer crash the process when a read of the archive fails mid-entry, or when a decoder other than the last one in a chain fails (for example the LZMA2 stage of a BCJ + LZMA2 entry). The error is reported once, on the entry's stream or `create` callback.
- On those entries the stream reports exactly one outcome on every supported Node version: an `error` is no longer followed by `finish` and `end` on Node 0.8–0.12 and Node 8.
- On those entries `destroy()` without an error now reports one `close` and no `finish` or `end` on every supported Node version, as Node 10 and later already did. Node 0.8–0.12 and Node 8 used to report `finish` and `end` as well, so a piped destination was ended, and Node 4–7 reported no `close` at all.
- On those entries a slow consumer no longer piles up `drain` listeners or triggers `MaxListenersExceededWarning`.
- `getEntryStreamStreaming` on those entries: destroying the stream now stops decompression, and decoding starts on the first read instead of at the call.

### Changed

- `getEntryStreamStreaming` reports a broken decoder setting as an `error` on the returned stream, as `getEntryStream` does, instead of rejecting.

## [2.2.9] - 2026-05-26

### Fixed

- The exported `EntryCallback` type allows `null` as the error.

## [2.2.8] - 2026-05-26

### Fixed

- A missing or too-short LZMA or LZMA2 properties block is reported as an error to the callback instead of being thrown.

### Changed

- `entry.create()` without a callback resolves `true`, as its type declares; it resolved `undefined`.

## [2.2.7] - 2026-05-22

### Fixed

- Directories in archives that record no Unix permissions are created with mode 0755 again, as before 2.2.6.

## [2.2.6] - 2026-05-22

### Changed

- Directories whose entries have Windows attributes and no Unix permissions are given mode 0700 instead of 0755. Reverted in 2.2.7.

## [2.2.4] - 2025-12-26

### Changed

- On Node 0.8 and 0.10, `SevenZipParser.parse()` without a callback fails with a `ReferenceError` instead of a message asking for a callback.

## [2.2.3] - 2025-12-26

### Changed

- `ArchiveSource.read()` may return a `BufferList` (type `BufferLike`) instead of a `Buffer` when the read is too large for one Buffer on the running Node version. Custom `ArchiveSource` implementations may return either a `Buffer` or a `BufferList`.

## [2.2.0] - 2025-12-25

### Changed

- `SevenZipParser.parse()` is asynchronous: it takes an optional callback and returns a promise when none is given. It was synchronous. `SevenZipIterator` is unaffected.
- `SevenZipParser.getEntries()` throws if `parse()` has not completed; it used to parse on demand.

## [2.0.2] - 2025-12-22

### Fixed

- Reading a folder whose packed data is larger than 2 GB no longer fails: `FileSource.read()` splits reads over 2 GB into chunks.
- Sizes and positions that are negative or overflow in a damaged archive are reported with the new `CORRUPT_ARCHIVE` error code.

## [2.0.0] - 2025-12-22

### Added

- `SevenZipParser`, `FileSource`, `BufferSource`, `createCodedError`, `ErrorCode` and the `ArchiveSource`, `SevenZipEntry` and `CodedError` types are exported from the package root.

### Removed

- The LZMA, LZMA2 and XZ decoders (`createLzmaDecoder`, `createLzma2Decoder`, `decodeLzma`, `decodeLzma2`, `LzmaDecoder`, `Lzma2Decoder`, `detectFormat`, `createXZDecoder`, `decodeXZ`, `OutputSink`) are no longer exported. They moved to the `xz-compat` package.
