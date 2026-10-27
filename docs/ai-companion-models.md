# AI companion: models, budgets, health

Provider: Groq (decision 2026-10-27). All model choice lives in `src/backend/ai/models.js`.

## Models

| Task | Env var | Default | Used by |
|---|---|---|---|
| Reply generation | `GROQ_PRIMARY_MODEL` | `openai/gpt-oss-120b` | `ai/generator.js` |
| Generation fallback | `GROQ_FALLBACK_MODEL` | `openai/gpt-oss-20b` | `ai/generator.js` |
| Message detector | `GROQ_DETECTION_MODEL` | `openai/gpt-oss-20b` (then retries on the generation model) | `ai/conversationalDetector.js` |
| Session memory summary | `GROQ_SUMMARY_MODEL` | `openai/gpt-oss-20b` | `routes/ai.js` `/session/:id/end` |

An env var set to a model in `RETIRED_MODELS` is ignored with a `[ai:models]` warning, so a stale
Render setting cannot break a task. When Groq retires a model
(console.groq.com/docs/deprecations), add it to `RETIRED_MODELS` and, if it is a default, change
the default to Groq's named replacement. `tests/aiCompanion.test.js` fails if any default is retired.

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
