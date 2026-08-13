/**
 * Delivery of a raw MIME email message to the WordPress ingress endpoints.
 *
 * The message bytes are sent unmodified as `message/rfc822`; WordPress
 * parses them with zbateson/mail-mime-parser. The SMTP envelope travels in
 * HTTP request headers. The email's own Message-ID header is the
 * idempotency key — WordPress upserts, so retries must not create
 * duplicates.
 *
 * A site may advertise multiple ingress endpoints (one per mailbox/library
 * instance). Delivery fans out: every endpoint whose advertised size limit
 * accepts the message receives it. Idempotency makes retries safe — when a
 * partial failure causes the sending server to retry, the endpoints that
 * already stored the message answer 200 without duplicating.
 *
 * The size guard uses the envelope-reported size so a message no endpoint
 * can accept is rejected before the stream is buffered; the stream is then
 * buffered once so the body can be re-sent on the single re-discovery retry.
 *
 * Error semantics:
 * - EmailTooLargeError    → permanent; no endpoint can accept the message;
 *                           caller should setReject().
 * - MissingCredentialError → thrown through; transient until setup is done.
 * - DeliveryFailedError   → transient; at least one endpoint did not accept;
 *                           caller should throw so the sending mail server
 *                           retries (idempotency dedupes the successes).
 * - HTTP 404/410          → cached endpoints are stale; invalidate,
 *                           re-discover and retry all endpoints exactly once
 *                           within this invocation.
 */

import type { WorkerConfiguration } from './configuration';
import {
  getCachedOrDiscoverEmailIngressEndpoints,
  invalidateCachedEmailIngressEndpoints,
  type EmailIngressEndpoint,
} from './wordpress-rest-api-discovery';
import {
  buildBasicAuthorizationHeaderValue,
  getWordPressApplicationPasswordCredential,
} from './wordpress-application-password';

export interface RawEmailForDelivery {
  envelopeFrom: string;
  envelopeTo: string;
  /** Size reported by the SMTP envelope (ForwardableEmailMessage.rawSize). */
  rawEmailSizeBytes: number;
  /** The raw message stream; only buffered after the size guard passes. */
  rawEmailStream: ReadableStream<Uint8Array>;
}

export interface EndpointDeliveryResult {
  endpointUrl: string;
  httpStatus: number;
}

export interface DeliveryResult {
  /** One entry per endpoint the message was delivered to. */
  deliveries: EndpointDeliveryResult[];
  /** Endpoints skipped because the message exceeds their advertised size limit. */
  skippedOversizeEndpointUrls: string[];
}

export class EmailTooLargeError extends Error {
  override readonly name = 'EmailTooLargeError';
}

export class DeliveryFailedError extends Error {
  override readonly name = 'DeliveryFailedError';
}

const STALE_ENDPOINT_HTTP_STATUSES = [404, 410];

async function postRawEmailToEndpoint(
  emailIngressEndpoint: EmailIngressEndpoint,
  rawEmailForDelivery: RawEmailForDelivery,
  rawEmailBytes: Uint8Array,
  authorizationHeaderValue: string,
  fetchFunction: typeof fetch,
): Promise<Response> {
  return fetchFunction(emailIngressEndpoint.url, {
    method: 'POST',
    headers: {
      authorization: authorizationHeaderValue,
      'content-type': emailIngressEndpoint.accepts,
      'x-envelope-from': rawEmailForDelivery.envelopeFrom,
      'x-envelope-to': rawEmailForDelivery.envelopeTo,
      'x-message-raw-size': String(rawEmailBytes.byteLength),
    },
    body: rawEmailBytes,
  });
}

/** Split endpoints into those whose advertised size limit accepts the message, and the rest. */
function partitionEndpointsBySizeLimit(
  emailIngressEndpoints: EmailIngressEndpoint[],
  rawEmailSizeBytes: number,
): { acceptingEndpoints: EmailIngressEndpoint[]; oversizeEndpointUrls: string[] } {
  const acceptingEndpoints: EmailIngressEndpoint[] = [];
  const oversizeEndpointUrls: string[] = [];
  for (const endpoint of emailIngressEndpoints) {
    if (rawEmailSizeBytes > endpoint.maxMessageSizeBytes) {
      oversizeEndpointUrls.push(endpoint.url);
    } else {
      acceptingEndpoints.push(endpoint);
    }
  }
  return { acceptingEndpoints, oversizeEndpointUrls };
}

/** POST the message to every endpoint concurrently, pairing each with its response. */
async function postRawEmailToAllEndpoints(
  emailIngressEndpoints: EmailIngressEndpoint[],
  rawEmailForDelivery: RawEmailForDelivery,
  rawEmailBytes: Uint8Array,
  authorizationHeaderValue: string,
  fetchFunction: typeof fetch,
): Promise<{ endpoint: EmailIngressEndpoint; response: Response }[]> {
  return Promise.all(
    emailIngressEndpoints.map(async (endpoint) => ({
      endpoint,
      response: await postRawEmailToEndpoint(
        endpoint,
        rawEmailForDelivery,
        rawEmailBytes,
        authorizationHeaderValue,
        fetchFunction,
      ),
    })),
  );
}

