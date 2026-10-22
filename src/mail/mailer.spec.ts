import { HttpMailer, LogMailer, mailerFromEnv, UnconfiguredMailer } from './mailer';

describe('mailerFromEnv', () => {
  it('uses the HTTP relay when a webhook is configured', () => {
    expect(mailerFromEnv({ MAIL_WEBHOOK_URL: 'https://relay.example/send', NODE_ENV: 'production' })).toBeInstanceOf(HttpMailer);
  });

  it('uses the logging mailer in development', () => {
    expect(mailerFromEnv({ NODE_ENV: 'development' })).toBeInstanceOf(LogMailer);
  });

  it('never falls back to logging in production', () => {
    expect(mailerFromEnv({ NODE_ENV: 'production' })).toBeInstanceOf(UnconfiguredMailer);
  });

  it.each([undefined, 'staging', 'preview', 'test', 'Development', 'prod'])(
    'does not log mail bodies when NODE_ENV is %p',
    (nodeEnv) => {
      const mailer = mailerFromEnv(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv });
      expect(mailer).not.toBeInstanceOf(LogMailer);
      expect(mailer).toBeInstanceOf(UnconfiguredMailer);
    },
  );

  it('uses the logging mailer outside development only on explicit opt-in', () => {
    expect(mailerFromEnv({ NODE_ENV: 'staging', MAIL_LOG_FALLBACK: 'true' })).toBeInstanceOf(LogMailer);
    expect(mailerFromEnv({ NODE_ENV: 'staging', MAIL_LOG_FALLBACK: '1' })).toBeInstanceOf(UnconfiguredMailer);
  });

  it('never logs in production, even with the opt-in flag', () => {
    expect(mailerFromEnv({ NODE_ENV: 'production', MAIL_LOG_FALLBACK: 'true' })).toBeInstanceOf(UnconfiguredMailer);
  });
});

describe('UnconfiguredMailer', () => {
  it('never writes the message body, which may carry a reset token', async () => {
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const secret = 'https://app.example/reset?token=SECRET-RESET-TOKEN';
      await mailerFromEnv({ NODE_ENV: 'staging' }).send({ to: 'a@b.co', subject: 'Reset your password', text: secret });
      const written = [...log.mock.calls, ...error.mock.calls].flat().join('\n');
      expect(written).not.toContain('SECRET-RESET-TOKEN');
      expect(written).toContain('NOT SENT');
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});

describe('HttpMailer', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('posts the message with a bearer token and throws on a non-2xx relay response', async () => {
    const fetchMock = jest.fn().mockResolvedValue(new Response('nope', { status: 500 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const mailer = new HttpMailer('https://relay.example/send', 'secret-token');
    await expect(mailer.send({ to: 'a@b.co', subject: 's', text: 't' })).rejects.toThrow(/500/);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer secret-token');
    expect(JSON.parse(init.body)).toEqual({ to: 'a@b.co', subject: 's', text: 't' });
  });
});
