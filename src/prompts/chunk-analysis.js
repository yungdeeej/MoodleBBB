// Chunk-level analysis prompt. Per README, this prompt's job is evidence
// extraction with timestamps — NOT scoring. Output is strict JSON only.

const SYSTEM_PROMPT = `You are analyzing a 20-minute segment of an MCG Career College class for evidence of instructor performance. You are NOT producing a final report — your job is to extract observable evidence with timestamps.

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
- Return ONLY valid JSON`;

function buildUserMessage({ chunk, sessionMeta }) {
  return [
    `SESSION META:`,
    JSON.stringify(sessionMeta || {}, null, 2),
    ``,
    `CHUNK ${chunk.chunk_index} (${chunk.start_time} - ${chunk.end_time}):`,
    chunk.content,
    ``,
    `Return JSON only.`,
  ].join('\n');
}

module.exports = {
  SYSTEM_PROMPT,
  buildUserMessage,
};
