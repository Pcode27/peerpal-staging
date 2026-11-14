'use strict';

// Single source of truth for which Groq model each AI task uses.
//
// Defaults follow Groq's replacement table (console.groq.com/docs/deprecations, checked 2026-10-27):
//   llama-3.1-8b-instant    (shut down 2026-08-16) -> openai/gpt-oss-20b
//   llama-3.3-70b-versatile (shut down 2026-08-16) -> openai/gpt-oss-120b
// Env vars still override, but a retired model ID is ignored so a stale Render setting
// cannot silently break a task again (the detector 404'd on every call from Sept 2026).

const RETIRED_MODELS = new Set([
  'llama-3.1-8b-instant',
  'llama-3.3-70b-versatile',
  'llama-3.1-70b-versatile',
  'llama3-8b-8192',
  'llama3-70b-8192',
  'gemma2-9b-it',
  'mixtral-8x7b-32768',
  'qwen/qwen3-32b',
  'qwen/qwen3.6-27b',
  'meta-llama/llama-4-scout-17b-16e-instruct',
  'meta-llama/llama-4-maverick-17b-128e-instruct',
  'moonshotai/kimi-k2-instruct',
  'moonshotai/kimi-k2-instruct-0905',
  'deepseek-r1-distill-llama-70b',
]);

const DEFAULTS = {
  GENERATION:          'openai/gpt-oss-120b',
  GENERATION_FALLBACK: 'openai/gpt-oss-20b',
  DETECTION:           'openai/gpt-oss-20b',
  // Safety classification: the stronger model, since a missed risk signal costs more than tokens.
  RISK:                'openai/gpt-oss-120b',
  SUMMARY:             'openai/gpt-oss-20b',
};

const ENV_VARS = {
  GENERATION:          'GROQ_PRIMARY_MODEL',
  GENERATION_FALLBACK: 'GROQ_FALLBACK_MODEL',
  DETECTION:           'GROQ_DETECTION_MODEL',
  RISK:                'GROQ_RISK_MODEL',
  SUMMARY:             'GROQ_SUMMARY_MODEL',
};

// gpt-oss models reason before answering, and reasoning tokens are spent from the same
// completion budget. At reasoning_effort 'low' that was 9-36 tokens in the 2026-10-27 live
// smoke test, so this is a guard against a starved or empty reply, not a length lever.
// Length is enforced on the output text by the validator/truncate step.
const REASONING_HEADROOM_TOKENS = 1024;

function resolveModel(task, env = process.env, warn = defaultWarn) {
  const fallback = DEFAULTS[task];
  if (!fallback) throw new Error(`unknown AI task: ${task}`);
  const configured = (env[ENV_VARS[task]] || '').trim();
  if (!configured) return fallback;
  if (RETIRED_MODELS.has(configured)) {
    warn(`${ENV_VARS[task]}=${configured} is retired on Groq; using ${fallback}. Update the env var.`);
    return fallback;
  }
  return configured;
}

function defaultWarn(msg) {
  console.warn(`[ai:models] ${msg}`);
}

module.exports = { resolveModel, RETIRED_MODELS, DEFAULTS, ENV_VARS, REASONING_HEADROOM_TOKENS };
