import { describe, expect, it } from 'vitest';

import { parseWorkerConfiguration, type WorkerEnvironment } from '../src/configuration';

const fakeKvNamespace = {} as KVNamespace;

function makeWorkerEnvironment(overrides: Partial<WorkerEnvironment> = {}): WorkerEnvironment {
  return {
    SETUP_TOKEN: 'a-setup-token',
    WORKER_CONFIGURATION_KV: fakeKvNamespace,
    ...overrides,
  };
}

describe('parseWorkerConfiguration', () => {
  it('parses a valid environment', () => {
    const workerConfiguration = parseWorkerConfiguration(makeWorkerEnvironment());

    expect(workerConfiguration.setupToken).toBe('a-setup-token');
    expect(workerConfiguration.workerConfigurationKv).toBe(fakeKvNamespace);
  });

  it('throws when SETUP_TOKEN is missing', () => {
    expect(() => parseWorkerConfiguration(makeWorkerEnvironment({ SETUP_TOKEN: '' }))).toThrow(
      /SETUP_TOKEN/,
    );
  });

  it('has no alert configuration when the alert settings are absent', () => {
    const workerConfiguration = parseWorkerConfiguration(makeWorkerEnvironment());

    expect(workerConfiguration.alertConfiguration).toBeNull();
  });

  it('parses a complete alert configuration', () => {
    const sendEmailBinding = { send: () => Promise.resolve() } as unknown as SendEmail;

    const workerConfiguration = parseWorkerConfiguration(
      makeWorkerEnvironment({
        ALERT_EMAIL: sendEmailBinding,
        ALERT_FROM_EMAIL_ADDRESS: 'worker@p.sacramentogaa.org',
        ALERT_RECIPIENT_EMAIL_ADDRESS: 'admin@example.net',
      }),
    );

    expect(workerConfiguration.alertConfiguration).toEqual({
      sendEmailBinding,
      fromEmailAddress: 'worker@p.sacramentogaa.org',
      recipientEmailAddress: 'admin@example.net',
    });
  });

  it('throws on a partial alert configuration', () => {
    expect(() =>
      parseWorkerConfiguration(
        makeWorkerEnvironment({ ALERT_RECIPIENT_EMAIL_ADDRESS: 'admin@example.net' }),
      ),
    ).toThrow(/partially configured/);
  });
});
