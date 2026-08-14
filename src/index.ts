/**
 *
 * bh-wp-mailboxes incoming email worker.
 *
 * Receives email via Cloudflare Email Routing and delivers the raw MIME
 * message to the WordPress REST API endpoint selected during setup. See
 * PLAN.md for the design.
 *
 * - `email()`: buffer raw message → deliver. Permanent failures (oversize)
 *   reject the message with an SMTP error; transient failures throw so the
 *   sending server retries. Failures also alert the administrator by email
 *   (rate-limited, sent independently of the WordPress site).
 * - `fetch()`: serves the one-time setup flow — application-password
 *   authorization plus selection of the destination ingress endpoint.
 */

import { parseWorkerConfiguration, type WorkerEnvironment } from './configuration';
import { deliverRawEmailToWordPress, EmailTooLargeError } from './deliver-raw-email-to-wordpress';
import {
  maybeSendDeliveryFailureAlert,
  type SendAlertEmailFunction,
} from './delivery-failure-alerting';
import {
  handleSetupCallbackRequest,
  handleSetupRequest,
  SETUP_CALLBACK_ROUTE_PATH,
  SETUP_ROUTE_PATH,
} from './setup-routes';
import { getTargetWordPressSiteUrl } from './target-wordpress-site-url';

export type { WorkerEnvironment };

/**
 * The email() handler logic, with fetch and alert-sending injectable for tests.
 */
export async function handleIncomingEmailMessage(
  message: ForwardableEmailMessage,
  environment: WorkerEnvironment,
  fetchFunction: typeof fetch = fetch,
  sendAlertEmailFunction?: SendAlertEmailFunction,
): Promise<void> {
  const workerConfiguration = parseWorkerConfiguration(environment);

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
    // Alert the administrator (rate-limited, independent of the WordPress
    // site); never let alerting problems affect the SMTP outcome.
    const targetWordPressSiteUrl = await getTargetWordPressSiteUrl(
      workerConfiguration.workerConfigurationKv,
    );
    await maybeSendDeliveryFailureAlert(
      workerConfiguration.workerConfigurationKv,
      workerConfiguration.alertSendEmailBinding,
      {
        targetWordPressSiteUrl: targetWordPressSiteUrl?.origin ?? '(site URL not configured)',
        errorName: error instanceof Error ? error.name : 'Error',
        errorMessage: error instanceof Error ? error.message : String(error),
        envelopeFrom: message.from,
        envelopeTo: message.to,
      },
      sendAlertEmailFunction,
    );

    if (error instanceof EmailTooLargeError) {
      // Permanent: retrying an oversized message can never succeed.
      message.setReject('Message too large for the receiving mailbox.');
      return;
    }
    // Transient (WordPress down, setup not completed, endpoint refusing):
    // throw so Cloudflare returns a temporary SMTP error and the sending
    // server retries.
    throw error;
  }
}

/**
 * The fetch() handler logic: the setup flow (application password +
 * destination endpoint selection).
 */
export async function handleFetchRequest(
  request: Request,
  environment: WorkerEnvironment,
  fetchFunction: typeof fetch = fetch,
): Promise<Response> {
  const workerConfiguration = parseWorkerConfiguration(environment);
  const requestUrl = new URL(request.url);

  if (requestUrl.pathname === SETUP_ROUTE_PATH) {
    return handleSetupRequest(request, workerConfiguration, fetchFunction);
  }

  if (requestUrl.pathname === SETUP_CALLBACK_ROUTE_PATH) {
    return handleSetupCallbackRequest(request, workerConfiguration, fetchFunction);
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
