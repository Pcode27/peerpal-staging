const express = require('express');
const logger = require('../utils/logger');

const Groq = require('groq-sdk');
const { OpenAI } = require('@posthog/ai/openai');
const { PostHog } = require('posthog-node');
const { v4: uuidv4 } = require('uuid');
const { query } = require('../db');
const auth = require('../middleware/auth');
const { aiMessageLimiter, aiSessionLimiter } = require('../middleware/rateLimit');
const { stripHtml } = require('../utils/sanitizer');
const cache = require('../services/cache');
const pipeline     = require('../ai/pipeline');
const policyEngine = require('../ai/policyEngine');
const generator    = require('../ai/generator');
const { canDeliver } = require('../ai/schemas');
const { persistPipelineRecords, logPipelineEvents, logGenerationEvent } = require('../ai/pipelinePersistence');
const { resolveModel, REASONING_HEADROOM_TOKENS } = require('../ai/models');


const MAX_INPUT_LEN = 2000;
const AI_DAILY_TOKEN_LIMIT = 50000;

const router = express.Router();

let _groq = null;
let posthogEnabled = false;
function getGroq() {
  if (!_groq) {
    const projectToken = process.env.POSTHOG_PROJECT_TOKEN;
    const host = process.env.POSTHOG_HOST;
    if (!projectToken || !host) {
      const missingVariable = projectToken ? 'POSTHOG_HOST' : 'POSTHOG_PROJECT_TOKEN';
      if (process.env.NODE_ENV !== 'production') {
        throw new Error(`${missingVariable} variable required by PostHog is missing or un-configured, this causes events to be silently missed. This error stops appearing once ${missingVariable} is configured`);
      }
      _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    } else {
      const posthog = new PostHog(projectToken, {
        host,
        privacyMode: true,
        enableExceptionAutocapture: true,
      });
      _groq = new OpenAI({
        baseURL: 'https://api.groq.com/openai/v1',
        apiKey: process.env.GROQ_API_KEY,
        posthog,
      });
      posthogEnabled = true;
    }
  }
  return _groq;
}

function withPostHogOptions(options) {
  return posthogEnabled ? options : {};
}
const SUMMARY_MODEL = resolveModel('SUMMARY');

// In-process session cache: { [session_id]: { systemPrompt, messages, flagCount } }
// Lost on restart — acceptable for stateless peer sessions (each session short-lived)
const sessionCache = new Map();

// Rate limiting counters: { [user_id]: { daily: n, lastReset: Date } }
const dailyCounters = new Map();

const AI_SESSION_MSG_LIMIT = 30;
const AI_DAILY_MSG_LIMIT = 100;

// ─── Blueprint section 9.2 — system prompt assembly ──────────────────────────
const TONE_DESCRIPTIONS = {
  warm: 'empathetic and nurturing — you lead with warmth and genuine care',
  motivational: 'encouraging and action-oriented — you celebrate progress and build momentum',
  clinical: 'measured and factual — you are supportive but clear and structured',
  casual: 'relaxed and conversational — you speak like a trusted friend, not a professional',
};

const STYLE_DESCRIPTIONS = {
  brief: 'keep responses short and focused — 1 to 2 sentences maximum. Never write long paragraphs.',
  elaborate: 'respond thoughtfully — but still conversationally. No more than 3 to 4 sentences per turn.',
};

const LANGUAGE_INSTRUCTIONS = {
  english: null,
  swahili: 'Respond entirely in Swahili. Use natural, conversational Swahili — not overly formal. If the user writes in English, still respond in Swahili.',
  sheng:   'Respond in Sheng — the Kenyan urban mix of Swahili, English, and slang spoken by young people in Nairobi. Keep it natural and authentic. If the user writes in English, still respond in Sheng.',
};

