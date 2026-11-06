const { Resend } = require('resend');
const logger = require('../utils/logger');

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let _resend = null;
function getResend() {
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

function verificationTemplate(alias, link) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px;margin:40px auto">
    <tr><td style="background:#ffffff;border-radius:12px;padding:40px 36px;color:#1A1A2E">
      <p style="font-size:22px;font-weight:600;margin:0 0 8px">PeerPal</p>
      <p style="font-size:16px;color:#555;margin:0 0 28px">Hi ${alias},</p>
      <p style="font-size:16px;line-height:1.6;margin:0 0 28px">
        Welcome to PeerPal. We're glad you're here.<br>
        Please confirm your email address to get started.
      </p>
      <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 28px">
        <tr><td style="background:#5BAD9A;border-radius:8px;padding:14px 28px">
          <a href="${link}" style="color:#ffffff;text-decoration:none;font-size:15px;font-weight:600">Confirm my email</a>
        </td></tr>
      </table>
      <p style="font-size:13px;color:#888;line-height:1.5;margin:0 0 8px">This link expires in 24 hours.</p>
      <p style="font-size:13px;color:#888;line-height:1.5;margin:0">
        If you didn't create an account, you can safely ignore this email.
      </p>
      <hr style="border:none;border-top:1px solid #eee;margin:28px 0">
      <p style="font-size:12px;color:#aaa;margin:0">— The PeerPal Team</p>
    </td></tr>
  </table>
</body>
</html>`;
}

function inviteTherapistTemplate(name, link) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px;margin:40px auto">
    <tr><td style="background:#ffffff;border-radius:12px;padding:40px 36px;color:#1A1A2E">
      <p style="font-size:22px;font-weight:600;margin:0 0 8px">PeerPal</p>
      <p style="font-size:16px;color:#555;margin:0 0 28px">Hi ${name},</p>
      <p style="font-size:16px;line-height:1.6;margin:0 0 28px">
        You've been added as a therapist partner on PeerPal.<br>
        Set your password to activate your account and get started.
      </p>
      <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 28px">
        <tr><td style="background:#5BAD9A;border-radius:8px;padding:14px 28px">
          <a href="${link}" style="color:#ffffff;text-decoration:none;font-size:15px;font-weight:600">Set my password</a>
        </td></tr>
      </table>
      <p style="font-size:13px;color:#888;line-height:1.5;margin:0 0 8px">This link expires in 72 hours.</p>
      <p style="font-size:13px;color:#888;line-height:1.5;margin:0">
        If you weren't expecting this, contact PeerPal support.
      </p>
      <hr style="border:none;border-top:1px solid #eee;margin:28px 0">
      <p style="font-size:12px;color:#aaa;margin:0">— The PeerPal Team</p>
    </td></tr>
  </table>
</body>
</html>`;
}

function resetTemplate(alias, link) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px;margin:40px auto">
    <tr><td style="background:#ffffff;border-radius:12px;padding:40px 36px;color:#1A1A2E">
      <p style="font-size:22px;font-weight:600;margin:0 0 8px">PeerPal</p>
      <p style="font-size:16px;color:#555;margin:0 0 28px">Hi ${alias},</p>
      <p style="font-size:16px;line-height:1.6;margin:0 0 28px">
        We received a request to reset your password.
      </p>
      <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 28px">
        <tr><td style="background:#5BAD9A;border-radius:8px;padding:14px 28px">
          <a href="${link}" style="color:#ffffff;text-decoration:none;font-size:15px;font-weight:600">Reset my password</a>
        </td></tr>
      </table>
      <p style="font-size:13px;color:#888;line-height:1.5;margin:0 0 8px">This link expires in 15 minutes.</p>
      <p style="font-size:13px;color:#888;line-height:1.5;margin:0">
        If you didn't request this, your account is safe — ignore this email.
      </p>
      <hr style="border:none;border-top:1px solid #eee;margin:28px 0">
      <p style="font-size:12px;color:#aaa;margin:0">— The PeerPal Team</p>
    </td></tr>
  </table>
