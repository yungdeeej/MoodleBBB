# MCG Career College — Instructor Performance Management System
## Complete Replit Build Specification

---

## PROJECT OVERVIEW

Build an automated instructor performance management system for MCG Career College that:

1. Pulls class recordings from BigBlueButton (BBB) via API
2. Transcribes audio using Deepgram
3. Analyzes instructor performance using Claude Sonnet 4.5 with chunked analysis
4. Combines transcript-derived insights with BBB Learning Analytics Dashboard (LAD) data
5. Identifies the instructor via the BBB moderator flag (the moderator IS the instructor at MCG)
6. Produces formal performance management reports with evidentiary defensibility
7. Stores everything in Replit Database
8. Fires alerts to Dean of Operations and Academic Director when thresholds are breached
9. Provides a dashboard for review and trend analysis

This system is used for **formal performance management** — outputs must be defensible in labour relations proceedings.

---

## ARCHITECTURE OVERVIEW

```
BBB Server → [analytics-callback] → Replit App → LAD JSON stored
BBB Server → [getRecordings API polling] → Replit App
                                              ↓
                                         Download .ogg audio
                                              ↓
                                      Deepgram (diarized transcript)
                                              ↓
                                Identify instructor from LAD moderator flag
                                              ↓
                                  Chunk transcript into 20-min segments
                                              ↓
                            Parallel Claude analysis of each chunk
                                              ↓
                          Synthesis pass (combines chunks + LAD)
                                              ↓
                        Final performance report → Replit DB
                                              ↓
                          Alerts (Email/Slack) if thresholds breached
                                              ↓
                                    Dashboard for review
```

---

## REQUIRED REPLIT SECRETS

Add these in Replit's Secrets panel before running:

| Secret Key | Description | Example |
|---|---|---|
| `BBB_URL` | BBB server URL (without `/api`) | `https://bbb.mcgcollege.ca/bigbluebutton/` |
| `BBB_SECRET` | Shared secret from `bbb-conf --secret` | `ECCJZNJWLPEA3YB6Y2LTQGQD3GJZ3F93` |
| `ANTHROPIC_API_KEY` | Claude API key | `sk-ant-...` |
| `DEEPGRAM_API_KEY` | Deepgram transcription | `<your key>` |
| `MOODLE_BASE_URL` | Moodle URL (for instructor profile enrichment) | `https://learn.mcgcollege.ca` |
| `MOODLE_API_TOKEN` | Moodle web services token | `<token>` |
| `ADMIN_EMAIL` | Dean of Ops email for alerts | `dj@mcgcollege.ca` |
| `ACADEMIC_DIRECTOR_EMAIL` | Academic Director email | `<email>` |
| `SLACK_WEBHOOK_URL` | Optional — for instant alerts | `https://hooks.slack.com/...` |
| `SMTP_USER` | Gmail/SMTP user for email alerts | `qa-system@mcgcollege.ca` |
| `SMTP_PASS` | Gmail App Password | `<app password>` |
| `MCG_INSTITUTION_NAME` | For report branding | `MCG Career College` |
| `ALERT_THRESHOLD_SCORE` | Auto-flag below this score | `2.5` |
| `MIN_DURATION_VARIANCE_PCT` | Flag classes cut short by this % | `-15` |
| `MAX_RECORDING_DURATION_MIN` | Safety cap | `360` |
| `MONTHLY_BUDGET_USD` | Hard stop for Claude spend | `300` |

---

## BBB SERVER CONFIGURATION (Done by BBB Admin, One-Time)

These three lines must be added to `/etc/bigbluebutton/bbb-web.properties` on the BBB server, then `sudo bbb-conf --restart`:

```properties
defaultKeepEvents=true
learningDashboardCleanupDelayInMinutes=0
defaultMetaAnalyticsCallbackUrl=https://[your-replit-app-url]/api/lad-callback
```

This enables:
- Persistent meeting event data
- Permanent Learning Dashboard data retention
- Automatic LAD JSON push to our Replit app when each meeting ends

---

## MOODLE CONFIGURATION (Done by Moodle Admin, One-Time)

1. **Enable Moodle Web Services:**
   - Site administration → Server → Web services → Overview
   - Enable web services + REST protocol
   - Create dedicated user `mcg-qa-system`
   - Create external service "MCG Instructor QA" with these functions:
     - `core_course_get_courses_by_field`
     - `core_enrol_get_enrolled_users`
     - `core_user_get_users_by_field`
   - Assign user to service, generate token

