# 7z-iterator

Read entries from a 7z archive with an async iterator, promises, callbacks, or a readable stream. Sources can be archive paths or readable streams.

## Install

```sh
npm install 7z-iterator
```

## Extract an archive

```js
const SevenZipIterator = require('7z-iterator');

async function extract(archivePath, destination) {
  const iterator = new SevenZipIterator(archivePath);
  const links = [];

  try {
    for await (const entry of iterator) {
      if (entry.type === 'link') links.unshift(entry);
      else if (entry.type === 'symlink') links.push(entry);
      else await entry.create(destination, { strip: 1 });
    }

    // Create links after their target directories and files.
    for (const entry of links) await entry.create(destination, { strip: 1 });
  } finally {
    iterator.destroy();
  }
}

extract('./archive.7z', './output').catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
```

### Callback API for older Node.js

Node.js 0.8+ can use the callback form instead of `for await`:

```js
var SevenZipIterator = require('7z-iterator');
var iterator = new SevenZipIterator('./archive.7z');
var links = [];

function createLinks(index, callback) {
  if (index === links.length) return callback();
  links[index].create('./output', { strip: 1 }, function(error) {
    if (error) return callback(error);
    createLinks(index + 1, callback);
  });
}

iterator.forEach(function(entry, callback) {
  if (entry.type === 'link') { links.unshift(entry); callback(); }
  else if (entry.type === 'symlink') { links.push(entry); callback(); }
  else entry.create('./output', { strip: 1 }, callback);
}, { callbacks: true, concurrency: 1 }, function(error) {
  if (error) throw error;
  createLinks(0, function(error) {
    iterator.destroy();
    if (error) throw error;
    console.log('Extraction complete');
  });
});
```

`entry.create(destination, options)` writes a file, directory, or link. Use `{ force: true }` to overwrite existing entries. Pass an archive password to the iterator constructor, for example `new SevenZipIterator(archivePath, { password: 'secret' })`. A readable stream source is buffered to a temporary file because 7z parsing needs random access.

## Limitations

Node.js 0.8+ is supported, but older releases have smaller maximum `Buffer` sizes. LZMA1 folders must fit in one buffer; LZMA2 can stream incrementally and is preferred for large archives. On Node.js 0.8-4.x, archives larger than about 1 GB cannot be processed reliably.
