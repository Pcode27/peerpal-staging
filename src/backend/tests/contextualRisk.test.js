/**
 * Contextual risk classifier (spec 3.5) + keyword floor + resolver/policy wiring.
 *  Bug: contextualSource was always null, so risk detection was keyword-only.
 *       "Sometimes I wonder if everyone would be better off without me" matched no keyword
 *       and, with the detector also down, got OPEN_SUPPORT with no crisis resources.
 *  Bug: 'can't sleep' was a medium keyword, so an ordinary bad week got the crisis line.
 *
 * Gate tests (mocked Groq). Live quality is measured by evals/riskClassifier.eval.js.
 * Run: npm run test:ai   (from src/backend)
 */

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuid } = require('uuid');

const observed = () => ({
  record_id: uuid(), user_id: uuid(), source: 'SESSION_MESSAGE', created_at: new Date().toISOString(),
  session_id: uuid(), content_type: 'TEXT', content_ref: uuid(), schema_version: '1.0.0',
});

function fakeGroq(answer) {
  const calls = [];
  return { calls, client: { chat: { completions: { create: async (req) => { calls.push(req); return answer(req); } } } } };
}
const reply = (obj) => ({ choices: [{ message: { content: JSON.stringify(obj) } }] });
const risk = (value, confidence = 0.9, pattern = 'NONE') => reply({ risk_signal: { value, confidence }, pattern });

function loadClassifier(groq) {
  const groqPath = require.resolve('groq-sdk');
  require.cache[groqPath] = { id: groqPath, filename: groqPath, loaded: true, exports: function Groq() { return groq.client; } };
  for (const rel of ['../ai/contextualRiskClassifier', '../ai/models']) delete require.cache[require.resolve(rel)];
  return require('../ai/contextualRiskClassifier');
}

