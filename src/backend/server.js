require('dotenv').config();
const { initSentry } = require('./services/sentry');
initSentry(); // must be before any other require that might throw
const logger = require('./utils/logger');
const http = require('http');
const cron = require('node-cron');
const app = require('./app');
const { createSignalingServer } = require('./ws/signaling');
const { runRoutingJob } = require('./jobs/routingJob');
const { runRiskScoreJob } = require('./jobs/riskScoreJob');
const { runCheckinReminderJob } = require('./jobs/checkinReminderJob');
const { runDailySummaryJob } = require('./jobs/dailySummaryJob');
const { runDeletionJob } = require('./jobs/deletionJob');
const { runVentPurgeJob } = require('./jobs/ventPurgeJob');
const { runPermissionInactivityJob } = require('./jobs/permissionInactivityJob');
const { runVersionDriftJob } = require('./jobs/versionDriftJob');
const { runFlagAggregationJob } = require('./jobs/flagAggregationJob');
const { runBanExpiryJob }              = require('./jobs/banExpiryJob');
const { runSlotLockCleanupJob }        = require('./jobs/slotLockCleanupJob');
const { runTherapistNoShowJob }        = require('./jobs/therapistNoShowJob');
const { runEscrowReleaseJob }          = require('./jobs/escrowReleaseJob');
const { runReferralPayoutJob }         = require('./jobs/referralPayoutJob');
const { runTherapistInviteReminderJob } = require('./jobs/therapistInviteReminderJob');
const { runPreSessionCheckinJob }      = require('./jobs/preSessionCheckinJob');
const { runPreSessionReminderJob }     = require('./jobs/preSessionReminderJob');
const { runPayoutReconciliationJob }   = require('./jobs/payoutReconciliationJob');
const { runPayoutRetryJob }            = require('./jobs/payoutRetryJob');
const { runMemberNoShowJob }           = require('./jobs/memberNoShowJob');
const { runDraftBookingExpiryJob }     = require('./jobs/draftBookingExpiryJob');
const { runWaitlistDigestJob }         = require('./jobs/waitlistDigestJob');
const { runReengagementJob }           = require('./jobs/reengagementJob');
const { runStalePeerSessionJob }       = require('./jobs/stalePeerSessionJob');
const { updateEngagementSegments }     = require('./ai/engagementScore');
const { runTrialDrip, runTrialReminder, runTrialExpiry } = require('./jobs/trialDripJob');
const { runDlqRetryJob } = require('./jobs/dlqRetryJob');
const { startEmailWorker } = require('./workers/emailWorker');
const { startNotificationWorker } = require('./workers/notificationWorker');

const PORT = process.env.PORT || 3001;

const server = http.createServer(app);

createSignalingServer(server);

// ─── Queue workers ────────────────────────────────────────────────────────────
startEmailWorker();
startNotificationWorker();

// ─── Background jobs ──────────────────────────────────────────────────────────
// Peer routing catch-all — every 5 minutes (handles requests whose in-process
// timers were lost due to server restart or Render free-tier sleep)
cron.schedule('*/5 * * * *', () => runRoutingJob().catch((err) => logger.error({ err }, 'routingJob failed')));

// Risk score recalculation — midnight UTC
cron.schedule('0 0 * * *', () => runRiskScoreJob().catch((err) => logger.error({ err }, 'riskScoreJob failed')));

// Check-in reminder — 17:00 UTC (8pm Nairobi EAT)
cron.schedule('0 17 * * *', () => runCheckinReminderJob().catch((err) => logger.error({ err }, 'checkinReminderJob failed')));

// Daily summary / journal prompt — 18:00 UTC (9pm Nairobi EAT)
cron.schedule('0 18 * * *', () => runDailySummaryJob().catch((err) => logger.error({ err }, 'dailySummaryJob failed')));

// Account deletion processing — every hour
cron.schedule('0 * * * *', () => runDeletionJob().catch((err) => logger.error({ err }, 'deletionJob failed')));

// Vent record purge — 04:00 UTC daily (7am Nairobi EAT), enforces 90-day retention
cron.schedule('0 4 * * *', () => runVentPurgeJob().catch((err) => logger.error({ err }, 'ventPurgeJob failed')));

// Permission inactivity expiry — 01:00 UTC (4am Nairobi EAT)
cron.schedule('0 1 * * *', () => runPermissionInactivityJob().catch((err) => logger.error({ err }, 'permissionInactivityJob failed')));

// Permission version drift check — 02:00 UTC (5am Nairobi EAT)
cron.schedule('0 2 * * *', () => runVersionDriftJob().catch((err) => logger.error({ err }, 'versionDriftJob failed')));

// Quality signal flag aggregation — 03:00 UTC (6am Nairobi EAT)
cron.schedule('0 3 * * *', () => runFlagAggregationJob().catch((err) => logger.error({ err }, 'flagAggregationJob failed')));

