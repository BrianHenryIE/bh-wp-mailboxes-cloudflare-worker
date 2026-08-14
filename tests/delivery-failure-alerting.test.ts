import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getAlertEmailAddresses,
  maybeSendDeliveryFailureAlert,
  storeAlertEmailAddresses,
  type AlertEmailAddresses,
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

const alertEmailAddresses: AlertEmailAddresses = {
  fromEmailAddress: 'worker@p.sacramentogaa.org',
  recipientEmailAddress: 'admin@example.net',
};

let fakeKvNamespace: FakeKvNamespace;

function makeSendEmailBinding(): SendEmail {
  return { send: vi.fn() };
}

beforeEach(() => {
  fakeKvNamespace = new FakeKvNamespace();
});

describe('storeAlertEmailAddresses / getAlertEmailAddresses', () => {
  it('round-trips the stored addresses', async () => {
    await storeAlertEmailAddresses(fakeKvNamespace.asKvNamespace(), alertEmailAddresses);

    expect(await getAlertEmailAddresses(fakeKvNamespace.asKvNamespace())).toEqual(
      alertEmailAddresses,
    );
  });

  it('returns null when nothing is stored', async () => {
    expect(await getAlertEmailAddresses(fakeKvNamespace.asKvNamespace())).toBeNull();
  });

  it('returns null for a corrupt stored value', async () => {
    await fakeKvNamespace.put('alert_email_addresses', '{not json');

    expect(await getAlertEmailAddresses(fakeKvNamespace.asKvNamespace())).toBeNull();
  });
});

describe('maybeSendDeliveryFailureAlert', () => {
  it('sends an alert naming the site and the error', async () => {
    await storeAlertEmailAddresses(fakeKvNamespace.asKvNamespace(), alertEmailAddresses);
    const sendAlertEmail = vi.fn().mockResolvedValue(undefined);
    const sendEmailBinding = makeSendEmailBinding();

    await maybeSendDeliveryFailureAlert(
      fakeKvNamespace.asKvNamespace(),
      sendEmailBinding,
      failureDetails,
      sendAlertEmail,
    );

    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
    const [bindingArgument, addressesArgument, subject, body] = sendAlertEmail.mock.calls[0] as [
      SendEmail,
      AlertEmailAddresses,
      string,
      string,
    ];
    expect(bindingArgument).toBe(sendEmailBinding);
    expect(addressesArgument).toEqual(alertEmailAddresses);
    expect(subject).toContain('https://sacramentogaa.org');
    expect(body).toContain('DeliveryFailedError');
    expect(body).toContain('sender@example.com');
  });

  it('sends at most one alert per day', async () => {
    await storeAlertEmailAddresses(fakeKvNamespace.asKvNamespace(), alertEmailAddresses);
    const sendAlertEmail = vi.fn().mockResolvedValue(undefined);

    await maybeSendDeliveryFailureAlert(
      fakeKvNamespace.asKvNamespace(),
      makeSendEmailBinding(),
      failureDetails,
      sendAlertEmail,
    );
    await maybeSendDeliveryFailureAlert(
      fakeKvNamespace.asKvNamespace(),
      makeSendEmailBinding(),
      failureDetails,
      sendAlertEmail,
    );

    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
  });

  it('does nothing but log when no addresses have been configured', async () => {
    const sendAlertEmail = vi.fn();

    await maybeSendDeliveryFailureAlert(
      fakeKvNamespace.asKvNamespace(),
      makeSendEmailBinding(),
      failureDetails,
      sendAlertEmail,
    );

    expect(sendAlertEmail).not.toHaveBeenCalled();
    // No rate-limit entry is written, so alerting starts working as soon as
    // addresses are entered on the setup UI.
    expect(await fakeKvNamespace.get('delivery_failure_alert_sent_recently')).toBeNull();
  });

  it('does nothing but log when the binding is absent', async () => {
    await storeAlertEmailAddresses(fakeKvNamespace.asKvNamespace(), alertEmailAddresses);
    const sendAlertEmail = vi.fn();

    await maybeSendDeliveryFailureAlert(
      fakeKvNamespace.asKvNamespace(),
      null,
      failureDetails,
      sendAlertEmail,
    );

    expect(sendAlertEmail).not.toHaveBeenCalled();
  });

  it('swallows send failures (alerting must never break email handling)', async () => {
    await storeAlertEmailAddresses(fakeKvNamespace.asKvNamespace(), alertEmailAddresses);
    const sendAlertEmail = vi.fn().mockRejectedValue(new Error('SMTP boom'));

    await expect(
      maybeSendDeliveryFailureAlert(
        fakeKvNamespace.asKvNamespace(),
        makeSendEmailBinding(),
        failureDetails,
        sendAlertEmail,
      ),
    ).resolves.toBeUndefined();
  });

  it('marks the rate limit before sending, so a failed send does not retry-loop', async () => {
    await storeAlertEmailAddresses(fakeKvNamespace.asKvNamespace(), alertEmailAddresses);
    const sendAlertEmail = vi.fn().mockRejectedValue(new Error('SMTP boom'));

    await maybeSendDeliveryFailureAlert(
      fakeKvNamespace.asKvNamespace(),
      makeSendEmailBinding(),
      failureDetails,
      sendAlertEmail,
    );
    await maybeSendDeliveryFailureAlert(
      fakeKvNamespace.asKvNamespace(),
      makeSendEmailBinding(),
      failureDetails,
      sendAlertEmail,
    );

    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
  });
});