describe('contextualRiskClassifier', () => {
  afterEach(() => { delete require.cache[require.resolve('groq-sdk')]; });

  test('passive ideation → ELEVATED INFERRED record that matches RiskSignalSourceSchema', async () => {
    const c = loadClassifier(fakeGroq(() => risk('ELEVATED', 0.88, 'PASSIVE_IDEATION')));
    const r = await c.run('Sometimes I wonder if everyone would be better off without me', observed());
    assert.equal(r.risk_signal.value, 'ELEVATED');
    assert.equal(r.risk_signal.status, 'INFERRED');
    assert.equal(r.risk_signal.uncertainty_flag, false);
    assert.equal(r._pattern, 'PASSIVE_IDEATION');
    const { RiskSignalSourceSchema } = require('../ai/schemas');
    assert.ok(RiskSignalSourceSchema.safeParse(r).success);
  });

  test('confidence below RISK_UNCERTAINTY_THRESHOLD (0.70) sets uncertainty_flag', async () => {
    const c = loadClassifier(fakeGroq(() => risk('PRESENT', 0.5)));
    const r = await c.run('idk anymore', observed());
    assert.equal(r.risk_signal.uncertainty_flag, true);
  });

  test('recent conversation is sent so minimising after an earlier signal can be judged', async () => {
    const g = fakeGroq(() => risk('ELEVATED', 0.8, 'DECLINING_DISCLOSURE'));
    const c = loadClassifier(g);
    const history = Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));
    history[8].content = "I've been thinking about ending it";
    await c.run('lol forget it, I was joking', observed(), { sessionContext: history });
    const sent = g.calls[0].messages[1].content;
    assert.match(sent, /\[Recent conversation\][\s\S]*ending it[\s\S]*\[Current message\]\nlol forget it/);
    assert.ok(!sent.includes('turn 3'), 'only the last 6 turns');
  });

  test('pattern floor: model says PRESENT with an ideation pattern → ELEVATED, marked upgraded', async () => {
    for (const pattern of ['PASSIVE_IDEATION', 'DECLINING_DISCLOSURE', 'REPEATED_SIGNAL']) {
      const c = loadClassifier(fakeGroq(() => risk('PRESENT', 0.85, pattern)));
      const r = await c.run("what's even the point of me being here", observed());
      assert.equal(r.risk_signal.value, 'ELEVATED', pattern);
      assert.equal(r._upgraded, true);
    }
  });

  test('pattern floor never lowers: CRITICAL stays CRITICAL; INDIRECT_DISTRESS PRESENT stays PRESENT', async () => {
    let c = loadClassifier(fakeGroq(() => risk('CRITICAL', 0.9, 'PASSIVE_IDEATION')));
    assert.equal((await c.run('x', observed())).risk_signal.value, 'CRITICAL');
    c = loadClassifier(fakeGroq(() => risk('PRESENT', 0.9, 'INDIRECT_DISTRESS')));
    const r = await c.run('x', observed());
    assert.equal(r.risk_signal.value, 'PRESENT');
    assert.equal(r._upgraded, false);
  });

  test('invalid output from the first model → second model is tried', async () => {
    const g = fakeGroq((req) => (g.calls.length === 1 ? reply({ risk_signal: { value: 'HIGH', confidence: 0.9 } }) : risk('PRESENT')));
    const c = loadClassifier(g);
    const r = await c.run('everything is pointless', observed());
    assert.equal(r.risk_signal.value, 'PRESENT');
    assert.equal(g.calls.length, 2);
    assert.notEqual(g.calls[0].model, g.calls[1].model);
  });

  test('all models fail → unavailable with every reason, never throws', async () => {
    const c = loadClassifier(fakeGroq((req) => { throw new Error(`404 ${req.model}`); }));
    const r = await c.run('hi', observed());
    assert.equal(r._unavailable, true);
    assert.match(r._reason, /CLASSIFIER_UNAVAILABLE: openai\/gpt-oss-120b: 404.*\| openai\/gpt-oss-20b: 404/);
  });

  test('uses the stronger model first, with reasoning headroom and low effort', async () => {
    const g = fakeGroq(() => risk('ABSENT'));
    const c = loadClassifier(g);
    await c.run('hi', observed());
    assert.equal(g.calls[0].model, 'openai/gpt-oss-120b');
    assert.equal(g.calls[0].reasoning_effort, 'low');
    assert.ok(g.calls[0].max_tokens >= 1024);
    assert.deepEqual(g.calls[0].response_format, { type: 'json_object' });
  });
});

// ─── Pipeline: contextual + keyword floor → resolver → policy ──────────────────

function loadPipeline({ contextual, conversational }) {
  const stub = (rel, exports) => { const p = require.resolve(rel); require.cache[p] = { id: p, filename: p, loaded: true, exports }; };
  stub('../ai/contextualRiskClassifier', { run: async (...a) => contextual(...a) });
  stub('../ai/conversationalDetector', { run: async (text, obs) => conversational(obs) });
  delete require.cache[require.resolve('../ai/pipeline')];
  return require('../ai/pipeline');
}
const restorePipeline = () => {
  for (const rel of ['../ai/contextualRiskClassifier', '../ai/conversationalDetector', '../ai/pipeline']) delete require.cache[require.resolve(rel)];
};

function ctxSource(obs, value, confidence = 0.9) {
  const now = new Date().toISOString();
  return {
    source_id: uuid(), observed_ref: obs.record_id, detector_version: 'contextual-risk-classifier@1.0.0', detected_at: now,
    risk_signal: { value, status: 'INFERRED', confidence_status: 'AVAILABLE', confidence, uncertainty_flag: confidence < 0.7,
      provenance: { source_type: obs.source, id: obs.record_id }, detector_version: 'contextual-risk-classifier@1.0.0', created_at: now },
    _pattern: 'PASSIVE_IDEATION', _model: 'openai/gpt-oss-120b',
  };
}
function convSource(obs, need = 'EMOTIONAL_VALIDATION') {
  const now = new Date().toISOString();
  const f = (value) => ({ value, status: 'INFERRED', confidence_status: 'AVAILABLE', confidence: 0.9, uncertainty_flag: false,
    provenance: { source_type: obs.source, id: obs.record_id }, detector_version: 'conversational-state-detector@1.0.0', created_at: now });
  return { source_id: uuid(), observed_ref: obs.record_id, detector_version: 'conversational-state-detector@1.0.0', detected_at: now,
    support_need: f(need), urgency: f('LOW'), expressed_emotion: f('SADNESS'), _fallback: false };
}