// Group ban expiry — every hour, lifts bans whose expires_at has passed
cron.schedule('0 * * * *', () => runBanExpiryJob().catch((err) => logger.error({ err }, 'banExpiryJob failed')));

// Stale peer session cleanup — every hour, closes active sessions >2h old
cron.schedule('0 * * * *', () => runStalePeerSessionJob().catch((err) => logger.error({ err }, 'stalePeerSessionJob failed')));

// Waitlist digest — 06:00 UTC (9am Nairobi EAT); emails yesterday's new signups
// to WAITLIST_NOTIFY_EMAIL. No-op if that env isn't set or nothing is new.
cron.schedule('0 6 * * *', () => runWaitlistDigestJob().catch((err) => logger.error({ err }, 'waitlistDigestJob failed')));

// ─── Phase 37: Therapy marketplace background jobs ────────────────────────────

// Slot lock cleanup — every 5 min
cron.schedule('*/5 * * * *', () => runSlotLockCleanupJob().catch((err) => logger.error({ err }, 'slotLockCleanupJob failed')));

// Draft booking expiry — every 5 min; deletes unpaid drafts whose slot lock has expired
cron.schedule('*/5 * * * *', () => runDraftBookingExpiryJob().catch((err) => logger.error({ err }, 'draftBookingExpiryJob failed')));

// Therapist no-show detection — every 10 min
cron.schedule('*/10 * * * *', () => runTherapistNoShowJob().catch((err) => logger.error({ err }, 'therapistNoShowJob failed')));

// Member no-show detection — every 10 min
cron.schedule('*/10 * * * *', () => runMemberNoShowJob().catch((err) => logger.error({ err }, 'memberNoShowJob failed')));

// Pre-session checkin — every 5 min (sends checkin at 30-min mark)
cron.schedule('*/5 * * * *', () => runPreSessionCheckinJob().catch((err) => logger.error({ err }, 'preSessionCheckinJob failed')));

// Pre-session reminder — every 5 min (sends reminder at 15-min mark)
cron.schedule('*/5 * * * *', () => runPreSessionReminderJob().catch((err) => logger.error({ err }, 'preSessionReminderJob failed')));

// Escrow release — hourly (releases 24h after session end, no open dispute)
cron.schedule('0 * * * *', () => runEscrowReleaseJob().catch((err) => logger.error({ err }, 'escrowReleaseJob failed')));

// Referral commission payouts — 1st of each month at 09:00 EAT (06:00 UTC)
cron.schedule('0 6 1 * *', () => runReferralPayoutJob().catch((err) => logger.error({ err }, 'referralPayoutJob failed')));

// Therapist invite reminder — daily 10:00 EAT (07:00 UTC); resends to therapists whose
// invite token expired in the last 25 hours and account is under 14 days old
cron.schedule('0 7 * * *', () => runTherapistInviteReminderJob().catch((err) => logger.error({ err }, 'therapistInviteReminderJob failed')));

// Payout reconciliation — 02:00 EAT daily (checks stuck processing payouts)
cron.schedule('0 23 * * *', () => runPayoutReconciliationJob().catch((err) => logger.error({ err }, 'payoutReconciliationJob failed')));

// Payout retry — 03:00 EAT daily (retries failed payouts with retry_count <= 1)
cron.schedule('0 0 * * *', () => runPayoutRetryJob().catch((err) => logger.error({ err }, 'payoutRetryJob failed')));

// Re-engagement nudges — every 2 hours; fires at most 1 push per user per 24h
cron.schedule('0 */2 * * *', () => runReengagementJob().catch((err) => logger.error({ err }, 'reengagementJob failed')));

// Engagement scoring — nightly at 02:30 EAT (23:30 UTC); no nudge logic, just stores segment
cron.schedule('30 23 * * *', () => updateEngagementSegments().catch((err) => logger.error({ err }, 'engagementScoring failed')));

// Trial drip — 06:00 EAT (03:00 UTC): issue 2 credits to active trial users
cron.schedule('0 3 * * *', () => runTrialDrip().catch((err) => logger.error({ err }, 'trialDripJob failed')));

// Trial Day-6 reminder + expiry — 06:05 EAT (03:05 UTC)
cron.schedule('5 3 * * *', () => runTrialReminder().catch((err) => logger.error({ err }, 'trialReminderJob failed')));
cron.schedule('5 3 * * *', () => runTrialExpiry().catch((err) => logger.error({ err }, 'trialExpiryJob failed')));

// DLQ retry — every 15 minutes; retries push/email jobs that exhausted BullMQ attempts
cron.schedule('*/15 * * * *', () => runDlqRetryJob().catch((err) => logger.error({ err }, 'dlqRetryJob failed')));

server.listen(PORT, () => {
  logger.info({ port: PORT, env: process.env.NODE_ENV || 'development' }, 'PeerPal backend started');
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
});

module.exports = server;
