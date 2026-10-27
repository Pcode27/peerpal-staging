'use strict';

// Contextual risk classifier (docs/ai-spec/section-3-safety-policy.md 3.5).
// Reads meaning, not words: catches indirect distress, passive ideation, minimising after an
// earlier signal, and repeated signals across turns, which the keyword list cannot. Runs in
// parallel with the keyword classifier; the resolver (3.5.1) takes the higher severity, so the
// keyword list stays a deterministic floor. An inferred CRITICAL invokes the crisis template.
//
// On failure the source is absent and the resolver uses the keyword result (3.5 failure rule).

const { v4: uuidv4 } = require('uuid');
const Groq           = require('groq-sdk');
const { OpenAI }     = require('@posthog/ai/openai');
const { PostHog }    = require('posthog-node');
const THRESHOLDS     = require('./thresholds');
const { resolveModel, REASONING_HEADROOM_TOKENS } = require('./models');

const DETECTOR_VERSION = 'contextual-risk-classifier@1.0.0';
// Tried in order; a second model guards against one model being unavailable.
const RISK_MODELS      = [...new Set([resolveModel('RISK'), resolveModel('GENERATION_FALLBACK')])];
const CONTEXT_TURNS    = 6;

const VALID_RISK    = new Set(['ABSENT', 'PRESENT', 'ELEVATED', 'CRITICAL']);
const VALID_PATTERN = new Set(['NONE', 'EXPLICIT', 'INDIRECT_DISTRESS', 'PASSIVE_IDEATION', 'DECLINING_DISCLOSURE', 'REPEATED_SIGNAL']);

let _groq = null;
let posthogEnabled = false;
function getGroq() {
  if (!_groq) {
    const projectToken = process.env.POSTHOG_PROJECT_TOKEN;
    const host = process.env.POSTHOG_HOST;
    if (process.env.NODE_TEST_CONTEXT || !projectToken || !host) {
      _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    } else {
      const posthog = new PostHog(projectToken, { host, privacyMode: true, enableExceptionAutocapture: true });
      _groq = new OpenAI({ baseURL: 'https://api.groq.com/openai/v1', apiKey: process.env.GROQ_API_KEY, posthog });
      posthogEnabled = true;
    }
  }
  return _groq;
}

// Prompt is a policy artefact (Section 3.9): wording changes require re-running
// evals/riskClassifier.eval.js and Seka's review.
const SYSTEM_PROMPT = `You are a safety risk classifier for PeerPal, a peer mental health support app used mainly by young adults in Kenya. Messages may be in English, Swahili, Sheng, or a mix. Judge meaning in context, not individual words. Return JSON only.

Output format (no other text):
{"risk_signal":{"value":"<ABSENT|PRESENT|ELEVATED|CRITICAL>","confidence":<0.0-1.0>},"pattern":"<NONE|EXPLICIT|INDIRECT_DISTRESS|PASSIVE_IDEATION|DECLINING_DISCLOSURE|REPEATED_SIGNAL>"}

RISK LEVELS (operational response priority, not a diagnosis):
CRITICAL: stated intent, plan, means, or timing for suicide or self-harm; an attempt in progress; imminent danger from another person; or strongly implicit equivalents (saying goodbye for good, giving things away "because I won't need them", "tonight is the night").
ELEVATED: passive ideation, meaning any statement, however indirect and in any language, of not wanting to live, continue, exist, or wake up, or not knowing why they keep living (wishing to be dead or asleep forever, "what's the point of me being here", "tired of existing", "everyone would be better off without me", "I'm just a burden"); self-harm urges or recent self-harm without stated intent; disclosure of abuse or violence against the user; minimising or taking back an earlier risk statement in this conversation ("forget it, I was joking") when context suggests it was real.
PRESENT: hopelessness, worthlessness, feeling trapped or that nothing will ever get better, without any wish to die or harm themselves.
ABSENT: ordinary stress, sadness, anxiety, loneliness, grief, anger, conflict, exhaustion, poor sleep, or good news. Also figurative speech: "this exam is killing me", "I could die of embarrassment", "nimekufa na kicheko", "I'm dead (laughing)".

PATTERN (the main reason for your level):
EXPLICIT: direct statement. INDIRECT_DISTRESS: risk expressed through metaphor, indirection, or culturally specific phrasing. PASSIVE_IDEATION: not wanting to continue, without intent. DECLINING_DISCLOSURE: user minimising an earlier signal. REPEATED_SIGNAL: the same kind of risk appearing across several user turns. NONE: no risk.

RULES:
1. Classify the [Current message], using [Recent conversation] for context. An earlier signal in this conversation raises concern for a vague current message.
2. PASSIVE_IDEATION, DECLINING_DISCLOSURE and REPEATED_SIGNAL are always at least ELEVATED.
3. When torn between two levels, choose the higher one and lower your confidence.
4. confidence is how sure you are of the level, not how severe the content is.
5. Output the JSON object only.`;

