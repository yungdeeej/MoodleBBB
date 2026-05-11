// Deepgram-backed transcription.
//
// We use the prerecorded API with diarization on. The output is a per-utterance
// list which we condense into a single human-readable transcript labeled by
// speaker. After we know the LAD moderator name we relabel the instructor's
// speaker tag to "INSTRUCTOR" — never before, to keep evidence defensible.

const fs = require('fs');
const { createClient } = require('@deepgram/sdk');

const FILLER_WORDS = new Set([
  'um', 'uh', 'er', 'ah', 'like', 'literally', 'basically',
  "y'know", 'yknow', 'sort', 'kinda', 'kind', // partial — caller refines
]);

function getClient() {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) throw new Error('DEEPGRAM_API_KEY is not set in Replit Secrets');
  return createClient(key);
}

function pad2(n) { return String(n).padStart(2, '0'); }
function formatTimestamp(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

function pickModelOptions() {
  return {
    model: 'nova-3',
    smart_format: true,
    diarize: true,
    punctuate: true,
    utterances: true,
    language: 'en',
    filler_words: true,
  };
}

// Deepgram returns rich JSON; collapse to:
//   { transcript, confidence, speakers, utterances, durationSec }
function extractStructured(dg) {
  const channel = dg?.results?.channels?.[0];
  const alt = channel?.alternatives?.[0];
  if (!alt) {
    return { transcript: '', confidence: 0, speakers: [], utterances: [], durationSec: 0 };
  }

  const utterances = (dg.results.utterances || []).map(u => ({
    start: u.start,
    end: u.end,
    speaker: typeof u.speaker === 'number' ? u.speaker : 0,
    text: u.transcript,
    confidence: u.confidence,
  }));

  const speakers = new Set(utterances.map(u => u.speaker));
  const durationSec = utterances.length ? utterances[utterances.length - 1].end : 0;

  return {
    transcript: alt.transcript || '',
    confidence: alt.confidence || 0,
    speakers: [...speakers],
    utterances,
    durationSec,
  };
}

// Returns a per-speaker tally of word count + utterance count.
function tallyPerSpeaker(utterances) {
  const out = new Map();
  for (const u of utterances) {
    const words = u.text.split(/\s+/).filter(Boolean).length;
    const cur = out.get(u.speaker) || { speaker: u.speaker, words: 0, utterances: 0, durationSec: 0 };
    cur.words += words;
    cur.utterances += 1;
    cur.durationSec += Math.max(0, (u.end || 0) - (u.start || 0));
    out.set(u.speaker, cur);
  }
  return [...out.values()].sort((a, b) => b.words - a.words);
}

// Build a labeled, timestamped transcript string.
function formatTranscript(utterances, speakerLabels) {
  return utterances
    .map(u => {
      const label = speakerLabels.get(u.speaker) || `SPEAKER ${u.speaker}`;
      return `[${formatTimestamp(u.start)}] ${label}: ${u.text}`;
    })
    .join('\n');
}

function countFillers(utterances) {
  let total = 0;
  const detail = { um: 0, uh: 0, like: 0, you_know: 0, basically: 0, sort_of: 0, other: 0 };
  const text = utterances.map(u => u.text.toLowerCase()).join(' ');
  detail.um = (text.match(/\bum+\b/g) || []).length;
  detail.uh = (text.match(/\buh+\b/g) || []).length;
  detail.like = (text.match(/\blike\b/g) || []).length;
  detail.you_know = (text.match(/\byou know\b/g) || []).length;
  detail.basically = (text.match(/\bbasically\b/g) || []).length;
  detail.sort_of = (text.match(/\bsort of\b|\bkind of\b/g) || []).length;
  total = Object.values(detail).reduce((a, b) => a + b, 0);
  return { total, detail };
}

// Top-level: transcribe an audio file already saved to disk.
// `ladModerator` (optional) is the LAD moderator object — when present we
// relabel that speaker as INSTRUCTOR.
async function transcribeFile(filePath, { ladModerator } = {}) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Audio file not found: ${filePath}`);
  }
  const client = getClient();
  const audioBuffer = fs.readFileSync(filePath);
  const { result, error } = await client.listen.prerecorded.transcribeFile(
    audioBuffer,
    pickModelOptions(),
  );
  if (error) throw new Error(`Deepgram error: ${error.message || error}`);

  const structured = extractStructured(result);
  const tallies = tallyPerSpeaker(structured.utterances);
  const topSpeaker = tallies[0]?.speaker;

  // Speaker labelling. Default: SPEAKER 0/1/2...
  const labels = new Map();
  for (const sp of structured.speakers) labels.set(sp, `SPEAKER ${sp}`);

  // Cross-check transcript dominance with LAD: only label INSTRUCTOR when
  // both signals agree. Without LAD we still flag the most-talkative speaker
  // as the *probable* instructor for downstream metrics, but the explicit
  // INSTRUCTOR label is reserved for the LAD-confirmed case.
  if (topSpeaker !== undefined) {
    if (ladModerator) {
      labels.set(topSpeaker, 'INSTRUCTOR');
    } else {
      labels.set(topSpeaker, 'PROBABLE INSTRUCTOR');
    }
  }

  const fillers = countFillers(structured.utterances.filter(u => u.speaker === topSpeaker));
  const totalWords = tallies.reduce((a, b) => a + b.words, 0) || 1;
  const instructorWords = tallies[0]?.words || 0;
  const instructorTalkPct = Math.round((instructorWords / totalWords) * 1000) / 10;

  return {
    transcript: formatTranscript(structured.utterances, labels),
    confidence: Math.round((structured.confidence || 0) * 1000) / 10,
    durationSec: structured.durationSec,
    durationMin: Math.round((structured.durationSec / 60) * 10) / 10,
    speakerCount: structured.speakers.length,
    perSpeaker: tallies.map(t => ({
      ...t,
      label: labels.get(t.speaker),
    })),
    instructorSpeakerId: topSpeaker,
    instructorTalkPct,
    fillerWords: fillers,
    // We deliberately do not return Deepgram's raw payload — it's huge and we
    // don't want it bloating Replit DB.
  };
}

module.exports = {
  transcribeFile,
  _formatTimestamp: formatTimestamp,
  _extractStructured: extractStructured,
  _countFillers: countFillers,
  FILLER_WORDS,
};
