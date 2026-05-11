// Full pipeline orchestrator.
//
// Per README, the per-recording pipeline is:
//   1. dedup check
//   2. preflight (duration / budget)
//   3. wait for LAD (poll DB up to 5 min)
//   4. identify instructor (LAD → Moodle → stub)
//   5. download audio
//   6. transcribe (Deepgram)
//   7. chunk transcript
//   8. parallel chunk analyses (Claude)
//   9. synthesis pass (Claude)
//   10. store final report
//   11. update instructor history
//   12. fire alerts if thresholds breached
//   13. cleanup /tmp
//   14. mark processed
//
// runFullSync() walks new recordings serially (memory constraint) and logs
// every failure without aborting the run.

const fs = require('fs');
const path = require('path');
const os = require('os');
const axios = require('axios');

const db = require('./db');
const bbb = require('./bbb-client');
const transcription = require('./transcription');
const { chunkTranscript } = require('./chunker');
const analyzer = require('./analyzer');
const instructorMapping = require('./instructor-mapping');
const { preflight, PreflightError } = require('./safety-rails');
const { fireAlerts } = require('./alerting');
const { applyScoringWeights } = require('./scoring');

const LAD_POLL_INTERVAL_MS = 10_000;
const LAD_POLL_TIMEOUT_MS = 5 * 60 * 1000;
const TMP_DIR = process.env.PIPELINE_TMP_DIR || os.tmpdir();

function ensureTmpDir() {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
  return TMP_DIR;
}

async function waitForLad(internalMeetingId, { timeoutMs = LAD_POLL_TIMEOUT_MS } = {}) {
  if (!internalMeetingId) return null;
  const deadline = Date.now() + timeoutMs;
  let lad = await db.get(`lad:${internalMeetingId}`);
  while (!lad && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, LAD_POLL_INTERVAL_MS));
    lad = await db.get(`lad:${internalMeetingId}`);
  }
  return lad || null;
}

async function downloadAudio(url, destPath) {
  const resp = await axios.get(url, { responseType: 'stream', timeout: 60_000 });
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(destPath);
    resp.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
  const stat = fs.statSync(destPath);
  return { path: destPath, sizeBytes: stat.size };
}

function safeUnlink(p) {
  try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* ignore */ }
}

async function appendInstructorHistory(instructor, analysis) {
  if (!instructor?.email) return;
  const key = `instructor-history:${instructor.email}`;
  const entry = {
    recordID: analysis.recordID || analysis.session_meta?.recordID,
    score: analysis.overall_score,
    tier: analysis.performance_tier,
    date: analysis.session_meta?.session_date || new Date().toISOString().slice(0, 10),
    courseCode: analysis.session_meta?.course_code,
    sessionTopic: analysis.session_meta?.session_topic,
  };
  await db.append(key, entry);
}

async function logSession(recordID, patch) {
  const cur = (await db.get(`session-log:${recordID}`)) || { recordID, events: [] };
  cur.events.push({ at: new Date().toISOString(), ...patch });
  cur.lastStatus = patch.status || cur.lastStatus;
  await db.set(`session-log:${recordID}`, cur);
  return cur;
}

