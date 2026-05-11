// Express server + cron scheduler for the MCG Instructor QA system.
//
// Endpoints (per README §10):
//   POST /api/lad-callback                # BBB pushes LAD JSON when meeting ends
//   POST /api/sync                        # Manual sync trigger
//   GET  /api/analyses                    # List all analyses
//   GET  /api/analysis/:recordID          # Single analysis detail
//   GET  /api/instructor/:email/history   # Instructor trend data
//   GET  /api/needs-review                # Instructors with stub profiles
//   POST /api/admin/override              # Manual instructor mapping fix
//   GET  /api/audit/bias                  # Bias audit (quarterly aggregate)
//   GET  /api/status                      # Health + budget
//   GET  /                                # Redirect to /dashboard
//   GET  /dashboard                       # Serve dashboard.html
//   GET  /admin-override                  # Serve admin-override.html
//
// Cron: every 2 hours, runFullSync().

const path = require('path');
const express = require('express');
const cron = require('node-cron');

const db = require('./src/db');
const bbb = require('./src/bbb-client');
const moodle = require('./src/moodle-client');
const pipeline = require('./src/pipeline');
const instructorMapping = require('./src/instructor-mapping');
const safetyRails = require('./src/safety-rails');
const alerting = require('./src/alerting');
const analyzer = require('./src/analyzer');

const PORT = Number(process.env.PORT) || 3000;
const SYNC_CRON = process.env.SYNC_CRON || '0 */2 * * *'; // every 2h
const DISABLE_CRON = process.env.DISABLE_CRON === 'true';

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Lightweight request log so Replit's console shows traffic at a glance.
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`[http] ${req.method} ${req.path} → ${res.statusCode} (${Date.now() - start}ms)`);
  });
  next();
});

// ----- public pages -----

app.get('/', (req, res) => res.redirect('/dashboard'));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/admin-override', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin-override.html')));

// ----- API: status + health -----