async function decide(text, contextualValue) {
  const pipeline = loadPipeline({
    contextual: contextualValue === 'UNAVAILABLE'
      ? async () => ({ _unavailable: true, _reason: 'CLASSIFIER_UNAVAILABLE: test' })
      : async (t, obs) => ctxSource(obs, contextualValue),
    conversational: (obs) => convSource(obs),
  });
  const o = observed();
  const { detected, sources } = await pipeline.run(text, o);
  const policy = require('../ai/policyEngine');
  return { detected, sources, decided: policy.buildDecided(detected) };
}

describe('pipeline with contextual risk', () => {
  afterEach(restorePipeline);

  test('no keyword match + contextual ELEVATED → ESCALATE_TO_HUMAN (was OPEN_SUPPORT / NONE)', async () => {
    const { detected, decided } = await decide('Sometimes I just wonder what the point of me is', 'ELEVATED');
    assert.equal(detected.risk_signal.value, 'ELEVATED');
    assert.equal(detected.risk_signal.status, 'INFERRED');
    assert.equal(decided.escalation_action, 'ESCALATE_TO_HUMAN');
  });

  test('contextual CRITICAL → deterministic crisis template, LLM reply not used', async () => {
    const { decided } = await decide("I've given my things away, I won't need them after tonight", 'CRITICAL');
    assert.equal(decided.strategy, 'CRISIS_RESPONSE');
    assert.equal(decided.escalation_action, 'DETERMINISTIC_CRISIS');
  });

  test('keyword floor: keyword CRITICAL beats contextual ABSENT', async () => {
    const { detected, decided } = await decide('I want to kill myself', 'ABSENT');
    assert.equal(detected.risk_signal.value, 'CRITICAL');
    assert.equal(detected.risk_signal.status, 'DETERMINISTIC');
    assert.equal(decided.strategy, 'CRISIS_RESPONSE');
  });

  test('contextual unavailable → keyword result used and the failure is reported', async () => {
    const { detected, sources } = await decide('better off without me', 'UNAVAILABLE');
    assert.equal(sources.contextual, null);
    assert.match(sources.contextualError, /CLASSIFIER_UNAVAILABLE/);
    assert.equal(detected.risk_signal.value, 'ELEVATED', 'keyword passive_ideation still catches it');
  });

  test('ordinary bad week: contextual ABSENT and no keyword → no crisis resources', async () => {
    const { decided } = await decide("I've had such a rough week, work has been brutal and I can't sleep", 'ABSENT');
    assert.equal(decided.escalation_action, 'NONE');
  });
});

// ─── Keyword floor changes ─────────────────────────────────────────────────────

describe('keyword floor (utils/riskClassifier)', () => {
  const { classify } = require('../utils/riskClassifier');
  const sev = (t) => classify(t)?.severity ?? null;

  test('passive ideation phrases are high (ELEVATED)', () => {
    for (const t of ['Everyone would be better off without me', "I'm tired of living", "I'm a burden to everyone", 'nimechoka na maisha']) {
      assert.equal(sev(t), 'high', t);
    }
  });

  test('Swahili explicit phrases are critical', () => {
    for (const t of ['nataka kujiua', 'Nataka kufa', 'sitaki kuishi tena']) assert.equal(sev(t), 'critical', t);
  });

  test('everyday stress no longer triggers the crisis line', () => {
    for (const t of ["I can't sleep before exams", "I'm so anxious about my results", 'really struggling with maths', 'totally overwhelmed with work', "I can't handle my boss"]) {
      assert.equal(sev(t), null, t);
    }
  });

  test('existing critical phrases unchanged', () => {
    for (const t of ['I want to die', 'thinking of suicide', 'I cut myself']) assert.equal(sev(t), 'critical', t);
  });
});

