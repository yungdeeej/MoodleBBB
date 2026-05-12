// BigBlueButton API client.
//
// Implements the BBB security model: every request URL has a checksum query
// param = sha1(callName + queryString + sharedSecret). The queryString is the
// already-encoded querystring without the leading "?".
//
// We use only the calls we actually need:
//   - getRecordings (paginated)
//   - getMeetings  (only for the test endpoint / health probe)

const crypto = require('crypto');
const axios = require('axios');
const xml2js = require('xml2js');

const xmlParser = new xml2js.Parser({ explicitArray: false, mergeAttrs: true });

function getConfig() {
  const url = process.env.BBB_URL;
  const secret = process.env.BBB_SECRET;
  if (!url || !secret) {
    throw new Error('BBB_URL and BBB_SECRET must be set in Replit Secrets');
  }
  // Normalize to ".../bigbluebutton/api/" base.
  const trimmed = url.replace(/\/+$/, '');
  const apiBase = trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
  return { apiBase, secret };
}

function buildQueryString(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

function checksum(callName, queryString, secret) {
  return crypto.createHash('sha1').update(callName + queryString + secret).digest('hex');
}

function buildUrl(callName, params = {}) {
  const { apiBase, secret } = getConfig();
  const qs = buildQueryString(params);
  const sum = checksum(callName, qs, secret);
  const sep = qs ? '&' : '';
  return `${apiBase}/${callName}?${qs}${sep}checksum=${sum}`;
}

async function bbbCall(callName, params = {}) {
  const url = buildUrl(callName, params);
  const resp = await axios.get(url, { timeout: 30000, validateStatus: () => true });
  if (resp.status >= 400) {
    throw new Error(`BBB ${callName} HTTP ${resp.status}: ${resp.data}`);
  }
  const parsed = await xmlParser.parseStringPromise(resp.data);
  const root = parsed.response || {};
  if (root.returncode === 'FAILED') {
    throw new Error(`BBB ${callName} FAILED: ${root.messageKey} / ${root.message}`);
  }
  return root;
}

// Normalize BBB's nested recording XML shape into a flat JS object that's
// safe to store in Replit DB.
function normalizeRecording(rec) {
  const playback = rec.playback?.format
    ? (Array.isArray(rec.playback.format) ? rec.playback.format : [rec.playback.format])
    : [];
  const presentation = playback.find(f => f.type === 'presentation');
  const podcast = playback.find(f => f.type === 'podcast');
  const video = playback.find(f => f.type === 'video');

  const metaRaw = rec.metadata || {};
  const meta = {};
  for (const [k, v] of Object.entries(metaRaw)) {
    // Skip nested XML noise; only keep string-ish primitives.
    if (typeof v === 'string') meta[k] = v;
  }

  const startEpoch = Number(rec.startTime) || null;
  const endEpoch = Number(rec.endTime) || null;
  const durationMin = startEpoch && endEpoch
    ? Math.round((endEpoch - startEpoch) / 60000)
    : null;

  return {
    recordID: rec.recordID,
    meetingID: rec.meetingID,
    internalMeetingID: rec.internalMeetingID,
    name: rec.name,
    published: rec.published === 'true',
    state: rec.state,
    startTime: startEpoch,
    endTime: endEpoch,
    startISO: startEpoch ? new Date(startEpoch).toISOString() : null,
    endISO: endEpoch ? new Date(endEpoch).toISOString() : null,
    durationMin,
    participants: rec.participants ? Number(rec.participants) : null,
    playbackUrl: presentation?.url || playback[0]?.url || null,
    audioUrl: podcast?.url || null,
    videoUrl: video?.url || null,
    rawPlaybackFormats: playback,
    metadata: meta,
    // Convenience accessors for the metadata fields we care about.
    moodleCourseId: meta['bbb-context'] || meta['bbb-context-id'] || null,
    courseName: meta['bbb-context-name'] || null,
    recordingName: meta['bbb-recording-name'] || meta['bbb-context-name'] || rec.name,
    recordingTags: meta['bbb-recording-tags'] || null,
  };
}

async function getMeetings() {
  const root = await bbbCall('getMeetings');
  const meetings = root.meetings?.meeting;
  if (!meetings) return [];
  return Array.isArray(meetings) ? meetings : [meetings];
}

async function getRecordingsPage({ offset = 0, limit = 100, meetingID, recordID, state } = {}) {
  const root = await bbbCall('getRecordings', {
    offset,
    limit,
    meetingID,
    recordID,
    state: state || 'published,processed',
  });
  const recs = root.recordings?.recording;
  if (!recs) return [];
  return (Array.isArray(recs) ? recs : [recs]).map(normalizeRecording);
}

// Walk through pages until we get fewer than `limit` results.
async function getAllRecordings(opts = {}) {
  const limit = opts.limit || 100;
  let offset = 0;
  const all = [];
  for (let safety = 0; safety < 50; safety++) {
    const page = await getRecordingsPage({ offset, limit, ...opts });
    all.push(...page);
    if (page.length < limit) break;
    offset += limit;
  }
  return all;
}

async function getNewRecordings(processedIds = []) {
  const seen = new Set(processedIds);
  const all = await getAllRecordings();
  return all.filter(r => !seen.has(r.recordID));
}

module.exports = {
  getMeetings,
  getRecordingsPage,
  getAllRecordings,
  getNewRecordings,
  // Exposed for tests / debugging:
  _buildUrl: buildUrl,
  _checksum: checksum,
  _normalizeRecording: normalizeRecording,
};
