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
// local log. Never selected in production, where a logged reset link would be
// an account takeover.
export class LogMailer implements Mailer {
  async send(mail: OutgoingMail): Promise<void> {
    console.log(`[mail:dev] to=${mail.to} subject="${mail.subject}"\n${mail.text}`);
  }
}

// Production without a configured relay. Mail is not sent, and the message
// body is deliberately not logged. This says so loudly, but the request still
// succeeds from the user's side, so the gap must be closed before launch.
export class UnconfiguredMailer implements Mailer {
  async send(mail: OutgoingMail): Promise<void> {
    console.error(`[mail] NOT SENT — no MAIL_WEBHOOK_URL configured. Subject "${mail.subject}" was dropped.`);
  }
}

export function mailerFromEnv(env: NodeJS.ProcessEnv = process.env): Mailer {
  if (env.MAIL_WEBHOOK_URL) return new HttpMailer(env.MAIL_WEBHOOK_URL, env.MAIL_WEBHOOK_TOKEN);
  if (env.NODE_ENV === 'production') return new UnconfiguredMailer();
  return new LogMailer();
}