2. **BBB Plugin Settings (Site administration → Plugins → Activity modules → BigBlueButton → Recording):**
   - Recording enabled by default: **Yes**
   - Session can be recorded editable: **No** (mandatory recording for QA)
   - Start recording from the beginning: **Yes**
   - Start recording from the beginning editable: **No**
   - Recording refresh period: **60** seconds (faster new recording detection)

---

## PROJECT STRUCTURE

```
/
├── index.js                          # Express server + cron scheduler
├── package.json
├── .replit
├── /src
│   ├── bbb-client.js                 # BBB API integration (checksum, getRecordings)
│   ├── moodle-client.js              # Moodle web services API
│   ├── pipeline.js                   # Orchestrates full analysis flow
│   ├── transcription.js              # Deepgram integration with diarization
│   ├── chunker.js                    # Transcript chunking logic
│   ├── analyzer.js                   # Claude API calls (chunk + synthesis)
│   ├── instructor-mapping.js         # Maps LAD moderator → MCG instructor
│   ├── db.js                         # Replit DB wrapper
│   ├── alerting.js                   # Email + Slack alerts
│   ├── safety-rails.js               # Budget and resource guardrails
│   └── prompts/
│       ├── chunk-analysis.js         # Per-chunk evidence extraction prompt
│       ├── synthesis.js              # Final report synthesis prompt
│       └── trend-summary.js          # Quarterly cross-session analysis
├── /public
│   ├── dashboard.html                # React dashboard
│   └── admin-override.html           # Manual instructor mapping fixes
├── /scripts
│   └── seed-instructors.js           # One-time instructor seeding
└── /reports                          # Generated PDF reports per session
```

---

## REPLIT DB SCHEMA (Key Conventions)

| Key Pattern | Contains |
|---|---|
| `recording:{recordID}` | BBB recording metadata snapshot |
| `lad:{internalMeetingID}` | Raw LAD JSON from BBB callback |
| `transcript:{recordID}` | Cleaned diarized transcript with confidence |
| `chunk-analyses:{recordID}` | Array of per-chunk Claude analyses |
| `analysis:{recordID}` | Final synthesized report |
| `instructor:{email}` | Instructor profile |
| `instructor-history:{email}` | Array of {recordID, score, date, tier} for trending |
| `session-log:{recordID}` | Processing status, errors, timestamps |
| `alert-log:{recordID}` | Whether alerts have been fired |
| `processed-ids` | Set of all processed recordIDs (dedup) |
| `moodle-course-cache:{courseId}` | Cached Moodle course teacher data (24h TTL) |
| `monthly-spend` | Running Claude API spend total |
| `config:weights` | Dimension scoring weights |
| `config:thresholds` | Alert thresholds |

**Storage strategy:**
- Audio files: process in `/tmp`, delete after transcription (200MB+, never goes to DB)
- Raw transcripts: store gzipped if needed
- Final reports: ~8KB each, fine for Replit DB
- LAD JSON: 5-20KB per session, fine for Replit DB

---

## CORE COMPONENT SPECIFICATIONS

### 1. BBB API Client (`src/bbb-client.js`)

Build a BBB API client that:

- Generates SHA-1 checksums per BBB security model: `sha1(callName + queryString + sharedSecret)`
- Implements `getRecordings` with pagination (offset, limit ≤ 100)
- Normalizes recording metadata, extracting:
  - `playbackUrl` (presentation format `.mp4`)
  - `audioUrl` (podcast format `.ogg` — preferred for transcription, 85% smaller)
  - All `meta_` parameters from `metadata` object
  - Especially: `bbb-context`, `bbb-context-name`, `bbb-context-id`, `bbb-recording-name`, `bbb-recording-tags`
- Provides `getNewRecordings(processedIds)` that filters out already-processed
- Uses `xml2js` for parsing BBB's XML responses

### 2. Moodle Web Services Client (`src/moodle-client.js`)

Build a Moodle API client that:

- Calls `https://{MOODLE_BASE_URL}/webservice/rest/server.php` with REST protocol
- Properly flattens array parameters per Moodle's quirky format (`courseids[0]=1&courseids[1]=2`)
- Provides:
  - `getCourseById(courseId)` — fetch course details
  - `getCourseTeachers(courseId)` — list editing teachers with capability `mod/bigbluebuttonbn:addinstance`
  - `getUserByEmail(email)` — resolve user from email

