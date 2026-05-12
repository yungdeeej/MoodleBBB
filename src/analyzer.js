// Two-stage Claude analyzer:
//   Stage 1: parallel chunk analysis (one Claude call per chunk)
//   Stage 2: synthesis pass combining chunks + LAD + metadata
//
// Model: claude-sonnet-4-5-20250929 (per README spec).
// Cost tracking is best-effort: we increment monthly-spend on every call.

const Anthropic = require('@anthropic-ai/sdk');
const db = require('./db');
const chunkPrompt = require('./prompts/chunk-analysis');
const synthesisPrompt = require('./prompts/synthesis');
const trendPrompt = require('./prompts/trend-summary');

const MODEL = 'claude-sonnet-4-5-20250929';

// Conservative per-1M-token pricing for spend tracking. Sonnet 4.5 pricing:
//   input  $3.00 / 1M tokens
//   output $15.00 / 1M tokens
const PRICE_INPUT_PER_TOKEN = 3 / 1_000_000;
const PRICE_OUTPUT_PER_TOKEN = 15 / 1_000_000;

function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY is not set in Replit Secrets');
  return new Anthropic({ apiKey: key });
}

// Some models return JSON wrapped in markdown fences despite "JSON only"
// instructions. Strip them safely.
function stripFences(text) {
  if (!text) return text;
  return text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

function parseJsonSafely(text, context) {
  const clean = stripFences(text);
  try {
    return JSON.parse(clean);
  } catch (err) {
    // Try to salvage: find the first { and last } and parse the slice.
    const first = clean.indexOf('{');
    const last = clean.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(clean.slice(first, last + 1));
      } catch (_) {
        // fall through
      }
    }
    throw new Error(`Failed to parse JSON from Claude (${context}): ${err.message}`);
  }
}

async function recordSpend(usage) {
  if (!usage) return;
  const cost =
    (usage.input_tokens || 0) * PRICE_INPUT_PER_TOKEN +
    (usage.output_tokens || 0) * PRICE_OUTPUT_PER_TOKEN;
  const cur = (await db.get('monthly-spend')) || { month: monthKey(), totalUsd: 0, calls: 0 };
  // Reset on new month.
  if (cur.month !== monthKey()) {
    cur.month = monthKey();
    cur.totalUsd = 0;
    cur.calls = 0;
  }
  cur.totalUsd = Math.round((cur.totalUsd + cost) * 10000) / 10000;
  cur.calls += 1;
  await db.set('monthly-spend', cur);
}

function monthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function callClaude({ system, user, maxTokens = 4096, temperature = 0 }) {
  const client = getClient();
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    temperature,
    system,
    messages: [{ role: 'user', content: user }],
  });
  await recordSpend(resp.usage);
  const text = (resp.content || [])
    .filter(p => p.type === 'text')
    .map(p => p.text)
    .join('\n');
  return { text, usage: resp.usage };
}

async function analyzeChunk(chunk, sessionMeta) {
  const user = chunkPrompt.buildUserMessage({ chunk, sessionMeta });
  const { text } = await callClaude({
    system: chunkPrompt.SYSTEM_PROMPT,
    user,
    maxTokens: 2048,
  });
  return parseJsonSafely(text, `chunk ${chunk.chunk_index}`);
}

// Run all chunk analyses in parallel. Failures are isolated per chunk — a
// single bad chunk doesn't kill the whole analysis.
async function analyzeAllChunks(chunks, sessionMeta) {
  const settled = await Promise.allSettled(
    chunks.map(c => analyzeChunk(c, sessionMeta)),
  );
  const results = [];
  const errors = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      results.push(s.value);
    } else {
      errors.push({ chunk_index: chunks[i].chunk_index, error: s.reason.message });
    }
  });
  return { results, errors };
}

async function synthesize({ recording, instructor, chunkAnalyses, lad, priorHistory, transcriptConfidence }) {
  const user = synthesisPrompt.buildUserMessage({
    recording, instructor, chunkAnalyses, lad, priorHistory, transcriptConfidence,
  });
  const { text } = await callClaude({
    system: synthesisPrompt.SYSTEM_PROMPT,
    user,
    maxTokens: 8192,
  });
  return parseJsonSafely(text, 'synthesis');
}

async function summarizeTrend({ instructor, sessions }) {
  const user = trendPrompt.buildUserMessage({ instructor, sessions });
  const { text } = await callClaude({
    system: trendPrompt.SYSTEM_PROMPT,
    user,
    maxTokens: 2048,
  });
  return parseJsonSafely(text, 'trend-summary');
}

module.exports = {
  MODEL,
  analyzeChunk,
  analyzeAllChunks,
  synthesize,
  summarizeTrend,
  _stripFences: stripFences,
  _parseJsonSafely: parseJsonSafely,
};
