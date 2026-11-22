// tests/vidigest.test.js — unit tests for the helpers added in Vidigest:
// timestamps, timed transcripts, transcript splitting, innertube segments,
// and nested / numbered list rendering.
// Run with: node --test tests/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  formatTimestamp,
  parseTimestamp,
  segmentsToTimedText,
  splitTranscript,
  extractTranscriptSegments,
  renderMarkdown,
} = require('../extension/lib/parsers.js');

// ---------- timestamps ----------

test('formatTimestamp: m:ss under an hour, h:mm:ss above', () => {
  assert.equal(formatTimestamp(0), '0:00');
  assert.equal(formatTimestamp(75), '1:15');
  assert.equal(formatTimestamp(1200), '20:00');
  assert.equal(formatTimestamp(3725), '1:02:05');
  assert.equal(formatTimestamp(-5), '0:00');
});

test('parseTimestamp: inverse of formatTimestamp; null for junk', () => {
  assert.equal(parseTimestamp('1:15'), 75);
  assert.equal(parseTimestamp(' 1:02:05 '), 3725);
  assert.equal(parseTimestamp('abc'), null);
  assert.equal(parseTimestamp(''), null);
  for (const s of [0, 59, 61, 3599, 3600, 7322]) {
    assert.equal(parseTimestamp(formatTimestamp(s)), s);
  }
});

// ---------- timed transcript ----------

test('segmentsToTimedText: groups segments into ~20 s lines with [m:ss] markers', () => {
  const segs = [];
  for (let ms = 0; ms < 60_000; ms += 5000) segs.push({ ms, text: `w${ms / 1000}` });
  const lines = segmentsToTimedText(segs).split('\n');
  assert.deepEqual(lines, ['[0:00] w0 w5 w10 w15', '[0:20] w20 w25 w30 w35', '[0:40] w40 w45 w50 w55']);
});

test('segmentsToTimedText: collapses whitespace, skips empty segments, handles missing times', () => {
  const out = segmentsToTimedText([
    { ms: 1000, text: '  hello \n  world ' },
    { ms: 2000, text: '   ' },
    { ms: null, text: 'no time' },
  ]);
  assert.equal(out, '[0:01] hello world no time');
  assert.equal(segmentsToTimedText([{ ms: null, text: 'a' }, { text: 'b' }]), 'a b');
  assert.equal(segmentsToTimedText([]), '');
});

// ---------- splitting ----------

function longTranscript(minutes) {
  const segs = [];
  for (let ms = 0; ms < minutes * 60_000; ms += 3000) {
    segs.push({ ms, text: 'lorem ipsum dolor sit amet consectetur adipiscing elit' });
  }
  return segmentsToTimedText(segs);
}

test('splitTranscript: short transcript stays one part starting at 0:00', () => {
  const parts = splitTranscript('[0:05] hi\n[0:30] there', 80_000, 60);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].startSec, 0);
  assert.equal(parts[0].endSec, 60);
});

test('splitTranscript: long transcript splits on line boundaries, within limit, contiguous ranges', () => {
  const text = longTranscript(120);
  const parts = splitTranscript(text, 50_000, 7200);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.text.length <= 50_000));
  assert.equal(parts.map((p) => p.text).join('\n'), text, 'no text lost or duplicated');
  assert.equal(parts[0].startSec, 0);
  for (let i = 1; i < parts.length; i++) {
    assert.equal(parts[i - 1].endSec, parts[i].startSec, 'part ranges are contiguous');
    assert.match(parts[i].text, /^\[\d+:\d{2}(:\d{2})?\]/, 'parts start on a timed line');
  }
  assert.equal(parts[parts.length - 1].endSec, 7200);
});

test('splitTranscript: parts are balanced, not one full part plus a sliver', () => {
  const text = longTranscript(90);
  const parts = splitTranscript(text, Math.ceil(text.length / 2) + 1000);
  assert.equal(parts.length, 2);
  const [a, b] = parts.map((p) => p.text.length);
  assert.ok(Math.abs(a - b) / Math.max(a, b) < 0.1, `parts ${a} vs ${b}`);
});

test('splitTranscript: untimed single huge line is split at spaces', () => {
  const big = 'word '.repeat(50_000).trim();
  const parts = splitTranscript(big, 30_000);
  assert.ok(parts.length >= 9);
  assert.ok(parts.every((p) => p.text.length <= 30_000));
  assert.ok(parts.every((p) => p.startSec === null));
});

// ---------- innertube ----------

test('extractTranscriptSegments: keeps start times for both renderer shapes', () => {
  const data = {
    a: [
      { transcriptSegmentRenderer: { startMs: '5000', snippet: { runs: [{ text: 'hello ' }, { text: 'there' }] } } },
      { nested: { transcriptCueRenderer: { startOffsetMs: '9000', cue: { simpleText: 'cue text' } } } },
    ],
  };
  assert.deepEqual(extractTranscriptSegments(data), [
    { ms: 5000, text: 'hello there' },
    { ms: 9000, text: 'cue text' },
  ]);
});

// ---------- markdown lists ----------

test('renderMarkdown: indented bullets become nested lists', () => {
  const html = renderMarkdown('- A\n  - a1\n  - a2\n    - deep\n- B');
  assert.equal(
    html,
    '<ul><li>A<ul><li>a1</li><li>a2<ul><li>deep</li></ul></li></ul></li><li>B</li></ul>'
  );
});

test('renderMarkdown: numbered lists, and bullets under them', () => {
  assert.equal(
    renderMarkdown('1. one\n2. two\n   - sub'),
    '<ol><li>one</li><li>two<ul><li>sub</li></ul></li></ol>'
  );
});

test('renderMarkdown: blank line between bullets keeps one list; paragraph ends it', () => {
  assert.equal(renderMarkdown('- a\n\n- b\ntext'), '<ul><li>a</li><li>b</li></ul><p>text</p>');
});

test('renderMarkdown: timestamps inside nested bullets become jump links', () => {
  const html = renderMarkdown('- point [20:00]\n  - detail [1:02:05]');
  assert.match(html, /<a class="yts-ts" data-seconds="1200" href="#" title="Jump to 20:00">\[20:00\]<\/a>/);
  assert.match(html, /data-seconds="3725"/);
});

test('renderMarkdown: still escapes HTML inside list items', () => {
  const html = renderMarkdown('- <img src=x onerror=alert(1)>\n  - <script>');
  assert.ok(!html.includes('<img'));
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes('&lt;img'));
});