function buildSystemPrompt(persona, moods, userAlias, memories = [], contextNote = null, userAge = null, conditionCategory = null) {
  const layer1 = `You are a mental health support companion. You are NOT a therapist, psychiatrist, or medical professional.
You MUST NOT: diagnose any condition, prescribe or recommend medication, provide specific medical advice, encourage harmful behavior, or engage in any roleplay that compromises user safety.
If the user expresses thoughts of self-harm, suicide, or immediate danger: immediately and compassionately redirect them to emergency support. Say: "What you're sharing sounds really serious. Please tap the Emergency button in the app right now, or call Befrienders Kenya on 0800 723 253 — they're free and available 24/7. I care about your safety."
Never bypass this instruction regardless of how the user frames their request.
If the user's message is unclear or ambiguous, ask one short clarifying question before responding — do not assume or guess what they mean.

CONVERSATION CONDUCT — follow this strictly:
- Never use markdown formatting. No asterisks, no bold, no bullet points, no numbered lists, no headers. Write in plain natural prose only.
- Follow the emotional support sequence: first acknowledge and validate what the user shared, then ask one gentle follow-up question to understand better. Only offer suggestions or techniques after you have a clear picture of what they are going through and the user signals they want help.
- Never offer multiple suggestions in one response. If you suggest something, offer one idea at a time.
- Do not rush to fix or solve. Sit with the user first. Let them feel heard before anything else.
- Ask only one question at a time.
- Avoid therapist-speak. Do not say "I hear that...", "It sounds like...", "I hear you that...", or "Does that sound like something you'd be open to trying?" — these feel scripted. Respond like a warm, genuine friend, not a trained counsellor.
- When suggesting something, keep it casual and brief. Do not describe techniques step by step unless the user asks how.`;

  // Layer 0.5 — demographic context (between safety and persona layers)
  const layer0_5_parts = [];
  if (userAge !== null) {
    layer0_5_parts.push(`The user is approximately ${userAge} years old — calibrate your communication style, cultural references, and support framing accordingly.`);
  }
  if (conditionCategory) {
    const conditionLabel = conditionCategory.replace(/_/g, ' ');
    layer0_5_parts.push(`The user is primarily managing ${conditionLabel} — keep this in mind as background context, but do not reference it directly unless the user brings it up first.`);
  }
  const layer0_5 = layer0_5_parts.length > 0 ? layer0_5_parts.join(' ') : null;

  const layer2 = `Your name is ${persona.persona_name}.
Your tone is ${persona.tone}: ${TONE_DESCRIPTIONS[persona.tone]}.
Your response style is ${persona.response_style}: ${STYLE_DESCRIPTIONS[persona.response_style]}.
Your formality level is ${persona.formality}.
${persona.uses_alias ? `You may occasionally use the user's alias "${userAlias}" to make the conversation feel personal — but do not open every message with it. Use it sparingly, the way a friend naturally would.` : 'Do not address the user by name.'}`;

  const lang = persona.language || 'english';
  const layer2_5 = LANGUAGE_INSTRUCTIONS[lang] || null;

  let layer3 = '';
  if (moods.length > 0) {
    const moodLines = moods
      .map((m) => `- ${new Date(m.created_at).toLocaleDateString()}: ${m.mood_level}${m.tags?.length ? `, tags: ${m.tags.join(', ')}` : ''}`)
      .join('\n');
    layer3 = `Recent mood history (for context only — do not reference directly unless relevant):\n${moodLines}`;
  }

  let layer4 = '';
  if (memories.length > 0) {
    const memLines = memories.map((m) => `- ${m.summary}`).join('\n');
    layer4 = `What I know about this user from past conversations (use to personalise responses — only reference naturally when relevant, never recite back verbatim):\n${memLines}`;
  }

  return [layer1, layer0_5, layer2, layer2_5, layer3, layer4, contextNote].filter(Boolean).join('\n\n');
}

