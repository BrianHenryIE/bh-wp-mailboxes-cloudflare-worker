import { beforeEach, describe, expect, it } from 'vitest';

import type { WorkerConfiguration } from '../src/configuration';
import {
  deliverRawEmailToWordPress,
  DeliveryFailedError,
  EmailTooLargeError,
  type RawEmailForDelivery,
} from '../src/deliver-raw-email-to-wordpress';
import { MissingCredentialError } from '../src/wordpress-application-password';
import { FakeKvNamespace } from './fakes/fake-kv-namespace';
import { fakeSiteIngressEndpointUrl, makeFakeWordPressSite } from './fakes/fake-wordpress-site';

const ingressEndpointUrl = fakeSiteIngressEndpointUrl;
const rediscoveredIngressEndpointUrl =
  'https://sacramentogaa.org/wp-json/bh-wp-mailboxes/v2/incoming-email';

const textEncoder = new TextEncoder();

function makeRawEmailForDelivery(
  rawEmailContent = 'Message-ID: <fixture-1@example>\r\n\r\nHello',
): RawEmailForDelivery {
  const rawEmailBytes = textEncoder.encode(rawEmailContent);
  return {
    envelopeFrom: 'sender@example.com',
    envelopeTo: 'mailbox@p.sacramentogaa.org',
    rawEmailSizeBytes: rawEmailBytes.byteLength,
    rawEmailStream: new Response(rawEmailBytes).body as ReadableStream<Uint8Array>,
  };
}

let fakeKvNamespace: FakeKvNamespace;

