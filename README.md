## 7z-iterator

Extract contents from 7z archive type using an iterator API using streams or paths. Use stream interface and pipe transforms to add decompression algorithms.

// asyncIterator

```js
var assert = require('assert');
var fs = require('fs');
var SevenZipIterator = require('7z-iterator');

(async function() {
  let iterator = new SevenZipIterator('/path/to/archive');

  try {
    const links = [];
    for await (const entry of iterator) {
      if (entry.type === 'link') links.unshift(entry);
      else if (entry.type === 'symlink') links.push(entry);
      else await entry.create(dest, options);
    }

    // create links after directories and files
    for (const entry of links) await entry.create(dest, options);
  } catch (err) {
    }

  iterator.destroy();
  iterator = null;
})();

(async function() {
  let iterator = new SevenZipIterator(fs.createReadStream('/path/to/archive'));

  try {
    const links = [];
    for await (const entry of iterator) {
      if (entry.type === 'link') links.unshift(entry);
      else if (entry.type === 'symlink') links.push(entry);
      else await entry.create(dest, options);
    }

    // create links after directories and files
    for (const entry of links) await entry.create(dest, options);
  } catch (err) {
    }

  iterator.destroy();
  iterator = null;
})();
```

// Async / Await

```js
var assert = require('assert');
var SevenZipIterator = require('7z-iterator');

// one by one
(async function() {
  let iterator = new SevenZipIterator('/path/to/archive');

  const links = [];
  let entry = await iterator.next();
  while (entry) {
    if (entry.type === 'link') links.unshift(entry);
    else if (entry.type === 'symlink') links.push(entry);
    else await entry.create(dest, options);
    entry = await iterator.next();
  }

  // create links after directories and files
  for (entry of links) {
    await entry.create(dest, options);
  }
  iterator.destroy();
  iterator = null;
})();

// infinite concurrency
(async function() {
  let iterator = new SevenZipIterator('/path/to/archive');

  try {
    const links = [];
    await iterator.forEach(
      async function (entry) {
        if (entry.type === 'link') links.unshift(entry);
        else if (entry.type === 'symlink') links.push(entry);
        else await entry.create(dest, options);
      },
      { concurrency: Infinity }
    );

    // create links after directories and files
    for (const entry of links) await entry.create(dest, options);
  } catch (err) {
    aseert.ok(!err);
  }

  iterator.destroy();
  iterator = null;
})();
```

// Callbacks

```js
var assert = require('assert');
var Queue = require('queue-cb');
var SevenZipIterator = require('7z-iterator');

var iterator = new SevenZipIterator('/path/to/archive');

// one by one
var links = [];
iterator.forEach(
  function (entry, callback) {
    if (entry.type === 'link') {
      links.unshift(entry);
      callback();
    } else if (entry.type === 'symlink') {
      links.push(entry);
      callback();
    } else entry.create(dest, options, callback);
  },
  { callbacks: true, concurrency: 1 },
  function (err) {

    // create links after directories and files
    var queue = new Queue();
    for (var index = 0; index < links.length; index++) {
      var entry = links[index];
      queue.defer(entry.create.bind(entry, dest, options));
    }
    queue.await(callback);

    iterator.destroy();
    iterator = null;
  }
);
```

## Limitations

### Node.js Version Compatibility

This library supports Node.js 0.8+ but has memory limits on older versions:

| Node.js Version | Maximum Single Buffer | Notes |
|-----------------|----------------------|-------|
| 0.8 - 4.x | ~1073 MB (0x3fffffff) | Hard limit due to kMaxLength |
| 6.x - 7.x | ~1073 MB | Uint8Array limit |
| 8.x - 9.x | ~2 GB | Buffer limit |
| 10+ | ~2.1 GB (2^31-1) | Buffer.allocUnsafe limit |

### LZMA1 vs LZMA2

- **LZMA2**: Streams incrementally, memory efficient, works on all Node versions
- **LZMA1**: Requires loading entire folder into memory before decompression. Fails on archives with folders larger than the buffer limit above.

### Archive Size Limits by Node Version

| Archive Type | Node 0.8-4.x | Node 6+ | Node 8+ | Node 10+ |
|--------------|--------------|---------|---------|----------|
| Small archives (< 1GB) | Works | Works | Works | Works |
| LZMA2 archives (> 1GB) | Fails | Fails | Works | Works |
| LZMA1 archives (> 1GB) | Fails | Fails | Fails | Fails |

For large LZMA1 archives, use Node 8+ or re-archive using LZMA2 format.