### 3. Instructor Mapping (`src/instructor-mapping.js`)

This is where it gets clever. The instructor is identified through a priority cascade:

**Priority 1: LAD moderator flag (most authoritative)**
- LAD JSON contains an `attendees` array with `moderator: true/false`
- The single attendee with `moderator: true` is the instructor
- Use their `name` and `ext_user_id` to match against Moodle/instructor profiles

**Priority 2: Moodle web services lookup (fallback)**
- Recording metadata contains `bbb-context` (Moodle course ID)
- Query Moodle for editing teachers of that course
- If single teacher → that's the instructor
- If multiple teachers → use disambiguation logic

**Priority 3: Auto-create stub profile**
- If instructor not in Replit DB, auto-create with `status: 'needs-review'`
- Flag for admin to enrich profile later
- Pipeline continues without blocking

**Output structure:**
```javascript
{
  email: 'jane.smith@mcgcollege.ca',
  name: 'Jane Smith',
  moodleUserId: 12345,
  campus: 'calgary',
  programs: ['CC101'],
  status: 'active', // or 'needs-review'
  currentSession: {
    moodleCourseId: 42,
    courseName: 'CC101 - Medical Office Foundations',
    courseShortname: 'cc101',
    sessionTopic: 'Module 4 Live Session',
    sessionDescription: '...',
    bbbActivityName: '...',
    scheduledDurationMin: 240,
    campus: 'calgary',
    moodleMetadata: { ... }
  }
}
```

### 4. Transcription (`src/transcription.js`)

Use Deepgram Nova-3 with these settings:
- `model: 'nova-3'`
- `smart_format: true`
- `diarize: true`
- `punctuate: true`
- `utterances: true`
- `language: 'en'`
- `filler_words: true` (critical for filler word counting)

Post-process:
- Identify likely instructor (most cumulative talk time)
- Relabel speaker as "INSTRUCTOR" — but **only after** cross-checking with LAD moderator flag
- Format timestamps as `[HH:MM:SS]`
- Calculate overall confidence percentage
- Return `{ transcript, confidence }`

### 5. Chunker (`src/chunker.js`)

Split transcript into 20-minute segments:
- Each chunk: ~15-20 minutes of content
- Include 30 seconds of overlap between chunks (avoid cutting mid-thought)
- For a 4-hour class: produces 12-13 chunks
- Each chunk roughly 4-6KB of text (~3000-5000 tokens)
- Tag each chunk with start/end timestamp and index

Output: `Array<{ chunk_index, start_time, end_time, content }>`

### 6. Chunk Analysis Prompt (`src/prompts/chunk-analysis.js`)

```
SYSTEM PROMPT:

You are analyzing a 20-minute segment of an MCG Career College class for evidence of instructor performance. You are NOT producing a final report — your job is to extract observable evidence with timestamps.

For this segment, identify and return JSON only (no markdown, no preamble):

{
  "chunk_index": number,
  "time_range": "HH:MM:SS - HH:MM:SS",
  "observations": [
    {
      "timestamp": "HH:MM:SS",
      "quote_or_action": "Direct quote or observed behavior",
      "dimensions_evidenced": [1, 3, 4],
      "valence": "positive | negative | neutral",
      "confidence": "high | medium | low"
    }
  ],
  "chunk_metrics": {
    "instructor_words": number,
    "student_words": number,
    "questions_by_instructor": number,
    "questions_by_students": number,
    "filler_words_count": number,
    "filler_words_breakdown": { "um": 0, "uh": 0, "like": 0, "you_know": 0, "other": 0 },
    "student_names_used": ["string"],
    "longest_monologue_seconds": number,
    "interactive_elements_observed": ["string"]
  },
  "potential_red_flags": [
    { "type": "string", "quote": "string", "timestamp": "HH:MM:SS", "severity": "Critical | High | Medium" }
  ],
  "topic_summary": "One sentence on what was taught in this segment"
}

DIMENSIONS (reference for dimensions_evidenced array):
1. Class Structure & Preparation
2. Content Delivery & Accuracy
3. Student Engagement
4. Communication Quality
5. Classroom Management
6. Inclusivity & Professionalism
7. Assessment & Feedback
8. Compliance & Deliverables

Rules:
- Only include observations with high evidentiary value
- Skip filler/transition moments — focus on signal
- Flag ANY potentially discriminatory, harassing, or inappropriate language as a red flag, regardless of context
- Do not score yet — that's a later step
- Return ONLY valid JSON
```

