// Split a labeled, timestamped transcript into ~20-minute chunks with a
// 30-second overlap. The transcript format is one line per utterance:
//   [HH:MM:SS] LABEL: text
//
// We chunk by timestamp, not by line count, because long monologues can have
// very few lines but a lot of content. Output is the array shape expected by
// the chunk-analysis prompt: { chunk_index, start_time, end_time, content }.

const DEFAULT_CHUNK_MIN = 20;
const DEFAULT_OVERLAP_SEC = 30;

const TS_RE = /^\[(\d{2}):(\d{2}):(\d{2})\]/;

function parseTimestamp(line) {
  const m = line.match(TS_RE);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function pad2(n) { return String(n).padStart(2, '0'); }
function fmt(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

function chunkTranscript(transcript, opts = {}) {
  const chunkSec = (opts.chunkMin || DEFAULT_CHUNK_MIN) * 60;
  const overlap = opts.overlapSec || DEFAULT_OVERLAP_SEC;
  const lines = transcript.split('\n').filter(Boolean);

  // Build (time, line) pairs. Lines without a timestamp inherit the previous
  // line's time — happens if Deepgram emits a continuation line.
  const tagged = [];
  let lastTime = 0;
  for (const line of lines) {
    const t = parseTimestamp(line);
    const time = t === null ? lastTime : t;
    if (t !== null) lastTime = t;
    tagged.push({ time, line });
  }

  if (!tagged.length) return [];

  const totalDuration = tagged[tagged.length - 1].time;
  if (totalDuration <= chunkSec) {
    return [{
      chunk_index: 0,
      start_time: fmt(tagged[0].time),
      end_time: fmt(totalDuration),
      content: lines.join('\n'),
    }];
  }

  const chunks = [];
  let chunkIndex = 0;
  let windowStart = tagged[0].time;
  while (windowStart < totalDuration) {
    const windowEnd = windowStart + chunkSec;
    const overlapStart = Math.max(0, windowStart - (chunkIndex === 0 ? 0 : overlap));
    const content = tagged
      .filter(({ time }) => time >= overlapStart && time < windowEnd)
      .map(t => t.line)
      .join('\n');
    if (content) {
      chunks.push({
        chunk_index: chunkIndex,
        start_time: fmt(overlapStart),
        end_time: fmt(Math.min(windowEnd, totalDuration)),
        content,
      });
      chunkIndex += 1;
    }
    windowStart = windowEnd;
  }
  return chunks;
}

module.exports = {
  chunkTranscript,
  _parseTimestamp: parseTimestamp,
  _fmt: fmt,
};
