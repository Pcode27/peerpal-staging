# AI companion: models, budgets, health

Provider: Groq (decision 2026-10-27). All model choice lives in `src/backend/ai/models.js`.

## Models

| Task | Env var | Default | Used by |
|---|---|---|---|
| Reply generation | `GROQ_PRIMARY_MODEL` | `openai/gpt-oss-120b` | `ai/generator.js` |
| Generation fallback | `GROQ_FALLBACK_MODEL` | `openai/gpt-oss-20b` | `ai/generator.js` |
| Message detector | `GROQ_DETECTION_MODEL` | `openai/gpt-oss-20b` (then retries on the generation model) | `ai/conversationalDetector.js` |
| Contextual risk classifier | `GROQ_RISK_MODEL` | `openai/gpt-oss-120b` (then retries on `gpt-oss-20b`) | `ai/contextualRiskClassifier.js` |
| Session memory summary | `GROQ_SUMMARY_MODEL` | `openai/gpt-oss-20b` | `routes/ai.js` `/session/:id/end` |

An env var set to a model in `RETIRED_MODELS` is ignored with a `[ai:models]` warning, so a stale
Render setting cannot break a task. When Groq retires a model
(console.groq.com/docs/deprecations), add it to `RETIRED_MODELS` and, if it is a default, change
the default to Groq's named replacement. `tests/aiCompanion.test.js` fails if any default is retired.

## Crisis detection

Three detectors run in parallel on every message (`ai/pipeline.js`):

1. **Keyword floor** (`utils/riskClassifier.js`): deterministic phrases. Can only raise the response.
   Everyday-stress phrases (`can't sleep`, `so anxious`, ...) were removed 2026-10-27 because they put
   the crisis line on ordinary bad weeks; passive-ideation phrases (English + Swahili) were added.
   The same list flags journals, vents and group posts (`high` holds a group post for review).
2. **Contextual risk classifier** (`ai/contextualRiskClassifier.js`, spec 3.5): an LLM reads the
   message with the last 6 turns and returns a level (ABSENT / PRESENT / ELEVATED / CRITICAL) and a
   pattern (EXPLICIT, INDIRECT_DISTRESS, PASSIVE_IDEATION, DECLINING_DISCLOSURE, REPEATED_SIGNAL).
   Code enforces that the three ideation patterns are at least ELEVATED (`PATTERN_FLOOR`; the model
   named them correctly but under-levelled 5 of 16 risk cases). If it is unavailable, the keyword
   result is used and a `CLASSIFIER_FAILURE` event is written.
3. **Conversational detector**: support need, urgency, emotion (strategy routing; `SAFETY_ESCALATION`
   surfaces resources).

The resolver takes the higher risk level; policy maps CRITICAL to the deterministic crisis template
(LLM not called), ELEVATED to escalate-to-human, PRESENT to surfacing resources.

**Eval** (paid, live Groq; run before changing the risk prompt, keyword list, thresholds or models):

```
cd src/backend && npm run eval:risk
```

Cases: `evals/risk_cases.json` (indirect, Swahili/Sheng, minimising after disclosure, repeated
signal, explicit; idioms and everyday stress that must not alarm). Thresholds: risk recall ≥ 93%,
every explicit case at least escalated, false alarms ≤ 15%. Add every real miss or false alarm.

2026-10-27 result: risk recall 100% (keyword-only: 6%), explicit cases 100% to the crisis template,
false alarms 0%.

## Token budgets

gpt-oss models reason before answering and spend reasoning tokens from the same completion budget.
Every call therefore asks for the visible answer plus `REASONING_HEADROOM_TOKENS` (1024) with
`reasoning_effort: 'low'`. Reply length is enforced on the text (`validateContent` + `truncate`),
not by limiting tokens. Live use at `low` was 9-36 reasoning tokens (smoke test 2026-10-27), so the
headroom guards against a starved or empty reply; it is not what controls reply length.

Live smoke test 2026-10-27 (10 messages, `gpt-oss-120b` + `gpt-oss-20b`): detector fallback 0/10,
average reply 203 chars (`elaborate` persona) / 175 (`brief`), all `finish_reason: stop`.

An empty completion is `FAILED` / `EMPTY_RESPONSE`; the user gets the route's safe clarifying line,
never a blank bubble or the sanitizer's stock phrase.

## Session history

`sessionCache` is in-process. On a miss (restart, redeploy, second instance) `restoreSession`
rebuilds history and the escalation flag count from `ai_interactions` and the full system prompt
(persona, moods, memories, age, condition) before the 30-message limit is checked.

## Health

```
cd src/backend && npm run ai:health -- 7
```

Aggregates only (no message content). Sources: `ai_detected_source` and the `events` rows
`DETECTION_FALLBACK_APPLIED` and `GENERATION_COMPLETED` (model, finish_reason, reasoning tokens,
content length; one per LLM generation).

Baseline before the fix (2026-09-14 to 2026-10-27, 36 messages, 3 users in the last 30 days):

| Metric | Baseline | Target |
|---|---|---|
| Detector fallback | 100% (`llama-3.1-8b-instant` 404, shut down 2026-08-16) | ~0% |
| Average reply | 90 chars (max 170, limit 600) | 200+ |
| Replies stopped by token limit | not recorded | ~0% |
