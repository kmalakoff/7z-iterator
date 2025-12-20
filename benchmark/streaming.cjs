/**
 * Streaming vs Buffered Benchmark
 *
 * Generates test fixtures (if 7zz available) and compares memory/performance
 * between streaming and buffered code paths.
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CACHE_DIR = path.join(__dirname, '../.cache/benchmark');
const DATA_SIZE = 1024 * 300; // 300KB of random data

// Compare streaming vs buffered using LZMA2 (same codec, different folder structure)
// - Single file = streaming path
// - Multi file = buffered path (solid archive)
const FIXTURES = [
  { name: 'single-file-lzma2.7z', type: 'single', expectedPath: 'streaming' },
  { name: 'multi-file-lzma2.7z', type: 'multi', expectedPath: 'buffered' },
];

function formatBytes(bytes) {
  const sign = bytes < 0 ? '-' : '';
  const abs = Math.abs(bytes);
  if (abs < 1024) return sign + abs + ' B';
  if (abs < 1024 * 1024) return sign + (abs / 1024).toFixed(1) + 'KB';
  return sign + (abs / (1024 * 1024)).toFixed(1) + 'MB';
}

function formatMs(ms) {
  return ms.toFixed(1) + 'ms';
}

function has7zz() {
  try {
    spawnSync('7zz', ['--help'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function generateFixtures() {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }

  // Check if all fixtures exist
  const missing = FIXTURES.filter((f) => !fs.existsSync(path.join(CACHE_DIR, f.name)));
  if (missing.length === 0) {
    console.log('All fixtures exist in .cache/benchmark/');
    return true;
  }

  console.log(`Generating ${missing.length} missing fixture(s)...`);

  // Generate random test data - create multiple files with same total size
  const singleFile = path.join(CACHE_DIR, 'single.bin');
  const multiDir = path.join(CACHE_DIR, 'multi');

  const randomData = Buffer.alloc(DATA_SIZE);
  for (let i = 0; i < DATA_SIZE; i++) {
    randomData[i] = Math.floor(Math.random() * 256);
  }

  // Single file: one 300KB file
  fs.writeFileSync(singleFile, randomData);

  // Multi files: 3 x 100KB files (same total size, but creates solid archive)
  if (!fs.existsSync(multiDir)) fs.mkdirSync(multiDir, { recursive: true });
  const chunkSize = Math.floor(DATA_SIZE / 3);
  fs.writeFileSync(path.join(multiDir, 'part1.bin'), randomData.slice(0, chunkSize));
  fs.writeFileSync(path.join(multiDir, 'part2.bin'), randomData.slice(chunkSize, chunkSize * 2));
  fs.writeFileSync(path.join(multiDir, 'part3.bin'), randomData.slice(chunkSize * 2));

  // Create archives
  for (const fixture of missing) {
    const archivePath = path.join(CACHE_DIR, fixture.name);
    console.log(`  Creating ${fixture.name} (${fixture.type} file)...`);
    try {
      if (fixture.type === 'single') {
        execSync(`7zz a -m0=lzma2 "${archivePath}" "${singleFile}"`, {
          stdio: 'ignore',
          cwd: CACHE_DIR,
        });
      } else {
        // Multi-file creates solid archive (files share one folder)
        execSync(`7zz a -m0=lzma2 -ms=on "${archivePath}" "${multiDir}"/*`, {
          stdio: 'ignore',
          cwd: CACHE_DIR,
          shell: true,
        });
      }
    } catch (err) {
      console.error(`  Failed to create ${fixture.name}: ${err.message}`);
      return false;
    }
  }

  // Cleanup temp files
  fs.unlinkSync(singleFile);
  fs.rmSync(multiDir, { recursive: true });
  console.log('Fixtures generated successfully.\n');
  return true;
}

const EXTRACT_DIR = path.join(__dirname, '../.tmp/benchmark-extract');

function benchmarkFixture(Iterator, fixturePath, label) {
  return new Promise((resolve, reject) => {
    // Clean extract dir
    if (fs.existsSync(EXTRACT_DIR)) {
      fs.rmSync(EXTRACT_DIR, { recursive: true });
    }
    fs.mkdirSync(EXTRACT_DIR, { recursive: true });

    if (global.gc) global.gc();

    const startMem = process.memoryUsage().heapUsed;
    const startTime = Date.now();
    let peakMem = startMem;
    let entryCount = 0;
    let extractedBytes = 0;

    const iterator = new Iterator(fixturePath);

    iterator.forEach(
      (entry, callback) => {
        entryCount++;

        if (entry.type === 'file') {
          entry.create(EXTRACT_DIR, (err) => {
            if (err) return callback(err);
            extractedBytes += entry.size || 0;

            const currentMem = process.memoryUsage().heapUsed;
            if (currentMem > peakMem) peakMem = currentMem;
            callback();
          });
        } else {
          const currentMem = process.memoryUsage().heapUsed;
          if (currentMem > peakMem) peakMem = currentMem;
          callback();
        }
      },
      (err) => {
        if (global.gc) global.gc();
        const endTime = Date.now();
        const endMem = process.memoryUsage().heapUsed;

        // Cleanup
        if (fs.existsSync(EXTRACT_DIR)) {
          fs.rmSync(EXTRACT_DIR, { recursive: true });
        }

        if (err) return reject(err);

        resolve({
          label,
          entryCount,
          extractedBytes,
          time: endTime - startTime,
          peakMemory: peakMem - startMem,
          finalMemory: endMem - startMem,
        });
      }
    );
  });
}

async function main() {
  console.log('═'.repeat(70));
  console.log(' STREAMING vs BUFFERED BENCHMARK');
  console.log('═'.repeat(70));
  console.log();

  // Check for 7zz
  if (!has7zz()) {
    console.log('7zz not found. Cannot generate test fixtures.');
    console.log('Install 7-Zip (7zz) to run this benchmark.');
    console.log('  macOS: brew install 7zip');
    console.log('  Linux: apt install 7zip');
    process.exit(1);
  }

  // Generate fixtures
  if (!generateFixtures()) {
    console.error('Failed to generate fixtures.');
    process.exit(1);
  }

  // Load local implementation
  const Iterator = require('../dist/cjs/index.js').default;

  console.log('Running benchmarks...\n');

  const results = [];

  for (const fixture of FIXTURES) {
    const fixturePath = path.join(CACHE_DIR, fixture.name);

    // Warmup run
    await benchmarkFixture(Iterator, fixturePath, 'warmup');

    // Actual benchmark
    const result = await benchmarkFixture(Iterator, fixturePath, fixture.name);
    result.codec = fixture.codec;
    result.expectedPath = fixture.expectedPath;
    results.push(result);
  }

  // Display results
  console.log('┌─ RESULTS ──────────────────────────────────────────────────────┐\n');
  console.log('   Fixture                │ Path      │ Time     │ Peak Mem  │ Extracted');
  console.log('   ───────────────────────┼───────────┼──────────┼───────────┼──────────');

  for (const r of results) {
    const name = r.label.padEnd(21);
    const pathType = r.expectedPath.padEnd(9);
    const time = formatMs(r.time).padStart(8);
    const peak = formatBytes(r.peakMemory).padStart(9);
    const extracted = formatBytes(r.extractedBytes).padStart(9);
    console.log(`   ${name} │ ${pathType} │ ${time} │ ${peak} │ ${extracted}`);
  }

  // Summary comparison
  console.log('\n┌─ SUMMARY ──────────────────────────────────────────────────────┐\n');

  const streamingResult = results.find((r) => r.expectedPath === 'streaming');
  const bufferedResult = results.find((r) => r.expectedPath === 'buffered');

  console.log('   Streaming (single-file folder):');
  console.log(`     Peak Memory: ${formatBytes(streamingResult.peakMemory)}`);
  console.log(`     Time:        ${formatMs(streamingResult.time)}`);
  console.log(`     Extracted:   ${formatBytes(streamingResult.extractedBytes)}`);
  console.log();
  console.log('   Buffered (multi-file folder, solid):');
  console.log(`     Peak Memory: ${formatBytes(bufferedResult.peakMemory)}`);
  console.log(`     Time:        ${formatMs(bufferedResult.time)}`);
  console.log(`     Extracted:   ${formatBytes(bufferedResult.extractedBytes)}`);
  console.log();

  if (bufferedResult.peakMemory > streamingResult.peakMemory) {
    const diff = ((bufferedResult.peakMemory - streamingResult.peakMemory) / bufferedResult.peakMemory) * 100;
    console.log(`   ✓ Streaming uses ${diff.toFixed(0)}% less peak memory than buffered`);
  } else if (streamingResult.peakMemory > bufferedResult.peakMemory) {
    const diff = ((streamingResult.peakMemory - bufferedResult.peakMemory) / streamingResult.peakMemory) * 100;
    console.log(`   ! Streaming uses ${diff.toFixed(0)}% MORE peak memory than buffered`);
  } else {
    console.log('   = Memory usage is equal');
  }

  console.log('\n' + '═'.repeat(70));
}

main().catch(console.error);
