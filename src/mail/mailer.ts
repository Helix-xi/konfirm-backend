// How transactional email leaves the system. The app only needs "send this
// text to this address". The concrete transport is picked from the environment
// so no vendor SDK is pinned in here.
//
// MAIL_WEBHOOK_URL: POSTs { to, subject, text } as JSON, with a Bearer token
// from MAIL_WEBHOOK_TOKEN when set. A small relay in front of any email
// provider (Postmark, Resend, SES) can implement this in a few lines.

export const MAILER = Symbol('MAILER');

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  send(mail: OutgoingMail): Promise<void>;
}

export class HttpMailer implements Mailer {
  constructor(
    private readonly url: string,
    private readonly token: string | undefined,
    private readonly timeoutMs = 8_000,
  ) {}

  async send(mail: OutgoingMail): Promise<void> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify(mail),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`mail relay responded ${res.status}`);
  }
}

// Development only: prints the message, including any reset link, to the
// local log. Selected only on explicit opt-in (see mailerFromEnv), because a
// logged reset link is an account takeover for anyone who can read the logs.
export class LogMailer implements Mailer {
  async send(mail: OutgoingMail): Promise<void> {
    console.log(`[mail:dev] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
  }
}

// Any environment without a configured relay that hasn't opted into
// LogMailer: production, but also staging, previews, or an unset NODE_ENV.
// Mail is not sent, and the message body is deliberately not logged. This says so loudly, but the request still
// succeeds from the user's side, so the gap must be closed before launch.
export class UnconfiguredMailer implements Mailer {
  async send(mail: OutgoingMail): Promise<void> {
    console.error(`[mail] NOT SENT — no MAIL_WEBHOOK_URL configured. Subject "${mail.subject}" was dropped.`);
  }
}

// Fails safe: logging mail bodies is opt-in, never the default. Only
// NODE_ENV=development (exactly) or MAIL_LOG_FALLBACK=true selects LogMailer.
// Everything else, including an unset or misspelled NODE_ENV, gets the
// subject-only UnconfiguredMailer, so a new staging or preview environment
// can't leak reset tokens before its relay is wired up.
export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer {
  if (env.MAIL_WEBHOOK_URL) return new HttpMailer(env.MAIL_WEBHOOK_URL, env.MAIL_WEBHOOK_TOKEN);
  if (env.NODE_ENV === 'production') return new UnconfiguredMailer();
  if (env.NODE_ENV === 'development' || env.MAIL_LOG_FALLBACK === 'true') return new LogMailer();
  return new UnconfiguredMailer();
}

// Merchant-facing transactional notifications. These build the message bodies
// for the events a merchant needs to hear about (payment confirmed, payment
// held/flagged, referral earned) so call sites only supply the facts. The
// Mailer transport above stays the single way mail leaves the system.

export interface PaymentNotification {
  merchantEmail: string;
  amount: string;
  currency: string;
  reference: string;
}

export interface HeldPaymentNotification extends PaymentNotification {
  reason?: string;
}

export interface ReferralEarnedNotification {
  merchantEmail: string;
  rewardAmount: string;
  currency: string;
  referredMerchant?: string;
}

export function paymentConfirmedMail(n: PaymentNotification): OutgoingMail {
  return {
    to: n.merchantEmail,
    subject: `Payment received — ${n.amount} ${n.currency}`,
    text: [
      `A payment of ${n.amount} ${n.currency} has been confirmed.`,
      `Reference: ${n.reference}`,
      '',
      'View the details in your activity tab.',
    ].join('\n'),
  };
}

export function paymentHeldMail(n: HeldPaymentNotification): OutgoingMail {
  return {
    to: n.merchantEmail,
    subject: `Payment held for review — ${n.amount} ${n.currency}`,
    text: [
      `A payment of ${n.amount} ${n.currency} has been held for review.`,
      `Reference: ${n.reference}`,
      ...(n.reason ? [`Reason: ${n.reason}`] : []),
      '',
      'Check your activity tab for next steps.',
    ].join('\n'),
  };
}

export function referralEarnedMail(n: ReferralEarnedNotification): OutgoingMail {
  return {
    to: n.merchantEmail,
    subject: `Referral reward earned — ${n.rewardAmount} ${n.currency}`,
    text: [
      `You earned a referral reward of ${n.rewardAmount} ${n.currency}.`,
      ...(n.referredMerchant ? [`Referred merchant: ${n.referredMerchant}`] : []),
      '',
      'See your referrals tab for details.',
    ].join('\n'),
  };
}