</body>
</html>`;
}

// Direct delivery — called by emailWorker and as fallback when queue is unavailable.
// Wrapped by circuit breaker in utils/breakers.js — do not call directly from high-traffic paths.
async function deliverEmail(to, subject, html) {
  if (!process.env.RESEND_API_KEY) {
    if (process.env.NODE_ENV === 'development') {
      logger.info(`[DEV] Would send email to ${to.slice(0, 3)}***: ${subject}`);
      return;
    }
    throw new Error('RESEND_API_KEY not configured — email cannot be delivered');
  }
  if (!process.env.EMAIL_FROM) {
    throw new Error('EMAIL_FROM not configured — email cannot be delivered');
  }
  await getResend().emails.send({
    from: process.env.EMAIL_FROM,
    to,
    subject,
    html,
  });
}

// Circuit-breaker-guarded delivery for direct (non-queued) sends.
async function deliverEmailSafe(to, subject, html) {
  const { getEmailBreaker } = require('../utils/breakers');
  await getEmailBreaker().fire(to, subject, html);
}

// Enqueue for async delivery — fire-and-forget. Returns immediately; email sends in background.
function enqueueEmail(to, subject, html) {
  const { emailQueue } = require('../queues');

  (async () => {
    if (emailQueue) {
      try {
        await Promise.race([
          emailQueue.add('send', { to, subject, html }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('queue timeout after 2s')), 2000)
          ),
        ]);
        return;
      } catch (err) {
        logger.warn('[email] Queue unavailable, falling back to direct send:', err.message);
      }
    }
    await deliverEmailSafe(to, subject, html);
  })().catch(err => logger.error('[email] Delivery failed:', err.message));
  // Caller returns immediately — no await needed
}

function getAppUrl() {
  return (process.env.FRONTEND_URL || '').split(',')[0].trim();
}

async function sendVerificationEmail(email, alias, token) {
  const link = `${getAppUrl()}/verify-email?token=${token}`;
  await enqueueEmail(email, 'Confirm your PeerPal account', verificationTemplate(alias, link));
}

async function sendPasswordResetEmail(email, alias, token) {
  const link = `${getAppUrl()}/reset-password?token=${token}`;
  await enqueueEmail(email, 'Reset your PeerPal password', resetTemplate(alias, link));
}

async function sendTherapistInvite(email, displayName, token) {
  const portalUrl = (process.env.THERAPIST_PORTAL_URL || '').trim() || getAppUrl();
  const link = `${portalUrl}?set_password=${token}`;
  await enqueueEmail(email, 'Welcome to PeerPal — set your password', inviteTherapistTemplate(displayName, link));
}

function resendInviteTemplate(name, link) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px;margin:40px auto">
    <tr><td style="background:#ffffff;border-radius:12px;padding:40px 36px;color:#1A1A2E">
      <p style="font-size:22px;font-weight:600;margin:0 0 8px">PeerPal</p>
      <p style="font-size:16px;color:#555;margin:0 0 28px">Hi ${name},</p>
      <p style="font-size:16px;line-height:1.6;margin:0 0 28px">
        Your previous sign-in link expired. Here's a fresh one — it's valid for 72 hours.
      </p>
      <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 28px">
        <tr><td style="background:#5BAD9A;border-radius:8px;padding:14px 28px">
          <a href="${link}" style="color:#ffffff;text-decoration:none;font-size:15px;font-weight:600">Set my password</a>
        </td></tr>
      </table>
      <p style="font-size:13px;color:#888;line-height:1.5;margin:0">
        If you weren't expecting this, contact PeerPal support.
      </p>
      <hr style="border:none;border-top:1px solid #eee;margin:28px 0">
      <p style="font-size:12px;color:#aaa;margin:0">— The PeerPal Team</p>
    </td></tr>
  </table>
</body>
</html>`;
}

async function sendTherapistPasswordReset(email, displayName, token) {
  const portalUrl = (process.env.THERAPIST_PORTAL_URL || '').trim() || getAppUrl();
  const link = `${portalUrl}?set_password=${token}`;
  await enqueueEmail(email, 'Your PeerPal sign-in link — set your password', resendInviteTemplate(displayName, link));
}