async function processRecording(recording) {
  const { recordID } = recording;
  console.log(`[pipeline] processing ${recordID}`);

  // 1. dedup
  if (await db.isInSet('processed-ids', recordID)) {
    console.log(`[pipeline] ${recordID} already processed — skipping`);
    return { recordID, status: 'skipped-already-processed' };
  }

  await logSession(recordID, { status: 'started' });
  await db.set(`recording:${recordID}`, recording);

  let audioPath = null;

  try {
    // 2. preflight (audio size check happens after download)
    await preflight({ recording });

    // 3. wait for LAD (may be null if callback never arrived; that's OK)
    const lad = await waitForLad(recording.internalMeetingID);
    await logSession(recordID, { status: 'lad', ladAvailable: !!lad });

    // 4. identify instructor
    const instructor = await instructorMapping.identifyInstructor({ recording, lad });
    await logSession(recordID, { status: 'instructor-identified', email: instructor.email, via: instructor.lastResolvedVia });

    // 5. download audio (prefer .ogg podcast format)
    const audioUrl = recording.audioUrl || recording.videoUrl;
    if (!audioUrl) throw new Error(`No audio URL available for ${recordID}`);
    ensureTmpDir();
    audioPath = path.join(TMP_DIR, `${recordID}.ogg`);
    const { sizeBytes } = await downloadAudio(audioUrl, audioPath);
    await preflight({ recording, audioSizeBytes: sizeBytes });
    await logSession(recordID, { status: 'audio-downloaded', sizeBytes });

    // 6. transcribe
    const ladModerator = lad ? instructorMapping._pickModeratorFromLad(lad) : null;
    const t = await transcription.transcribeFile(audioPath, { ladModerator });
    await db.set(`transcript:${recordID}`, {
      recordID,
      confidence: t.confidence,
      durationMin: t.durationMin,
      perSpeaker: t.perSpeaker,
      fillerWords: t.fillerWords,
      transcript: t.transcript,
    });
    await logSession(recordID, { status: 'transcribed', confidence: t.confidence, durationMin: t.durationMin });

    // 7. chunk
    const chunks = chunkTranscript(t.transcript);
    await logSession(recordID, { status: 'chunked', count: chunks.length });

    // 8. parallel chunk analysis
    const sessionMeta = {
      instructor_name: instructor.name,
      course: instructor.currentSession?.courseName,
      session_topic: instructor.currentSession?.sessionTopic,
    };
    const { results: chunkAnalyses, errors: chunkErrors } = await analyzer.analyzeAllChunks(chunks, sessionMeta);
    await db.set(`chunk-analyses:${recordID}`, { chunkAnalyses, chunkErrors });
    await logSession(recordID, { status: 'chunk-analyses', count: chunkAnalyses.length, errors: chunkErrors.length });

    // 9. synthesis
    const priorHistory = (await db.get(`instructor-history:${instructor.email}`)) || [];
    const analysisRaw = await analyzer.synthesize({
      recording,
      instructor,
      chunkAnalyses,
      lad,
      priorHistory,
      transcriptConfidence: t.confidence,
    });

    // Apply weighted overall score post-hoc so the weights live in code, not
    // the prompt. Falls back to Claude's overall_score if dimension scores
    // are missing.
    const weighted = applyScoringWeights(analysisRaw);
    const analysis = {
      recordID,
      ...weighted,
      processed_at: new Date().toISOString(),
      ladAvailable: !!lad,
      instructorEmail: instructor.email,
      transcriptConfidence: t.confidence,
    };

    // 10. store
    await db.set(`analysis:${recordID}`, analysis);
    await logSession(recordID, { status: 'synthesized', overall_score: analysis.overall_score });

    // 11. history
    await appendInstructorHistory(instructor, analysis);

    // 12. alerts
    const alertResult = await fireAlerts({ recordID, analysis });
    await logSession(recordID, { status: 'alerts', ...alertResult });

    // 14. mark processed (cleanup is in finally)
    await db.addToSet('processed-ids', recordID);
    await logSession(recordID, { status: 'complete' });
    await db.audit('pipeline.complete', { recordID, instructorEmail: instructor.email, score: analysis.overall_score });
    return { recordID, status: 'complete', overall_score: analysis.overall_score };
  } catch (err) {
    console.error(`[pipeline] ${recordID} failed:`, err.message);
    const code = err instanceof PreflightError ? err.code : 'PIPELINE_ERROR';
    await logSession(recordID, { status: 'error', code, message: err.message });
    await db.audit('pipeline.error', { recordID, code, message: err.message });
    return { recordID, status: 'error', code, message: err.message };
  } finally {
    // 13. cleanup
    safeUnlink(audioPath);
  }
}

async function runFullSync() {
  const processed = (await db.get('processed-ids')) || [];
  const newRecordings = await bbb.getNewRecordings(processed);
  console.log(`[pipeline] sync: ${newRecordings.length} new recording(s)`);

  const summary = { total: newRecordings.length, ok: 0, errors: 0, skipped: 0, items: [] };
  for (const r of newRecordings) {
    const result = await processRecording(r);
    summary.items.push(result);
    if (result.status === 'complete') summary.ok += 1;
    else if (result.status === 'error') summary.errors += 1;
    else summary.skipped += 1;
  }
  await db.audit('sync.complete', summary);
  return summary;
}

module.exports = {
  processRecording,
  runFullSync,
  waitForLad,
  _downloadAudio: downloadAudio,
};
