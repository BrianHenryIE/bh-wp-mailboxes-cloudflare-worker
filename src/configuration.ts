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
  /**
   * Optional: when set, this secret is the authoritative setup token.
   * When absent, the token is chosen on the /setup web UI on first visit
   * and stored (hashed) in KV — see ./setup-token.
   */
  SETUP_TOKEN?: string;
  WORKER_CONFIGURATION_KV: KVNamespace;
  /**
   * Delivery-failure alerting `send_email` binding. Always declared in
   * wrangler.jsonc; whether alerts are sent is decided by the addresses
   * entered on the setup UI (stored in KV).
   */
  ALERT_EMAIL?: SendEmail;
}

export interface WorkerConfiguration {
  /** The SETUP_TOKEN secret, or null when the token is managed in KV via the setup UI. */
  setupToken: string | null;
  workerConfigurationKv: KVNamespace;
  /** Null only when the binding is absent (e.g. some local test setups). */
  alertSendEmailBinding: SendEmail | null;
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
  return {
    setupToken: environment.SETUP_TOKEN ?? null,
    workerConfigurationKv: environment.WORKER_CONFIGURATION_KV,
    alertSendEmailBinding: environment.ALERT_EMAIL ?? null,
  };
}