function therapistVerifiedTemplate(name, portalUrl) {
  const n = escapeHtml(name); const u = escapeHtml(portalUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px;margin:40px auto">
    <tr><td style="background:#ffffff;border-radius:12px;padding:40px 36px;color:#1A1A2E">
      <p style="font-size:22px;font-weight:600;margin:0 0 8px">PeerPal</p>
      <p style="font-size:16px;color:#555;margin:0 0 28px">Hi ${n},</p>
      <p style="font-size:16px;line-height:1.6;margin:0 0 28px">
        Your PeerPal therapist account has been verified.<br>
        You can now receive bookings from clients on the platform.
      </p>
      <p style="font-size:15px;line-height:1.6;margin:0 0 28px;color:#444">
        Log in to complete your schedule and start accepting sessions.
      </p>
      <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 28px">
        <tr><td style="background:#5BAD9A;border-radius:8px;padding:14px 28px">
          <a href="${u}" style="color:#ffffff;text-decoration:none;font-size:15px;font-weight:600">Go to my portal</a>
        </td></tr>
      </table>
      <hr style="border:none;border-top:1px solid #eee;margin:28px 0">
      <p style="font-size:12px;color:#aaa;margin:0">The PeerPal Team</p>
    </td></tr>
  </table>
</body>
</html>`;
}

function therapistSuspendedTemplate(name) {
  const n = escapeHtml(name);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px;margin:40px auto">
    <tr><td style="background:#ffffff;border-radius:12px;padding:40px 36px;color:#1A1A2E">
      <p style="font-size:22px;font-weight:600;margin:0 0 8px">PeerPal</p>
      <p style="font-size:16px;color:#555;margin:0 0 28px">Hi ${n},</p>
      <p style="font-size:16px;line-height:1.6;margin:0 0 28px">
        Your PeerPal therapist account has been suspended.<br>
        You will not receive new bookings while your account is suspended.
      </p>
      <p style="font-size:15px;line-height:1.6;margin:0 0 28px;color:#444">
        If you have questions, please contact us at
        <a href="mailto:support@peer-pal.com" style="color:#5BAD9A">support@peer-pal.com</a>.
      </p>
      <hr style="border:none;border-top:1px solid #eee;margin:28px 0">
      <p style="font-size:12px;color:#aaa;margin:0">The PeerPal Team</p>
    </td></tr>
  </table>
</body>
</html>`;
}

function therapistUnsuspendedTemplate(name, portalUrl) {
  const n = escapeHtml(name); const u = escapeHtml(portalUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F5F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px;margin:40px auto">
    <tr><td style="background:#ffffff;border-radius:12px;padding:40px 36px;color:#1A1A2E">
      <p style="font-size:22px;font-weight:600;margin:0 0 8px">PeerPal</p>
      <p style="font-size:16px;color:#555;margin:0 0 28px">Hi ${n},</p>
      <p style="font-size:16px;line-height:1.6;margin:0 0 28px">
        Your PeerPal therapist account suspension has been lifted.<br>
        You are now available to receive bookings again.
      </p>
      <p style="font-size:15px;line-height:1.6;margin:0 0 28px;color:#444">
        Log in to review your schedule.
      </p>
      <table cellpadding="0" cellspacing="0" role="presentation" style="margin:0 0 28px">
        <tr><td style="background:#5BAD9A;border-radius:8px;padding:14px 28px">
          <a href="${u}" style="color:#ffffff;text-decoration:none;font-size:15px;font-weight:600">Go to my portal</a>
        </td></tr>
      </table>
      <hr style="border:none;border-top:1px solid #eee;margin:28px 0">
      <p style="font-size:12px;color:#aaa;margin:0">The PeerPal Team</p>
    </td></tr>
  </table>
</body>
</html>`;
}

async function sendTherapistVerified(email, displayName) {
  const portalUrl = (process.env.THERAPIST_PORTAL_URL || '').trim() || getAppUrl();
  enqueueEmail(email, 'Your PeerPal account is verified', therapistVerifiedTemplate(displayName, portalUrl));
}

async function sendTherapistSuspended(email, displayName) {
  enqueueEmail(email, 'Your PeerPal account has been suspended', therapistSuspendedTemplate(displayName));
}

async function sendTherapistUnsuspended(email, displayName) {
  const portalUrl = (process.env.THERAPIST_PORTAL_URL || '').trim() || getAppUrl();
  enqueueEmail(email, 'Your PeerPal account has been reinstated', therapistUnsuspendedTemplate(displayName, portalUrl));
}

module.exports = {
  sendVerificationEmail, sendPasswordResetEmail,
  sendTherapistInvite, sendTherapistPasswordReset,
  sendTherapistVerified, sendTherapistSuspended, sendTherapistUnsuspended,
  deliverEmail, deliverEmailSafe,
};
