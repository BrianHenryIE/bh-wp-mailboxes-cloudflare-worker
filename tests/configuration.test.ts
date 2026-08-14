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

  it('has no alert binding when the environment omits it', () => {
    const workerConfiguration = parseWorkerConfiguration(makeWorkerEnvironment());

    expect(workerConfiguration.alertSendEmailBinding).toBeNull();
  });

  it('passes the send_email binding through', () => {
    const sendEmailBinding = { send: () => Promise.resolve() } as unknown as SendEmail;

    const workerConfiguration = parseWorkerConfiguration(
      makeWorkerEnvironment({ ALERT_EMAIL: sendEmailBinding }),
    );

    expect(workerConfiguration.alertSendEmailBinding).toBe(sendEmailBinding);
  });
});
