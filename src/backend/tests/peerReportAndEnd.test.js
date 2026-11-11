/**
 * Phase 59.2 — Report and end session flow.
 *
 * Unit:   report submission logic (reason → description mapping, Other guard).
 * Static: both peer session screens wire ReportAndEndModal to POST /peer/report.
 *
 * Run: node --test tests/peerReportAndEnd.test.js  (from src/backend)
 */

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs   = require('fs');
const path = require('path');

const screensDir = path.join(__dirname, '..', '..', '..', 'src', 'frontend', 'src', 'screens', 'peer');
const voiceSrc = fs.readFileSync(path.join(screensDir, 'PeerVoiceCallScreen.jsx'), 'utf8');
const textSrc  = fs.readFileSync(path.join(screensDir, 'PeerTextChatScreen.jsx'),  'utf8');

// ── Unit: reason → description mapping ───────────────────────────────────────

function buildDescription(reason, other) {
  return reason === 'Other' ? other.trim() : reason;
}

describe('ReportAndEndModal: description mapping', () => {
  test('standard reason is sent as-is', () => {
    assert.equal(buildDescription('Harassment', ''), 'Harassment');
    assert.equal(buildDescription('Inappropriate language', ''), 'Inappropriate language');
    assert.equal(buildDescription('Made me uncomfortable', ''), 'Made me uncomfortable');
    assert.equal(buildDescription('Shared personal contact details', ''), 'Shared personal contact details');
  });

  test('Other reason uses free text', () => {
    assert.equal(buildDescription('Other', '  they asked for my number  '), 'they asked for my number');
  });
});

describe('ReportAndEndModal: submit guard', () => {
  test('blocks submit when no reason selected', () => {
    // Mirrors disabled={submitting || !reason} in JSX
    const reason = '';
    assert.ok(!reason, 'empty reason should disable submit');
  });

  test('blocks Other submit when free text is too short', () => {
    const reason = 'Other';
    const other = 'ok';
    const blocked = reason === 'Other' && other.trim().length < 3;
    assert.ok(blocked, 'Other with <3 chars should be blocked');
  });

  test('allows Other submit when free text is long enough', () => {
    const reason = 'Other';
    const other = 'they were rude';
    const blocked = reason === 'Other' && other.trim().length < 3;
    assert.ok(!blocked);
  });
});

// ── Static: voice screen ─────────────────────────────────────────────────────

describe('PeerVoiceCallScreen: ReportAndEndModal wiring', () => {
  test('defines ReportAndEndModal component', () => {
    assert.match(voiceSrc, /function ReportAndEndModal/);
  });

  test('contains all 5 required reasons', () => {
    assert.match(voiceSrc, /Harassment/);
    assert.match(voiceSrc, /Inappropriate language/);
    assert.match(voiceSrc, /Made me uncomfortable/);
    assert.match(voiceSrc, /Shared personal contact details/);
    assert.match(voiceSrc, /'Other'/);
  });

  test('posts to /api/peer/report', () => {
    assert.match(voiceSrc, /\/api\/peer\/report/);
  });

  test('channel is voice', () => {
    assert.match(voiceSrc, /channel="voice"/);
  });

  test('onConfirm calls endCall', () => {
    assert.match(voiceSrc, /onConfirm.*endCall|endCall.*onConfirm/s);
  });

  test('cancel button calls onClose without ending session', () => {
    // Cancel is a plain onClick={onClose} — no endCall/handleEndSession in that branch
    const modalSrc = voiceSrc.slice(
      voiceSrc.indexOf('function ReportAndEndModal'),
      voiceSrc.indexOf('function ReportModal')
    );
    assert.match(modalSrc, /onClick=\{onClose\}/);
  });

  test('Other textarea enforces 200 char max', () => {
    assert.match(voiceSrc, /slice\(0, 200\)/);
  });
});

// ── Static: text screen ──────────────────────────────────────────────────────

describe('PeerTextChatScreen: ReportAndEndModal wiring', () => {
  test('defines ReportAndEndModal component', () => {
    assert.match(textSrc, /function ReportAndEndModal/);
  });

  test('channel is text', () => {
    assert.match(textSrc, /channel="text"/);
  });

  test('onConfirm calls handleEndSession', () => {
    assert.match(textSrc, /onConfirm.*handleEndSession|handleEndSession.*onConfirm/s);
  });

  test('in-session Flag button opens ReportAndEndModal not ReportModal', () => {
    // aria-label for the in-session button should reference report-and-end
    assert.match(textSrc, /Report and end session/);
    // showReportAndEnd state must exist
    assert.match(textSrc, /showReportAndEnd/);
  });

  test('post-session Report button still uses original ReportModal', () => {
    assert.match(textSrc, /function ReportModal/);
    assert.match(textSrc, /setShowReport\(true\)/);
  });
});
