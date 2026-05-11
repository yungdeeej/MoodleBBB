// Post-processing weights from README. Apply after Claude returns the raw
// per-dimension scores so weights stay editable without prompt changes.

const DEFAULT_WEIGHTS = {
  1: 0.12, // Class Structure & Preparation
  2: 0.20, // Content Delivery & Accuracy
  3: 0.18, // Student Engagement
  4: 0.15, // Communication Quality
  5: 0.10, // Classroom Management
  6: 0.08, // Inclusivity & Professionalism
  7: 0.12, // Assessment & Feedback
  8: 0.05, // Compliance & Deliverables
};

function tierFromScore(score) {
  if (score === null || score === undefined || Number.isNaN(score)) return 'Insufficient Data';
  if (score < 1.5) return 'Critical Concern';
  if (score < 2.5) return 'Below Standard';
  if (score < 3.5) return 'Meets Standard';
  if (score < 4.5) return 'Exceeds Standard';
  return 'Exemplary';
}

function applyScoringWeights(analysis, weights = DEFAULT_WEIGHTS) {
  if (!analysis || !Array.isArray(analysis.dimensions)) return analysis;
  let weightedSum = 0;
  let weightApplied = 0;
  for (const d of analysis.dimensions) {
    const w = weights[d.id];
    if (typeof d.score === 'number' && typeof w === 'number') {
      weightedSum += d.score * w;
      weightApplied += w;
    }
  }
  if (weightApplied > 0) {
    const overall = Math.round((weightedSum / weightApplied) * 100) / 100;
    analysis.overall_score = overall;
    analysis.performance_tier = tierFromScore(overall);
    analysis._scoring_meta = {
      method: 'weighted',
      weights,
      weight_applied: weightApplied,
    };
  }
  return analysis;
}

module.exports = {
  DEFAULT_WEIGHTS,
  applyScoringWeights,
  tierFromScore,
};
