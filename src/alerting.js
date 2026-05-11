// Email + Slack alerts. Driven by the threshold table in README.md.
//
// Email uses Nodemailer over Gmail SMTP (port 465, App Password). Slack uses
// the incoming-webhook URL from SLACK_WEBHOOK_URL. Either channel can be
// missing — we degrade gracefully and log instead.

const axios = require('axios');
const nodemailer = require('nodemailer');
const db = require('./db');

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

const ALERT_THRESHOLD_SCORE = envNum('ALERT_THRESHOLD_SCORE', 2.5);
const MIN_DURATION_VARIANCE_PCT = envNum('MIN_DURATION_VARIANCE_PCT', -15);
const PIP_TRIGGER_CONSECUTIVE = 3;

function emailTransport() {
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: true,
    auth: { user, pass },
  });
}

async function sendEmail({ to, subject, text, html }) {
  const transport = emailTransport();
  if (!transport) {
    console.warn('[alerting] SMTP not configured — skipping email:', subject);
    return { skipped: true };
  }
  const from = process.env.SMTP_USER;
  const recipients = (Array.isArray(to) ? to : [to]).filter(Boolean);
  if (!recipients.length) return { skipped: true };
  return transport.sendMail({ from, to: recipients.join(','), subject, text, html });
}

async function sendSlack({ text, blocks }) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) {
    console.warn('[alerting] SLACK_WEBHOOK_URL not configured — skipping Slack');
    return { skipped: true };
  }
  return axios.post(url, blocks ? { text, blocks } : { text }, { timeout: 10000 });
}

function buildAlerts(analysis) {
  const meta = analysis.session_meta || {};
  const alerts = [];

  if (typeof analysis.overall_score === 'number' && analysis.overall_score < ALERT_THRESHOLD_SCORE) {
    alerts.push({
      severity: 'High',
      reason: `Overall score ${analysis.overall_score} below threshold ${ALERT_THRESHOLD_SCORE}`,
      recipients: ['admin', 'academic_director'],
    });
  }

  for (const flag of analysis.red_flags || []) {
    if (flag.requires_immediate_review) {
      alerts.push({
        severity: 'Critical',
        reason: `Red flag: ${flag.type} — ${flag.description}`,
        evidenceTimestamp: flag.timestamp,
        recipients: ['admin', 'academic_director', 'hr'],
      });
    }
  }

  if (typeof meta.duration_variance_pct === 'number' && meta.duration_variance_pct < MIN_DURATION_VARIANCE_PCT) {
    alerts.push({
      severity: 'Medium',
      reason: `Class cut short by ${Math.abs(meta.duration_variance_pct).toFixed(1)}% (variance ${meta.duration_variance_pct}% < ${MIN_DURATION_VARIANCE_PCT}%)`,
      recipients: ['admin'],
    });
  }

  const quant = analysis.quantitative_metrics || {};
  if (typeof quant.student_talk_time_pct === 'number' && quant.student_talk_time_pct < 5) {
    alerts.push({
      severity: 'Medium',
      reason: `Student talk time only ${quant.student_talk_time_pct}% (<5%)`,
      recipients: ['admin'],
    });
  }
  if (
    typeof quant.unique_students_who_spoke === 'number' &&
    typeof meta.participant_count === 'number' &&
    meta.participant_count > 0
  ) {
    const ratio = quant.unique_students_who_spoke / meta.participant_count;
    if (ratio < 0.2) {
      alerts.push({
        severity: 'Medium',
        reason: `Only ${quant.unique_students_who_spoke}/${meta.participant_count} students spoke (ratio ${ratio.toFixed(2)} < 0.2)`,
        recipients: ['admin'],
      });
    }
  }
  if (typeof quant.filler_word_rate_per_min === 'number' && quant.filler_word_rate_per_min > 8) {
    alerts.push({
      severity: 'Low',
      reason: `Filler words ${quant.filler_word_rate_per_min}/min (>8/min)`,
      recipients: ['admin'],
    });
  }
  return alerts;
}

