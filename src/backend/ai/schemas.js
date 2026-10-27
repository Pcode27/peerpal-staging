'use strict';

/**
 * AI pipeline schemas — Section 1 of the PeerPal AI Specification.
 *
 * Defines Zod schemas for every stage in the OBSERVED → DETECTED → DECIDED → GENERATED
 * pipeline, plus all controlled enumerations, provenance, and cross-record constraints.
 *
 * All downstream components (resolver, policy engine, generation, audit) import from here.
 * Do not define pipeline types anywhere else.
 */

const { z } = require('zod');

// ─── Schema version ───────────────────────────────────────────────────────────
// Increment MAJOR when any required field is added/removed/renamed or any enum
// value is removed. Increment MINOR for optional additions. Patch for docs only.
const SCHEMA_VERSION = '1.0.0';

// ─── Primitive validators ─────────────────────────────────────────────────────
const UUID = z.string().uuid({ message: 'Must be a valid UUID' });

const SemVer = z.string().regex(
  /^\d+\.\d+\.\d+$/,
  'Must be semver: MAJOR.MINOR.PATCH'
);

const ISOTimestamp = z.string().datetime({ message: 'Must be an ISO 8601 datetime string' });

// Format: <name>@<semver> — e.g. "keyword-classifier@1.0.0" or "groq/llama-3.3-70b@1.0.0"
const VersionPinnedId = z.string().regex(
  /^[^@]+@\d+\.\d+\.\d+$/,
  'Must be version-pinned: name@MAJOR.MINOR.PATCH'
);

// ─── Controlled enumerations ──────────────────────────────────────────────────
// Source: Section 1.7. Changes to any enum require AI_SAFETY_REVIEW.
// Changes to ExpressedEmotion require DUAL_REVIEW.

const ObservedSourceEnum = z.enum([
  'MOOD_ENTRY',
  'JOURNAL',
  'SESSION_MESSAGE',
  'SESSION_EVENT',
  'USER_PROFILE',
  'PEER_CONTEXT',
]);

const ObservedContentTypeEnum = z.enum(['TEXT', 'STRUCTURED', 'MIXED']);

const DetectionStatusEnum = z.enum([
  'INFERRED',       // Produced by classifier; calibrated confidence required
  'DETERMINISTIC',  // Produced by rule-based logic; no confidence
  'NOT_APPLICABLE', // Field not applicable for this input type
]);

const ConfidenceStatusEnum = z.enum([
  'AVAILABLE',      // Confidence value is present; does not imply calibration
  'NOT_APPLICABLE', // Component does not emit confidence for this field
]);

const ExpressedEmotionEnum = z.enum([
  'DISTRESS',
  'SADNESS',
  'ANXIETY',
  'ANGER',
  'POSITIVE',
  'NEUTRAL',
  'MIXED',   // ≥2 emotion classes independently exceed threshold
  'UNCLEAR', // No candidate exceeds threshold — distinct from MIXED
]);

const SupportNeedEnum = z.enum([
  'EMOTIONAL_VALIDATION',
  'PRACTICAL_GUIDANCE',
  'PSYCHOEDUCATION',
  'SAFETY_ESCALATION',
  'PEER_BRIDGE',
  'CHECK_IN',
  'NONE_IDENTIFIED',
]);

const UrgencyEnum = z.enum(['NONE', 'LOW', 'MODERATE', 'HIGH', 'CRITICAL']);

const RiskSignalEnum = z.enum([
  'ABSENT',   // No risk content detected — does NOT confirm safety
  'PRESENT',  // Risk content below escalation threshold
  'ELEVATED', // Requires escalation review
  'CRITICAL', // Deterministic crisis path required
]);

const ResponseStrategyEnum = z.enum([
  'OPEN_SUPPORT',
  'VALIDATION_FOCUS',
  'PSYCHOEDUCATION',
  'GUIDED_EXERCISE',
  'SAFETY_HOLD',
  'CRISIS_RESPONSE',
]);

const EscalationActionEnum = z.enum([
  'NONE',
  'SURFACE_RESOURCES',
  'ESCALATE_TO_HUMAN',
  'DETERMINISTIC_CRISIS',
]);

const ValidationStatusEnum = z.enum(['PASSED', 'SANITIZED', 'FAILED']);

const DetectionReasonCodeEnum = z.enum([
  'KEYWORD_RISK_MATCH',
  'HIGH_CONFIDENCE_DETECTION',
  'LOW_CONFIDENCE_DETECTION',
  'CONFLICTING_SIGNALS',
  'SINGLE_SIGNAL_DOMINANT',
  'NO_SIGNAL_DETECTED',
  'URGENCY_ELEVATED_BY_CONTEXT',
]);