/**
 * Deliver a raw email to every discovered WordPress ingress endpoint whose
 * size limit accepts it.
 *
 * @throws EmailTooLargeError when the message exceeds every endpoint's
 * advertised max_message_size_bytes (permanent failure).
 * @throws DeliveryFailedError when any endpoint does not accept the message
 * (transient failure; the caller should let the sending server retry —
 * endpoints that already stored the message dedupe on redelivery).
 */
export async function deliverRawEmailToWordPress(
  workerConfiguration: WorkerConfiguration,
  rawEmailForDelivery: RawEmailForDelivery,
  fetchFunction: typeof fetch = fetch,
): Promise<DeliveryResult> {
  const emailIngressEndpoints = await getCachedOrDiscoverEmailIngressEndpoints(
    workerConfiguration.workerConfigurationKv,
    workerConfiguration.targetWordPressSiteUrl,
    fetchFunction,
  );

  // Size guard runs on the envelope-reported size BEFORE buffering, so a
  // message no endpoint can accept (up to 25 MiB) is never read into memory.
  let { acceptingEndpoints, oversizeEndpointUrls } = partitionEndpointsBySizeLimit(
    emailIngressEndpoints,
    rawEmailForDelivery.rawEmailSizeBytes,
  );

  if (acceptingEndpoints.length === 0) {
    throw new EmailTooLargeError(
      `Message of ${String(rawEmailForDelivery.rawEmailSizeBytes)} bytes exceeds every endpoint's advertised size limit.`,
    );
  }

  const credential = await getWordPressApplicationPasswordCredential(
    workerConfiguration.workerConfigurationKv,
  );
  const authorizationHeaderValue = buildBasicAuthorizationHeaderValue(credential);

  // Buffer the stream (a stream is single-read) so the body can be sent to
  // every endpoint and re-sent on the re-discovery retry below.
  const rawEmailBytes = new Uint8Array(
    await new Response(rawEmailForDelivery.rawEmailStream).arrayBuffer(),
  );

  let deliveryAttempts = await postRawEmailToAllEndpoints(
    acceptingEndpoints,
    rawEmailForDelivery,
    rawEmailBytes,
    authorizationHeaderValue,
    fetchFunction,
  );

  // A stale cached endpoint (plugin update/deactivation, permalink change):
  // invalidate, re-discover, retry every endpoint exactly once. Retrying
  // endpoints that already accepted is safe — delivery is idempotent.
  const anyStaleEndpoint = deliveryAttempts.some(({ response }) =>
    STALE_ENDPOINT_HTTP_STATUSES.includes(response.status),
  );

  if (anyStaleEndpoint) {
    await invalidateCachedEmailIngressEndpoints(workerConfiguration.workerConfigurationKv);

    const rediscoveredEmailIngressEndpoints = await getCachedOrDiscoverEmailIngressEndpoints(
      workerConfiguration.workerConfigurationKv,
      workerConfiguration.targetWordPressSiteUrl,
      fetchFunction,
    );

    ({ acceptingEndpoints, oversizeEndpointUrls } = partitionEndpointsBySizeLimit(
      rediscoveredEmailIngressEndpoints,
      rawEmailForDelivery.rawEmailSizeBytes,
    ));

    if (acceptingEndpoints.length === 0) {
      throw new EmailTooLargeError(
        `Message of ${String(rawEmailForDelivery.rawEmailSizeBytes)} bytes exceeds every endpoint's advertised size limit.`,
      );
    }

    deliveryAttempts = await postRawEmailToAllEndpoints(
      acceptingEndpoints,
      rawEmailForDelivery,
      rawEmailBytes,
      authorizationHeaderValue,
      fetchFunction,
    );
  }

  const failedDeliveries = deliveryAttempts.filter(({ response }) => !response.ok);
  if (failedDeliveries.length > 0) {
    const failureSummary = failedDeliveries
      .map(({ endpoint, response }) => `${endpoint.url} → HTTP ${String(response.status)}`)
      .join(', ');
    throw new DeliveryFailedError(
      `Delivery failed for ${String(failedDeliveries.length)} of ${String(deliveryAttempts.length)} endpoints${anyStaleEndpoint ? ' after endpoint re-discovery' : ''}: ${failureSummary}.`,
    );
  }

  return {
    deliveries: deliveryAttempts.map(({ endpoint, response }) => ({
      endpointUrl: endpoint.url,
      httpStatus: response.status,
    })),
    skippedOversizeEndpointUrls: oversizeEndpointUrls,
  };
}