// Check if this is the 3rd consecutive below-standard session for the instructor.
async function checkPipTrigger(instructorEmail) {
  if (!instructorEmail) return null;
  const history = (await db.get(`instructor-history:${instructorEmail}`)) || [];
  if (history.length < PIP_TRIGGER_CONSECUTIVE) return null;
  const recent = history.slice(-PIP_TRIGGER_CONSECUTIVE);
  const allBelow = recent.every(h => typeof h.score === 'number' && h.score < 3);
  return allBelow
    ? {
        severity: 'High',
        reason: `${PIP_TRIGGER_CONSECUTIVE} consecutive sessions below standard (scores: ${recent.map(r => r.score).join(', ')}) — formal PIP trigger`,
        recipients: ['admin', 'academic_director'],
      }
    : null;
}

function recipientsToEmails(tags) {
  const map = {
    admin: process.env.ADMIN_EMAIL,
    academic_director: process.env.ACADEMIC_DIRECTOR_EMAIL,
    hr: process.env.HR_EMAIL || process.env.ADMIN_EMAIL,
    compliance: process.env.COMPLIANCE_EMAIL || process.env.ADMIN_EMAIL,
  };
  return [...new Set(tags.map(t => map[t]).filter(Boolean))];
}

function alertToHtml(alert, analysis) {
  const m = analysis.session_meta || {};
  return `
<h2>${alert.severity} alert</h2>
<p><strong>Reason:</strong> ${alert.reason}</p>
<h3>Session</h3>
<ul>
  <li>Instructor: ${m.instructor_name || 'Unknown'} &lt;${m.instructor_email || ''}&gt;</li>
  <li>Course: ${m.course_name || ''} (${m.course_code || ''})</li>
  <li>Topic: ${m.session_topic || ''}</li>
  <li>Date: ${m.session_date || ''}</li>
  <li>Campus: ${m.campus || ''}</li>
  <li>Overall score: ${analysis.overall_score} (${analysis.performance_tier})</li>
</ul>
<p><em>${analysis.tldr || ''}</em></p>
<p>This alert was generated by the automated QA system. It is intended to trigger human review, not direct action. Please consult the full report and follow the right-of-reply workflow before any performance management decision.</p>
`;
}

async function fireAlerts({ recordID, analysis }) {
  const existing = await db.get(`alert-log:${recordID}`);
  if (existing && existing.fired) {
    return { skipped: 'already-fired' };
  }
  const alerts = buildAlerts(analysis);
  const pip = await checkPipTrigger(analysis.session_meta?.instructor_email);
  if (pip) alerts.push(pip);

  if (!alerts.length) {
    await db.set(`alert-log:${recordID}`, { fired: false, alerts: [], at: new Date().toISOString() });
    return { fired: false };
  }

  const results = [];
  for (const a of alerts) {
    const emails = recipientsToEmails(a.recipients);
    const subject = `[MCG QA — ${a.severity}] ${analysis.session_meta?.instructor_name || 'Instructor'} — ${analysis.session_meta?.course_code || ''}`;
    const html = alertToHtml(a, analysis);
    const text = `${a.severity}: ${a.reason}\n\n${analysis.tldr || ''}\nSee dashboard for full report.`;
    try {
      await sendEmail({ to: emails, subject, text, html });
    } catch (err) {
      console.error('[alerting] email failed:', err.message);
    }
    try {
      await sendSlack({ text: `*${subject}*\n${a.reason}\n${analysis.tldr || ''}` });
    } catch (err) {
      console.error('[alerting] slack failed:', err.message);
    }
    results.push({ ...a, sentTo: emails });
  }

  await db.set(`alert-log:${recordID}`, {
    fired: true,
    at: new Date().toISOString(),
    alerts: results,
  });
  await db.audit('alerts.fired', { recordID, count: results.length });
  return { fired: true, alerts: results };
}

module.exports = {
  fireAlerts,
  buildAlerts,
  checkPipTrigger,
  sendEmail,
  sendSlack,
  ALERT_THRESHOLD_SCORE,
  MIN_DURATION_VARIANCE_PCT,
  PIP_TRIGGER_CONSECUTIVE,
};
