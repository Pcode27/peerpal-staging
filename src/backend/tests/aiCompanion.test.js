/**
 * AI companion wiring (fix/ai-companion-wiring).
 *  Bug 1: detector default `llama-3.1-8b-instant` was shut down by Groq on 2026-08-16. Every
 *         call 404'd, so all 36 production messages fell back to NONE_IDENTIFIED / OPEN_SUPPORT.
 *  Bug 2: generation budget was max_response_length/3 tokens (200 for OPEN_SUPPORT) on a
 *         reasoning model that spends from the same budget. Replies averaged 90 chars.
 *  Bug 3: ai_generated.model_id was a hardcoded constant, not the model that answered.
 *  Bug 4: an empty completion passed validation and would be delivered as a blank bubble.
 *  Bug 5: sessionCache is in-process; a restart wiped history and reset the 30-message limit.
 *
 * Run: npm run test:ai-companion   (from src/backend)
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const models = require('../ai/models');

const OBSERVED = {
  record_id: 'aaaaaaaa-0000-0000-0000-000000000001', user_id: 'aaaaaaaa-0000-0000-0000-000000000002',
  source: 'SESSION_MESSAGE', created_at: new Date().toISOString(),
  session_id: 'aaaaaaaa-0000-0000-0000-000000000003', content_type: 'TEXT',
  content_ref: 'aaaaaaaa-0000-0000-0000-000000000001', schema_version: '1.0.0',
};
const DECIDED = {
  decision_id: 'aaaaaaaa-0000-4000-8000-000000000004', strategy: 'OPEN_SUPPORT',
  escalation_action: 'NONE', question_limit: 2, max_response_length: 600, may_suggest_exercises: false,
};
const DETECTOR_JSON = JSON.stringify({
  support_need: { value: 'EMOTIONAL_VALIDATION', confidence: 0.9 },
  urgency:      { value: 'LOW', confidence: 0.8 },
  expressed_emotion: { value: 'SADNESS', confidence: 0.8 },
});
const REPLY = "That sounds like a heavy week, and it makes sense you're worn out. What has been weighing on you most?";

// Fake Groq: records every request; `answer(req)` decides the response or throws.
function fakeGroq(answer) {
  const calls = [];
  return {
    calls,
    client: { chat: { completions: { create: async (req) => { calls.push(req); return answer(req); } } } },
  };
}
const notFound = (model) => Object.assign(new Error(`404 The model \`${model}\` does not exist or you do not have access to it.`), { status: 404 });
const ok = (content, extra = {}) => ({
  choices: [{ message: { content }, finish_reason: extra.finish_reason ?? 'stop' }],
  usage: { completion_tokens: extra.completion_tokens ?? 120, completion_tokens_details: { reasoning_tokens: extra.reasoning_tokens ?? 80 } },
});

// Load a module with groq-sdk swapped for the fake and PostHog disabled (production path).
const saved = {};
function load(modRel, groq, env = {}) {
  for (const k of ['NODE_ENV', 'POSTHOG_PROJECT_TOKEN', 'POSTHOG_HOST', 'GROQ_PRIMARY_MODEL', 'GROQ_FALLBACK_MODEL', 'GROQ_DETECTION_MODEL', 'GROQ_SUMMARY_MODEL']) {
    if (!(k in saved)) saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.NODE_ENV = 'production';
  Object.assign(process.env, env);
  const groqPath = require.resolve('groq-sdk');
  require.cache[groqPath] = { id: groqPath, filename: groqPath, loaded: true, exports: function Groq() { return groq.client; } };
  for (const rel of [modRel, '../ai/models']) delete require.cache[require.resolve(rel)];
  return require(modRel);
}
function restoreEnv() {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  delete require.cache[require.resolve('groq-sdk')];
}

describe('models.resolveModel', () => {
  test('no default is a retired model', () => {
    for (const [task, model] of Object.entries(models.DEFAULTS)) {
      assert.ok(!models.RETIRED_MODELS.has(model), `${task} default ${model} is retired`);
    }
  });

  test('detector default is the Groq replacement for llama-3.1-8b-instant', () => {
    assert.equal(models.resolveModel('DETECTION', {}), 'openai/gpt-oss-20b');
  });

  test('env override is honoured', () => {
    assert.equal(models.resolveModel('GENERATION', { GROQ_PRIMARY_MODEL: 'openai/gpt-oss-20b' }), 'openai/gpt-oss-20b');
  });

  test('a retired model left in env is ignored, with a warning naming the env var', () => {
    const warnings = [];
    const m = models.resolveModel('DETECTION', { GROQ_DETECTION_MODEL: 'llama-3.1-8b-instant' }, w => warnings.push(w));
    assert.equal(m, 'openai/gpt-oss-20b');
    assert.match(warnings[0], /GROQ_DETECTION_MODEL=llama-3\.1-8b-instant is retired/);
  });

  test('unknown task throws', () => {
    assert.throws(() => models.resolveModel('NOPE', {}), /unknown AI task/);
  });
});

describe('conversationalDetector', () => {
  afterEach(restoreEnv);

  test('stale retired env var no longer breaks detection', async () => {
    const g = fakeGroq((req) => { if (req.model === 'llama-3.1-8b-instant') throw notFound(req.model); return ok(DETECTOR_JSON); });
    const det = load('../ai/conversationalDetector', g, { GROQ_DETECTION_MODEL: 'llama-3.1-8b-instant' });
    const r = await det.run('I have been so low all week', OBSERVED);
    assert.equal(r._fallback, false);
    assert.equal(r.support_need.value, 'EMOTIONAL_VALIDATION');
    assert.equal(g.calls[0].model, 'openai/gpt-oss-20b');
  });

  test('detection model 404 → retries on the generation model', async () => {
    const g = fakeGroq((req) => { if (req.model === 'openai/gpt-oss-20b') throw notFound(req.model); return ok(DETECTOR_JSON); });
    const det = load('../ai/conversationalDetector', g);
    const r = await det.run('I have been so low all week', OBSERVED);
    assert.equal(r._fallback, false);
    assert.deepEqual(g.calls.map(c => c.model), ['openai/gpt-oss-20b', 'openai/gpt-oss-120b']);
  });

  test('both models down → fallback reason names both', async () => {
    const g = fakeGroq((req) => { throw notFound(req.model); });
    const det = load('../ai/conversationalDetector', g);
    const r = await det.run('hi', OBSERVED);
    assert.equal(r._fallback, true);
    assert.match(r._fallback_reason, /CLASSIFIER_UNAVAILABLE: openai\/gpt-oss-20b: 404.*\| openai\/gpt-oss-120b: 404/);
  });

  test('request leaves room for reasoning and asks for low effort', async () => {
    const g = fakeGroq(() => ok(DETECTOR_JSON));
    const det = load('../ai/conversationalDetector', g);
    await det.run('hi', OBSERVED);
    assert.ok(g.calls[0].max_tokens >= 200 + models.REASONING_HEADROOM_TOKENS);
    assert.equal(g.calls[0].reasoning_effort, 'low');
  });
});

describe('generator', () => {
  afterEach(restoreEnv);
  const ctx = { systemPrompt: 'You are a companion.', messages: [], userMessage: 'rough week', posthogContext: { userId: 'u', traceId: 't', sessionId: 's' } };

  // Models a reasoning model: reasoning spends `reasoning` tokens first; the answer gets what is left.
  function reasoningModel(reasoning = 400) {
    return (req) => {
      const left = req.max_tokens - reasoning;
      const content = left <= 0 ? '' : REPLY.slice(0, left * 3);
      return ok(content, { finish_reason: left * 3 < REPLY.length ? 'length' : 'stop', completion_tokens: Math.min(req.max_tokens, reasoning + REPLY.length / 3), reasoning_tokens: reasoning });
    };
  }

  test('a full reply survives a model that reasons before answering', async () => {
    const g = fakeGroq(reasoningModel(400));
    const gen = load('../ai/generator', g);
    const r = await gen.generate(DECIDED, ctx);
    assert.equal(r.validation_status, 'PASSED');
    assert.equal(r.content, REPLY);
    assert.equal(g.calls[0].max_tokens, Math.ceil(600 / 3) + models.REASONING_HEADROOM_TOKENS);
  });

  test('old budget (600/3 = 200 tokens) would have produced nothing', () => {
    const answer = reasoningModel(400)({ max_tokens: Math.ceil(600 / 3) });
    assert.equal(answer.choices[0].message.content, '');
  });

  test('empty completion is FAILED with EMPTY_RESPONSE, never delivered blank', async () => {
    const g = fakeGroq(() => ok('', { finish_reason: 'length' }));
    const gen = load('../ai/generator', g);
    const r = await gen.generate(DECIDED, ctx);
    assert.equal(r.validation_status, 'FAILED');
    assert.deepEqual(r.violations, ['EMPTY_RESPONSE']);
    assert.equal(r._telemetry.finish_reason, 'length');
  });

  test('model_id records the model that answered, including fallback', async () => {
    const g = fakeGroq((req) => { if (req.model === 'openai/gpt-oss-120b') throw notFound(req.model); return ok(REPLY); });
    const gen = load('../ai/generator', g);
    const r = await gen.generate(DECIDED, ctx);
    assert.equal(r.model_id, 'groq/openai/gpt-oss-20b@1.1.0');
    assert.equal(r._telemetry.fallback_used, true);
    const { GeneratedSchema } = require('../ai/schemas');
    assert.ok(GeneratedSchema.safeParse(r).success, 'record still matches GeneratedSchema');
  });

  test('telemetry carries finish_reason and reasoning tokens', async () => {
    const g = fakeGroq(() => ok(REPLY, { reasoning_tokens: 333, completion_tokens: 370 }));
    const gen = load('../ai/generator', g);
    const r = await gen.generate(DECIDED, ctx);
    assert.deepEqual(
      { model: r._telemetry.model, finish_reason: r._telemetry.finish_reason, reasoning_tokens: r._telemetry.reasoning_tokens, completion_tokens: r._telemetry.completion_tokens },
      { model: 'openai/gpt-oss-120b', finish_reason: 'stop', reasoning_tokens: 333, completion_tokens: 370 },
    );
  });
});

describe('scripts/ai_health_report summarize', () => {
  const { summarize } = require('../scripts/ai_health_report');

  test('production baseline: every detection fell back', () => {
    const r = summarize({ detections: 36, fallbacks: 36, generations: [] });
    assert.equal(r.detector_fallback_pct, 100);
    assert.equal(r.avg_reply_chars, null);
  });

  test('reply length ignores FAILED rows; finish=length and empties are counted', () => {
    const g = (o) => ({ model: 'openai/gpt-oss-120b', finish_reason: 'stop', validation_status: 'PASSED', content_length: 300, reasoning_tokens: 100, fallback_used: false, ...o });
    const r = summarize({
      detections: 4, fallbacks: 1,
      generations: [g({}), g({ content_length: 100 }), g({ content_length: 0, validation_status: 'FAILED', finish_reason: 'length' }), g({ model: 'openai/gpt-oss-20b', fallback_used: true })],
    });
    assert.equal(r.detector_fallback_pct, 25);
    assert.equal(r.avg_reply_chars, Math.round((300 + 100 + 300) / 3));
    assert.equal(r.median_reply_chars, 300);
    assert.equal(r.empty_pct, 25);
    assert.equal(r.finish_length_pct, 25);
    assert.equal(r.failed_pct, 25);
    assert.equal(r.generation_fallback_pct, 25);
    assert.deepEqual(r.models, { 'openai/gpt-oss-120b': 3, 'openai/gpt-oss-20b': 1 });
  });
});

describe('restoreSession (routes/ai.js)', () => {
  let interactions;
  beforeEach(() => {
    interactions = [
      { input_text: 'hi', output_text: 'Hello, how are you doing?', flag_reason: null },
      { input_text: 'not great', output_text: 'I am sorry.', flag_reason: 'ESCALATE_TO_HUMAN: POLICY_ESCALATION_TRIGGERED' },
      { input_text: 'thanks', output_text: 'Any time.', flag_reason: 'SURFACE_RESOURCES: STRATEGY_BY_SUPPORT_NEED' },
    ];
    const db = {
      query: async (sql) => {
        const q = sql.replace(/\s+/g, ' ').trim();
        if (q.startsWith('SELECT alias, birth_year FROM users')) return { rows: [{ alias: 'BrightBison23', birth_year: 2000 }] };
        if (q.includes('FROM group_memberships')) return { rows: [] };
        if (q.startsWith('SELECT * FROM ai_personas')) return { rows: [{ persona_name: 'Amani', tone: 'warm' }] };
        if (q.startsWith('SELECT mood_level')) return { rows: [] };
        if (q.startsWith('SELECT summary FROM ai_memories')) return { rows: [{ summary: 'Talked about exams.' }] };
        if (q.startsWith('SELECT input_text, output_text, flag_reason FROM ai_interactions')) return { rows: interactions };
        throw new Error(`unhandled SQL: ${q.slice(0, 100)}`);
      },
    };
    const stubs = {
      '../db': db,
      '../services/cache': { get: async () => null, set: async () => {}, del: async () => {}, incrby: async () => {} },
      '../middleware/auth': (q, r, n) => n(),
      '../middleware/rateLimit': { aiMessageLimiter: (q, r, n) => n(), aiSessionLimiter: (q, r, n) => n() },
    };
    for (const [rel, exports] of Object.entries(stubs)) {
      const p = require.resolve(rel);
      require.cache[p] = { id: p, filename: p, loaded: true, exports };
    }
    delete require.cache[require.resolve('../routes/ai')];
  });

  test('rebuilds history, flag count and the full prompt (memories included)', async () => {
    const { restoreSession } = require('../routes/ai');
    const s = await restoreSession('sess-1', 'user-1');
    assert.equal(s.messages.length, 6);
    assert.deepEqual(s.messages.slice(0, 2), [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'Hello, how are you doing?' }]);
    assert.equal(s.messages.filter(m => m.role === 'user').length, 3, 'session message limit counts restored turns');
    assert.equal(s.flagCount, 1, 'only ESCALATE_TO_HUMAN counts');
    assert.match(s.systemPrompt, /Talked about exams\./);
    assert.match(s.systemPrompt, /Peer Help \(on the home screen\)/, 'companion knows the app features');
  });

  test('a new session restores empty', async () => {
    interactions = [];
    const { restoreSession } = require('../routes/ai');
    const s = await restoreSession('sess-2', 'user-1');
    assert.deepEqual(s.messages, []);
    assert.equal(s.flagCount, 0);
  });
});
