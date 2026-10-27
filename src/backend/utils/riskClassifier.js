// Blueprint section 9.3 — keyword risk classifier
// classify(text) → { severity: 'critical'|'high'|'medium', category, keyword } or null
//
// This is the deterministic floor. Meaning-based detection is ai/contextualRiskClassifier.js;
// the resolver takes the higher of the two. Keep phrases precise: a match here can only raise
// the response (medium surfaces the crisis line), so a broad phrase means false alarms.
// Changes require re-running evals/riskClassifier.eval.js.

const KEYWORDS = {
  critical: [
    // Self-harm ideation
    { category: 'self_harm', keywords: [
      'hurt myself','hurting myself','cut myself','cutting myself','self harm','self-harm',
      'end it all','ending it all','don\'t want to be here','dont want to be here',
      'want to disappear','wish i was dead',
    ]},
    // Suicidal ideation
    { category: 'suicidal_ideation', keywords: [
      'kill myself','killing myself','want to die','wanted to die','suicide','suicidal',
      'no reason to live','end my life','ending my life','take my life','rather be dead',
      'better off dead','thinking of suicide',
      // Swahili: "I want to kill myself", "I will kill myself", "I want to die", "I don't want to live"
      'nataka kujiua','nitajiua','nataka kufa','sitaki kuishi',
    ]},
  ],
  high: [
    // Abuse disclosure
    { category: 'abuse_disclosure', keywords: [
      'being abused','he hits me','she hits me','they hurt me','being hurt by',
      'domestic violence','sexual abuse','being assaulted','he abuses me',
    ]},
    // Severe distress
    { category: 'severe_distress', keywords: [
      'can\'t cope','cannot cope','falling apart','breaking down','losing my mind',
      'completely broken','can\'t go on','cannot go on','giving up on life',
      'no way out','feel trapped','absolutely hopeless',
    ]},
    // Substance crisis
    { category: 'substance_crisis', keywords: [
      'overdose','took too many','took too much','drunk and scared',
      'mixed pills','swallowed a lot','can\'t stop drinking',
    ]},
    // Passive ideation: no stated intent, but needs a human path (spec 3.5 PASSIVE_IDEATION)
    { category: 'passive_ideation', keywords: [
      'better off without me','better off if i was gone','better off if i wasn\'t here',
      'wish i could sleep forever','tired of living','no point in living','no point living',
      'burden to everyone','don\'t want to exist','dont want to exist',
      // Swahili: "I'm tired of life"
      'nimechoka na maisha',
    ]},
  ],
  medium: [
    // Moderate distress
    { category: 'moderate_distress', keywords: [
      // Everyday-stress phrases ('can't sleep', 'so anxious', 'really struggling',
      // 'totally overwhelmed', 'can't handle') removed 2026-10-27: they put the crisis line on
      // ordinary bad weeks. The contextual classifier now judges them by meaning.
      'feel hopeless','feeling hopeless','so depressed','very depressed','feel worthless',
      'exhausted and sad','nothing matters','what\'s the point',
    ]},
  ],
};

function classify(text) {
  if (!text || typeof text !== 'string') return null;
  const lower = text.toLowerCase();

  for (const severity of ['critical', 'high', 'medium']) {
    for (const group of KEYWORDS[severity]) {
      for (const keyword of group.keywords) {
        if (lower.includes(keyword)) {
          return { severity, category: group.category, keyword };
        }
      }
    }
  }
  return null;
}

module.exports = { classify };
