'use strict';

/**
 * Generates PWA icons for all three portals using the PeerPal brand mark.
 * Brand mark: two figures (sage green + amber) with heartbeat line.
 * Run: node scripts/generate-icons.js
 */

const sharp = require('../src/backend/node_modules/sharp');
const path  = require('path');
const fs    = require('fs');

// ── Brand mark (two-figure logo, viewBox 200×180) ────────────────────────────
const MARK_W = 200;
const MARK_H = 180;

const MARK_ELEMENTS = `
  <circle cx="84" cy="54" r="17" fill="#8FAF9A"/>
  <rect x="57" y="82" width="42" height="65" rx="21" fill="#8FAF9A" transform="rotate(-12 78 114)"/>
  <circle cx="116" cy="54" r="17" fill="#C8943A"/>
  <rect x="101" y="82" width="42" height="65" rx="21" fill="#C8943A" transform="rotate(12 122 114)"/>
  <polyline
    points="68,108 80,108 87,94 94,122 101,108 105,108 112,100 118,116 124,108 136,108"
    fill="none" stroke="#F5EDE4" stroke-width="2.5"
    stroke-linecap="round" stroke-linejoin="round" opacity="0.95"/>
`;

// ── Portals ───────────────────────────────────────────────────────────────────
const PORTALS = [
  {
    name:    'frontend',
    bg:      '#F5EDE4',
    outDir:  path.join(__dirname, '../src/frontend/public'),
  },
  {
    name:    'therapist',
    bg:      '#2F2622',
    outDir:  path.join(__dirname, '../src/therapist/public'),
  },
  {
    name:    'admin',
    bg:      '#1e293b',
    outDir:  path.join(__dirname, '../src/admin/public'),
  },
];

// ── Sizes ─────────────────────────────────────────────────────────────────────
// markFill: fraction of icon width the mark occupies (maskable smaller = safe zone)
const SIZES = [
  { filename: 'pwa-64x64.png',              size: 64,  markFill: 0.65, maskable: false },
  { filename: 'pwa-192x192.png',            size: 192, markFill: 0.65, maskable: false },
  { filename: 'pwa-512x512.png',            size: 512, markFill: 0.65, maskable: false },
  { filename: 'maskable-icon-512x512.png',  size: 512, markFill: 0.50, maskable: true  },
  { filename: 'apple-touch-icon-180x180.png', size: 180, markFill: 0.65, maskable: false },
];

// ── SVG builder ───────────────────────────────────────────────────────────────
function buildSvg(size, bg, markFill) {
  const scale   = (size * markFill) / MARK_W;
  const markPxW = MARK_W * scale;
  const markPxH = MARK_H * scale;
  const tx      = (size - markPxW) / 2;
  const ty      = (size - markPxH) / 2;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${bg}"/>
  <g transform="translate(${tx.toFixed(2)},${ty.toFixed(2)}) scale(${scale.toFixed(4)})">
    ${MARK_ELEMENTS}
  </g>
</svg>`;
}

// ── Generate ──────────────────────────────────────────────────────────────────
async function generate() {
  for (const portal of PORTALS) {
    fs.mkdirSync(portal.outDir, { recursive: true });
    for (const spec of SIZES) {
      const svg  = buildSvg(spec.size, portal.bg, spec.markFill);
      const dest = path.join(portal.outDir, spec.filename);
      await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(dest);
      const kb = (fs.statSync(dest).size / 1024).toFixed(1);
      console.log(`${portal.name.padEnd(10)} ${spec.filename.padEnd(35)} ${kb} KB`);
    }
  }
  console.log('\nDone.');
}

generate().catch(err => { console.error(err); process.exit(1); });
