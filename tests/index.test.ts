import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { handleFetchRequest, handleIncomingEmailMessage } from '../src/index';
import type { WorkerEnvironment } from '../src/index';
import { FakeKvNamespace } from './fakes/fake-kv-namespace';
import { makeFakeForwardableEmailMessage } from './fakes/fake-forwardable-email-message';
import { makeFakeWordPressSite } from './fakes/fake-wordpress-site';

const FIXTURES_DIRECTORY = join(import.meta.dirname, 'fixtures');

async function readFixtureBytes(fixtureFileName: string): Promise<Uint8Array> {
  return new Uint8Array(await readFile(join(FIXTURES_DIRECTORY, fixtureFileName)));
}

let fakeKvNamespace: FakeKvNamespace;

function makeWorkerEnvironment(): WorkerEnvironment {
  return {
    SETUP_TOKEN: 'correct-token',
    WORKER_CONFIGURATION_KV: fakeKvNamespace.asKvNamespace(),
  };
}

async function storeSiteUrl(): Promise<void> {
  await fakeKvNamespace.put('target_wordpress_site_url', 'https://sacramentogaa.org/');
}

async function storeTestCredential(): Promise<void> {
  await fakeKvNamespace.put(
    'wordpress_application_password_credential',
    JSON.stringify({ userLogin: 'ingress-user', applicationPassword: 'app pass' }),
  );
}

async function storeSelectedEndpoint(maxMessageSizeBytes = 1024 * 1024): Promise<void> {
  await fakeKvNamespace.put(
    'selected_email_ingress_endpoint',
    JSON.stringify({
      version: 1,
      namespace: 'bh-wp-mailboxes/v1',
      url: 'https://sacramentogaa.org/wp-json/bh-wp-mailboxes/v1/incoming-email',
      accepts: 'message/rfc822',
      maxMessageSizeBytes,
    }),
  );
}

beforeEach(() => {
  fakeKvNamespace = new FakeKvNamespace();
});

