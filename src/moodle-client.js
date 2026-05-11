// Moodle Web Services client.
//
// Moodle's REST endpoint is a quirky beast:
//   - Always POST to /webservice/rest/server.php
//   - moodlewsrestformat=json and wstoken go on the querystring
//   - The function name + all function parameters go in the request body as
//     application/x-www-form-urlencoded.
//   - Array parameters must be flattened with bracket indexing, e.g.
//     options[ids][0]=1&options[ids][1]=2  (NOT options[ids][]=1).
//
// Errors come back as a 200 with a body shaped like { exception, errorcode, message }.

const axios = require('axios');
const db = require('./db');

function getConfig() {
  const base = process.env.MOODLE_BASE_URL;
  const token = process.env.MOODLE_API_TOKEN;
  if (!base || !token) {
    throw new Error('MOODLE_BASE_URL and MOODLE_API_TOKEN must be set in Replit Secrets');
  }
  return { base: base.replace(/\/+$/, ''), token };
}

// Flatten params into Moodle's bracket-indexed form.
function flatten(obj, prefix = '', out = {}) {
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    return out;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      flatten(v, prefix ? `${prefix}[${k}]` : k, out);
    }
    return out;
  }
  out[prefix] = obj;
  return out;
}

async function call(wsfunction, params = {}) {
  const { base, token } = getConfig();
  const flat = flatten(params);
  const form = new URLSearchParams();
  form.append('wsfunction', wsfunction);
  for (const [k, v] of Object.entries(flat)) form.append(k, String(v));

  const url = `${base}/webservice/rest/server.php?wstoken=${encodeURIComponent(token)}&moodlewsrestformat=json`;
  const resp = await axios.post(url, form.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 30000,
    validateStatus: () => true,
  });

  if (resp.status >= 400) {
    throw new Error(`Moodle ${wsfunction} HTTP ${resp.status}: ${JSON.stringify(resp.data)}`);
  }
  if (resp.data && typeof resp.data === 'object' && resp.data.exception) {
    throw new Error(`Moodle ${wsfunction} ${resp.data.errorcode}: ${resp.data.message}`);
  }
  return resp.data;
}

async function getCourseById(courseId) {
  const id = Number(courseId);
  if (!Number.isFinite(id)) throw new Error(`Invalid courseId: ${courseId}`);

  const data = await call('core_course_get_courses_by_field', {
    field: 'id',
    value: id,
  });
  const course = data?.courses?.[0];
  return course || null;
}

// Returns enrolled users on a course, filtered to those with a teaching role.
// Moodle role shortnames for teachers: 'editingteacher', 'teacher', 'manager'.
const TEACHER_ROLE_SHORTNAMES = new Set(['editingteacher', 'teacher', 'manager']);

async function getCourseTeachers(courseId) {
  const cacheKey = `moodle-course-cache:${courseId}`;
  const cached = await db.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < 24 * 60 * 60 * 1000) {
    return cached.teachers;
  }

  const id = Number(courseId);
  const users = await call('core_enrol_get_enrolled_users', {
    courseid: id,
    options: [
      { name: 'userfields', value: 'id,username,firstname,lastname,fullname,email,roles' },
    ],
  });

  const teachers = (Array.isArray(users) ? users : [])
    .filter(u => Array.isArray(u.roles) && u.roles.some(r => TEACHER_ROLE_SHORTNAMES.has(r.shortname)))
    .map(u => ({
      moodleUserId: u.id,
      username: u.username,
      firstName: u.firstname,
      lastName: u.lastname,
      fullName: u.fullname,
      email: u.email,
      roles: u.roles.map(r => r.shortname),
    }));

  await db.set(cacheKey, { teachers, cachedAt: Date.now() });
  return teachers;
}

async function getUserByEmail(email) {
  if (!email) return null;
  const data = await call('core_user_get_users_by_field', {
    field: 'email',
    values: [email],
  });
  const user = Array.isArray(data) ? data[0] : null;
  if (!user) return null;
  return {
    moodleUserId: user.id,
    username: user.username,
    firstName: user.firstname,
    lastName: user.lastname,
    fullName: user.fullname,
    email: user.email,
  };
}

async function getUsersByIds(ids = []) {
  if (!ids.length) return [];
  const data = await call('core_user_get_users_by_field', {
    field: 'id',
    values: ids,
  });
  return Array.isArray(data) ? data : [];
}

module.exports = {
  call,
  getCourseById,
  getCourseTeachers,
  getUserByEmail,
  getUsersByIds,
  _flatten: flatten,
};
