import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeliveryFailureAlertConfiguration } from '../src/configuration';
import {
  maybeSendDeliveryFailureAlert,
  type DeliveryFailureDetails,
} from '../src/delivery-failure-alerting';
import { FakeKvNamespace } from './fakes/fake-kv-namespace';

const failureDetails: DeliveryFailureDetails = {
  targetWordPressSiteUrl: 'https://sacramentogaa.org',
  errorName: 'DeliveryFailedError',
  errorMessage: 'Delivery to https://sacramentogaa.org/wp-json/… failed with HTTP 500.',
  envelopeFrom: 'sender@example.com',
  envelopeTo: 'mailbox@p.sacramentogaa.org',
};

let fakeKvNamespace: FakeKvNamespace;

function makeAlertConfiguration(): DeliveryFailureAlertConfiguration {
  return {
    sendEmailBinding: { send: vi.fn() },
    fromEmailAddress: 'worker@p.sacramentogaa.org',
    recipientEmailAddress: 'admin@example.net',
  };
}

beforeEach(() => {
  fakeKvNamespace = new FakeKvNamespace();
});

describe('maybeSendDeliveryFailureAlert', () => {
  it('sends an alert naming the site and the error', async () => {
    const sendAlertEmail = vi.fn().mockResolvedValue(undefined);
    const alertConfiguration = makeAlertConfiguration();

    await maybeSendDeliveryFailureAlert(
      fakeKvNamespace.asKvNamespace(),
      alertConfiguration,
      failureDetails,
      sendAlertEmail,
    );

    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
    const [configurationArgument, subject, body] = sendAlertEmail.mock.calls[0] as [
      DeliveryFailureAlertConfiguration,
      string,
      string,
    ];
    expect(configurationArgument).toBe(alertConfiguration);
    expect(subject).toContain('https://sacramentogaa.org');
    expect(body).toContain('DeliveryFailedError');
    expect(body).toContain('sender@example.com');
  });

  it('sends at most one alert per day', async () => {
    const sendAlertEmail = vi.fn().mockResolvedValue(undefined);

    await maybeSendDeliveryFailureAlert(
      fakeKvNamespace.asKvNamespace(),
      makeAlertConfiguration(),
      failureDetails,
      sendAlertEmail,
    );
    await maybeSendDeliveryFailureAlert(
      fakeKvNamespace.asKvNamespace(),
      makeAlertConfiguration(),
      failureDetails,
      sendAlertEmail,
    );

    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
  });

  it('does nothing but log when alerting is not configured', async () => {
    const sendAlertEmail = vi.fn();

    await maybeSendDeliveryFailureAlert(
      fakeKvNamespace.asKvNamespace(),
      null,
      failureDetails,
      sendAlertEmail,
    );

    expect(sendAlertEmail).not.toHaveBeenCalled();
    // No rate-limit entry is written, so alerting starts working as soon as
    // it is configured.
    expect(await fakeKvNamespace.get('delivery_failure_alert_sent_recently')).toBeNull();
  });

  it('swallows send failures (alerting must never break email handling)', async () => {
    const sendAlertEmail = vi.fn().mockRejectedValue(new Error('SMTP boom'));

    await expect(
      maybeSendDeliveryFailureAlert(
        fakeKvNamespace.asKvNamespace(),
        makeAlertConfiguration(),
        failureDetails,
        sendAlertEmail,
      ),
    ).resolves.toBeUndefined();
  });

  it('marks the rate limit before sending, so a failed send does not retry-loop', async () => {
    const sendAlertEmail = vi.fn().mockRejectedValue(new Error('SMTP boom'));

    await maybeSendDeliveryFailureAlert(
      fakeKvNamespace.asKvNamespace(),
      makeAlertConfiguration(),
      failureDetails,
      sendAlertEmail,
    );
    await maybeSendDeliveryFailureAlert(
      fakeKvNamespace.asKvNamespace(),
      makeAlertConfiguration(),
      failureDetails,
      sendAlertEmail,
    );

    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
  });
});