### 7. Synthesis Prompt (`src/prompts/synthesis.js`)

```
SYSTEM PROMPT:

You are an expert instructional design auditor evaluating live online class recordings for MCG Career College, a private licensed career college operating in Alberta, Canada under PSL (Private Vocational Training Act) and IRCC DLI compliance frameworks.

Your assessments are used as one input into FORMAL PERFORMANCE MANAGEMENT decisions affecting instructor employment. Every conclusion you draw must be defensible in a labour relations or wrongful dismissal proceeding. Treat this as an evidentiary document, not a coaching note.

EVIDENTIARY STANDARDS:

1. NO CONCLUSION WITHOUT EVIDENCE. Every score must cite at least one specific timestamped quote or observation from the provided chunk analyses. Where a dimension cannot be assessed due to data quality, mark it null and explain why.

2. DISTINGUISH OBSERVATION FROM INFERENCE. State what was said/done literally before drawing inference. "Instructor said 'any questions?' at 14:32 and waited 1 second before continuing" is observation. "Instructor did not provide adequate wait time" is inference. Show both.

3. AVOID PERSONALITY JUDGMENTS. Do not assess the instructor's character, intent, attitude, or motivation. Assess only observable teaching behaviours. Replace "instructor seems disengaged" with "instructor's tone variation was monotone for an 18-minute segment (12:00–30:00) with no questions posed to students."

4. NEVER INFER FROM AUDIO QUALITY. Accent, dialect, transcription errors, or audio artifacts MUST NOT lower a score. If transcription quality is below 90% confidence, flag the dimension as inconclusive.

5. APPLY THE SAME STANDARD TO ALL INSTRUCTORS. Do not adjust scores based on instructor name, demographic markers, or inferred identity.

6. USE LAD DATA AUTHORITATIVELY. The Learning Analytics Dashboard data is authoritative for quantitative metrics. Use those numbers verbatim — do not re-estimate from transcript.

EVALUATION FRAMEWORK:

Score the instructor across 8 dimensions on a 1-5 scale:
- 1 = Critical Concern (immediate intervention required)
- 2 = Below Standard (formal improvement plan warranted)
- 3 = Meets Standard (acceptable performance)
- 4 = Exceeds Standard (strong performance, worth recognizing)
- 5 = Exemplary (model practice, worth replicating)

DIMENSIONS:

1. CLASS STRUCTURE & PREPARATION
   - Were learning objectives stated within the first 5 minutes?
   - Was a clear agenda or roadmap provided?
   - Were materials referenced organized and accessible?
   - Did the instructor signal transitions between topics?

2. CONTENT DELIVERY & ACCURACY
   - Command of subject matter (evidenced by ability to elaborate, give examples, answer questions accurately)
   - Factual accuracy — flag any statements that appear factually incorrect (note: only flag if high confidence; otherwise note as "requires SME verification")
   - Depth appropriate to a career college diploma-level audience
   - Connection of content to practical career applications

3. STUDENT ENGAGEMENT
   - Use LAD data: activity scores, talk time distribution, raise hand counts, poll participation
   - Number of questions posed to students by instructor
   - Average wait time after questions (in seconds, estimated)
   - Use of student names (count occurrences)
   - Distribution of speaking opportunities across students
   - Use of interactive elements (polls, breakouts, whiteboard, chat references)

4. COMMUNICATION QUALITY
   - Estimated words per minute (target range: 130-160 for instruction)
   - Filler word frequency per minute (um, uh, like, you know, sort of, basically)
   - Clarity of explanations
   - Vocal variety and pacing

5. CLASSROOM MANAGEMENT
   - Handling of late arrivals (use LAD join timestamps)
   - Off-topic redirection
   - Tech issue handling
   - Time management — actual vs scheduled duration

6. INCLUSIVITY & PROFESSIONALISM
   - Respectful language toward all students
   - Equitable distribution of attention across speaking students (use LAD talk time data)
   - Absence of language that could constitute harassment, discrimination, or bias under the Alberta Human Rights Act
   - Flag any potential HR concerns separately in red_flags

7. ASSESSMENT & FEEDBACK
   - Frequency of checks for understanding (CFU)
   - Quality of feedback on student responses (specific vs generic)
   - Reinforcement of correct answers
   - Constructive correction of misconceptions
   - Use of polls/quizzes (LAD will show poll vote counts)

8. COMPLIANCE & DELIVERABLES
   - Verbal acknowledgment of attendance/students present
   - Recording disclosure mentioned at start (PIPEDA/PIPA requirement)
   - Coverage of syllabus topic for the session (if provided)
   - On-time start (within 5 min of scheduled — use LAD start time)
   - On-time end (within 10 min of scheduled — use LAD finish time)

INPUTS YOU WILL RECEIVE:
- Recording metadata (instructor name, course code, session topic, scheduled/actual duration)
- 12+ chunk-level evidence reports from the same class
- LAD JSON with authoritative engagement metrics
- Optional: instructor's prior session scores (for trend context only — do not let this bias the current assessment)
- Optional: lesson plan or syllabus excerpt for the day

OUTPUT FORMAT:

Return ONLY valid JSON. No preamble, no markdown code fences, no commentary outside the JSON object.

{
  "session_meta": {
    "instructor_name": "string",
    "instructor_email": "string",
    "course_code": "string",
    "course_name": "string",
    "session_topic": "string",
    "session_date": "YYYY-MM-DD",
    "campus": "string",
    "scheduled_duration_min": number,
    "actual_duration_min": number,
    "duration_variance_pct": number,
    "duration_variance_flag": "On Time | Cut Short | Ran Over",
    "participant_count": number,
    "active_speakers_count": number,
    "transcript_confidence_pct": number,
    "lad_data_available": boolean
  },
  "overall_score": number,
  "performance_tier": "Critical Concern | Below Standard | Meets Standard | Exceeds Standard | Exemplary",
  "tldr": "Two-sentence executive summary suitable for Dean's dashboard. State the tier and the single most important finding.",
  "dimensions": [
    {
      "id": 1,
      "name": "Class Structure & Preparation",
      "score": number | null,
      "score_rationale": "One-paragraph explanation citing evidence",
      "evidence": [
        {
          "timestamp": "HH:MM:SS",
          "observation": "Direct quote or specific behavior observed",
          "inference": "What this evidences about the dimension",
          "type": "positive | negative | neutral",
          "source": "transcript | LAD"
        }
      ],
      "data_quality_caveat": "string or null"
    }
    // ... repeat for all 8 dimensions
  ],
  "quantitative_metrics": {
    "instructor_talk_time_pct": number,
    "student_talk_time_pct": number,
    "silence_pct": number,
    "estimated_words_per_minute": number,
    "filler_word_count": number,
    "filler_word_rate_per_min": number,
    "filler_words_detail": { "um": 0, "uh": 0, "like": 0, "you_know": 0, "other": 0 },
    "questions_asked_by_instructor": number,
    "questions_asked_by_students": number,
    "unique_students_who_spoke": number,
    "student_participation_equity_ratio": number,
    "longest_uninterrupted_monologue_min": number,
    "use_of_student_names_count": number,
    "interactive_elements_used": ["string"],
    "breaks_taken_count": number,
    "total_break_duration_min": number,
    "lad_metrics": {
      "average_activity_score": number,
      "students_with_low_engagement": number,
      "raise_hand_total": number,
      "emoji_reactions_total": number,
      "poll_votes_total": number,
      "chat_messages_total": number
    }
  },
  "strengths": [
    {
      "strength": "Specific evidence-based strength",
      "evidence_timestamp": "HH:MM:SS",
      "dimension_id": number
    }
  ],
  "areas_for_improvement": [
    {
      "issue": "Behavior-focused description of the issue",
      "evidence_timestamp": "HH:MM:SS",
      "evidence_quote": "Direct quote or description",
      "coaching_recommendation": "Specific actionable next step",
      "priority": "High | Medium | Low",
      "dimension_id": number
    }
  ],
  "red_flags": [
    {
      "type": "HR Concern | Compliance Violation | Factual Accuracy | Student Wellbeing | Other",
      "description": "Factual description of what was observed",
      "evidence_quote": "Direct quote",
      "timestamp": "HH:MM:SS",
      "severity": "Critical | High | Medium",
      "recommended_review_by": "HR | Academic Director | Dean of Ops | Compliance Officer",
      "requires_immediate_review": boolean
    }
  ],
  "content_coverage": {
    "topics_covered": ["string"],
    "topics_skipped_vs_syllabus": ["string"],
    "depth_assessment": "Surface | Adequate | Thorough",
    "syllabus_alignment_pct": number,
    "syllabus_provided": boolean
  },
  "recommended_actions": [
    {
      "action": "Specific actionable recommendation",
      "owner": "Instructor | Academic Director | Dean of Operations | HR",
      "urgency": "Immediate (24h) | This Week | This Term | Next Review Cycle",
      "performance_management_relevance": "None | Document for File | Coaching Conversation | Formal PIP | Disciplinary Review"
    }
  ],
  "confidence_in_assessment": "High | Medium | Low",
  "confidence_caveats": "Explanation of any factors that limit the reliability of this assessment",
  "instructor_right_of_reply_notes": "Auto-generated note: This assessment is one data point and should be reviewed with the instructor before any formal action. The instructor has the right to provide context, dispute specific findings, and respond in writing prior to performance management decisions."
}

CRITICAL RULES:

- If transcript confidence is below 80% for a dimension, set its score to null and explain in data_quality_caveat. Do not score what you cannot reliably assess.
- Never invent evidence. If you can't find evidence for a claim, do not make the claim.
- A single excellent or poor moment is not sufficient evidence for an extreme score. Look for patterns across chunks.
- Flag any potential harassment, discrimination, slurs, or bias as a red_flag with requires_immediate_review: true regardless of overall score.
- Be honest, not flattering. The Dean needs accurate signal for personnel decisions.
- Be honest, not punitive. If the instructor is doing well, say so clearly. Strong performance documentation matters as much as weak performance documentation.
- Never assess based on accent, dialect, or speech patterns that don't materially impair student comprehension.
- If you would not be willing to defend a finding in a tribunal hearing, do not include it.
- Use LAD data verbatim for quantitative_metrics. Only fall back to transcript estimation when LAD is unavailable.
```