const DecisionReasonCodeEnum = z.enum([
  'POLICY_ESCALATION_TRIGGERED',
  'STRATEGY_BY_SUPPORT_NEED',
  'STRATEGY_CONSTRAINED_BY_SAFETY',
  'FALLBACK_STRATEGY_APPLIED',
  'DEFAULT_STRATEGY_APPLIED',
  'UNCERTAINTY_CONSERVED',
]);

const GenerationViolationEnum = z.enum([
  'RESPONSE_LENGTH_EXCEEDED',
  'PROHIBITED_CONTENT',
  'QUESTION_LIMIT_EXCEEDED',
  'EXERCISE_NOT_PERMITTED',
  'STRATEGY_CONTRACT_BREACH',
  'EMPTY_RESPONSE', // model returned no text (e.g. completion budget spent on reasoning)
]);

// ─── Provenance ───────────────────────────────────────────────────────────────
// Structured reference to the source data that produced a DETECTED field.
// source_type is a controlled ObservedSource value — not a free-form string.
const ProvenanceSchema = z.object({
  source_type: ObservedSourceEnum,
  id: UUID,
});

// ─── DetectedField<T> ─────────────────────────────────────────────────────────
// Factory function producing a typed, versioned, provenance-carrying field schema.
// Every inferred property in a DETECTED record uses this wrapper.
//
// Invariants enforced:
//   - confidence is required when confidence_status = AVAILABLE
//   - uncertainty_flag is required when confidence_status = AVAILABLE
//   - confidence must be null when confidence_status = NOT_APPLICABLE
//   - Presence of confidence does not imply calibration (Section 1, P4)
function DetectedField(valueSchema) {
  return z.object({
    value:             valueSchema,
    status:            DetectionStatusEnum,
    confidence_status: ConfidenceStatusEnum,
    confidence:        z.number().min(0).max(1).nullable(),
    uncertainty_flag:  z.boolean().nullable(),
    provenance:        ProvenanceSchema,
    detector_version:  VersionPinnedId,
    created_at:        ISOTimestamp,
  }).superRefine((data, ctx) => {
    if (data.confidence_status === 'AVAILABLE') {
      if (data.confidence === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['confidence'],
          message: 'confidence is required when confidence_status is AVAILABLE',
        });
      }
      if (data.uncertainty_flag === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['uncertainty_flag'],
          message: 'uncertainty_flag is required when confidence_status is AVAILABLE',
        });
      }
    }
    if (data.confidence_status === 'NOT_APPLICABLE' && data.confidence !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['confidence'],
        message: 'confidence must be null when confidence_status is NOT_APPLICABLE',
      });
    }
  });
}

// ─── OBSERVED ─────────────────────────────────────────────────────────────────
// Source-of-truth pointer to existing user data. Never modified by AI components.
const ObservedSchema = z.object({
  record_id:      UUID,
  user_id:        UUID,
  source:         ObservedSourceEnum,
  created_at:     ISOTimestamp,
  session_id:     UUID.nullable().optional(),
  content_type:   ObservedContentTypeEnum,
  content_ref:    UUID, // Opaque reference — interpretation defined in Section 9
  schema_version: SemVer,
});

// ─── DETECTED_SOURCE ──────────────────────────────────────────────────────────
// Intermediate output of a single classifier, before resolver merging.
// Never consumed by the policy engine directly.

// Risk signal source — output of keyword classifier (DETERMINISTIC) or
// contextual classifier (INFERRED).
const RiskSignalSourceSchema = z.object({
  source_id:        UUID,
  observed_ref:     UUID,
  detector_version: VersionPinnedId,
  detected_at:      ISOTimestamp,
  risk_signal:      DetectedField(RiskSignalEnum),
});

// Conversational state source — output of the Section 4 conversational-state detector.
// expressed_emotion is optional at the source level; the detector may not produce it
// for all input types (e.g. SESSION_EVENT).
const ConversationalStateSourceSchema = z.object({
  source_id:        UUID,
  observed_ref:     UUID,
  detector_version: VersionPinnedId,
  detected_at:      ISOTimestamp,
  support_need:     DetectedField(SupportNeedEnum),
  urgency:          DetectedField(UrgencyEnum),
  expressed_emotion: DetectedField(ExpressedEmotionEnum).nullable().optional(),
});

