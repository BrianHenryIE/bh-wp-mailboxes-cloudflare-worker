/**
 * bh-wp-mailboxes incoming email worker.
 *
 * Receives email via Cloudflare Email Routing and delivers the raw MIME
 * message to the WordPress REST API endpoint provided by the
 * bh-wp-mailboxes plugin. See PLAN.md for the design.
 *
 * - `email()`: validate recipient domain → buffer raw message → deliver.
 *   Permanent failures (wrong domain, oversize) reject the message with an
 *   SMTP error; transient failures throw so the sending server retries.
 * - `fetch()`: serves the one-time application-password setup flow.
 */

import {
  assertRecipientDomainMatchesTargetWordPressSite,
  parseWorkerConfiguration,
  RecipientDomainMismatchError,
  type WorkerEnvironment,
} from './configuration';
import { deliverRawEmailToWordPress, EmailTooLargeError } from './deliver-raw-email-to-wordpress';
import {
  handleSetupCallbackRequest,
  handleSetupRequest,
  SETUP_CALLBACK_ROUTE_PATH,
  SETUP_ROUTE_PATH,
} from './setup-routes';

export type { WorkerEnvironment };

/**
 * The email() handler logic, with fetch injectable for tests.
 */
export async function handleIncomingEmailMessage(
  message: ForwardableEmailMessage,
  environment: WorkerEnvironment,
  fetchFunction: typeof fetch = fetch,
): Promise<void> {
  const workerConfiguration = parseWorkerConfiguration(environment);

  try {
    assertRecipientDomainMatchesTargetWordPressSite(
      message.to,
      workerConfiguration.targetWordPressSiteUrl,
    );
  } catch (error) {
    if (error instanceof RecipientDomainMismatchError) {
      message.setReject(`Recipient not accepted: ${error.message}`);
      return;
    }
    throw error;
  }

  try {
    const deliveryResult = await deliverRawEmailToWordPress(
      workerConfiguration,
      {
        envelopeFrom: message.from,
        envelopeTo: message.to,
        rawEmailSizeBytes: message.rawSize,
        rawEmailStream: message.raw,
      },
      fetchFunction,
    );
    console.log(
      `Delivered ${String(message.rawSize)} bytes from ${message.from} to ${deliveryResult.endpointUrl} (HTTP ${String(deliveryResult.httpStatus)}).`,
    );
  } catch (error) {
    if (error instanceof EmailTooLargeError) {
      // Permanent: retrying an oversized message can never succeed.
      message.setReject('Message too large for the receiving mailbox.');
      return;
    }
    // Transient (WordPress down, credential not yet configured, discovery
    // failure): throw so Cloudflare returns a temporary SMTP error and the
    // sending server retries.
    throw error;
  }
}

/**
 * The fetch() handler logic: the application-password setup flow.
 */
export async function handleFetchRequest(
  request: Request,
  environment: WorkerEnvironment,
): Promise<Response> {
  const workerConfiguration = parseWorkerConfiguration(environment);
  const requestUrl = new URL(request.url);

  if (requestUrl.pathname === SETUP_ROUTE_PATH) {
    return handleSetupRequest(request, workerConfiguration);
  }

  if (requestUrl.pathname === SETUP_CALLBACK_ROUTE_PATH) {
    return handleSetupCallbackRequest(request, workerConfiguration);
  }

  return new Response('Not found.', { status: 404 });
}

export default {
  async email(message, environment): Promise<void> {
    await handleIncomingEmailMessage(message, environment);
  },

  async fetch(request, environment): Promise<Response> {
    return handleFetchRequest(request, environment);
  },
} satisfies ExportedHandler<WorkerEnvironment>;