### 8. Analyzer (`src/analyzer.js`)

Two-stage analysis using Claude Sonnet 4.5 (model: `claude-sonnet-4-5-20250929`):

**Stage 1: Parallel chunk analysis**
- Send all 12+ chunks to Claude in parallel using `Promise.all`
- Each call: ~3K input tokens, ~1K output tokens, ~$0.012 per chunk
- Returns array of structured chunk analyses

**Stage 2: Synthesis**
- Single Claude call with:
  - All chunk analyses combined
  - LAD JSON data
  - Recording metadata
  - Instructor profile + prior scores
- ~15K input tokens, ~3K output tokens, ~$0.08
- Returns final performance management report

**Total per class:** ~$0.20-0.45 depending on length

Always strip markdown fences before JSON parsing. Validate JSON structure before storing.

### 9. Pipeline Orchestration (`src/pipeline.js`)

```
async function processRecording(recording):
  1. Check if already processed (skip if yes)
  2. Run preflight safety checks (duration, budget)
  3. Wait for LAD data (poll DB for up to 5 minutes if not yet received)
  4. Identify instructor (LAD moderator → Moodle fallback → auto-stub)
  5. Download .ogg audio to /tmp
  6. Transcribe via Deepgram
  7. Chunk transcript
  8. Run parallel chunk analyses
  9. Run synthesis pass with LAD + chunks
  10. Store final report in Replit DB
  11. Update instructor history
  12. Fire alerts if thresholds breached
  13. Clean up /tmp files
  14. Mark as processed

async function runFullSync():
  1. Get processed IDs from DB
  2. Call getNewRecordings()
  3. Process one at a time (no parallelism — memory constraint)
  4. Log errors but continue with next recording
```

