/**
 * Administrator alerting when email delivery to WordPress is failing.
 *
 * The whole point of alerting is that it works when the WordPress site does
 * not, so alerts are sent through Cloudflare Email Routing's `send_email`
 * binding — entirely independent of the site being delivered to. The
 * recipient must be a verified destination address on the worker's zone.
 *
 * Alerts are rate-limited to at most one per day via a KV entry with a
 * 24-hour expiry (approximate: concurrent invocations may race, which is
 * acceptable for an advisory alert). Alerting failures are logged and
 * swallowed — they must never affect handling of the email itself.
 *
 * Optional: when the binding or addresses are not configured, failures are
 * logged only.
 */

import type { DeliveryFailureAlertConfiguration } from './configuration';

const ALERT_SENT_RECENTLY_KV_KEY = 'delivery_failure_alert_sent_recently';
const ALERT_MINIMUM_INTERVAL_SECONDS = 24 * 60 * 60;

export interface DeliveryFailureDetails {
  targetWordPressSiteUrl: string;
  errorName: string;
  errorMessage: string;
  envelopeFrom: string;
  envelopeTo: string;
}

export type SendAlertEmailFunction = (
  alertConfiguration: DeliveryFailureAlertConfiguration,
  subject: string,
  body: string,
) => Promise<void>;

/**
 * Build the raw RFC 5322 message and send it through the `send_email` binding.
 *
 * `cloudflare:email` only exists inside workerd, so it is imported lazily —
 * unit tests inject their own {@link SendAlertEmailFunction}.
 */
const sendAlertEmailViaBinding: SendAlertEmailFunction = async (
  alertConfiguration,
  subject,
  body,
) => {
  const { EmailMessage } = await import('cloudflare:email');

  const rawMessage =
    `From: ${alertConfiguration.fromEmailAddress}\r\n` +
    `To: ${alertConfiguration.recipientEmailAddress}\r\n` +
    `Subject: ${subject}\r\n` +
    `Date: ${new Date().toUTCString()}\r\n` +
    `Message-ID: <delivery-failure-alert-${String(Date.now())}@${alertConfiguration.fromEmailAddress.split('@')[1] ?? 'worker'}>\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `\r\n` +
    body;

  await alertConfiguration.sendEmailBinding.send(
    new EmailMessage(
      alertConfiguration.fromEmailAddress,
      alertConfiguration.recipientEmailAddress,
      rawMessage,
    ),
  );
};

/**
 * Send a delivery-failure alert email, unless one was already sent within
 * the last 24 hours or alerting is not configured. Never throws.
 */
export async function maybeSendDeliveryFailureAlert(
  workerConfigurationKv: KVNamespace,
  alertConfiguration: DeliveryFailureAlertConfiguration | null,
  failureDetails: DeliveryFailureDetails,
  sendAlertEmailFunction: SendAlertEmailFunction = sendAlertEmailViaBinding,
): Promise<void> {
  try {
    if (!alertConfiguration) {
      console.log(
        `Delivery failure (alerting not configured): ${failureDetails.errorName}: ${failureDetails.errorMessage}`,
      );
      return;
    }

    const alertSentRecently = await workerConfigurationKv.get(ALERT_SENT_RECENTLY_KV_KEY);
    if (alertSentRecently) {
      return;
    }

    // Mark before sending so a send that fails after the SMTP handshake
    // cannot loop into repeated sends on rapid redeliveries.
    await workerConfigurationKv.put(ALERT_SENT_RECENTLY_KV_KEY, new Date().toISOString(), {
      expirationTtl: ALERT_MINIMUM_INTERVAL_SECONDS,
    });

    const subject = `Email delivery to ${failureDetails.targetWordPressSiteUrl} is failing`;
    const body =
      `The bh-wp-mailboxes Cloudflare email worker could not deliver an incoming email to WordPress.\n` +
      `\n` +
      `Site: ${failureDetails.targetWordPressSiteUrl}\n` +
      `Error: ${failureDetails.errorName}: ${failureDetails.errorMessage}\n` +
      `Envelope from: ${failureDetails.envelopeFrom}\n` +
      `Envelope to: ${failureDetails.envelopeTo}\n` +
      `Time: ${new Date().toISOString()}\n` +
      `\n` +
      `Transient failures are retried by the sending mail server, so no mail is lost yet — ` +
      `but delivery will keep failing until the cause is fixed. Check the site is up, the ` +
      `receiving plugin is active, and the worker's selected endpoint and application ` +
      `password are still valid (re-run the worker /setup route if needed).\n` +
      `\n` +
      `At most one of these alerts is sent per day.\n`;

    await sendAlertEmailFunction(alertConfiguration, subject, body);
    console.log(`Delivery-failure alert sent to ${alertConfiguration.recipientEmailAddress}.`);
  } catch (error) {
    console.log(
      `Failed to send delivery-failure alert: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