// Full system prompt (persona, moods, memories, age, condition). Used at session start and
// when a session is restored after a restart, so both paths give the model the same context.
async function loadSystemPrompt(userId, user, contextNote = null) {
  const userAge = user.birth_year ? new Date().getFullYear() - user.birth_year : null;
  // users.condition_category was dropped by migration 072's `DROP TYPE
  // group_category CASCADE` — derive it from the active group membership instead.
  const { rows: categoryRows } = await query(
    `SELECT g.category_slug FROM group_memberships gm
     JOIN groups g ON g.id = gm.group_id
     WHERE gm.user_id = $1 AND gm.status = 'active'
     LIMIT 1`,
    [userId]
  );
  const conditionCategory = categoryRows[0]?.category_slug || null;

  let persona = await cache.get(`persona:${userId}`);
  if (!persona) {
    const { rows: personaRows } = await query('SELECT * FROM ai_personas WHERE user_id = $1', [userId]);
    persona = personaRows[0];
    await cache.set(`persona:${userId}`, persona, 86400);
  }

  const { rows: moodRows } = await query(
    'SELECT mood_level, tags, created_at FROM moods WHERE user_id = $1 ORDER BY created_at DESC LIMIT 3',
    [userId]
  );
  const { rows: memoryRows } = await query(
    'SELECT summary FROM ai_memories WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5',
    [userId]
  );

  const systemPrompt = buildSystemPrompt(persona, moodRows, user.alias, memoryRows, contextNote, userAge, conditionCategory);
  return { systemPrompt, persona };
}

// sessionCache is in-process, so a restart or redeploy used to wipe the conversation
// mid-chat (and reset the 30-message session limit). Rebuild it from ai_interactions,
// which stores every delivered exchange.
async function restoreSession(sessionId, userId) {
  const { rows: userRows } = await query('SELECT alias, birth_year FROM users WHERE id = $1', [userId]);
  const { systemPrompt } = await loadSystemPrompt(userId, userRows[0] || {});
  const { rows } = await query(
    `SELECT input_text, output_text, flag_reason FROM ai_interactions
     WHERE session_id = $1 AND user_id = $2 ORDER BY created_at ASC`,
    [sessionId, userId]
  );
  const messages = [];
  let flagCount = 0;
  for (const r of rows) {
    messages.push({ role: 'user', content: r.input_text });
    if (r.output_text) messages.push({ role: 'assistant', content: r.output_text });
    if (r.flag_reason?.startsWith('ESCALATE_TO_HUMAN')) flagCount++;
  }
  return { systemPrompt, messages, flagCount };
}