describe('handleIncomingEmailMessage', () => {
  it.each(['plain-text-simple.eml', 'multipart-with-attachment.eml'])(
    'delivers fixture %s byte-for-byte',
    async (fixtureFileName) => {
      await storeTestCredential();
      await storeSelectedEndpoint();
      const fixtureBytes = await readFixtureBytes(fixtureFileName);
      const { message } = makeFakeForwardableEmailMessage(fixtureBytes);
      const { fakeFetch, endpointRequests } = makeFakeWordPressSite({
        maxMessageSizeBytes: 1024 * 1024,
      });

      await handleIncomingEmailMessage(message, makeWorkerEnvironment(), fakeFetch);

      expect(endpointRequests).toHaveLength(1);
      const endpointRequest = endpointRequests[0];
      if (!endpointRequest) throw new Error('expected an endpoint request');
      const deliveredBytes = new Uint8Array(await endpointRequest.arrayBuffer());
      expect(deliveredBytes).toEqual(fixtureBytes);
    },
  );

  it('sets envelope headers from the SMTP envelope, not the MIME headers', async () => {
    await storeTestCredential();
    await storeSelectedEndpoint();
    const fixtureBytes = await readFixtureBytes('plain-text-simple.eml');
    const { message } = makeFakeForwardableEmailMessage(fixtureBytes, {
      envelopeFrom: 'bounce-path@relay.example.net',
      envelopeTo: 'mailbox@p.sacramentogaa.org',
    });
    const { fakeFetch, endpointRequests } = makeFakeWordPressSite({
      maxMessageSizeBytes: 1024 * 1024,
    });

    await handleIncomingEmailMessage(message, makeWorkerEnvironment(), fakeFetch);

    expect(endpointRequests[0]?.headers.get('x-envelope-from')).toBe(
      'bounce-path@relay.example.net',
    );
    expect(endpointRequests[0]?.headers.get('x-envelope-to')).toBe('mailbox@p.sacramentogaa.org');
  });

  it('delivers mail whose recipient domain is unrelated to the target site', async () => {
    await storeTestCredential();
    await storeSelectedEndpoint();
    const fixtureBytes = await readFixtureBytes('plain-text-simple.eml');
    const { message, setRejectMock } = makeFakeForwardableEmailMessage(fixtureBytes, {
      envelopeTo: 'mailbox@unrelated.example',
    });
    const { fakeFetch, endpointRequests } = makeFakeWordPressSite({
      maxMessageSizeBytes: 1024 * 1024,
    });

    await handleIncomingEmailMessage(message, makeWorkerEnvironment(), fakeFetch);

    expect(setRejectMock).not.toHaveBeenCalled();
    expect(endpointRequests).toHaveLength(1);
    expect(endpointRequests[0]?.headers.get('x-envelope-to')).toBe('mailbox@unrelated.example');
  });

  it('rejects (permanent) oversized mail', async () => {
    await storeTestCredential();
    await storeSelectedEndpoint(10);
    const fixtureBytes = await readFixtureBytes('plain-text-simple.eml');
    const { message, setRejectMock } = makeFakeForwardableEmailMessage(fixtureBytes);
    const { fakeFetch, endpointRequests } = makeFakeWordPressSite();

    await handleIncomingEmailMessage(message, makeWorkerEnvironment(), fakeFetch);

    expect(setRejectMock).toHaveBeenCalledWith(expect.stringContaining('too large'));
    expect(endpointRequests).toHaveLength(0);
  });

  it('throws (transient) when WordPress rejects the delivery', async () => {
    await storeTestCredential();
    await storeSelectedEndpoint();
    const fixtureBytes = await readFixtureBytes('plain-text-simple.eml');
    const { message, setRejectMock } = makeFakeForwardableEmailMessage(fixtureBytes);
    const { fakeFetch } = makeFakeWordPressSite({
      endpointResponseStatuses: [500],
      maxMessageSizeBytes: 1024 * 1024,
    });

    await expect(
      handleIncomingEmailMessage(message, makeWorkerEnvironment(), fakeFetch),
    ).rejects.toThrow(/HTTP 500/);
    expect(setRejectMock).not.toHaveBeenCalled();
  });

  it('sends a rate-limited alert email when delivery fails and alerting is configured', async () => {
    await storeTestCredential();
    await storeSelectedEndpoint();
    await storeSiteUrl();
    const fixtureBytes = await readFixtureBytes('plain-text-simple.eml');
    const { fakeFetch } = makeFakeWordPressSite({ endpointResponseStatuses: [500] });

    const sendAlertEmail = vi.fn().mockResolvedValue(undefined);
    const environmentWithAlerting: WorkerEnvironment = {
      ...makeWorkerEnvironment(),
      ALERT_EMAIL: { send: vi.fn() },
      ALERT_FROM_EMAIL_ADDRESS: 'worker@p.sacramentogaa.org',
      ALERT_RECIPIENT_EMAIL_ADDRESS: 'admin@example.net',
    };

    const firstMessage = makeFakeForwardableEmailMessage(fixtureBytes).message;
    await expect(
      handleIncomingEmailMessage(firstMessage, environmentWithAlerting, fakeFetch, sendAlertEmail),
    ).rejects.toThrow(/HTTP 500/);

    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
    const [, subject] = sendAlertEmail.mock.calls[0] as [unknown, string, string];
    expect(subject).toContain('sacramentogaa.org');

    // A second failure within the rate-limit window does not send again.
    const secondMessage = makeFakeForwardableEmailMessage(fixtureBytes).message;
    await expect(
      handleIncomingEmailMessage(secondMessage, environmentWithAlerting, fakeFetch, sendAlertEmail),
    ).rejects.toThrow(/HTTP 500/);
    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
  });

  it('throws (transient) when no credential has been configured yet', async () => {
    await storeSelectedEndpoint();
    const fixtureBytes = await readFixtureBytes('plain-text-simple.eml');
    const { message } = makeFakeForwardableEmailMessage(fixtureBytes);
    const { fakeFetch } = makeFakeWordPressSite({ maxMessageSizeBytes: 1024 * 1024 });

    await expect(
      handleIncomingEmailMessage(message, makeWorkerEnvironment(), fakeFetch),
    ).rejects.toThrow(/setup/i);
  });
});

describe('handleFetchRequest', () => {
  it('serves the /setup site URL form', async () => {
    const response = await handleFetchRequest(
      new Request('https://worker.example/setup?token=correct-token'),
      makeWorkerEnvironment(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('name="site_url"');
  });

  it('a site URL submission redirects to authorize-application.php', async () => {
    const response = await handleFetchRequest(
      new Request('https://worker.example/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'token=correct-token&site_url=https%3A%2F%2Fsacramentogaa.org',
      }),
      makeWorkerEnvironment(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('authorize-application.php');
  });

  it('serves the /setup/callback route', async () => {
    await storeSiteUrl();
    const response = await handleFetchRequest(
      new Request(
        'https://worker.example/setup/callback?token=correct-token' +
          '&site_url=https%3A%2F%2Fsacramentogaa.org&user_login=u&password=p',
      ),
      makeWorkerEnvironment(),
      makeFakeWordPressSite().fakeFetch,
    );

    expect(response.status).toBe(200);
  });

  it('returns 404 for unknown routes', async () => {
    const response = await handleFetchRequest(
      new Request('https://worker.example/anything-else'),
      makeWorkerEnvironment(),
    );

    expect(response.status).toBe(404);
  });
});