app.get('/api/status', async (req, res) => {
  try {
    const budget = await safetyRails.getBudgetStatus();
    const processed = (await db.get('processed-ids')) || [];
    res.json({
      status: 'ok',
      uptimeSec: Math.round(process.uptime()),
      bbb: { configured: !!process.env.BBB_URL && !!process.env.BBB_SECRET },
      anthropic: { configured: !!process.env.ANTHROPIC_API_KEY, model: analyzer.MODEL },
      deepgram: { configured: !!process.env.DEEPGRAM_API_KEY },
      moodle: { configured: !!process.env.MOODLE_BASE_URL && !!process.env.MOODLE_API_TOKEN },
      replitDb: { configured: !!process.env.REPLIT_DB_URL },
      cron: { enabled: !DISABLE_CRON, schedule: SYNC_CRON },
      processedCount: processed.length,
      budget,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ----- API: LAD callback from BBB -----

app.post('/api/lad-callback', async (req, res) => {
  try {
    const { meeting_id, internal_meeting_id, data } = req.body || {};
    if (!internal_meeting_id || !data) {
      return res.status(400).json({ received: false, error: 'missing internal_meeting_id or data' });
    }
    await db.set(`lad:${internal_meeting_id}`, {
      meeting_id,
      internal_meeting_id,
      duration_sec: data.duration,
      start: data.start,
      finish: data.finish,
      metadata: data.metadata,
      attendees: data.attendees,
      files: data.files,
      polls: data.polls,
      // Pass through anything else BBB sent so we don't lose forward-compat fields.
      raw: data,
      received_at: new Date().toISOString(),
    });
    await db.audit('lad.received', { internal_meeting_id });
    res.json({ received: true });
  } catch (err) {
    console.error('[lad-callback] error:', err);
    res.status(500).json({ received: false, error: err.message });
  }
});

// ----- API: sync trigger -----

app.post('/api/sync', async (req, res) => {
  try {
    // Kick off in the background; sync can take a long time.
    res.json({ started: true, at: new Date().toISOString() });
    pipeline.runFullSync().catch(err => console.error('[sync] failed:', err));
  } catch (err) {
    res.status(500).json({ started: false, error: err.message });
  }
});

// ----- API: analyses list + detail -----

app.get('/api/analyses', async (req, res) => {
  try {
    const all = await db.getMany('analysis:');
    const summary = all.map(({ value: a }) => ({
      recordID: a.recordID,
      instructorEmail: a.instructorEmail,
      instructorName: a.session_meta?.instructor_name,
      courseCode: a.session_meta?.course_code,
      courseName: a.session_meta?.course_name,
      campus: a.session_meta?.campus,
      sessionDate: a.session_meta?.session_date,
      overallScore: a.overall_score,
      tier: a.performance_tier,
      tldr: a.tldr,
      processedAt: a.processed_at,
      hasRedFlags: Array.isArray(a.red_flags) && a.red_flags.length > 0,
    }));
    summary.sort((a, b) => (b.processedAt || '').localeCompare(a.processedAt || ''));
    res.json({ count: summary.length, analyses: summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/analysis/:recordID', async (req, res) => {
  try {
    const a = await db.get(`analysis:${req.params.recordID}`);
    if (!a) return res.status(404).json({ error: 'not found' });
    await db.audit('analysis.read', { recordID: req.params.recordID });
    res.json(a);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- API: instructors -----

app.get('/api/instructors', async (req, res) => {
  try {
    const rows = await db.getMany('instructor:');
    const instructors = rows
      .map(({ value }) => value)
      .filter(Boolean)
      .map(i => ({
        email: i.email,
        name: i.name,
        campus: i.campus,
        status: i.status,
        programs: i.programs,
        moodleUserId: i.moodleUserId,
      }));
    res.json({ count: instructors.length, instructors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/instructor/:email', async (req, res) => {
  try {
    const profile = await db.get(`instructor:${req.params.email.toLowerCase()}`);
    if (!profile) return res.status(404).json({ error: 'not found' });
    res.json(profile);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/instructor/:email/history', async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    const history = (await db.get(`instructor-history:${email}`)) || [];
    res.json({ email, count: history.length, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/needs-review', async (req, res) => {
  try {
    const rows = await db.getMany('instructor:');
    const needsReview = rows
      .map(({ value }) => value)
      .filter(i => i && i.status === 'needs-review');
    res.json({ count: needsReview.length, instructors: needsReview });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- API: admin override -----

app.post('/api/admin/override', async (req, res) => {
  try {
    const { recordID, newInstructorEmail, actor } = req.body || {};
    if (!recordID || !newInstructorEmail) {
      return res.status(400).json({ error: 'recordID and newInstructorEmail required' });
    }
    const updated = await instructorMapping.applyOverride({ recordID, newInstructorEmail, actor });
    res.json({ ok: true, analysis: updated });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ----- API: instructor right-of-reply -----
// Stored per-recordID and shown alongside the analysis in any HR view.
app.post('/api/right-of-reply/:recordID', async (req, res) => {
  try {
    const { instructorEmail, response } = req.body || {};
    if (!response) return res.status(400).json({ error: 'response required' });
    const key = `right-of-reply:${req.params.recordID}`;
    const replies = (await db.get(key)) || [];
    const entry = {
      at: new Date().toISOString(),
      instructorEmail,
      response,
    };
    replies.push(entry);
    await db.set(key, replies);
    await db.audit('right-of-reply.submitted', { recordID: req.params.recordID, instructorEmail });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/right-of-reply/:recordID', async (req, res) => {
  const replies = (await db.get(`right-of-reply:${req.params.recordID}`)) || [];
  res.json({ recordID: req.params.recordID, replies });
});

// ----- API: bias audit -----
// Aggregates scores by instructor + campus + course for the period. Not a
// statistical test — just a transparency dashboard for quarterly review.
app.get('/api/audit/bias', async (req, res) => {
  try {
    const rows = await db.getMany('analysis:');
    const buckets = {
      byCampus: {},
      byCourse: {},
      byInstructor: {},
    };
    function push(map, key, score) {
      if (!key) return;
      const cur = map[key] || { count: 0, sum: 0, scores: [] };
      cur.count += 1;
      cur.sum += score || 0;
      cur.scores.push(score);
      map[key] = cur;
    }
    for (const { value: a } of rows) {
      if (typeof a.overall_score !== 'number') continue;
      push(buckets.byCampus, a.session_meta?.campus, a.overall_score);
      push(buckets.byCourse, a.session_meta?.course_code, a.overall_score);
      push(buckets.byInstructor, a.instructorEmail, a.overall_score);
    }
    function finalize(map) {
      return Object.entries(map).map(([k, v]) => ({
        key: k,
        count: v.count,
        avg: Math.round((v.sum / v.count) * 100) / 100,
      })).sort((a, b) => a.avg - b.avg);
    }
    res.json({
      generated_at: new Date().toISOString(),
      byCampus: finalize(buckets.byCampus),
      byCourse: finalize(buckets.byCourse),
      byInstructor: finalize(buckets.byInstructor),
      note: 'This is a transparency report only — disparities here are NOT evidence of bias in either direction. Investigate further before any conclusion.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----- API: smoke tests for external services -----

app.get('/api/test/bbb', async (req, res) => {
  try {
    const meetings = await bbb.getMeetings();
    res.json({ ok: true, meetings: meetings.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/test/moodle', async (req, res) => {
  try {
    // No-cost smoke test: ask Moodle for course ID 1 if possible.
    const course = await moodle.getCourseById(1).catch(() => null);
    res.json({ ok: true, sampleCourseFetched: !!course });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ----- 404 fallthrough -----

app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));

// ----- error handler -----

app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[express] unhandled error:', err);
  res.status(500).json({ error: err.message });
});

// ----- cron -----

if (!DISABLE_CRON && cron.validate(SYNC_CRON)) {
  cron.schedule(SYNC_CRON, () => {
    console.log(`[cron] starting scheduled sync (${SYNC_CRON})`);
    pipeline.runFullSync().catch(err => console.error('[cron] sync failed:', err));
  });
  console.log(`[cron] sync scheduled: ${SYNC_CRON}`);
} else if (DISABLE_CRON) {
  console.log('[cron] disabled via DISABLE_CRON=true');
} else {
  console.warn(`[cron] invalid schedule "${SYNC_CRON}" — cron disabled`);
}

// ----- listen -----
// Replit expects the app to bind on 0.0.0.0:$PORT so the proxy can reach it.
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] listening on http://0.0.0.0:${PORT}`);
});

module.exports = app;
