// One-time seeding for instructor profiles.
//
// Usage:
//   node scripts/seed-instructors.js [path-to-json]
//
// JSON file shape (array):
// [
//   {
//     "email": "jane.smith@mcgcollege.ca",
//     "name": "Jane Smith",
//     "moodleUserId": 12345,
//     "campus": "calgary",
//     "programs": ["CC101"],
//     "status": "active"
//   }
// ]
//
// If no path is given, the script seeds a small example set so the dashboard
// shows something useful right after import.

const fs = require('fs');
const path = require('path');
const db = require('../src/db');

const DEFAULT_SEED = [
  {
    email: 'jane.smith@mcgcollege.ca',
    name: 'Jane Smith',
    moodleUserId: 12345,
    campus: 'calgary',
    programs: ['CC101'],
    status: 'active',
  },
  {
    email: 'aaron.lee@mcgcollege.ca',
    name: 'Aaron Lee',
    moodleUserId: 12346,
    campus: 'edmonton',
    programs: ['BUS200'],
    status: 'active',
  },
];

function loadSeed() {
  const arg = process.argv[2];
  if (!arg) return DEFAULT_SEED;
  const abs = path.isAbsolute(arg) ? arg : path.resolve(process.cwd(), arg);
  if (!fs.existsSync(abs)) {
    console.error(`Seed file not found: ${abs}`);
    process.exit(1);
  }
  const data = JSON.parse(fs.readFileSync(abs, 'utf8'));
  if (!Array.isArray(data)) {
    console.error('Seed file must export a JSON array of instructor objects.');
    process.exit(1);
  }
  return data;
}

(async function main() {
  const records = loadSeed();
  console.log(`Seeding ${records.length} instructor(s)...`);
  for (const r of records) {
    if (!r.email) {
      console.warn('Skipping record without email:', r);
      continue;
    }
    const key = `instructor:${r.email.toLowerCase()}`;
    const existing = await db.get(key);
    const merged = {
      ...(existing || {}),
      ...r,
      email: r.email.toLowerCase(),
      status: r.status || 'active',
      createdAt: existing?.createdAt || new Date().toISOString(),
      seededAt: new Date().toISOString(),
    };
    await db.set(key, merged);
    console.log(`  ✓ ${merged.email} (${merged.name})`);
  }
  await db.audit('seed.instructors', { count: records.length });
  console.log('Done.');
})().catch(err => {
  console.error('Seed failed:', err);
  process.exit(1);
});
