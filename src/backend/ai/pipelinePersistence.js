'use strict';

const { query, transaction } = require('../db');
const generator = require('./generator');

// ─── Core lineage persistence ─────────────────────────────────────────────────
//
// Writes ai_detected → ai_decided → ai_generated inside a single DB transaction.
// All succeed or all roll back — broken lineage is worse than missing records.
//
// ai_detected_source records (intermediate classifier outputs) are written
// best-effort outside the transaction; their absence does not break the lineage chain.
//
// Throws on transaction failure — caller decides whether to surface or swallow.
async function persistPipelineRecords(sessionId, userId, observed, detected, decided, generated, sources) {
  // ── DETECTED_SOURCE: best-effort, fire-and-forget ─────────────────────────
  const sourceTasks = [];

  if (sources.keyword) {
    const { _matched_keyword, _matched_category, ...kwPayload } = sources.keyword;
    sourceTasks.push(query(
      `INSERT INTO ai_detected_source
         (session_id, user_id, observed_ref, source_type, detector_version, payload, schema_version)
       VALUES ($1,$2,$3,'KEYWORD_RISK',$4,$5,'1.0.0')`,
      [sessionId, userId, observed.record_id, sources.keyword.detector_version, JSON.stringify(kwPayload)]
    ));
  }

  if (sources.conversational) {
    // _fallback retained in payload — DB queries use it to distinguish
    // detector-unavailable (payload._fallback=true) from genuine NONE_IDENTIFIED.
    const { _fallback, _fallback_reason, ...convPayload } = sources.conversational;
    sourceTasks.push(query(
      `INSERT INTO ai_detected_source
         (session_id, user_id, observed_ref, source_type, detector_version, payload, schema_version)
       VALUES ($1,$2,$3,'CONVERSATIONAL_STATE',$4,$5,'1.0.0')`,
      [sessionId, userId, observed.record_id,
       sources.conversational.detector_version,
       JSON.stringify({ ...convPayload, _fallback: !!_fallback })]
    ));
  }

  Promise.all(sourceTasks).catch(
    (err) => console.error('[pipeline:persist:sources]', err.message)
  );

  // ── Core lineage: transactional ───────────────────────────────────────────
  await transaction(async (client) => {
    await client.query(
      `INSERT INTO ai_detected
         (detection_id, session_id, user_id, observed_ref, detector_id, detected_at,
          risk_signal, support_need, urgency, expressed_emotion, reason_code, schema_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'1.0.0')`,
      [
        detected.detection_id, sessionId, userId, detected.observed_ref,
        detected.detector_id, detected.detected_at,
        JSON.stringify(detected.risk_signal),
        JSON.stringify(detected.support_need),
        JSON.stringify(detected.urgency),
        detected.expressed_emotion ? JSON.stringify(detected.expressed_emotion) : null,
        detected.reason_code,
      ]
    );

    await client.query(
      `INSERT INTO ai_decided
         (decision_id, session_id, user_id, detection_ref, policy_version, decided_at,
          upstream_uncertainty, strategy, question_limit, must_validate,
          may_suggest_exercises, max_response_length, escalation_action, reason_code, schema_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'1.0.0')`,
      [
        decided.decision_id, sessionId, userId, decided.detection_ref,
        decided.policy_version, decided.decided_at,
        decided.upstream_uncertainty, decided.strategy,
        decided.question_limit, decided.must_validate,
        decided.may_suggest_exercises, decided.max_response_length,
        decided.escalation_action, decided.reason_code,
      ]
    );

    await client.query(
      `INSERT INTO ai_generated
         (generation_id, session_id, user_id, decision_ref, model_id, generated_at,
          content, validation_status, violations, flagged, schema_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'1.0.0')`,
      [
        generated.generation_id, sessionId, userId, generated.decision_ref,
        generated.model_id, generated.generated_at,
        generated.content, generated.validation_status,
        JSON.stringify(generated.violations),
        generated.validation_status === 'FAILED',
      ]
    );
  });
}

// ─── Observability events ─────────────────────────────────────────────────────
//
// Fire-and-forget. Failures are logged as structured JSON so ops tooling
// (Sentry, log aggregators) can track event write failure rates and alert.
// effectiveUrgency = R7 upshift value, stripped from DECIDED schema.
function logPipelineEvents(userId, sessionId, detected, decided, sources, effectiveUrgency) {
  const log = (name, props) =>
    query(
      `INSERT INTO events (user_id, event_name, properties) VALUES ($1,$2,$3)`,
      [userId, name, JSON.stringify(props)]
    ).catch((err) => {
      console.error(JSON.stringify({
        level:      'error',
        msg:        'pipeline_event_write_failed',
        event_name: name,
        session_id: sessionId,
        error:      err.message,
      }));
    });

  if (sources.keyword) {
    log('KEYWORD_CLASSIFICATION', {
      session_id:       sessionId,
      detection_id:     detected.detection_id,
      risk_signal:      sources.keyword.risk_signal.value,
      detector_version: sources.keyword.detector_version,
    });
  }

  if (sources.conversational?._fallback) {
    log('DETECTION_FALLBACK_APPLIED', {
      session_id:    sessionId,
      detection_id:  detected.detection_id,
      reason:        sources.conversational._fallback_reason,
      fields_zeroed: { support_need: 'NONE_IDENTIFIED', urgency: 'NONE', expressed_emotion: null },
    });
  }

  log('POLICY_DECISION', {
    session_id:           sessionId,
    decision_id:          decided.decision_id,
    detection_id:         detected.detection_id,
    strategy:             decided.strategy,
    escalation_action:    decided.escalation_action,
    upstream_uncertainty: decided.upstream_uncertainty,
    effective_urgency:    effectiveUrgency,
    policy_version:       decided.policy_version,
    reason_code:          decided.reason_code,
  });

  if (decided.strategy === 'CRISIS_RESPONSE') {
    log('CRISIS_PATH_INVOKED', {
      session_id:              sessionId,
      decision_id:             decided.decision_id,
      crisis_template_version: generator.CRISIS_TEMPLATE_VERSION,
    });
  }
}

// One row per LLM generation: which model actually answered, why it stopped, and how much
// of the budget went to reasoning. Read by scripts/ai_health_report.js. Crisis template
// replies carry no telemetry and are skipped. Never includes message content.
function logGenerationEvent(userId, sessionId, generated) {
  if (!generated?._telemetry) return;
  query(
    `INSERT INTO events (user_id, event_name, properties) VALUES ($1,$2,$3)`,
    [userId, 'GENERATION_COMPLETED', JSON.stringify({
      session_id:        sessionId,
      generation_id:     generated.generation_id,
      validation_status: generated.validation_status,
      violations:        generated.violations,
      content_length:    generated.content.length,
      ...generated._telemetry,
    })]
  ).catch((err) => {
    console.error(JSON.stringify({ level: 'error', msg: 'pipeline_event_write_failed', event_name: 'GENERATION_COMPLETED', session_id: sessionId, error: err.message }));
  });
}

module.exports = { persistPipelineRecords, logPipelineEvents, logGenerationEvent };