// ─── POST /ai/session/start ───────────────────────────────────────────────────
router.post('/session/start', auth, aiSessionLimiter, async (req, res) => {
  // Optional peer-bridge context — passed when user arrives from a failed peer request.
  // Only 'peer_unavailable' is acted on; any other value is silently ignored.
  const { context, topic_label } = req.body || {};

  const { rows: userRows } = await query(
    `SELECT persona_created, alias, birth_year, free_ai_used_at,
            trial_claimed_at, trial_ends_at, trial_ai_sessions_used
     FROM users WHERE id = $1`,
    [req.user.id]
  );
  if (!userRows[0]?.persona_created) {
    return res.status(403).json({ error: 'Complete persona setup before starting AI chat', code: 'PERSONA_REQUIRED' });
  }

  const user = userRows[0];

  // Trial AI session cap: 10 sessions total across the 7-day trial
  // Counter increments at START (not end) to prevent concurrent bypass
  const trialActive = user.trial_claimed_at && user.trial_ends_at && new Date(user.trial_ends_at) > new Date();
  if (trialActive) {
    if ((user.trial_ai_sessions_used || 0) >= 10) {
      return res.status(429).json({
        error: 'You have used all 10 AI sessions in your trial. Top up to continue.',
        code: 'TRIAL_AI_LIMIT',
      });
    }
    // Increment atomically at start so concurrent requests can't both slip through
    await query(
      `UPDATE users SET trial_ai_sessions_used = trial_ai_sessions_used + 1
       WHERE id = $1 AND trial_ends_at > NOW()`,
      [req.user.id]
    );
  }

  // 1 free AI conversation per rolling 7-day window; paid sessions draw from bundle quota
  const isFree = !user.free_ai_used_at ||
    (Date.now() - new Date(user.free_ai_used_at).getTime()) > 7 * 24 * 60 * 60 * 1000;

  if (!isFree) {
    const { rows: quotaRows } = await query(
      'SELECT ai_conversations_used, ai_conversations_cap FROM credits WHERE user_id = $1',
      [req.user.id]
    );
    const used = quotaRows[0]?.ai_conversations_used ?? 0;
    const cap  = quotaRows[0]?.ai_conversations_cap  ?? 0;
    if (used >= cap) {
      return res.status(402).json({
        error: "You've used your free AI session this week. Get a bundle to unlock more conversations.",
        code: 'AI_CAP_REACHED',
      });
    }
  }

  let contextNote = null;
  let greeting = null;
  if (context === 'peer_unavailable') {
    const topicPart = topic_label ? ` about ${topic_label}` : '';
    contextNote = `[SESSION CONTEXT] This user was looking for a peer to talk to${topicPart} but no peer was available. They have come to you as a bridge. For your opening message, begin with warmth and brief acknowledgment. Do not open with "How are you feeling today?" — let them lead at their own pace.`;
    greeting = `I heard you were looking for someone to connect with${topicPart}. I'm glad you're here. Take your time — we can start wherever feels right.`;
  }

  const { systemPrompt, persona } = await loadSystemPrompt(req.user.id, user, contextNote);

  const { rows: sessionRows } = await query(
    `INSERT INTO sessions (user_id, type, status, is_free_session) VALUES ($1, 'ai', 'active', $2) RETURNING id`,
    [req.user.id, isFree]
  );
  const sessionId = sessionRows[0].id;

  if (isFree) {
    await query('UPDATE users SET free_ai_used_at = NOW() WHERE id = $1', [req.user.id]);
  } else {
    // Atomic increment — guard against concurrent requests bypassing the cap check
    const { rowCount } = await query(
      `UPDATE credits SET ai_conversations_used = ai_conversations_used + 1
       WHERE user_id = $1 AND ai_conversations_used < ai_conversations_cap`,
      [req.user.id]
    );
    if (!rowCount) {
      await query('DELETE FROM sessions WHERE id = $1', [sessionId]).catch(() => {});
      return res.status(402).json({
        error: "You've used your free AI session this week. Get a bundle to unlock more conversations.",
        code: 'AI_CAP_REACHED',
      });
    }
  }

  sessionCache.set(sessionId, { systemPrompt, messages: [], flagCount: 0 });

  return res.status(201).json({ session_id: sessionId, persona_name: persona.persona_name, is_free: isFree, ...(greeting ? { greeting } : {}) });
});