function makeWorkerConfiguration(): WorkerConfiguration {
  return {
    targetWordPressSiteUrl: new URL('https://sacramentogaa.org'),
    setupToken: 'token',
    workerConfigurationKv: fakeKvNamespace.asKvNamespace(),
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

describe('deliverRawEmailToWordPress', () => {
  it('POSTs the raw bytes with envelope and auth headers', async () => {
    await storeTestCredential();
    const { fakeFetch, endpointRequests } = makeFakeWordPressSite();

    const deliveryResult = await deliverRawEmailToWordPress(
      makeWorkerConfiguration(),
      makeRawEmailForDelivery(),
      fakeFetch,
    );

    expect(deliveryResult.deliveries).toHaveLength(1);
    expect(deliveryResult.deliveries[0]?.httpStatus).toBe(201);
    expect(deliveryResult.deliveries[0]?.endpointUrl).toBe(ingressEndpointUrl);
    expect(deliveryResult.skippedOversizeEndpointUrls).toHaveLength(0);

    expect(endpointRequests).toHaveLength(1);
    const endpointRequest = endpointRequests[0];
    if (!endpointRequest) throw new Error('expected an endpoint request');

    expect(endpointRequest.method).toBe('POST');
    expect(endpointRequest.headers.get('content-type')).toBe('message/rfc822');
    expect(endpointRequest.headers.get('x-envelope-from')).toBe('sender@example.com');
    expect(endpointRequest.headers.get('x-envelope-to')).toBe('mailbox@p.sacramentogaa.org');
    expect(endpointRequest.headers.get('authorization')).toBe(
      `Basic ${btoa('ingress-user:app pass')}`,
    );

    const bodyText = await endpointRequest.text();
    expect(bodyText).toContain('Message-ID: <fixture-1@example>');
    expect(endpointRequest.headers.get('x-message-raw-size')).toBe(
      String(textEncoder.encode(bodyText).byteLength),
    );
  });

  it('throws EmailTooLargeError before POSTing or buffering when the message exceeds every advertised limit', async () => {
    await storeTestCredential();
    const { fakeFetch, endpointRequests } = makeFakeWordPressSite({ maxMessageSizeBytes: 10 });
    const oversizedRawEmail = makeRawEmailForDelivery('x'.repeat(100));

    await expect(
      deliverRawEmailToWordPress(makeWorkerConfiguration(), oversizedRawEmail, fakeFetch),
    ).rejects.toThrow(EmailTooLargeError);

    expect(endpointRequests).toHaveLength(0);
    // The stream was never read: the size guard uses the envelope-reported
    // size, so oversized mail is not buffered into memory.
    expect(oversizedRawEmail.rawEmailStream.locked).toBe(false);
  });

  it('throws MissingCredentialError when setup has not run', async () => {
    const { fakeFetch } = makeFakeWordPressSite();

    await expect(
      deliverRawEmailToWordPress(makeWorkerConfiguration(), makeRawEmailForDelivery(), fakeFetch),
    ).rejects.toThrow(MissingCredentialError);
  });

  it('throws DeliveryFailedError on a non-2xx response', async () => {
    await storeTestCredential();
    const { fakeFetch } = makeFakeWordPressSite({ endpointResponseStatuses: [500] });

    await expect(
      deliverRawEmailToWordPress(makeWorkerConfiguration(), makeRawEmailForDelivery(), fakeFetch),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('re-discovers and retries once on 404, then succeeds', async () => {
    await storeTestCredential();
    // Pre-populate the cache with a stale endpoint.
    await fakeKvNamespace.put(
      'email_ingress_endpoints',
      JSON.stringify([
        {
          version: 1,
          namespace: 'bh-wp-mailboxes/v1',
          url: ingressEndpointUrl,
          accepts: 'message/rfc822',
          maxMessageSizeBytes: 1024,
        },
      ]),
    );
    const { fakeFetch, endpointRequests } = makeFakeWordPressSite({
      endpointResponseStatuses: [404, 201],
      advertisedUrlPerDiscovery: [rediscoveredIngressEndpointUrl],
    });

    const deliveryResult = await deliverRawEmailToWordPress(
      makeWorkerConfiguration(),
      makeRawEmailForDelivery(),
      fakeFetch,
    );

    expect(deliveryResult.deliveries).toHaveLength(1);
    expect(deliveryResult.deliveries[0]?.httpStatus).toBe(201);
    expect(deliveryResult.deliveries[0]?.endpointUrl).toBe(rediscoveredIngressEndpointUrl);
    expect(endpointRequests).toHaveLength(2);
    expect(endpointRequests[1]?.url).toBe(rediscoveredIngressEndpointUrl);
    // The retry re-sends the same body.
    expect(await endpointRequests[1]?.text()).toContain('Message-ID: <fixture-1@example>');
  });

  it('throws DeliveryFailedError when the retry after re-discovery also fails', async () => {
    await storeTestCredential();
    const { fakeFetch, endpointRequests } = makeFakeWordPressSite({
      endpointResponseStatuses: [404, 404],
    });

    await expect(
      deliverRawEmailToWordPress(makeWorkerConfiguration(), makeRawEmailForDelivery(), fakeFetch),
    ).rejects.toThrow(DeliveryFailedError);

    // Exactly two attempts — no retry loop.
    expect(endpointRequests).toHaveLength(2);
  });

  describe('multiple advertised endpoints (fan-out)', () => {
    const secondIngressEndpointUrl =
      'https://sacramentogaa.org/wp-json/second-mailbox/v1/incoming-email';

    it('delivers to every advertised endpoint', async () => {
      await storeTestCredential();
      const { fakeFetch, endpointRequests } = makeFakeWordPressSite({
        advertisedEndpointsPerDiscovery: [
          [{ url: ingressEndpointUrl }, { url: secondIngressEndpointUrl }],
        ],
      });

      const deliveryResult = await deliverRawEmailToWordPress(
        makeWorkerConfiguration(),
        makeRawEmailForDelivery(),
        fakeFetch,
      );

      expect(deliveryResult.deliveries.map(({ endpointUrl }) => endpointUrl).sort()).toEqual(
        [ingressEndpointUrl, secondIngressEndpointUrl].sort(),
      );
      expect(deliveryResult.deliveries.every(({ httpStatus }) => httpStatus === 201)).toBe(true);

      expect(endpointRequests).toHaveLength(2);
      // Both endpoints receive the same bytes and credentials.
      const bodies = await Promise.all(endpointRequests.map((request) => request.text()));
      expect(bodies[0]).toBe(bodies[1]);
      expect(
        endpointRequests.every(
          (request) =>
            request.headers.get('authorization') === `Basic ${btoa('ingress-user:app pass')}`,
        ),
      ).toBe(true);
    });

    it('skips only the endpoints whose size limit the message exceeds', async () => {
      await storeTestCredential();
      const { fakeFetch, endpointRequests } = makeFakeWordPressSite({
        advertisedEndpointsPerDiscovery: [
          [
            { url: ingressEndpointUrl, maxMessageSizeBytes: 10 },
            { url: secondIngressEndpointUrl, maxMessageSizeBytes: 1024 },
          ],
        ],
      });

      const deliveryResult = await deliverRawEmailToWordPress(
        makeWorkerConfiguration(),
        makeRawEmailForDelivery('x'.repeat(100)),
        fakeFetch,
      );

      expect(deliveryResult.deliveries).toHaveLength(1);
      expect(deliveryResult.deliveries[0]?.endpointUrl).toBe(secondIngressEndpointUrl);
      expect(deliveryResult.skippedOversizeEndpointUrls).toEqual([ingressEndpointUrl]);
      expect(endpointRequests).toHaveLength(1);
      expect(endpointRequests[0]?.url).toBe(secondIngressEndpointUrl);
    });

    it('throws EmailTooLargeError only when the message exceeds every endpoint limit', async () => {
      await storeTestCredential();
      const { fakeFetch, endpointRequests } = makeFakeWordPressSite({
        advertisedEndpointsPerDiscovery: [
          [
            { url: ingressEndpointUrl, maxMessageSizeBytes: 10 },
            { url: secondIngressEndpointUrl, maxMessageSizeBytes: 20 },
          ],
        ],
      });

      await expect(
        deliverRawEmailToWordPress(
          makeWorkerConfiguration(),
          makeRawEmailForDelivery('x'.repeat(100)),
          fakeFetch,
        ),
      ).rejects.toThrow(EmailTooLargeError);

      expect(endpointRequests).toHaveLength(0);
    });

    it('throws DeliveryFailedError naming the failed endpoint when one of two fails', async () => {
      await storeTestCredential();
      const { fakeFetch, endpointRequests } = makeFakeWordPressSite({
        advertisedEndpointsPerDiscovery: [
          [{ url: ingressEndpointUrl }, { url: secondIngressEndpointUrl }],
        ],
        endpointResponseStatusesByUrl: {
          [ingressEndpointUrl]: [201],
          [secondIngressEndpointUrl]: [500],
        },
      });

      await expect(
        deliverRawEmailToWordPress(makeWorkerConfiguration(), makeRawEmailForDelivery(), fakeFetch),
      ).rejects.toThrow(new RegExp(`1 of 2 endpoints.*${secondIngressEndpointUrl} → HTTP 500`));

      // Both were attempted; the sender's retry will redeliver and the
      // successful endpoint dedupes on Message-ID.
      expect(endpointRequests).toHaveLength(2);
    });

    it('re-discovers once and retries every endpoint when any endpoint is stale', async () => {
      await storeTestCredential();
      const { fakeFetch, endpointRequests } = makeFakeWordPressSite({
        advertisedEndpointsPerDiscovery: [
          [{ url: ingressEndpointUrl }, { url: secondIngressEndpointUrl }],
        ],
        endpointResponseStatusesByUrl: {
          [ingressEndpointUrl]: [201, 200],
          [secondIngressEndpointUrl]: [404, 201],
        },
      });

      const deliveryResult = await deliverRawEmailToWordPress(
        makeWorkerConfiguration(),
        makeRawEmailForDelivery(),
        fakeFetch,
      );

      // Both endpoints were retried after re-discovery (idempotent: the
      // first endpoint answers 200 for the duplicate).
      expect(endpointRequests).toHaveLength(4);
      expect(deliveryResult.deliveries.map(({ httpStatus }) => httpStatus).sort()).toEqual([
        200, 201,
      ]);
    });
  });
});