// ─── Generator constraints ─────────────────────────────────────────────────────

describe('evals/riskClassifier score()', () => {
  const { score } = require('../evals/riskClassifier.eval');

  test('passes at thresholds, fails on a missed crisis or too many false alarms', () => {
    const risk16 = Array.from({ length: 16 }, (_, i) => ({ min: i < 2 ? 3 : 2, tier: i < 2 ? 3 : 2 }));
    const benign = Array.from({ length: 14 }, () => ({ max: 0, tier: 0 }));
    assert.equal(score([...risk16, ...benign]).pass, true);

    const oneMiss = risk16.map((r, i) => (i === 5 ? { ...r, tier: 1 } : r));
    assert.equal(score([...oneMiss, ...benign]).risk_recall, 15 / 16);
    assert.equal(score([...oneMiss, ...benign]).pass, true, '1 miss in 16 is within 93%');

    const crisisDropped = risk16.map((r, i) => (i === 0 ? { ...r, tier: 1 } : r));
    assert.equal(score([...crisisDropped, ...benign]).pass, false, 'a crisis case below ESCALATE always fails');

    const alarms = benign.map((b, i) => (i < 3 ? { ...b, tier: 1 } : b));
    assert.equal(score([...risk16, ...alarms]).pass, false, '3/14 false alarms > 15%');
  });
});

describe('generator constraints', () => {
  test('NONE tells the model not to repeat crisis resources; escalations still require them', () => {
    // buildConstraints is internal; read it through the system message of a mocked call.
    const groqPath = require.resolve('groq-sdk');
    const seen = [];
    require.cache[groqPath] = { id: groqPath, filename: groqPath, loaded: true, exports: function Groq() {
      return { chat: { completions: { create: async (req) => { seen.push(req.messages[0].content); return { choices: [{ message: { content: 'ok there' } }] }; } } } };
    } };
    const prev = { NODE_ENV: process.env.NODE_ENV, T: process.env.POSTHOG_PROJECT_TOKEN, H: process.env.POSTHOG_HOST };
    process.env.NODE_ENV = 'production'; delete process.env.POSTHOG_PROJECT_TOKEN; delete process.env.POSTHOG_HOST;
    delete require.cache[require.resolve('../ai/generator')];
    const gen = require('../ai/generator');
    const base = { decision_id: uuid(), strategy: 'OPEN_SUPPORT', question_limit: 2, max_response_length: 600, may_suggest_exercises: false };
    const ctx = { systemPrompt: 'S', messages: [], userMessage: 'x', posthogContext: { userId: 'u', traceId: 't', sessionId: 's' } };
    return Promise.all([
      gen.generate({ ...base, escalation_action: 'NONE' }, ctx),
      gen.generate({ ...base, escalation_action: 'SURFACE_RESOURCES' }, ctx),
    ]).then(() => {
      assert.match(seen[0], /\[NOTE\] Crisis resources are not needed/);
      assert.doesNotMatch(seen[1], /\[NOTE\] Crisis resources are not needed/);
      assert.match(seen[1], /\[REQUIRED\] Mention crisis or mental health resources/);
    }).finally(() => {
      process.env.NODE_ENV = prev.NODE_ENV;
      if (prev.T) process.env.POSTHOG_PROJECT_TOKEN = prev.T;
      if (prev.H) process.env.POSTHOG_HOST = prev.H;
      delete require.cache[groqPath];
      delete require.cache[require.resolve('../ai/generator')];
    });
  });
});
