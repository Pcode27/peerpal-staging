'use strict';

const keywordClassifier        = require('./keywordClassifier');
const contextualRiskClassifier = require('./contextualRiskClassifier');
const conversationalDetector   = require('./conversationalDetector');
const resolver                 = require('./resolver');

/**
 * Detection pipeline orchestrator.
 * Runs the keyword classifier (sync), the contextual risk classifier (async, Section 3.5) and
 * the conversational-state detector (async) in parallel, then passes the DETECTED_SOURCE
 * records to the resolver to produce canonical DETECTED. The resolver takes the higher risk
 * severity of keyword and contextual, so keywords remain a deterministic floor.
 *
 * @param {string} text     - Sanitized message text
 * @param {object} observed - ObservedSchema record
 * @param {object} options
 * @param {Array}  options.sessionContext - Prior session messages [{role, content}]
 * @returns {{ detected, sources }}
 *   detected: canonical DETECTED record (DetectedSchema-shaped)
 *   sources: { keyword, contextual, contextualError, conversational } for persistence and
 *            observability logging. contextual is null when the classifier was unavailable
 *            (contextualError holds the reason). Strip _fallback, _fallback_reason,
 *            _matched_keyword, _matched_category, _pattern, _model before writing to
 *            ai_detected_source.
 */
async function run(text, observed, { sessionContext = [], posthogContext } = {}) {
  // No causal dependency between the three; start them simultaneously.
  const keywordPromise = new Promise((resolve) => {
    try {
      resolve(keywordClassifier.run(text, observed));
    } catch (err) {
      // FAIL_CLOSED: classifier unavailable → null → resolver applies ELEVATED (Section 3.10)
      console.error('[pipeline] keyword classifier failed:', err.message);
      resolve(null);
    }
  });
  const contextualPromise = contextualRiskClassifier
    .run(text, observed, { sessionContext, posthogContext })
    .catch((err) => ({ _unavailable: true, _reason: `CLASSIFIER_UNAVAILABLE: ${err.message}` }));

  const [keywordSource, ctxResult, convSrc] = await Promise.all([
    keywordPromise,
    contextualPromise,
    conversationalDetector.run(text, observed, { sessionContext, posthogContext }),
  ]);

  // Section 3.5: an unavailable contextual classifier means its source is absent.
  const contextualSource = ctxResult?._unavailable ? null : ctxResult;

  const detected = resolver.resolve({
    keywordSource,
    contextualSource,
    conversationalSource: convSrc,
    observed,
  });

  return {
    detected,
    sources: {
      keyword:         keywordSource,
      contextual:      contextualSource,
      contextualError: ctxResult?._unavailable ? ctxResult._reason : null,
      conversational:  convSrc,
    },
  };
}

module.exports = { run };
