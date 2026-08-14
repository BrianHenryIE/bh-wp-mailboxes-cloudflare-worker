import { beforeEach, describe, expect, it } from 'vitest';

import type { WorkerConfiguration } from '../src/configuration';
import {
  deliverRawEmailToWordPress,
  DeliveryFailedError,
  EmailTooLargeError,
  type RawEmailForDelivery,
} from '../src/deliver-raw-email-to-wordpress';
import { MissingSelectedEndpointError } from '../src/selected-email-ingress-endpoint';
import { MissingCredentialError } from '../src/wordpress-application-password';
import { FakeKvNamespace } from './fakes/fake-kv-namespace';
import { fakeSiteIngressEndpointUrl, makeFakeWordPressSite } from './fakes/fake-wordpress-site';

const ingressEndpointUrl = fakeSiteIngressEndpointUrl;

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
    setupToken: 'token',
    workerConfigurationKv: fakeKvNamespace.asKvNamespace(),
    alertSendEmailBinding: null,
  };
}

async function storeTestCredential(): Promise<void> {
  await fakeKvNamespace.put(
    'wordpress_application_password_credential',
    JSON.stringify({ userLogin: 'ingress-user', applicationPassword: 'app pass' }),
  );
}

async function storeSelectedEndpoint(
  endpointUrl = ingressEndpointUrl,
  maxMessageSizeBytes = 1024,
): Promise<void> {
  await fakeKvNamespace.put(
    'selected_email_ingress_endpoint',
    JSON.stringify({
      version: 1,
      namespace: 'bh-wp-mailboxes/v1',
      url: endpointUrl,
      accepts: 'message/rfc822',
      maxMessageSizeBytes,
    }),
  );
}

beforeEach(() => {
  fakeKvNamespace = new FakeKvNamespace();
});

describe('deliverRawEmailToWordPress', () => {
  it('POSTs the raw bytes to the selected endpoint with envelope and auth headers', async () => {
    await storeTestCredential();
    await storeSelectedEndpoint();
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

    expect(endpointRequest.url).toBe(ingressEndpointUrl);
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

  it('never performs discovery at delivery time', async () => {
    await storeTestCredential();
    await storeSelectedEndpoint();
    const { fakeFetch } = makeFakeWordPressSite();

    await deliverRawEmailToWordPress(
      makeWorkerConfiguration(),
      makeRawEmailForDelivery(),
      fakeFetch,
    );

    const requestedUrls = fakeFetch.mock.calls.map((callArguments) => {
      const input = callArguments[0] as RequestInfo | URL;
      return input instanceof Request ? input.url : input.toString();
    });
    expect(requestedUrls).toEqual([ingressEndpointUrl]);
  });

  it('throws MissingSelectedEndpointError (transient) when setup has not completed', async () => {
    await storeTestCredential();
    const { fakeFetch, endpointRequests } = makeFakeWordPressSite();

    await expect(
      deliverRawEmailToWordPress(makeWorkerConfiguration(), makeRawEmailForDelivery(), fakeFetch),
    ).rejects.toThrow(MissingSelectedEndpointError);

    expect(endpointRequests).toHaveLength(0);
  });

  it('throws EmailTooLargeError before POSTing or buffering when the message exceeds the advertised limit', async () => {
    await storeTestCredential();
    await storeSelectedEndpoint(ingressEndpointUrl, 10);
    const { fakeFetch, endpointRequests } = makeFakeWordPressSite();
    const oversizedRawEmail = makeRawEmailForDelivery('x'.repeat(100));

    await expect(
      deliverRawEmailToWordPress(makeWorkerConfiguration(), oversizedRawEmail, fakeFetch),
    ).rejects.toThrow(EmailTooLargeError);

    expect(endpointRequests).toHaveLength(0);
    // The stream was never read: the size guard uses the envelope-reported
    // size, so oversized mail is not buffered into memory.
    expect(oversizedRawEmail.rawEmailStream.locked).toBe(false);
  });

  it('throws MissingCredentialError when setup has not stored a credential', async () => {
    await storeSelectedEndpoint();
    const { fakeFetch } = makeFakeWordPressSite();

    await expect(
      deliverRawEmailToWordPress(makeWorkerConfiguration(), makeRawEmailForDelivery(), fakeFetch),
    ).rejects.toThrow(MissingCredentialError);
  });

  it('throws DeliveryFailedError on a non-2xx response', async () => {
    await storeTestCredential();
    await storeSelectedEndpoint();
    const { fakeFetch } = makeFakeWordPressSite({ endpointResponseStatuses: [500] });

    await expect(
      deliverRawEmailToWordPress(makeWorkerConfiguration(), makeRawEmailForDelivery(), fakeFetch),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('throws DeliveryFailedError on 404 without re-routing to another endpoint', async () => {
    await storeTestCredential();
    await storeSelectedEndpoint();
    const { fakeFetch, endpointRequests } = makeFakeWordPressSite({
      endpointResponseStatuses: [404],
    });

    await expect(
      deliverRawEmailToWordPress(makeWorkerConfiguration(), makeRawEmailForDelivery(), fakeFetch),
    ).rejects.toThrow(DeliveryFailedError);

    // Exactly one attempt to the selected endpoint: no discovery, no retry,
    // no delivery anywhere else. The administrator re-runs setup.
    expect(endpointRequests).toHaveLength(1);
    expect(endpointRequests[0]?.url).toBe(ingressEndpointUrl);
  });
});