### 10. Express Server + Endpoints (`index.js`)

```
POST /api/lad-callback         # BBB pushes LAD JSON when meeting ends
POST /api/sync                 # Manual sync trigger
GET  /api/analyses             # List all analyses
GET  /api/analysis/:recordID   # Single analysis detail
GET  /api/instructor/:email/history  # Instructor trend data
GET  /api/needs-review         # Instructors with stub profiles
POST /api/admin/override       # Manual instructor mapping fix
GET  /dashboard                # Serve dashboard.html
GET  /admin-override           # Serve admin-override.html
```

**Cron schedule:** Every 2 hours, run `runFullSync()`

### 11. LAD Callback Handler (`POST /api/lad-callback`)

When BBB sends the LAD JSON callback (after meeting ends):

```javascript
app.post('/api/lad-callback', express.json({ limit: '10mb' }), async (req, res) => {
  const { meeting_id, internal_meeting_id, data } = req.body;
  
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
    received_at: new Date().toISOString()
  });
  
  res.json({ received: true });
});
```

The LAD JSON contains the authoritative moderator identification:
```json
{
  "attendees": [
    {
      "ext_user_id": "...",
      "name": "Jane Smith",
      "moderator": true,  // THIS IS THE INSTRUCTOR
      "joins": [...],
      "leaves": [...],
      "duration": 14400,
      "engagement": { ... }
    }
  ]
}
```