// ─── Canonical DETECTED ───────────────────────────────────────────────────────
// Assembled by the resolver from DETECTED_SOURCE records. Immutable after write.
// This is what the policy engine reads.
//
// expressed_emotion is optional — absent when no emotion detection was performed
// or when the source record was not produced (e.g. SESSION_EVENT input).
const DetectedSchema = z.object({
  detection_id:      UUID,
  observed_ref:      UUID,
  detector_id:       VersionPinnedId, // Assembly component version
  detected_at:       ISOTimestamp,
  expressed_emotion: DetectedField(ExpressedEmotionEnum).nullable().optional(),
  support_need:      DetectedField(SupportNeedEnum),
  urgency:           DetectedField(UrgencyEnum),
  risk_signal:       DetectedField(RiskSignalEnum),
  reason_code:       DetectionReasonCodeEnum,
  schema_version:    SemVer,
});

// ─── DECIDED ─────────────────────────────────────────────────────────────────
// Deterministic policy engine output. Immutable after write.
// Defines the strategy contract for generation.
const DecidedSchema = z.object({
  decision_id:          UUID,
  detection_ref:        UUID,
  policy_version:       SemVer,
  decided_at:           ISOTimestamp,
  upstream_uncertainty: z.boolean(), // True if any relied-upon DETECTED field had uncertainty_flag=true
  strategy:             ResponseStrategyEnum,
  question_limit:       z.number().int().min(0).max(5),
  must_validate:        z.boolean(),
  may_suggest_exercises: z.boolean(),
  max_response_length:  z.number().int().positive(),
  escalation_action:    EscalationActionEnum,
  reason_code:          DecisionReasonCodeEnum,
  schema_version:       SemVer,
});

// ─── GENERATED ───────────────────────────────────────────────────────────────
// LLM output produced within the constraints of DECIDED.
// FAILED records must never be delivered to the user.
const GeneratedSchema = z.object({
  generation_id:     UUID,
  decision_ref:      UUID,
  model_id:          VersionPinnedId,
  generated_at:      ISOTimestamp,
  content:           z.string().min(1),
  validation_status: ValidationStatusEnum,
  violations:        z.array(GenerationViolationEnum),
  schema_version:    SemVer,
});

// ─── Cross-record constraints ─────────────────────────────────────────────────
// Validates consistency between a canonical DETECTED and a DECIDED record.
// Returns an array of violation strings. Empty array = valid.
//
// Spec ref: Section 1.4, Section 3.7 Rule R3.
function validateCrossRecord(detected, decided) {
  const errors = [];

  // Constraint: SAFETY_ESCALATION support need → escalation_action must not be NONE
  if (
    detected.support_need?.value === 'SAFETY_ESCALATION' &&
    decided.escalation_action === 'NONE'
  ) {
    errors.push(
      'DECIDED.escalation_action must not be NONE when DETECTED.support_need is SAFETY_ESCALATION'
    );
  }

  // Constraint: CRISIS_RESPONSE strategy → escalation_action must be DETERMINISTIC_CRISIS
  if (
    decided.strategy === 'CRISIS_RESPONSE' &&
    decided.escalation_action !== 'DETERMINISTIC_CRISIS'
  ) {
    errors.push(
      'DECIDED.escalation_action must be DETERMINISTIC_CRISIS when strategy is CRISIS_RESPONSE'
    );
  }

  // Constraint: DETERMINISTIC_CRISIS → strategy must be CRISIS_RESPONSE
  if (
    decided.escalation_action === 'DETERMINISTIC_CRISIS' &&
    decided.strategy !== 'CRISIS_RESPONSE'
  ) {
    errors.push(
      'DECIDED.strategy must be CRISIS_RESPONSE when escalation_action is DETERMINISTIC_CRISIS'
    );
  }

  return errors;
}

// ─── Delivery guard ───────────────────────────────────────────────────────────
// Returns true only if a GENERATED record is safe to deliver to the user.
// A FAILED record must never be delivered under any condition.
function canDeliver(generated) {
  return generated.validation_status !== 'FAILED';
}

// ─── Exports ──────────────────────────────────────────────────────────────────
module.exports = {
  SCHEMA_VERSION,

  // Primitives
  UUID,
  SemVer,
  ISOTimestamp,
  VersionPinnedId,

  // Enums
  ObservedSourceEnum,
  ObservedContentTypeEnum,
  DetectionStatusEnum,
  ConfidenceStatusEnum,
  ExpressedEmotionEnum,
  SupportNeedEnum,
  UrgencyEnum,
  RiskSignalEnum,
  ResponseStrategyEnum,
  EscalationActionEnum,
  ValidationStatusEnum,
  DetectionReasonCodeEnum,
  DecisionReasonCodeEnum,
  GenerationViolationEnum,

  // Shared
  ProvenanceSchema,
  DetectedField,

  // Stage schemas
  ObservedSchema,
  RiskSignalSourceSchema,
  ConversationalStateSourceSchema,
  DetectedSchema,
  DecidedSchema,
  GeneratedSchema,

  // Validators
  validateCrossRecord,
  canDeliver,
};
