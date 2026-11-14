// AI companion health: detector fallback rate, reply length, why generations stopped.
// Aggregates only; never selects message content.
// Usage: node scripts/ai_health_report.js [days=7]   (from src/backend)
//
// Targets after fix/ai-companion-wiring deploys (baseline 2026-09-14..10-27 in brackets):
//   detector_fallback_pct  -> ~0      [100%: 36/36, model 404]
//   avg_reply_chars        -> 200+    [90]
//   finish_length_pct      -> ~0      [not recorded before]

function pct(n, d) {
  return d ? Math.round((1000 * n) / d) / 10 : null;
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// rows: { detections, fallbacks, fallback_reasons: [{reason, n}], generations: [{model, finish_reason,
//         validation_status, content_length, reasoning_tokens, fallback_used}] }
function summarize({ detections, fallbacks, fallback_reasons = [], generations = [] }) {
  const lengths  = generations.filter(g => g.validation_status !== 'FAILED').map(g => g.content_length);
  const byModel  = {};
  for (const g of generations) byModel[g.model] = (byModel[g.model] || 0) + 1;
  const reasoning = generations.map(g => g.reasoning_tokens).filter(n => typeof n === 'number');
  return {
    detections,
    detector_fallback_pct: pct(fallbacks, detections),
    top_fallback_reasons:  fallback_reasons.slice(0, 3),
    generations:           generations.length,
    failed_pct:            pct(generations.filter(g => g.validation_status === 'FAILED').length, generations.length),
    empty_pct:             pct(generations.filter(g => g.content_length === 0).length, generations.length),
    finish_length_pct:     pct(generations.filter(g => g.finish_reason === 'length').length, generations.length),
    generation_fallback_pct: pct(generations.filter(g => g.fallback_used).length, generations.length),
    avg_reply_chars:       lengths.length ? Math.round(lengths.reduce((a, b) => a + b, 0) / lengths.length) : null,
    median_reply_chars:    median(lengths),
    median_reasoning_tokens: median(reasoning),
    models:                byModel,
  };
}

async function main(days) {
  require('dotenv').config();
  const { query } = require('../db');
  const since = `now() - ($1 || ' days')::interval`;
  const { rows: [d] } = await query(
    `SELECT count(*)::int detections,
            count(*) FILTER (WHERE (payload->>'_fallback')::boolean)::int fallbacks
     FROM ai_detected_source WHERE source_type = 'CONVERSATIONAL_STATE' AND detected_at > ${since}`, [days]);
  const { rows: fallback_reasons } = await query(
    `SELECT left(properties->>'reason', 160) reason, count(*)::int n FROM events
     WHERE event_name = 'DETECTION_FALLBACK_APPLIED' AND created_at > ${since}
     GROUP BY 1 ORDER BY 2 DESC`, [days]);
  const { rows: generations } = await query(
    `SELECT properties->>'model' model, properties->>'finish_reason' finish_reason,
            properties->>'validation_status' validation_status,
            (properties->>'content_length')::int content_length,
            (properties->>'reasoning_tokens')::int reasoning_tokens,
            (properties->>'fallback_used')::boolean fallback_used
     FROM events WHERE event_name = 'GENERATION_COMPLETED' AND created_at > ${since}`, [days]);
  console.log(`AI companion health, last ${days} days`);
  console.log(JSON.stringify(summarize({ ...d, fallback_reasons, generations }), null, 2));
}

if (require.main === module) {
  main(String(parseInt(process.argv[2], 10) || 7))
    .then(() => process.exit(0))
    .catch((err) => { console.error(err.message); process.exit(1); });
}

module.exports = { summarize };
