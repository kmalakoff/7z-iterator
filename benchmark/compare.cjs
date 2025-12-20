/**
 * Performance comparison: current vs published 7z-iterator
 *
 * Compares memory usage, speed, and stability between:
 * - Local (current working version)
 * - Published (npm 7z-iterator@1.1.2)
 */

const fs = require('fs');
const path = require('path');

// Test configuration
const TEST_FILE = path.join(__dirname, '../test/data/lzma2.7z');
const ITERATIONS = 5;

// Helper to format bytes
function formatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// Helper to get memory usage
function getMemoryUsage() {
  if (global.gc) global.gc(); // Force GC if available
  return process.memoryUsage();
}

// Run extraction and measure performance
async function runExtraction(Iterator, label) {
  const results = {
    label,
    times: [],
    memoryBefore: [],
    memoryAfter: [],
    memoryPeak: [],
    errors: [],
  };

  for (let i = 0; i < ITERATIONS; i++) {
    const memBefore = getMemoryUsage();
    results.memoryBefore.push(memBefore.heapUsed);

    let peakMemory = memBefore.heapUsed;
    const memInterval = setInterval(() => {
      const current = process.memoryUsage().heapUsed;
      if (current > peakMemory) peakMemory = current;
    }, 10);

    const startTime = Date.now();

    try {
      await new Promise((resolve, reject) => {
        const iterator = new Iterator(TEST_FILE);
        let entryCount = 0;
        let totalSize = 0;

        iterator.forEach(
          (entry) => {
            entryCount++;
            if (entry.size) totalSize += entry.size;
          },
          (err) => {
            if (err) reject(err);
            else resolve({ entryCount, totalSize });
          }
        );
      });
    } catch (err) {
      results.errors.push(err.message);
    }

    const endTime = Date.now();
    clearInterval(memInterval);

    const memAfter = getMemoryUsage();

    results.times.push(endTime - startTime);
    results.memoryAfter.push(memAfter.heapUsed);
    results.memoryPeak.push(peakMemory);
  }

  return results;
}

// Calculate statistics
function calcStats(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const sum = arr.reduce((a, b) => a + b, 0);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1],
    avg: sum / arr.length,
    median: sorted[Math.floor(sorted.length / 2)],
  };
}

// Print results
function printResults(results) {
  console.log(`\n=== ${results.label} ===`);

  const timeStats = calcStats(results.times);
  console.log(`Time (ms):     min=${timeStats.min}, max=${timeStats.max}, avg=${timeStats.avg.toFixed(1)}, median=${timeStats.median}`);

  const peakStats = calcStats(results.memoryPeak);
  console.log(`Peak Memory:   min=${formatBytes(peakStats.min)}, max=${formatBytes(peakStats.max)}, avg=${formatBytes(peakStats.avg)}`);

  const deltaMemory = results.memoryAfter.map((after, i) => after - results.memoryBefore[i]);
  const deltaStats = calcStats(deltaMemory);
  console.log(`Memory Delta:  min=${formatBytes(deltaStats.min)}, max=${formatBytes(deltaStats.max)}, avg=${formatBytes(deltaStats.avg)}`);

  if (results.errors.length > 0) {
    console.log(`Errors: ${results.errors.length}`);
    results.errors.forEach((e) => console.log(`  - ${e}`));
  }
}

// Compare two results
function compareResults(local, published) {
  console.log('\n=== COMPARISON ===');

  const localTimeAvg = calcStats(local.times).avg;
  const publishedTimeAvg = calcStats(published.times).avg;
  const timeDiff = (((localTimeAvg - publishedTimeAvg) / publishedTimeAvg) * 100).toFixed(1);
  console.log(`Speed: Local is ${timeDiff > 0 ? timeDiff + '% slower' : Math.abs(timeDiff) + '% faster'} than published`);

  const localPeakAvg = calcStats(local.memoryPeak).avg;
  const publishedPeakAvg = calcStats(published.memoryPeak).avg;
  const memDiff = (((localPeakAvg - publishedPeakAvg) / publishedPeakAvg) * 100).toFixed(1);
  console.log(`Memory: Local uses ${memDiff > 0 ? memDiff + '% more' : Math.abs(memDiff) + '% less'} peak memory`);

  console.log(`\nStability: Local errors=${local.errors.length}, Published errors=${published.errors.length}`);
}

// Main
async function main() {
  console.log('Performance Comparison: Local vs Published 7z-iterator');
  console.log(`Test file: ${TEST_FILE}`);
  console.log(`Iterations: ${ITERATIONS}`);
  console.log(`Node: ${process.version}`);

  // Check if test file exists
  if (!fs.existsSync(TEST_FILE)) {
    console.error('Test file not found:', TEST_FILE);
    process.exit(1);
  }

  // Load both versions
  let LocalIterator;
  let PublishedIterator;

  try {
    // Local version (from dist)
    LocalIterator = require('../dist/cjs/index.js').default;
    console.log('\nLoaded local version from dist/cjs');
  } catch (err) {
    console.error('Failed to load local version:', err.message);
    process.exit(1);
  }

  try {
    // Published version - install to temp location
    const publishedPath = path.join(__dirname, 'node_modules/7z-iterator-published');
    if (!fs.existsSync(publishedPath)) {
      console.log('\nInstalling published version...');
      require('child_process').execSync('npm pack 7z-iterator@1.1.2 && mkdir -p node_modules/7z-iterator-published && tar -xzf 7z-iterator-1.1.2.tgz -C node_modules/7z-iterator-published --strip-components=1 && rm 7z-iterator-1.1.2.tgz', {
        cwd: __dirname,
        stdio: 'inherit',
      });
      // Install its dependencies
      require('child_process').execSync('npm install --production', {
        cwd: publishedPath,
        stdio: 'inherit',
      });
    }
    PublishedIterator = require(publishedPath).default;
    console.log('Loaded published version 1.1.2');
  } catch (err) {
    console.error('Failed to load published version:', err.message);
    console.log('Continuing with local-only benchmark...');
    PublishedIterator = null;
  }

  // Warmup
  console.log('\nWarming up...');
  await runExtraction(LocalIterator, 'warmup');

  // Run benchmarks
  console.log('\nRunning benchmarks...');

  const localResults = await runExtraction(LocalIterator, 'Local (current)');
  printResults(localResults);

  if (PublishedIterator) {
    const publishedResults = await runExtraction(PublishedIterator, 'Published (1.1.2)');
    printResults(publishedResults);
    compareResults(localResults, publishedResults);
  }
}

main().catch(console.error);
