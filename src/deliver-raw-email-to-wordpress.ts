/**
 * Delivery of a raw MIME email message to the selected WordPress ingress
 * endpoint.
 *
 * The message bytes are sent unmodified as `message/rfc822`; WordPress
 * parses them with zbateson/mail-mime-parser. The SMTP envelope travels in
 * HTTP request headers. The email's own Message-ID header is the
 * idempotency key — WordPress upserts, so retries must not create
 * duplicates.
 *
 * The destination is the endpoint the administrator selected during setup
 * ({@link ./selected-email-ingress-endpoint}). The worker delivers there and
 * nowhere else: a failing endpoint is a loud failure (the caller throws so
 * the sending server retries, and alerts the administrator), never a reason
 * to re-route mail to a different mailbox.
 *
 * The size guard uses the envelope-reported size so an oversized message is
 * rejected before the stream is buffered.
 *
 * Error semantics:
 * - EmailTooLargeError           → permanent; caller should setReject().
 * - MissingSelectedEndpointError → transient until setup completes.
 * - MissingCredentialError       → thrown through; transient until setup is
 *                                  done.
 * - DeliveryFailedError          → transient; caller should throw so the
 *                                  sending mail server retries.
 */

import type { WorkerConfiguration } from './configuration';
import {
  getSelectedEmailIngressEndpoint,
  MissingSelectedEndpointError,
} from './selected-email-ingress-endpoint';
import type { EmailIngressEndpoint } from './wordpress-rest-api-discovery';
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

/**
 * Deliver a raw email to the ingress endpoint selected during setup.
 *
 * @throws MissingSelectedEndpointError when setup has not completed
 * (transient failure).
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
  const emailIngressEndpoint = await getSelectedEmailIngressEndpoint(
    workerConfiguration.workerConfigurationKv,
  );

  if (!emailIngressEndpoint) {
    throw new MissingSelectedEndpointError();
  }

  // Size guard runs on the envelope-reported size BEFORE buffering, so an
  // oversized message (up to 25 MiB) is never read into memory.
  if (rawEmailForDelivery.rawEmailSizeBytes > emailIngressEndpoint.maxMessageSizeBytes) {
    throw new EmailTooLargeError(
      `Message of ${String(rawEmailForDelivery.rawEmailSizeBytes)} bytes exceeds the endpoint's limit of ${String(emailIngressEndpoint.maxMessageSizeBytes)} bytes.`,
    );
  }

  const credential = await getWordPressApplicationPasswordCredential(
    workerConfiguration.workerConfigurationKv,
  );
  const authorizationHeaderValue = buildBasicAuthorizationHeaderValue(credential);

  const rawEmailBytes = new Uint8Array(
    await new Response(rawEmailForDelivery.rawEmailStream).arrayBuffer(),
  );

  const response = await postRawEmailToEndpoint(
    emailIngressEndpoint,
    rawEmailForDelivery,
    rawEmailBytes,
    authorizationHeaderValue,
    fetchFunction,
  );

  if (!response.ok) {
    // 404/410 included: the selected endpoint is this worker's only
    // destination. If it has moved or been disabled, the administrator must
    // re-run setup — mail queues on the sending server meanwhile.
    throw new DeliveryFailedError(
      `Delivery to ${emailIngressEndpoint.url} failed with HTTP ${String(response.status)}.`,
    );
  }

  return { endpointUrl: emailIngressEndpoint.url, httpStatus: response.status };
}