// ─── POST /ai/session/:id/message ─────────────────────────────────────────────
router.post('/session/:id/message', auth, aiMessageLimiter, async (req, res) => {
  const { input_text } = req.body;
  if (!input_text || typeof input_text !== 'string' || input_text.trim().length === 0) {
    return res.status(400).json({ error: 'input_text is required', code: 'MISSING_INPUT' });
  }
  const cleanInput = stripHtml(input_text);
  if (cleanInput.length === 0) {
    return res.status(400).json({ error: 'input_text is required', code: 'MISSING_INPUT' });
  }
  if (cleanInput.length > MAX_INPUT_LEN) {
    return res.status(400).json({ error: `Message must be ${MAX_INPUT_LEN} characters or fewer`, code: 'INPUT_TOO_LONG' });
  }

  // Verify session ownership and active status
  const { rows: sessionRows } = await query(
    'SELECT id, status FROM sessions WHERE id = $1 AND user_id = $2 AND type = $3',
    [req.params.id, req.user.id, 'ai']
  );
  if (!sessionRows.length) return res.status(404).json({ error: 'Session not found', code: 'NOT_FOUND' });
  if (sessionRows[0].status !== 'active') {
    return res.status(409).json({ error: 'Session is not active', code: 'SESSION_ENDED' });
  }

  // Restore before the limit check, or a restart would reset the session message count.
  let sessionData = sessionCache.get(req.params.id);
  if (!sessionData) {
    sessionData = await restoreSession(req.params.id, req.user.id);
    sessionCache.set(req.params.id, sessionData);
  }

  // Rate limits
  if (sessionData.messages.filter((m) => m.role === 'user').length >= AI_SESSION_MSG_LIMIT) {
    return res.status(429).json({ error: 'Session message limit reached (30)', code: 'SESSION_LIMIT' });
  }

  const userId = req.user.id;
  const today = new Date().toDateString();
  const daily = dailyCounters.get(userId) || { count: 0, date: today };
  if (daily.date !== today) { daily.count = 0; daily.date = today; }
  if (daily.count >= AI_DAILY_MSG_LIMIT) {
    return res.status(429).json({ error: 'Daily AI message limit reached (100)', code: 'DAILY_LIMIT' });
  }
  daily.count++;
  dailyCounters.set(userId, daily);

  // ── Daily token limit ─────────────────────────────────────────────────────
  const todayISO = new Date().toISOString().slice(0, 10);
  const tokenKey = `ai_tokens:${userId}:${todayISO}`;
  const tokenCount = (await cache.get(tokenKey)) || 0;
  if (tokenCount >= AI_DAILY_TOKEN_LIMIT) {
    return res.status(429).json({ error: 'Daily AI token limit reached', code: 'TOKEN_LIMIT' });
  }

  // ── Build OBSERVED record ─────────────────────────────────────────────────
  const observedId = uuidv4();
  const observed = {
    record_id:      observedId,
    user_id:        userId,
    source:         'SESSION_MESSAGE',
    created_at:     new Date().toISOString(),
    session_id:     req.params.id,
    content_type:   'TEXT',
    content_ref:    observedId,
    schema_version: '1.0.0',
  };


  const posthogContext = {
    sessionId: req.params.id,
    userId,
    traceId: uuidv4(),
  };

  // ── Run detection pipeline ────────────────────────────────────────────────
  const { detected, sources } = await pipeline.run(cleanInput, observed, {
    sessionContext: sessionData.messages,
    posthogContext,
  });

  // ── Policy decision ───────────────────────────────────────────────────────
  // effectiveUrgency (R7 upshift) is stripped from the DECIDED schema but logged
  // separately in the POLICY_DECISION event (Section 3.11).
  const decidedRaw = policyEngine.decide(detected);
  const decided    = policyEngine.buildDecided(detected);

  // ── CRISIS_RESPONSE: deterministic path — Groq not invoked (Section 3.6) ──
  if (decided.strategy === 'CRISIS_RESPONSE') {
    const crisisGenerated = await generator.generate(decided, {
      systemPrompt: '', messages: [], userMessage: cleanInput, posthogContext,
    });

    const triggerDetail = sources.keyword?._matched_category
      ? `keyword: ${sources.keyword._matched_category}`
      : `risk_signal: ${detected.risk_signal.value}`;

    await Promise.all([
      query(
        `INSERT INTO ai_interactions
           (user_id, session_id, input_text, output_text, flagged, flag_reason)
         VALUES ($1,$2,$3,$4,true,$5)`,
        [userId, req.params.id, cleanInput, crisisGenerated.content, triggerDetail]
      ),
      query(
        `INSERT INTO escalation_logs
           (user_id, session_id, trigger_type, trigger_detail, escalated_to)
         VALUES ($1,$2,'keyword',$3,'emergency')`,
        [userId, req.params.id, triggerDetail]
      ),
      query(
        `INSERT INTO notifications (user_id, type, payload, channel)
         SELECT id, 'emergency_alert', $1, 'in_app'
         FROM users WHERE role = 'admin' AND is_active = true`,
        [JSON.stringify({ source: 'ai_critical', session_id: req.params.id, risk_signal: detected.risk_signal.value })]
      ),
      persistPipelineRecords(req.params.id, userId, observed, detected, decided, crisisGenerated, sources).catch(
        (err) => logger.error('[pipeline:persist] crisis:', err.message)
      ),
    ]);

    logPipelineEvents(userId, req.params.id, detected, decided, sources, decidedRaw.effectiveUrgency);

    return res.status(200).json({
      response_text:      canDeliver(crisisGenerated) ? crisisGenerated.content : null,
      action:             'emergency',
      flagged:            true,
      session_flag_count: sessionData.flagCount,
    });
  }

  // ── Generate response ─────────────────────────────────────────────────────
  const generated = await generator.generate(decided, {
    systemPrompt: sessionData.systemPrompt,
    messages:     sessionData.messages,
    userMessage:  cleanInput,
    posthogContext,
  });
  logGenerationEvent(userId, req.params.id, generated);

  // Delivery guard — FAILED generated output is never returned to the user
  if (!canDeliver(generated)) {
    persistPipelineRecords(req.params.id, userId, observed, detected, decided, generated, sources).catch(
      (err) => logger.error('[pipeline:persist] failed-generation:', err.message)
    );
    logPipelineEvents(userId, req.params.id, detected, decided, sources, decidedRaw.effectiveUrgency);
    return res.status(200).json({
      response_text:      'I want to make sure I respond to you well. Could you share a bit more about what you mean?',
      flagged:            false,
      session_flag_count: sessionData.flagCount,
      action:             null,
    });
  }

  const responseText = generated.content;
  const flagged      = decided.escalation_action !== 'NONE';
  const flagReason   = flagged ? `${decided.escalation_action}: ${decided.reason_code}` : null;

  if (decided.escalation_action === 'ESCALATE_TO_HUMAN') {
    sessionData.flagCount++;
  }

  // ── Token tracking ────────────────────────────────────────────────────────
  const tokensUsed = Math.ceil((cleanInput.length + responseText.length) / 4);
  const midnight   = new Date();
  midnight.setHours(24, 0, 0, 0);
  await Promise.all([
    cache.incrby(tokenKey, tokensUsed, Math.floor(midnight.getTime() / 1000)),
    query(
      `INSERT INTO ai_usage (user_id, date, token_count, message_count)
       VALUES ($1,$2,$3,1)
       ON CONFLICT (user_id, date) DO UPDATE
         SET token_count   = ai_usage.token_count + EXCLUDED.token_count,
             message_count = ai_usage.message_count + 1,
             updated_at    = NOW()`,
      [userId, todayISO, tokensUsed]
    ),
  ]);

  // Update session cache
  sessionData.messages.push({ role: 'user',      content: cleanInput });
  sessionData.messages.push({ role: 'assistant', content: responseText });
  sessionCache.set(req.params.id, sessionData);

  // Persist legacy interaction record (read by session list preview)
  const contextSnapshot = {
    persona_tone:      sessionData.systemPrompt?.match(/tone is (\w+)/)?.[1],
    flag_count:        sessionData.flagCount,
    strategy:          decided.strategy,
    escalation_action: decided.escalation_action,
  };
  await query(
    `INSERT INTO ai_interactions
       (user_id, session_id, input_text, output_text, context_snapshot, flagged, flag_reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [userId, req.params.id, cleanInput, responseText, JSON.stringify(contextSnapshot), flagged, flagReason]
  );

  // Persist pipeline records to audit tables — non-fatal on failure
  persistPipelineRecords(req.params.id, userId, observed, detected, decided, generated, sources).catch(
    (err) => logger.error(err.message)
  );

  // Fire-and-forget observability events
  logPipelineEvents(userId, req.params.id, detected, decided, sources, decidedRaw.effectiveUrgency);

  // Second ESCALATE_TO_HUMAN in session → bump user risk level + admin alert
  if (decided.escalation_action === 'ESCALATE_TO_HUMAN' && sessionData.flagCount >= 2) {
    await query(
      `UPDATE users SET risk_level = CASE
         WHEN risk_level = 'low'    THEN 'medium'
         WHEN risk_level = 'medium' THEN 'high'
         ELSE risk_level END
       WHERE id = $1`,
      [userId]
    );
    await query(
      `INSERT INTO escalation_logs
         (user_id, session_id, trigger_type, trigger_detail, escalated_to)
       VALUES ($1,$2,'repeated_flag',$3,'admin')`,
      [userId, req.params.id, `2nd ESCALATE_TO_HUMAN in session: ${decided.reason_code}`]
    );
    await query(
      `INSERT INTO notifications (user_id, type, payload, channel)
       SELECT id, 'emergency_alert', $1, 'in_app'
       FROM users WHERE role = 'admin' AND is_active = true`,
      [JSON.stringify({ source: 'ai_repeated_flag', session_id: req.params.id, user_alias: req.user.alias })]
    );
  }

  return res.status(200).json({
    response_text:      responseText,
    flagged,
    session_flag_count: sessionData.flagCount,
    action:             null,
  });
});

// ─── GET /ai/sessions ─────────────────────────────────────────────────────────
router.get('/sessions', auth, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;

  const { rows } = await query(
    `SELECT s.id, s.channel, s.status, s.created_at, s.ended_at,
            (SELECT output_text FROM ai_interactions
             WHERE session_id = s.id AND output_text IS NOT NULL
             ORDER BY created_at ASC LIMIT 1) AS preview
     FROM sessions s
     WHERE s.user_id = $1 AND s.type = 'ai'
     ORDER BY s.created_at DESC
     LIMIT $2 OFFSET $3`,
    [req.user.id, limit, offset]
  );
  const { rows: countRows } = await query(
    `SELECT COUNT(*) FROM sessions WHERE user_id = $1 AND type = 'ai'`,
    [req.user.id]
  );
  const total = parseInt(countRows[0].count);

  return res.status(200).json({ sessions: rows, total, page, pages: Math.ceil(total / limit) });
});

// ─── POST /ai/session/:id/end ─────────────────────────────────────────────────
router.post('/session/:id/end', auth, async (req, res) => {
  const { rows } = await query(
    `UPDATE sessions SET status = 'completed', ended_at = NOW()
     WHERE id = $1 AND user_id = $2 AND type = 'ai' RETURNING ended_at`,
    [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Session not found', code: 'NOT_FOUND' });

  // Funnel step hook: first session → step3; second session within 7 days → converted
  try {
    await query(
      `UPDATE users SET
         last_session_at = NOW(),
         first_session_completed_at = COALESCE(first_session_completed_at, NOW()),
         reengagement_step = CASE
           WHEN first_session_completed_at IS NULL THEN 'step3_incomplete'
           WHEN reengagement_step = 'step3_incomplete'
                AND first_session_completed_at >= NOW() - INTERVAL '7 days' THEN 'converted'
           ELSE reengagement_step
         END
       WHERE id = $1`,
      [req.user.id]
    );
  } catch (e) {
    logger.error(e.message);
  }

  const sessionData = sessionCache.get(req.params.id);
  sessionCache.delete(req.params.id);

  // Async summarisation — fire and forget, does not block response
  if (sessionData?.messages?.length >= 4) {
    const sessionId = req.params.id;
    const userId = req.user.id;
    const posthogTraceId = uuidv4();
    const messages = sessionData.messages;
    (async () => {
      try {
        const transcript = messages
          .map((m) => `${m.role === 'user' ? 'User' : 'Companion'}: ${m.content}`)
          .join('\n');
        const result = await getGroq().chat.completions.create({
          model: SUMMARY_MODEL,
          messages: [
            {
              role: 'system',
              content: 'You summarise mental health support conversations for a companion AI to use in future sessions. Write 2–4 sentences in third person. Focus on: emotional themes, what the user shared about their life, what seemed to help, anything important to remember for next time. Omit crisis content and specific advice given. Be factual and concise.',
            },
            { role: 'user', content: transcript },
          ],
          max_tokens: 200 + REASONING_HEADROOM_TOKENS,
          reasoning_effort: 'low',
          ...withPostHogOptions({
            posthogDistinctId: userId,
            posthogTraceId,
            posthogProperties: {
              $ai_session_id: sessionId,
              $ai_provider: 'groq',
            },
          }),
        });
        const summaryText = result.choices[0]?.message?.content?.trim();
        if (summaryText) {
          await query(
            'INSERT INTO ai_memories (user_id, session_id, summary) VALUES ($1, $2, $3)',
            [userId, sessionId, summaryText]
          );
        }
      } catch (err) {
        logger.error('Session summarisation failed:', err.message);
      }
    })();
  }

  return res.status(200).json({ ended_at: rows[0].ended_at });
});

// ─── DELETE /ai/memories ──────────────────────────────────────────────────────
router.delete('/memories', auth, async (req, res) => {
  await query('DELETE FROM ai_memories WHERE user_id = $1', [req.user.id]);
  return res.status(200).json({ cleared: true });
});

// ─── PATCH /ai/persona ───────────────────────────────────────────────────────
// Updates persona fields: tone, response_style, formality, uses_alias, language, persona_name.
const VALID_TONES      = ['warm', 'motivational', 'clinical', 'casual'];
const VALID_STYLES     = ['brief', 'elaborate'];
const VALID_FORMALITY  = ['formal', 'neutral', 'informal'];
const VALID_LANGUAGES  = ['english', 'swahili', 'sheng'];

router.patch('/persona', auth, async (req, res) => {
  const { tone, response_style, formality, uses_alias, language, persona_name } = req.body;

  const updates = [];
  const values  = [];

  if (tone !== undefined) {
    if (!VALID_TONES.includes(tone)) return res.status(400).json({ error: `tone must be one of: ${VALID_TONES.join(', ')}` });
    updates.push(`tone = $${values.length + 1}`);
    values.push(tone);
  }
  if (response_style !== undefined) {
    if (!VALID_STYLES.includes(response_style)) return res.status(400).json({ error: `response_style must be one of: ${VALID_STYLES.join(', ')}` });
    updates.push(`response_style = $${values.length + 1}`);
    values.push(response_style);
  }
  if (formality !== undefined) {
    if (!VALID_FORMALITY.includes(formality)) return res.status(400).json({ error: `formality must be one of: ${VALID_FORMALITY.join(', ')}` });
    updates.push(`formality = $${values.length + 1}`);
    values.push(formality);
  }
  if (uses_alias !== undefined) {
    updates.push(`uses_alias = $${values.length + 1}`);
    values.push(Boolean(uses_alias));
  }
  if (language !== undefined) {
    if (!VALID_LANGUAGES.includes(language)) return res.status(400).json({ error: `language must be one of: ${VALID_LANGUAGES.join(', ')}` });
    updates.push(`language = $${values.length + 1}`);
    values.push(language);
  }
  if (persona_name !== undefined) {
    if (typeof persona_name !== 'string' || persona_name.trim().length === 0) {
      return res.status(400).json({ error: 'persona_name must be a non-empty string' });
    }
    if (persona_name.trim().length > 20) {
      return res.status(400).json({ error: 'persona_name must be 20 characters or fewer' });
    }
    updates.push(`persona_name = $${values.length + 1}`);
    values.push(persona_name.trim());
  }

  if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

  updates.push(`updated_at = NOW()`);
  values.push(req.user.id);

  const { rows } = await query(
    `UPDATE ai_personas SET ${updates.join(', ')} WHERE user_id = $${values.length} RETURNING *`,
    values
  );
  if (!rows.length) return res.status(404).json({ error: 'Persona not found' });

  // Bust the persona cache so the next session picks up changes immediately
  await cache.del(`persona:${req.user.id}`);

  return res.status(200).json({ persona: rows[0] });
});

module.exports = router;
module.exports.restoreSession = restoreSession; // exported for tests/aiCompanion.test.js
