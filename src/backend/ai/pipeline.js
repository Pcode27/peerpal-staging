'use strict';

const keywordClassifier      = require('./keywordClassifier');
const conversationalDetector = require('./conversationalDetector');
const resolver               = require('./resolver');

/**
 * Detection pipeline orchestrator.
 * Runs the keyword classifier (sync) and conversational-state detector (async) in parallel,
 * then passes both DETECTED_SOURCE records to the resolver to produce canonical DETECTED.
 *
 * The contextual risk classifier (Section 3.5) is not yet implemented; contextualSource
 * is always null at this stage. The resolver handles this per Section 3.5.1.
 *
 * @param {string} text     - Sanitized message text
 * @param {object} observed - ObservedSchema record
 * @param {object} options
 * @param {Array}  options.sessionContext - Prior session messages [{role, content}]
 * @returns {{ detected, sources }}
 *   detected: canonical DETECTED record (DetectedSchema-shaped)
 *   sources: { keyword, conversational } for persistence and observability logging
 *            Strip _fallback, _fallback_reason, _matched_keyword, _matched_category
 *            before writing to ai_detected_source.
 */
async function run(text, observed, { sessionContext = [], posthogContext } = {}) {
  // Keyword classifier is synchronous; conversational detector is async.
  // Start both simultaneously — no causal dependency between them.
  let keywordSource = null;
  const keywordPromise = new Promise((resolve) => {
    try {
      resolve(keywordClassifier.run(text, observed));
    } catch (err) {
      // FAIL_CLOSED: classifier unavailable → null → resolver applies ELEVATED (Section 3.10)
      console.error('[pipeline] keyword classifier failed:', err.message);
      resolve(null);
    }
  });

  const [kwSrc, convSrc] = await Promise.all([
    keywordPromise,
    conversationalDetector.run(text, observed, { sessionContext, posthogContext }),
  ]);

  keywordSource = kwSrc;

  const detected = resolver.resolve({
    keywordSource,
    contextualSource:     null, // Section 3.5 contextual risk classifier: not yet implemented
    conversationalSource: convSrc,
    observed,
  });

  return {
    detected,
    sources: {
      keyword:        keywordSource,
      conversational: convSrc,
    },
  };
}

module.exports = { run };