### 12. Alerting (`src/alerting.js`)

**Threshold-based alerts:**

| Condition | Severity | Recipients |
|---|---|---|
| `overall_score < 2.5` | High | Dean + Academic Director |
| Any `red_flag.requires_immediate_review: true` | Critical | Dean + Academic Director + HR |
| `duration_variance_pct < -15%` | Medium | Dean |
| `student_talk_time_pct < 5%` | Medium | Dean |
| LAD `unique_students_who_spoke / participant_count < 0.2` | Medium | Dean |
| `filler_word_rate_per_min > 8` | Low (coaching opportunity) | Dean |
| 3 consecutive sessions below standard | High (PIP trigger) | Dean + Academic Director |

**Channels:** Slack webhook + Email (Gmail App Password)

### 13. Safety Rails (`src/safety-rails.js`)

```
MAX_RECORDING_DURATION_MIN = 360  // 6 hrs — anything longer is anomalous
MAX_AUDIO_FILE_SIZE_MB = 500
MONTHLY_BUDGET_USD = 300  // hard stop for Claude API spend

Preflight checks before processing:
- Duration within limits
- Audio file size within limits
- Monthly Claude spend not yet exceeded
- Throw early to skip recording if any check fails
```

### 14. Dashboard (`public/dashboard.html`)

React-based dashboard showing:
- **Overview:** Recent sessions, scores, alerts
- **Instructor list:** Sortable by score, campus, course
- **Instructor detail:** Trend chart, all sessions, drill-down to individual reports
- **Session detail:** Full report with evidence timestamps, dimension breakdown
- **Needs-review queue:** Auto-created instructor stubs awaiting admin enrichment
- **Alerts log:** Historical alerts with status (acknowledged/resolved)

Use Recharts for trend visualization. Use TailwindCSS for styling.

---

## SCORING WEIGHTS (Post-Processing, Customizable)

Apply these weights after Claude returns raw dimension scores:

| Dimension | Weight |
|---|---|
| Content Delivery & Accuracy | 20% |
| Student Engagement | 18% |
| Communication Quality | 15% |
| Class Structure | 12% |
| Assessment & Feedback | 12% |
| Classroom Management | 10% |
| Inclusivity & Professionalism | 8% |
| Compliance & Deliverables | 5% |

`overall_score = Σ(dimension_score × weight)`

---

## PACKAGE.JSON

```json
{
  "name": "mcg-instructor-qa",
  "version": "1.0.0",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "seed": "node scripts/seed-instructors.js"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.30.1",
    "@deepgram/sdk": "^3.9.0",
    "@replit/database": "^3.0.0",
    "axios": "^1.7.0",
    "express": "^4.21.0",
    "node-cron": "^3.0.3",
    "nodemailer": "^6.9.15",
    "xml2js": "^0.6.2"
  }
}
```

---

## COMPLIANCE & RISK GUARDRAILS

Build these into the system from day one — non-negotiable for formal performance management use:

### 1. Consent Disclosure
Build a `consent-template.md` file in the repo with sample policy language for:
- Instructor employment contract addendum (AI-assisted performance review disclosure)
- Student recording consent (AI processing of recordings under PIPEDA/PIPA)
- Verbal disclosure script for first class of term

### 2. Right of Reply Workflow
Every report must include the `instructor_right_of_reply_notes` field. Build a separate UI endpoint where:
- Instructor can view their own reports
- Instructor can submit a written response per report
- Responses are stored and shown alongside the AI report in any HR view

### 3. Human-in-the-Loop Enforcement
Policy: No score below threshold may trigger automatic discipline. Alerts trigger human review, not action.

