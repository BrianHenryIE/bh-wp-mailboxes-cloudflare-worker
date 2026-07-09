import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { beforeEach, describe, expect, it } from 'vitest';

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
    TARGET_WORDPRESS_SITE_URL: 'https://sacramentogaa.org',
    SETUP_TOKEN: 'correct-token',
    WORKER_CONFIGURATION_KV: fakeKvNamespace.asKvNamespace(),
  };
}

async function storeTestCredential(): Promise<void> {
  await fakeKvNamespace.put(
    'wordpress_application_password_credential',
    JSON.stringify({ userLogin: 'ingress-user', applicationPassword: 'app pass' }),
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

  it('rejects (permanent) mail whose recipient domain does not match the target site', async () => {
    const fixtureBytes = await readFixtureBytes('plain-text-simple.eml');
    const { message, setRejectMock } = makeFakeForwardableEmailMessage(fixtureBytes, {
      envelopeTo: 'mailbox@unrelated.example',
    });
    const { fakeFetch, endpointRequests } = makeFakeWordPressSite();

    await handleIncomingEmailMessage(message, makeWorkerEnvironment(), fakeFetch);

    expect(setRejectMock).toHaveBeenCalledWith(expect.stringContaining('Recipient not accepted'));
    expect(endpointRequests).toHaveLength(0);
  });

  it('rejects (permanent) oversized mail', async () => {
    await storeTestCredential();
    const fixtureBytes = await readFixtureBytes('plain-text-simple.eml');
    const { message, setRejectMock } = makeFakeForwardableEmailMessage(fixtureBytes);
    const { fakeFetch, endpointRequests } = makeFakeWordPressSite({ maxMessageSizeBytes: 10 });

    await handleIncomingEmailMessage(message, makeWorkerEnvironment(), fakeFetch);

    expect(setRejectMock).toHaveBeenCalledWith(expect.stringContaining('too large'));
    expect(endpointRequests).toHaveLength(0);
  });

  it('throws (transient) when WordPress rejects the delivery', async () => {
    await storeTestCredential();
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

  it('throws (transient) when no credential has been configured yet', async () => {
    const fixtureBytes = await readFixtureBytes('plain-text-simple.eml');
    const { message } = makeFakeForwardableEmailMessage(fixtureBytes);
    const { fakeFetch } = makeFakeWordPressSite({ maxMessageSizeBytes: 1024 * 1024 });

    await expect(
      handleIncomingEmailMessage(message, makeWorkerEnvironment(), fakeFetch),
    ).rejects.toThrow(/setup/i);
  });
});

describe('handleFetchRequest', () => {
  it('serves the /setup redirect', async () => {
    const response = await handleFetchRequest(
      new Request('https://worker.example/setup?token=correct-token'),
      makeWorkerEnvironment(),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('authorize-application.php');
  });

  it('serves the /setup/callback route', async () => {
    const response = await handleFetchRequest(
      new Request(
        'https://worker.example/setup/callback?token=correct-token' +
          '&site_url=https%3A%2F%2Fsacramentogaa.org&user_login=u&password=p',
      ),
      makeWorkerEnvironment(),
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
