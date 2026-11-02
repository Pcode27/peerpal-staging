// Profile "Refer a Friend" link box legibility.
//  Bug: the box used --color-bg-primary (#FAF6F2) as its background, but .card redefines
//  --color-text-primary to cream (#F5EDE4) for its dark surface, so the link was cream on cream.
// The test resolves the box's real colors from the CSS tokens (with the .card overrides
// applied) and checks WCAG AA contrast (4.5:1) for the link and the Copy / Copied labels.
// Run: npm test   (from src/frontend)
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8');

function tokens(css) {
  const out = {};
  for (const [, k, v] of css.matchAll(/(--color-[\w-]+)\s*:\s*([^;]+);/g)) out[k] ??= v.trim();
  return out;
}

// :root tokens, then the .card block overrides from index.css (what children of .card see).
const root = tokens(read('../src/styles/globals.css').match(/:root\s*\{([\s\S]*?)\}/)[1]);
const cardOverrides = tokens(read('../src/index.css').match(/^\.card,[\s\S]*?\{([\s\S]*?)\}/m)[1]);
const inCard = { ...root, ...cardOverrides };

function resolve(value, scope) {
  const m = value.match(/^var\((--[\w-]+)\)$/);
  return m ? resolve(scope[m[1]], scope) : value;
}

function rgb(hex) {
  const h = hex.replace('#', '');
  return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
}
function luminance(hex) {
  const [r, g, b] = rgb(hex).map(c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// The copy button's inline style in ProfileScreen.jsx.
const profile = read('../src/screens/ProfileScreen.jsx');
const button = profile.slice(profile.indexOf('onClick={handleCopyReferral}'), profile.indexOf('{referralStats.total_referred}'));
const styleValue = (prop) => button.match(new RegExp(`${prop}: '(var\\(--[\\w-]+\\)|#[0-9A-Fa-f]{6})'`))[1];

describe('Refer a Friend link box contrast', () => {
  const bg = resolve(styleValue('background'), inCard);

  test('referral link text is legible on the box background', () => {
    const fg = resolve(styleValue('color'), inCard);
    const ratio = contrast(fg, bg);
    assert.ok(ratio >= 4.5, `link ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs 4.5:1`);
  });

  test('Copy and Copied labels are legible on the box background', () => {
    for (const token of ['var(--color-accent)', 'var(--color-calm)']) {
      assert.ok(button.includes(token), `${token} still used in the button`);
      const fg = resolve(token, inCard);
      const ratio = contrast(fg, bg);
      assert.ok(ratio >= 4.5, `${token} ${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs 4.5:1`);
    }
  });
});
