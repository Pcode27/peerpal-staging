require('dotenv').config();
require('express-async-errors'); // patches Express 4 to forward async throws to the global error handler
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const pinoHttp = require('pino-http');
const logger = require('./utils/logger');
const { apiLimiter } = require('./middleware/rateLimit');
const { Sentry } = require('./services/sentry');
const { buildInfo } = require('./utils/buildInfo');

const app = express();

// Trust Render/Vercel reverse proxy so rate limiter can read real client IP
app.set('trust proxy', 1);

// ─── HTTP request logging ─────────────────────────────────────────────────────
app.use(pinoHttp({
  logger,
  // Use existing requestId from middleware below (assigned before pinoHttp runs if order matters,
  // but pinoHttp assigns req.id first — we copy to req.requestId after)
  genReqId: (req) => req.headers['x-request-id'] || require('crypto').randomUUID(),
  // Skip health-check noise in logs
  autoLogging: {
    ignore: (req) => req.url === '/health' || req.url === '/health/db',
  },
  customLogLevel: (_req, res) => {
    if (res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
  customErrorMessage: (req, res) => `${req.method} ${req.url} ${res.statusCode}`,
}));

// ─── Security & parsing ───────────────────────────────────────────────────────
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    directives: {
      defaultSrc:     ["'self'"],
      scriptSrc:      ["'self'"],
      styleSrc:       ["'self'", "'unsafe-inline'"],
      imgSrc:         ["'self'", 'data:', 'https:'],
      connectSrc:     ["'self'", 'https:', 'wss:'],
      fontSrc:        ["'self'", 'https:'],
      objectSrc:      ["'none'"],
      frameSrc:       ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// CORS — explicit allowlist + Vercel preview subdomains
// Localhost ports are always allowed (can't be remotely spoofed) so local dev
// works regardless of whether FRONTEND_URL is set to production values.
const DEV_ORIGINS = ['http://localhost:5173', 'http://localhost:4173', 'http://localhost:5174', 'http://localhost:5175', 'http://localhost:5176'];
const ALLOWED_ORIGINS = process.env.FRONTEND_URL
  ? [...process.env.FRONTEND_URL.split(',').map((o) => o.trim()), ...DEV_ORIGINS]
  : DEV_ORIGINS;

const VERCEL_PREVIEW_RE = /^https:\/\/[a-z0-9-]+-iamparodys-projects\.vercel\.app$/;
// Public marketing / waitlist site — only POSTs the anonymous waitlist endpoint, no credentials.
const MARKETING_ORIGINS = ['https://peer-pal.com', 'https://www.peer-pal.com'];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    if (MARKETING_ORIGINS.includes(origin)) return cb(null, true);
    if (VERCEL_PREVIEW_RE.test(origin)) return cb(null, true);
    cb(null, false);
  },
  credentials: true,
}));

// Daraja M-Pesa callback — parsed JSON, no raw body needed (Paystack removed)
// Capture raw body before parsing — needed for Paystack HMAC webhook verification
app.use(express.json({
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// ─── Request ID — copy pino-http's req.id → req.requestId for route code ────
app.use((req, res, next) => {
  req.requestId = req.id;
  res.setHeader('X-Request-Id', req.id);
  next();
});

// ─── General rate limit ───────────────────────────────────────────────────────
app.use('/api', apiLimiter);

// ─── Health checks ────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ service: 'peerpal-backend', status: 'ok' }));

app.get('/health', async (_req, res) => {
  try {
    const { query, poolMetrics } = require('./db');
    const { breakerStats } = require('./utils/breakers');
    const t0 = Date.now();
    await query('SELECT 1');
    res.json({
      status: 'ok',
      db: 'ok',
      db_latency_ms: Date.now() - t0,
      pool: poolMetrics(),
      breakers: breakerStats(),
      uptime_seconds: Math.floor(process.uptime()),
      ...buildInfo(),
    });
  } catch {
    res.status(503).json({ status: 'degraded', db: 'error', ...buildInfo() });
  }
});

// Detailed DB health — pool depth, latency, and a lightweight table ping
app.get('/health/db', async (_req, res) => {
  const { query, poolMetrics } = require('./db');
  const t0 = Date.now();
  try {
    await query('SELECT 1');
    const latency = Date.now() - t0;
    const pool = poolMetrics();
    const saturated = pool.waiting > 0;
    res.status(saturated ? 207 : 200).json({
      status: saturated ? 'saturated' : 'ok',
      latency_ms: latency,
      pool,
    });
  } catch (err) {
    res.status(503).json({ status: 'error', latency_ms: Date.now() - t0, detail: err.message });
  }
});

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use('/api/auth',          require('./routes/auth'));
app.use('/api/onboarding',    require('./routes/onboarding'));
app.use('/api/moods',         require('./routes/moods'));
app.use('/api/journals',      require('./routes/journals'));
app.use('/api/vents',         require('./routes/vents'));
app.use('/api/ai',            require('./routes/ai'));
app.use('/api/credits',       require('./routes/credits'));
app.use('/api/peer',          require('./routes/peer'));
app.use('/api/groups',        require('./routes/groups'));
app.use('/api/admin',         require('./routes/admin'));
app.use('/api/emergency',     require('./routes/emergency'));
app.use('/api/safety-plan',   require('./routes/safetyPlan'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/feedback',      require('./routes/feedback'));
app.use('/api/resources',     require('./routes/resources'));
app.use('/api/therapists',    require('./routes/therapists'));
app.use('/api/therapy',       require('./routes/therapy'));
app.use('/api/profile',       require('./routes/profile'));
app.use('/api/analytics',     require('./routes/analytics'));
app.use('/api/training',      require('./routes/training'));
app.use('/api/policy',        require('./routes/policy'));
app.use('/api/waitlist',      require('./routes/waitlist'));
app.use('/api/trial',         require('./routes/trial'));
app.use('/api/promo',         require('./routes/promo'));
app.use('/api/referrals',     require('./routes/referrals'));

// ─── Sentry error handler (must be before custom error handler) ───────────────
if (process.env.SENTRY_DSN) {
  app.use(Sentry.expressErrorHandler());
}

// ─── Global error handler ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  (req.log || logger).error({ err, requestId: req.requestId }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error', code: 'SERVER_ERROR' });
});

module.exports = app;
