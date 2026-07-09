import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { WorkerConfiguration } from '../src/configuration';
import {
  deliverRawEmailToWordPress,
  DeliveryFailedError,
  EmailTooLargeError,
  type RawEmailForDelivery,
} from '../src/deliver-raw-email-to-wordpress';
import { MissingCredentialError } from '../src/wordpress-application-password';
import { FakeKvNamespace } from './fakes/fake-kv-namespace';

const ingressEndpointUrl = 'https://sacramentogaa.org/wp-json/bh-wp-mailboxes/v1/incoming-email';
const rediscoveredIngressEndpointUrl =
  'https://sacramentogaa.org/wp-json/bh-wp-mailboxes/v2/incoming-email';

const textEncoder = new TextEncoder();

function makeRawEmailForDelivery(
  rawEmailContent = 'Message-ID: <fixture-1@example>\r\n\r\nHello',
): RawEmailForDelivery {
  return {
    envelopeFrom: 'sender@example.com',
    envelopeTo: 'mailbox@p.sacramentogaa.org',
    rawEmailBytes: textEncoder.encode(rawEmailContent),
  };
}

interface FakeWordPressSiteOptions {
  endpointResponseStatuses?: number[];
  maxMessageSizeBytes?: number;
  advertisedUrlPerDiscovery?: string[];
}

/**
 * A fake fetch that serves WordPress discovery (HEAD site, GET /wp-json/)
 * and the ingress endpoint POST, recording endpoint requests.
 */
function makeFakeWordPressSite({
  endpointResponseStatuses = [201],
  maxMessageSizeBytes = 1024,
  advertisedUrlPerDiscovery = [ingressEndpointUrl],
}: FakeWordPressSiteOptions = {}) {
  const endpointRequests: Request[] = [];
  let discoveryCount = 0;
  let endpointResponseIndex = 0;

  const fakeFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input.toString(), init);

    if (request.method === 'HEAD') {
      return Promise.resolve(
        new Response(null, {
          status: 200,
          headers: { link: '<https://sacramentogaa.org/wp-json/>; rel="https://api.w.org/"' },
        }),
      );
    }

    if (request.url === 'https://sacramentogaa.org/wp-json/') {
      const advertisedUrl =
        advertisedUrlPerDiscovery[Math.min(discoveryCount, advertisedUrlPerDiscovery.length - 1)];
      discoveryCount += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            email_ingress_endpoints: [
              {
                version: 1,
                namespace: 'bh-wp-mailboxes/v1',
                url: advertisedUrl,
                accepts: 'message/rfc822',
                max_message_size_bytes: maxMessageSizeBytes,
              },
            ],
          }),
          { status: 200 },
        ),
      );
    }

    endpointRequests.push(request);
    const status =
      endpointResponseStatuses[
        Math.min(endpointResponseIndex, endpointResponseStatuses.length - 1)
      ] ?? 500;
    endpointResponseIndex += 1;
    return Promise.resolve(new Response(null, { status }));
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

  return { fakeFetch, endpointRequests };
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

    expect(deliveryResult.httpStatus).toBe(201);
    expect(deliveryResult.endpointUrl).toBe(ingressEndpointUrl);

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

  it('throws EmailTooLargeError before POSTing when the message exceeds the advertised limit', async () => {
    await storeTestCredential();
    const { fakeFetch, endpointRequests } = makeFakeWordPressSite({ maxMessageSizeBytes: 10 });

    await expect(
      deliverRawEmailToWordPress(
        makeWorkerConfiguration(),
        makeRawEmailForDelivery('x'.repeat(100)),
        fakeFetch,
      ),
    ).rejects.toThrow(EmailTooLargeError);

    expect(endpointRequests).toHaveLength(0);
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
      'email_ingress_endpoint',
      JSON.stringify({
        version: 1,
        namespace: 'bh-wp-mailboxes/v1',
        url: ingressEndpointUrl,
        accepts: 'message/rfc822',
        max_message_size_bytes: 1024,
      }),
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

    expect(deliveryResult.httpStatus).toBe(201);
    expect(deliveryResult.endpointUrl).toBe(rediscoveredIngressEndpointUrl);
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
});
