/**
 * Administrator alerting when email delivery to WordPress is failing.
 *
 * The whole point of alerting is that it works when the WordPress site does
 * not, so alerts are sent through Cloudflare Email Routing's `send_email`
 * binding — entirely independent of the site being delivered to. The binding
 * is always deployed; whether alerts are sent is decided by the addresses
 * entered on the setup UI and stored in KV. The recipient must be a verified
 * destination address on the worker's zone; the sender must be an address on
 * a zone with Email Routing enabled.
 *
 * Alerts are rate-limited to at most one per day via a KV entry with a
 * 24-hour expiry (approximate: concurrent invocations may race, which is
 * acceptable for an advisory alert). Alerting failures are logged and
 * swallowed — they must never affect handling of the email itself.
 */

const ALERT_EMAIL_ADDRESSES_KV_KEY = 'alert_email_addresses';
const ALERT_SENT_RECENTLY_KV_KEY = 'delivery_failure_alert_sent_recently';
const ALERT_MINIMUM_INTERVAL_SECONDS = 24 * 60 * 60;

export interface AlertEmailAddresses {
  /** Sender: an address on the worker's Email Routing zone. */
  fromEmailAddress: string;
  /** Recipient: a verified Email Routing destination address. */
  recipientEmailAddress: string;
}

export interface DeliveryFailureDetails {
  targetWordPressSiteUrl: string;
  errorName: string;
  errorMessage: string;
  envelopeFrom: string;
  envelopeTo: string;
}

export type SendAlertEmailFunction = (
  sendEmailBinding: SendEmail,
  alertEmailAddresses: AlertEmailAddresses,
  subject: string,
  body: string,
) => Promise<void>;

export async function storeAlertEmailAddresses(
  workerConfigurationKv: KVNamespace,
  alertEmailAddresses: AlertEmailAddresses,
): Promise<void> {
  await workerConfigurationKv.put(
    ALERT_EMAIL_ADDRESSES_KV_KEY,
    JSON.stringify(alertEmailAddresses),
  );
}

export async function deleteAlertEmailAddresses(workerConfigurationKv: KVNamespace): Promise<void> {
  await workerConfigurationKv.delete(ALERT_EMAIL_ADDRESSES_KV_KEY);
}

/**
 * The alert addresses entered during setup, or null when alerting is not
 * configured.
 */
export async function getAlertEmailAddresses(
  workerConfigurationKv: KVNamespace,
): Promise<AlertEmailAddresses | null> {
  const alertEmailAddressesJson = await workerConfigurationKv.get(ALERT_EMAIL_ADDRESSES_KV_KEY);

  if (!alertEmailAddressesJson) {
    return null;
  }

  try {
    const parsed = JSON.parse(alertEmailAddressesJson) as Partial<AlertEmailAddresses>;
    if (
      typeof parsed.fromEmailAddress === 'string' &&
      typeof parsed.recipientEmailAddress === 'string'
    ) {
      return {
        fromEmailAddress: parsed.fromEmailAddress,
        recipientEmailAddress: parsed.recipientEmailAddress,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build the raw RFC 5322 message and send it through the `send_email` binding.
 *
 * `cloudflare:email` only exists inside workerd, so it is imported lazily —
 * unit tests inject their own {@link SendAlertEmailFunction}.
 */
const sendAlertEmailViaBinding: SendAlertEmailFunction = async (
  sendEmailBinding,
  alertEmailAddresses,
  subject,
  body,
) => {
  const { EmailMessage } = await import('cloudflare:email');

  const rawMessage =
    `From: ${alertEmailAddresses.fromEmailAddress}\r\n` +
    `To: ${alertEmailAddresses.recipientEmailAddress}\r\n` +
    `Subject: ${subject}\r\n` +
    `Date: ${new Date().toUTCString()}\r\n` +
    `Message-ID: <delivery-failure-alert-${String(Date.now())}@${alertEmailAddresses.fromEmailAddress.split('@')[1] ?? 'worker'}>\r\n` +
    `Content-Type: text/plain; charset=utf-8\r\n` +
    `\r\n` +
    body;

  await sendEmailBinding.send(
    new EmailMessage(
      alertEmailAddresses.fromEmailAddress,
      alertEmailAddresses.recipientEmailAddress,
      rawMessage,
    ),
  );
};

/**
 * Send a test email to the configured alert addresses, so the administrator
 * can confirm the addresses work (recipient verified in Email Routing,
 * sender on the zone) without waiting for a real failure.
 *
 * Unlike {@link maybeSendDeliveryFailureAlert} this THROWS on failure — the
 * setup UI reports the error — and neither consumes nor respects the
 * once-per-day rate limit.
 */
export async function sendTestAlertEmail(
  sendEmailBinding: SendEmail,
  alertEmailAddresses: AlertEmailAddresses,
  sendAlertEmailFunction: SendAlertEmailFunction = sendAlertEmailViaBinding,
): Promise<void> {
  const subject = 'Test email from the bh-wp-mailboxes worker';
  const body =
    `This is a test of the delivery-failure alert emails configured on the worker's setup UI.
` +
    `
` +
    `If you are reading this, alerting works: alerts will be sent from ` +
    `${alertEmailAddresses.fromEmailAddress} to ${alertEmailAddresses.recipientEmailAddress}, ` +
    `at most once per day, when email delivery to WordPress is failing.
`;

  await sendAlertEmailFunction(sendEmailBinding, alertEmailAddresses, subject, body);
}

/**
 * Send a delivery-failure alert email, unless one was already sent within
 * the last 24 hours or no alert addresses have been configured on the setup
 * UI. Never throws.
 */
export async function maybeSendDeliveryFailureAlert(
  workerConfigurationKv: KVNamespace,
  sendEmailBinding: SendEmail | null,
  failureDetails: DeliveryFailureDetails,
  sendAlertEmailFunction: SendAlertEmailFunction = sendAlertEmailViaBinding,
): Promise<void> {
  try {
    const alertEmailAddresses = await getAlertEmailAddresses(workerConfigurationKv);

    if (!sendEmailBinding || !alertEmailAddresses) {
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

    await sendAlertEmailFunction(sendEmailBinding, alertEmailAddresses, subject, body);
    console.log(`Delivery-failure alert sent to ${alertEmailAddresses.recipientEmailAddress}.`);
  } catch (error) {
    console.log(
      `Failed to send delivery-failure alert: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
