/**
 * Visual timeline of memory and performance during extraction
 */

const fs = require('fs');
const path = require('path');

const TEST_FILE = path.join(__dirname, '../.cache/node-v24.12.0-win-x64.7z');
const CHART_WIDTH = 60;

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

async function collectTimeline(Iterator, label) {
  if (global.gc) global.gc();

  const timeline = [];
  const startTime = Date.now();
  const startMem = process.memoryUsage().heapUsed;

  return new Promise((resolve, reject) => {
    const iterator = new Iterator(TEST_FILE);
    let entryIndex = 0;

    iterator.forEach(
      (entry) => {
        const now = Date.now();
        const mem = process.memoryUsage();
        entryIndex++;

        timeline.push({
          index: entryIndex,
          time: now - startTime,
          memory: mem.heapUsed - startMem,
          path: entry.path,
          size: entry.size || 0,
          type: entry.type,
        });
      },
      (err) => {
        if (global.gc) global.gc();
        const endTime = Date.now();
        const endMem = process.memoryUsage().heapUsed;

        if (err) return reject(err);

        resolve({
          label,
          timeline,
          totalTime: endTime - startTime,
          finalMemory: endMem - startMem,
        });
      }
    );
  });
}

function drawChart(title, data, maxVal, width, formatter) {
  console.log(`\n${title}:`);
  console.log('─'.repeat(width + 20));

  // Sample if too many entries
  const maxEntries = 20;
  const step = data.length > maxEntries ? Math.ceil(data.length / maxEntries) : 1;

  for (let i = 0; i < data.length; i += step) {
    const point = data[i];
    const val = point.value;
    const barLen = Math.max(0, Math.round((val / maxVal) * width));
    const bar = '█'.repeat(barLen);
    const label = `${i + 1}`.padStart(4);
    const valStr = formatter(val).padStart(10);
    const pathShort = point.label.length > 30 ? '...' + point.label.slice(-27) : point.label;
    console.log(`${label} │${bar.padEnd(width)}│${valStr}  ${pathShort}`);
  }

  console.log('─'.repeat(width + 20));
}

function visualize(local, published) {
  console.log('\n' + '═'.repeat(70));
  console.log(' MEMORY & PERFORMANCE TIMELINE COMPARISON');
  console.log('═'.repeat(70));
  console.log(`Test file: ${path.basename(TEST_FILE)}`);
  console.log(`Entries: ${local.timeline.length}`);

  // Prepare data
  const localMem = local.timeline.map((t) => ({ value: t.memory, label: t.path }));
  const pubMem = published.timeline.map((t) => ({ value: t.memory, label: t.path }));
  const localTime = local.timeline.map((t) => ({ value: t.time, label: t.path }));
  const pubTime = published.timeline.map((t) => ({ value: t.time, label: t.path }));

  // Find max values for scaling
  const maxMem = Math.max(...localMem.map((d) => d.value), ...pubMem.map((d) => d.value), 1);
  const maxTime = Math.max(...localTime.map((d) => d.value), ...pubTime.map((d) => d.value), 1);

  // Draw memory charts
  console.log('\n┌─ MEMORY USAGE (per entry) ─────────────────────────────────────┐');
  drawChart('LOCAL (current)', localMem, maxMem, CHART_WIDTH, formatBytes);
  drawChart('PUBLISHED (1.1.2)', pubMem, maxMem, CHART_WIDTH, formatBytes);

  // Draw timing charts
  console.log('\n┌─ CUMULATIVE TIME (per entry) ─────────────────────────────────┐');
  drawChart('LOCAL (current)', localTime, maxTime, CHART_WIDTH, formatMs);
  drawChart('PUBLISHED (1.1.2)', pubTime, maxTime, CHART_WIDTH, formatMs);

  // Side by side comparison (sampled for large files)
  console.log('\n┌─ SIDE-BY-SIDE COMPARISON (sampled) ────────────────────────────┐');
  console.log('\n   Entry  │ Local Mem  │ Pub Mem    │ Local Time │ Pub Time');
  console.log('   ───────┼────────────┼────────────┼────────────┼───────────');

  const maxRows = 15;
  const step = local.timeline.length > maxRows ? Math.ceil(local.timeline.length / maxRows) : 1;

  for (let i = 0; i < local.timeline.length; i += step) {
    const lt = local.timeline[i];
    const pt = published.timeline[i];
    const idx = String(i + 1).padStart(4);
    const lm = formatBytes(lt.memory).padStart(10);
    const pm = formatBytes(pt.memory).padStart(10);
    const ltime = formatMs(lt.time).padStart(10);
    const ptime = formatMs(pt.time).padStart(10);
    console.log(`  ${idx}   │${lm} │${pm} │${ltime} │${ptime}`);
  }

  // Summary
  console.log('\n┌─ SUMMARY ──────────────────────────────────────────────────────┐');
  console.log(`\n   Total Time:    Local ${formatMs(local.totalTime).padStart(8)}  vs  Published ${formatMs(published.totalTime).padStart(8)}`);
  console.log(`   Final Memory:  Local ${formatBytes(local.finalMemory).padStart(8)}  vs  Published ${formatBytes(published.finalMemory).padStart(8)}`);

  const timeDiff = (((local.totalTime - published.totalTime) / published.totalTime) * 100).toFixed(1);
  const memDiff = (((local.finalMemory - published.finalMemory) / Math.abs(published.finalMemory || 1)) * 100).toFixed(1);

  console.log(`\n   Time:   Local is ${timeDiff > 0 ? timeDiff + '% slower' : Math.abs(timeDiff) + '% faster'}`);
  console.log(`   Memory: Local uses ${memDiff > 0 ? memDiff + '% more' : Math.abs(memDiff) + '% less'} at end`);

  // ASCII art timeline (sparkline)
  console.log('\n┌─ MEMORY TIMELINE (sparkline) ─────────────────────────────────┐');

  // Sample to fit in ~60 chars
  const sparkWidth = 60;
  const sparkStep = Math.max(1, Math.ceil(localMem.length / sparkWidth));

  const localSparkData = [];
  const pubSparkData = [];
  for (let i = 0; i < localMem.length; i += sparkStep) {
    localSparkData.push(localMem[i].value);
    pubSparkData.push(pubMem[i].value);
  }

  const sparkline = (data, max) =>
    data
      .map((v) => {
        const h = Math.round((v / max) * 7);
        return ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'][Math.min(7, Math.max(0, h))];
      })
      .join('');

  console.log(`\n   Local:     ${sparkline(localSparkData, maxMem)}`);
  console.log(`   Published: ${sparkline(pubSparkData, maxMem)}`);
  console.log(`              ${'─'.repeat(localSparkData.length)}`);
  console.log(`              0${' '.repeat(localSparkData.length - 6)}${local.timeline.length} entries`);
}

async function main() {
  console.log('Loading implementations...');

  const LocalIterator = require('../dist/cjs/index.js').default;
  const publishedPath = path.join(__dirname, 'node_modules/7z-iterator-published');

  if (!fs.existsSync(publishedPath)) {
    console.error('Published version not installed. Run compare.cjs first.');
    process.exit(1);
  }

  const PublishedIterator = require(publishedPath).default;

  console.log('Collecting timelines...');

  // Warmup
  await collectTimeline(LocalIterator, 'warmup');
  await collectTimeline(PublishedIterator, 'warmup');

  // Actual runs
  const local = await collectTimeline(LocalIterator, 'Local');
  const published = await collectTimeline(PublishedIterator, 'Published');

  visualize(local, published);
}

main().catch(console.error);