### 4. Bias Audit Hook
Add a `/api/audit/bias` endpoint that aggregates scores by instructor name/demographic. Run quarterly.

### 5. Retention Policy
Set 7-year retention on all reports (Alberta employment standards minimum). Add scheduled job to flag data older than retention for review.

### 6. Audit Log
Every read/write to instructor reports must be logged with: timestamp, user (or system), action, recordID. Store as `audit-log:{timestamp}-{random}`.

---

## TESTING PLAN (Run Before Production)

1. **Test BBB credentials:**
   - Hit `getMeetings` endpoint, verify response
   - Hit `getRecordings`, verify normalization

2. **Test Moodle web services:**
   - Call `core_course_get_courses_by_field`, verify token works
   - Call `core_enrol_get_enrolled_users`, verify teacher list returned

3. **Test LAD callback (after BBB admin config done):**
   - Run a 5-minute test class
   - End meeting
   - Check Replit logs for callback received within 30 seconds
   - Verify `lad:{internalMeetingID}` exists in DB

4. **Test full pipeline with one recording:**
   - Manually trigger sync: `curl -X POST https://your-app.repl.co/api/sync`
   - Verify each pipeline stage logs success
   - Check final report at `/api/analyses`
   - Validate instructor identified correctly via LAD moderator flag

5. **Test alerting:**
   - Manually set a test instructor's score to 1.5
   - Verify Slack and email alerts fire
   - Confirm Dean + Academic Director receive critical-flag alerts

6. **Test dashboard:**
   - View overview, drill into a session
   - Filter by instructor, campus, score range
   - Verify trend chart renders historical data

---

## COST ESTIMATE (Per Month at MCG Scale)

Assuming 30 instructors × 4 classes/week × 4 weeks = 480 classes/month, avg 2hr each:

| Item | Monthly Cost |
|---|---|
| Deepgram (Nova-3, ~$0.0043/min × 480 hrs) | ~$124 |
| Claude Sonnet 4.5 (480 × $0.30 avg) | ~$144 |
| Replit Core/Teams | $20–35 |
| Email (Gmail/SMTP free) | $0 |
| **Total** | **~$290–305/month** |

---

## WHAT I NEED YOU TO BUILD (Order of Priority)

1. `src/bbb-client.js` — BBB API client with checksum + getRecordings
2. `src/moodle-client.js` — Moodle web services wrapper
3. `src/db.js` — Replit DB wrapper
4. `src/instructor-mapping.js` — LAD-moderator-first identity resolution
5. `src/transcription.js` — Deepgram diarized transcription
6. `src/chunker.js` — 20-min transcript chunking
7. `src/prompts/chunk-analysis.js` — Chunk analysis prompt (per spec above)
8. `src/prompts/synthesis.js` — Synthesis prompt (per spec above)
9. `src/analyzer.js` — Two-stage Claude analysis
10. `src/pipeline.js` — Full orchestration
11. `src/alerting.js` — Email + Slack alerts
12. `src/safety-rails.js` — Budget + resource guardrails
13. `index.js` — Express server + cron + endpoints
14. `package.json` — Dependencies
15. `scripts/seed-instructors.js` — One-time seeding script
16. `public/dashboard.html` — React dashboard
17. `public/admin-override.html` — Manual instructor mapping fix UI
18. `consent-template.md` — Compliance language templates

Build everything to be production-ready, with proper error handling, logging, and graceful degradation when LAD data isn't available (fall back to Moodle + transcript only).

Use ES modules or CommonJS — pick one and stay consistent. Use async/await throughout, no callbacks. Comment liberally so future me can debug at 2am.

---

## POST-BUILD CHECKLIST

Before going live:

- [ ] BBB admin has applied the 3 config lines and restarted BBB
- [ ] Moodle web services enabled with all 4 functions
- [ ] Moodle BBB plugin settings locked down (recording mandatory)
- [ ] All Replit secrets configured
- [ ] Instructor seed data loaded
- [ ] Test recording processed end-to-end successfully
- [ ] Email alerts received successfully
- [ ] Dashboard renders correctly
- [ ] Consent language reviewed by legal/HR
- [ ] Instructor notification of AI-assisted QA sent
- [ ] Right of reply workflow tested
- [ ] Bias audit endpoint working
- [ ] First quarterly review scheduled

---

End of build specification. Build everything above. Ask for clarification if any spec is ambiguous; otherwise produce all files and code in full, production-ready form.
