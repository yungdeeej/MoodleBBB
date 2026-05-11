// Preflight guardrails. Throws PreflightError with a stable code so the
// pipeline can log + skip without escalating to alerts.

const db = require('./db');

class PreflightError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function envNum(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

const MAX_RECORDING_DURATION_MIN = envNum('MAX_RECORDING_DURATION_MIN', 360);
const MAX_AUDIO_FILE_SIZE_MB = envNum('MAX_AUDIO_FILE_SIZE_MB', 500);
const MONTHLY_BUDGET_USD = envNum('MONTHLY_BUDGET_USD', 300);

function monthKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function preflight({ recording, audioSizeBytes }) {
  if (recording.durationMin && recording.durationMin > MAX_RECORDING_DURATION_MIN) {
    throw new PreflightError(
      'DURATION_EXCEEDED',
      `Recording duration ${recording.durationMin}min exceeds cap ${MAX_RECORDING_DURATION_MIN}min`,
    );
  }
  if (audioSizeBytes !== undefined) {
    const sizeMb = audioSizeBytes / (1024 * 1024);
    if (sizeMb > MAX_AUDIO_FILE_SIZE_MB) {
      throw new PreflightError(
        'AUDIO_SIZE_EXCEEDED',
        `Audio size ${sizeMb.toFixed(1)}MB exceeds cap ${MAX_AUDIO_FILE_SIZE_MB}MB`,
      );
    }
  }
  const spend = (await db.get('monthly-spend')) || { month: monthKey(), totalUsd: 0 };
  if (spend.month === monthKey() && spend.totalUsd >= MONTHLY_BUDGET_USD) {
    throw new PreflightError(
      'BUDGET_EXCEEDED',
      `Monthly Claude spend $${spend.totalUsd} has hit cap $${MONTHLY_BUDGET_USD}`,
    );
  }
  return true;
}

async function getBudgetStatus() {
  const spend = (await db.get('monthly-spend')) || { month: monthKey(), totalUsd: 0, calls: 0 };
  return {
    month: spend.month,
    totalUsd: spend.totalUsd,
    calls: spend.calls,
    budgetUsd: MONTHLY_BUDGET_USD,
    remainingUsd: Math.max(0, MONTHLY_BUDGET_USD - spend.totalUsd),
    overBudget: spend.totalUsd >= MONTHLY_BUDGET_USD,
  };
}

module.exports = {
  PreflightError,
  preflight,
  getBudgetStatus,
  MAX_RECORDING_DURATION_MIN,
  MAX_AUDIO_FILE_SIZE_MB,
  MONTHLY_BUDGET_USD,
};
