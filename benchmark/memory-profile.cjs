/**
 * Memory profiling over time during extraction
 *
 * Tracks memory usage at each entry to see release patterns
 */

const fs = require('fs');
const path = require('path');

// Use a larger test file for better visibility
const TEST_FILES = [path.join(__dirname, '../test/data/lzma2.7z'), path.join(__dirname, '../test/data/bcj.7z'), path.join(__dirname, '../test/data/copy.7z')];

function formatBytes(bytes) {
  const sign = bytes < 0 ? '-' : '';
  const abs = Math.abs(bytes);
  if (abs < 1024) return sign + abs + ' B';
  if (abs < 1024 * 1024) return sign + (abs / 1024).toFixed(2) + ' KB';
  return sign + (abs / (1024 * 1024)).toFixed(2) + ' MB';
}

async function profileExtraction(Iterator, label, testFile) {
  if (global.gc) global.gc();

  const memorySnapshots = [];
  const startMem = process.memoryUsage().heapUsed;

  return new Promise((resolve, reject) => {
    const iterator = new Iterator(testFile);
    let entryIndex = 0;

    iterator.forEach(
      (entry) => {
        entryIndex++;
        const mem = process.memoryUsage();
        memorySnapshots.push({
          entry: entryIndex,
          path: entry.path,
          size: entry.size || 0,
          heapUsed: mem.heapUsed,
          heapTotal: mem.heapTotal,
          delta: mem.heapUsed - startMem,
        });
      },
      (err) => {
        if (global.gc) global.gc();
        const endMem = process.memoryUsage().heapUsed;

        if (err) {
          reject(err);
          return;
        }

        resolve({
          label,
          testFile: path.basename(testFile),
          snapshots: memorySnapshots,
          startMem,
          endMem,
          finalDelta: endMem - startMem,
        });
      }
    );
  });
}

function analyzeResults(results) {
  console.log(`\n=== ${results.label} - ${results.testFile} ===`);
  console.log(`Entries processed: ${results.snapshots.length}`);
  console.log(`Start memory: ${formatBytes(results.startMem)}`);
  console.log(`End memory: ${formatBytes(results.endMem)}`);
  console.log(`Final delta: ${formatBytes(results.finalDelta)}`);

  if (results.snapshots.length > 0) {
    const deltas = results.snapshots.map((s) => s.delta);
    const peak = Math.max(...deltas);
    const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
    const min = Math.min(...deltas);

    console.log('\nMemory during extraction:');
    console.log(`  Peak delta: ${formatBytes(peak)}`);
    console.log(`  Avg delta:  ${formatBytes(avg)}`);
    console.log(`  Min delta:  ${formatBytes(min)}`);

    // Show memory at each entry
    console.log('\nPer-entry memory:');
    results.snapshots.forEach((s) => {
      const barLen = Math.max(0, Math.min(50, Math.floor(s.delta / 10000)));
      const bar = barLen > 0 ? '█'.repeat(barLen) : '';
      console.log(`  ${s.entry}: ${formatBytes(s.delta).padStart(10)} ${bar} ${s.path}`);
    });
  }

  return {
    peak: Math.max(...results.snapshots.map((s) => s.delta)),
    avg: results.snapshots.reduce((a, s) => a + s.delta, 0) / results.snapshots.length,
    final: results.finalDelta,
  };
}

async function main() {
  console.log('Memory Profile: Local vs Published 7z-iterator');
  console.log(`Node: ${process.version}`);
  console.log(`GC available: ${typeof global.gc === 'function'}`);

  // Load both versions
  const LocalIterator = require('../dist/cjs/index.js').default;
  const publishedPath = path.join(__dirname, 'node_modules/7z-iterator-published');
  const PublishedIterator = fs.existsSync(publishedPath) ? require(publishedPath).default : null;

  for (const testFile of TEST_FILES) {
    if (!fs.existsSync(testFile)) continue;

    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing: ${path.basename(testFile)}`);
    console.log('='.repeat(60));

    // Profile local
    const localResults = await profileExtraction(LocalIterator, 'Local', testFile);
    const localStats = analyzeResults(localResults);

    if (PublishedIterator) {
      // Profile published
      const publishedResults = await profileExtraction(PublishedIterator, 'Published', testFile);
      const publishedStats = analyzeResults(publishedResults);

      // Compare
      console.log('\n--- Comparison ---');
      const peakDiff = (((localStats.peak - publishedStats.peak) / publishedStats.peak) * 100).toFixed(1);
      const avgDiff = (((localStats.avg - publishedStats.avg) / publishedStats.avg) * 100).toFixed(1);
      const finalDiff = (((localStats.final - publishedStats.final) / Math.abs(publishedStats.final || 1)) * 100).toFixed(1);

      console.log(`Peak:  Local ${peakDiff > 0 ? '+' : ''}${peakDiff}%`);
      console.log(`Avg:   Local ${avgDiff > 0 ? '+' : ''}${avgDiff}%`);
      console.log(`Final: Local ${finalDiff > 0 ? '+' : ''}${finalDiff}%`);
    }
  }
}

main().catch(console.error);
