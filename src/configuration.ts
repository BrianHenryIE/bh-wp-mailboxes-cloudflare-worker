/**
 * Worker configuration parsing and validation.
 *
 * The worker refuses to run with an invalid configuration. Which mail reaches
 * the worker is controlled by the zone's Email Routing rules; the recipient
 * domain is independent of the WordPress site's domain. The WordPress site
 * URL itself is not an env var — it is entered on the `/setup` form and
 * stored in KV ({@link ./target-wordpress-site-url}).
 */

export interface WorkerEnvironment {
  SETUP_TOKEN: string;
  WORKER_CONFIGURATION_KV: KVNamespace;
  /** Optional delivery-failure alerting: `send_email` binding. */
  ALERT_EMAIL?: SendEmail;
  /** Optional delivery-failure alerting: sender address on the worker's zone. */
  ALERT_FROM_EMAIL_ADDRESS?: string;
  /** Optional delivery-failure alerting: recipient (a verified Email Routing destination address). */
  ALERT_RECIPIENT_EMAIL_ADDRESS?: string;
}

export interface DeliveryFailureAlertConfiguration {
  sendEmailBinding: SendEmail;
  fromEmailAddress: string;
  recipientEmailAddress: string;
}

export interface WorkerConfiguration {
  setupToken: string;
  workerConfigurationKv: KVNamespace;
  /** Null when alerting is not configured (failures are logged only). */
  alertConfiguration: DeliveryFailureAlertConfiguration | null;
}

export class WorkerConfigurationError extends Error {
  override readonly name = 'WorkerConfigurationError';
}

/**
 * Validate the environment bindings and return a typed configuration object.
 *
 * @throws WorkerConfigurationError when a binding is missing or invalid.
 */
export function parseWorkerConfiguration(environment: WorkerEnvironment): WorkerConfiguration {
  if (!environment.SETUP_TOKEN) {
    throw new WorkerConfigurationError('SETUP_TOKEN secret is not set.');
  }

  return {
    setupToken: environment.SETUP_TOKEN,
    workerConfigurationKv: environment.WORKER_CONFIGURATION_KV,
    alertConfiguration: parseAlertConfiguration(environment),
  };
}

/**
 * Alerting is all-or-nothing: either the binding and both addresses are
 * configured, or none of them are. Partial configuration is a deploy-time
 * mistake and refuses to run rather than silently not alerting.
 */
function parseAlertConfiguration(
  environment: WorkerEnvironment,
): DeliveryFailureAlertConfiguration | null {
  const configuredAlertSettings = [
    environment.ALERT_EMAIL,
    environment.ALERT_FROM_EMAIL_ADDRESS,
    environment.ALERT_RECIPIENT_EMAIL_ADDRESS,
  ].filter(Boolean).length;

  if (configuredAlertSettings === 0) {
    return null;
  }

  if (
    !environment.ALERT_EMAIL ||
    !environment.ALERT_FROM_EMAIL_ADDRESS ||
    !environment.ALERT_RECIPIENT_EMAIL_ADDRESS
  ) {
    throw new WorkerConfigurationError(
      'Delivery-failure alerting is partially configured: ALERT_EMAIL (send_email binding), ALERT_FROM_EMAIL_ADDRESS and ALERT_RECIPIENT_EMAIL_ADDRESS must all be set, or none.',
    );
  }

  return {
    sendEmailBinding: environment.ALERT_EMAIL,
    fromEmailAddress: environment.ALERT_FROM_EMAIL_ADDRESS,
    recipientEmailAddress: environment.ALERT_RECIPIENT_EMAIL_ADDRESS,
  };
}
