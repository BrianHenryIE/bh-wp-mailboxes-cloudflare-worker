/**
 * Delivery of a raw MIME email message to the WordPress ingress endpoint.
 *
 * The message bytes are sent unmodified as `message/rfc822`; WordPress
 * parses them with zbateson/mail-mime-parser. The SMTP envelope travels in
 * HTTP request headers. The email's own Message-ID header is the
 * idempotency key — WordPress upserts, so retries must not create
 * duplicates.
 *
 * Error semantics:
 * - EmailTooLargeError    → permanent; caller should setReject().
 * - MissingCredentialError → thrown through; transient until setup is done.
 * - DeliveryFailedError   → transient; caller should throw so the sending
 *                           mail server retries.
 * - HTTP 404/410          → cached endpoint is stale; invalidate, re-discover
 *                           and retry exactly once within this invocation.
 */

import type { WorkerConfiguration } from './configuration';
import {
  getCachedOrDiscoverEmailIngressEndpoint,
  invalidateCachedEmailIngressEndpoint,
  type EmailIngressEndpoint,
} from './wordpress-rest-api-discovery';
import {
  buildBasicAuthorizationHeaderValue,
  getWordPressApplicationPasswordCredential,
} from './wordpress-application-password';

export interface RawEmailForDelivery {
  envelopeFrom: string;
  envelopeTo: string;
  rawEmailBytes: Uint8Array;
}

export interface DeliveryResult {
  endpointUrl: string;
  httpStatus: number;
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
      'x-message-raw-size': String(rawEmailForDelivery.rawEmailBytes.byteLength),
    },
    body: rawEmailForDelivery.rawEmailBytes,
  });
}

/**
 * Deliver a raw email to the discovered WordPress ingress endpoint.
 *
 * @throws EmailTooLargeError when the message exceeds the endpoint's
 * advertised max_message_size_bytes (permanent failure).
 * @throws DeliveryFailedError when WordPress does not accept the message
 * (transient failure; the caller should let the sending server retry).
 */
export async function deliverRawEmailToWordPress(
  workerConfiguration: WorkerConfiguration,
  rawEmailForDelivery: RawEmailForDelivery,
  fetchFunction: typeof fetch = fetch,
): Promise<DeliveryResult> {
  const emailIngressEndpoint = await getCachedOrDiscoverEmailIngressEndpoint(
    workerConfiguration.workerConfigurationKv,
    workerConfiguration.targetWordPressSiteUrl,
    fetchFunction,
  );

  if (rawEmailForDelivery.rawEmailBytes.byteLength > emailIngressEndpoint.maxMessageSizeBytes) {
    throw new EmailTooLargeError(
      `Message of ${String(rawEmailForDelivery.rawEmailBytes.byteLength)} bytes exceeds the endpoint's limit of ${String(emailIngressEndpoint.maxMessageSizeBytes)} bytes.`,
    );
  }

  const credential = await getWordPressApplicationPasswordCredential(
    workerConfiguration.workerConfigurationKv,
  );
  const authorizationHeaderValue = buildBasicAuthorizationHeaderValue(credential);

  let response = await postRawEmailToEndpoint(
    emailIngressEndpoint,
    rawEmailForDelivery,
    authorizationHeaderValue,
    fetchFunction,
  );

  // A stale cached endpoint (plugin update/deactivation, permalink change):
  // invalidate, re-discover, retry exactly once.
  if (STALE_ENDPOINT_HTTP_STATUSES.includes(response.status)) {
    await invalidateCachedEmailIngressEndpoint(workerConfiguration.workerConfigurationKv);

    const rediscoveredEmailIngressEndpoint = await getCachedOrDiscoverEmailIngressEndpoint(
      workerConfiguration.workerConfigurationKv,
      workerConfiguration.targetWordPressSiteUrl,
      fetchFunction,
    );

    response = await postRawEmailToEndpoint(
      rediscoveredEmailIngressEndpoint,
      rawEmailForDelivery,
      authorizationHeaderValue,
      fetchFunction,
    );

    if (response.ok) {
      return { endpointUrl: rediscoveredEmailIngressEndpoint.url, httpStatus: response.status };
    }

    throw new DeliveryFailedError(
      `Delivery failed with HTTP ${String(response.status)} after endpoint re-discovery.`,
    );
  }

  if (!response.ok) {
    throw new DeliveryFailedError(`Delivery failed with HTTP ${String(response.status)}.`);
  }

  return { endpointUrl: emailIngressEndpoint.url, httpStatus: response.status };
}
