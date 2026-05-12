// Identity resolution for "who is the instructor for this recording?"
//
// Priority cascade (per README):
//   1. LAD moderator flag — the single attendee with moderator:true is the
//      instructor at MCG. Authoritative whenever LAD is available.
//   2. Moodle web services lookup — look up editing teachers for the BBB
//      context's Moodle course. Use only if there's exactly one teacher OR
//      disambiguation succeeds via name match against the LAD attendee list.
//   3. Auto-create stub with status:'needs-review' so the pipeline keeps
//      moving and an admin can fix the mapping later via the override UI.

const db = require('./db');
const moodle = require('./moodle-client');

function normEmail(e) {
  return (e || '').trim().toLowerCase();
}

function normName(n) {
  return (n || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Pick the single moderator attendee from a LAD payload. If multiple
// moderators are present (rare — usually a sysadmin joins), prefer the one
// with the most cumulative duration (the real teacher of the session).
function pickModeratorFromLad(lad) {
  if (!lad || !Array.isArray(lad.attendees)) return null;
  const mods = lad.attendees.filter(a => a.moderator === true);
  if (mods.length === 0) return null;
  if (mods.length === 1) return mods[0];
  return mods
    .slice()
    .sort((a, b) => (b.duration || 0) - (a.duration || 0))[0];
}

// Try to look up an instructor profile by email or moodleUserId in our DB.
async function findExistingInstructor({ email, moodleUserId, name }) {
  if (email) {
    const direct = await db.get(`instructor:${normEmail(email)}`);
    if (direct) return direct;
  }
  if (moodleUserId) {
    const ks = await db.keys('instructor:');
    for (const k of ks) {
      const profile = await db.get(k);
      if (profile && profile.moodleUserId === moodleUserId) return profile;
    }
  }
  if (name) {
    const target = normName(name);
    const ks = await db.keys('instructor:');
    for (const k of ks) {
      const profile = await db.get(k);
      if (profile && normName(profile.name) === target) return profile;
    }
  }
  return null;
}

// Disambiguate a list of Moodle teachers using the LAD attendee names.
// Returns the single best match or null if ambiguous.
function matchTeacherToLadModerator(teachers, ladModerator) {
  if (!ladModerator) return null;
  const target = normName(ladModerator.name);
  const targetExtId = ladModerator.ext_user_id;

  if (targetExtId) {
    const byExtId = teachers.find(t =>
      String(t.moodleUserId) === String(targetExtId) ||
      String(t.username) === String(targetExtId));
    if (byExtId) return byExtId;
  }

  const byFullName = teachers.find(t => normName(t.fullName) === target);
  if (byFullName) return byFullName;

  const byParts = teachers.find(t => {
    const built = normName(`${t.firstName} ${t.lastName}`);
    return built === target;
  });
  return byParts || null;
}

async function buildSessionContext({ recording, moodleCourse, moodleTeacher }) {
  return {
    moodleCourseId: recording.moodleCourseId ? Number(recording.moodleCourseId) : null,
    courseName: moodleCourse?.fullname || recording.courseName || null,
    courseShortname: moodleCourse?.shortname || null,
    sessionTopic: recording.recordingName || recording.name || null,
    sessionDescription: moodleCourse?.summary || null,
    bbbActivityName: recording.name || null,
    scheduledDurationMin: recording.durationMin || null,
    campus: moodleCourse?.categoryname || moodleTeacher?.campus || null,
    moodleMetadata: moodleCourse
      ? {
          categoryid: moodleCourse.categoryid,
          format: moodleCourse.format,
          startdate: moodleCourse.startdate,
          enddate: moodleCourse.enddate,
        }
      : null,
  };
}

async function createStubInstructor({ email, name, moodleUserId, source, recording, moodleCourse, moodleTeacher }) {
  const fallbackEmail = email || `unknown+${moodleUserId || Date.now()}@needs-review.mcgcollege.ca`;
  const profile = {
    email: normEmail(fallbackEmail),
    name: name || 'Unknown Instructor',
    moodleUserId: moodleUserId || null,
    campus: moodleCourse?.categoryname || null,
    programs: [],
    status: 'needs-review',
    createdAt: new Date().toISOString(),
    createdFrom: source,
    currentSession: await buildSessionContext({ recording, moodleCourse, moodleTeacher }),
  };
  await db.set(`instructor:${profile.email}`, profile);
  await db.audit('instructor.stub-created', { email: profile.email, source });
  return profile;
}

// Main entry — given a recording + LAD payload (may be null), return an
// instructor profile object. NEVER throws on identity failure; instead
// returns a stub with status:'needs-review'.
async function identifyInstructor({ recording, lad }) {
  const trail = []; // for the audit log
  let moodleCourse = null;
  let moodleTeachers = [];

  // Pull the Moodle course up front; it's useful in every branch.
  if (recording.moodleCourseId) {
    try {
      moodleCourse = await moodle.getCourseById(recording.moodleCourseId);
      trail.push(`moodle:course=${recording.moodleCourseId} fetched`);
    } catch (err) {
      trail.push(`moodle:course-lookup-failed: ${err.message}`);
    }
    try {
      moodleTeachers = await moodle.getCourseTeachers(recording.moodleCourseId);
      trail.push(`moodle:teachers=${moodleTeachers.length}`);
    } catch (err) {
      trail.push(`moodle:teachers-lookup-failed: ${err.message}`);
    }
  }

  // Priority 1: LAD moderator flag.
  const ladModerator = pickModeratorFromLad(lad);
  if (ladModerator) {
    trail.push(`lad:moderator="${ladModerator.name}" ext_user_id=${ladModerator.ext_user_id || 'n/a'}`);

    // Try to match LAD moderator to a Moodle teacher to get the verified email.
    const matchedTeacher = matchTeacherToLadModerator(moodleTeachers, ladModerator);
    if (matchedTeacher) {
      trail.push(`matched:lad-moderator→moodle-teacher email=${matchedTeacher.email}`);
      const existing = await findExistingInstructor({
        email: matchedTeacher.email,
        moodleUserId: matchedTeacher.moodleUserId,
      });
      const profile = existing || {
        email: normEmail(matchedTeacher.email),
        name: matchedTeacher.fullName,
        moodleUserId: matchedTeacher.moodleUserId,
        campus: moodleCourse?.categoryname || null,
        programs: [],
        status: 'active',
        createdAt: new Date().toISOString(),
      };
      profile.currentSession = await buildSessionContext({ recording, moodleCourse, moodleTeacher: matchedTeacher });
      profile.lastResolvedVia = 'lad-moderator+moodle-match';
      profile.resolutionTrail = trail;
      await db.set(`instructor:${profile.email}`, profile);
      return profile;
    }

    // LAD says X but Moodle has no matching teacher — try direct lookup by name
    // among existing instructor profiles before we stub.
    const existing = await findExistingInstructor({ name: ladModerator.name });
    if (existing) {
      trail.push(`matched:lad-moderator→existing-profile email=${existing.email}`);
      existing.currentSession = await buildSessionContext({ recording, moodleCourse });
      existing.lastResolvedVia = 'lad-moderator+name-match';
      existing.resolutionTrail = trail;
      await db.set(`instructor:${existing.email}`, existing);
      return existing;
    }

    trail.push('falling-through: lad-moderator unmatched in moodle and DB');
    return createStubInstructor({
      name: ladModerator.name,
      moodleUserId: null,
      source: 'lad-moderator-unmatched',
      recording,
      moodleCourse,
    });
  }

  // Priority 2: Moodle teacher list.
  if (moodleTeachers.length === 1) {
    const t = moodleTeachers[0];
    trail.push('priority-2:single-moodle-teacher');
    const existing = await findExistingInstructor({
      email: t.email,
      moodleUserId: t.moodleUserId,
    });
    const profile = existing || {
      email: normEmail(t.email),
      name: t.fullName,
      moodleUserId: t.moodleUserId,
      campus: moodleCourse?.categoryname || null,
      programs: [],
      status: 'active',
      createdAt: new Date().toISOString(),
    };
    profile.currentSession = await buildSessionContext({ recording, moodleCourse, moodleTeacher: t });
    profile.lastResolvedVia = 'moodle-single-teacher';
    profile.resolutionTrail = trail;
    await db.set(`instructor:${profile.email}`, profile);
    return profile;
  }

  if (moodleTeachers.length > 1) {
    trail.push(`priority-2:multiple-moodle-teachers count=${moodleTeachers.length}`);
    // Cannot disambiguate without LAD — flag for admin review with the full
    // candidate list attached.
    const stub = await createStubInstructor({
      name: 'Ambiguous — multiple teachers',
      source: 'moodle-multiple-teachers',
      recording,
      moodleCourse,
    });
    stub.candidates = moodleTeachers;
    stub.resolutionTrail = trail;
    await db.set(`instructor:${stub.email}`, stub);
    return stub;
  }

  // Priority 3: stub.
  trail.push('priority-3:no-identity-signal');
  const stub = await createStubInstructor({
    source: 'no-signal',
    recording,
    moodleCourse,
  });
  stub.resolutionTrail = trail;
  await db.set(`instructor:${stub.email}`, stub);
  return stub;
}

// Admin override: take a recording's analysis and rewrite it to a different
// instructor email. Used by the admin-override UI.
async function applyOverride({ recordID, newInstructorEmail, actor }) {
  const analysis = await db.get(`analysis:${recordID}`);
  if (!analysis) throw new Error(`No analysis for recordID=${recordID}`);
  const newEmail = normEmail(newInstructorEmail);
  const target = await db.get(`instructor:${newEmail}`);
  if (!target) throw new Error(`No instructor profile for ${newEmail}`);

  const previous = analysis.session_meta?.instructor_email;
  analysis.session_meta.instructor_email = newEmail;
  analysis.session_meta.instructor_name = target.name;
  analysis.overrideHistory = analysis.overrideHistory || [];
  analysis.overrideHistory.push({
    at: new Date().toISOString(),
    from: previous,
    to: newEmail,
    actor: actor || 'admin',
  });
  await db.set(`analysis:${recordID}`, analysis);
  await db.audit('analysis.override', { recordID, from: previous, to: newEmail, actor });
  return analysis;
}

module.exports = {
  identifyInstructor,
  applyOverride,
  // exported for tests / debugging
  _pickModeratorFromLad: pickModeratorFromLad,
  _matchTeacherToLadModerator: matchTeacherToLadModerator,
};