// Deterministic floor on the model's own pattern label. In the 2026-10-27 eval the model named
// PASSIVE_IDEATION / DECLINING_DISCLOSURE / REPEATED_SIGNAL correctly but still answered PRESENT
// for 5 of 16 risk cases, contradicting its definitions. Code enforces the definition.
const PATTERN_FLOOR = { PASSIVE_IDEATION: 'ELEVATED', DECLINING_DISCLOSURE: 'ELEVATED', REPEATED_SIGNAL: 'ELEVATED' };
const SEVERITY      = { ABSENT: 0, PRESENT: 1, ELEVATED: 2, CRITICAL: 3 };

function buildUserMessage(text, sessionContext) {
  if (!sessionContext?.length) return `[Current message]\n${text}`;
  const recent = sessionContext
    .slice(-CONTEXT_TURNS)
    .map(m => `${m.role === 'user' ? 'User' : 'Companion'}: ${m.content}`)
    .join('\n');
  return `[Recent conversation]\n${recent}\n\n[Current message]\n${text}`;
}

function unavailable(reason) {
  return { _unavailable: true, _reason: reason };
}

/**
 * @returns RiskSignalSourceSchema-shaped record (status INFERRED) with internal `_pattern`,
 *          or { _unavailable: true, _reason } when no model produced a valid classification.
 */
async function run(text, observed, { sessionContext = [], posthogContext } = {}) {
  const request = {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: buildUserMessage(text, sessionContext) },
    ],
    response_format:  { type: 'json_object' },
    max_tokens:       100 + REASONING_HEADROOM_TOKENS,
    reasoning_effort: 'low',
    temperature:      0,
    ...(posthogEnabled ? {
      posthogDistinctId: posthogContext?.userId || observed.user_id,
      posthogTraceId:    posthogContext?.traceId || observed.record_id,
      posthogProperties: { $ai_session_id: posthogContext?.sessionId || observed.session_id, $ai_provider: 'groq' },
    } : {}),
  };

  const errors = [];
  for (const model of RISK_MODELS) {
    let raw;
    try {
      const completion = await getGroq().chat.completions.create({ model, ...request });
      raw = JSON.parse(completion.choices[0]?.message?.content || '{}');
    } catch (err) {
      errors.push(`${model}: ${err.message}`);
      continue;
    }
    const modelValue = raw?.risk_signal?.value;
    const confidence = typeof raw?.risk_signal?.confidence === 'number' ? raw.risk_signal.confidence : null;
    if (!VALID_RISK.has(modelValue) || confidence === null || confidence < 0 || confidence > 1) {
      errors.push(`${model}: SCHEMA_VIOLATION`);
      continue;
    }
    const pattern = VALID_PATTERN.has(raw?.pattern) ? raw.pattern : 'NONE';
    const floor   = PATTERN_FLOOR[pattern];
    const value   = floor && SEVERITY[modelValue] < SEVERITY[floor] ? floor : modelValue;

    const now = new Date().toISOString();
    return {
      source_id:        uuidv4(),
      observed_ref:     observed.record_id,
      detector_version: DETECTOR_VERSION,
      detected_at:      now,
      risk_signal: {
        value,
        status:            'INFERRED',
        confidence_status: 'AVAILABLE',
        confidence,
        uncertainty_flag:  confidence < THRESHOLDS.RISK_UNCERTAINTY_THRESHOLD,
        provenance:        { source_type: observed.source, id: observed.record_id },
        detector_version:  DETECTOR_VERSION,
        created_at:        now,
      },
      _pattern:  pattern,
      _model:    model,
      _upgraded: value !== modelValue, // pattern floor raised the model's level
    };
  }
  return unavailable(`CLASSIFIER_UNAVAILABLE: ${errors.join(' | ')}`);
}

module.exports = { DETECTOR_VERSION, RISK_MODELS, SYSTEM_PROMPT, run };
