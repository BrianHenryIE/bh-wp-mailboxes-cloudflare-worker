/**
 * Worker configuration parsing and validation.
 *
 * The worker refuses to run with an invalid configuration. Which mail reaches
 * the worker is controlled by the zone's Email Routing rules; the recipient
 * domain is independent of the WordPress site's domain.
 */

export interface WorkerEnvironment {
  TARGET_WORDPRESS_SITE_URL: string;
  SETUP_TOKEN: string;
  WORKER_CONFIGURATION_KV: KVNamespace;
}

export interface WorkerConfiguration {
  targetWordPressSiteUrl: URL;
  setupToken: string;
  workerConfigurationKv: KVNamespace;
}

export class WorkerConfigurationError extends Error {
  override readonly name = 'WorkerConfigurationError';
}

const LOCAL_DEVELOPMENT_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Validate the environment bindings and return a typed configuration object.
 *
 * @throws WorkerConfigurationError when a binding is missing or invalid.
 */
export function parseWorkerConfiguration(environment: WorkerEnvironment): WorkerConfiguration {
  const rawTargetWordPressSiteUrl = environment.TARGET_WORDPRESS_SITE_URL;

  if (!rawTargetWordPressSiteUrl) {
    throw new WorkerConfigurationError('TARGET_WORDPRESS_SITE_URL is not set.');
  }

  let targetWordPressSiteUrl: URL;
  try {
    targetWordPressSiteUrl = new URL(rawTargetWordPressSiteUrl);
  } catch {
    throw new WorkerConfigurationError(
      `TARGET_WORDPRESS_SITE_URL is not a valid URL: "${rawTargetWordPressSiteUrl}".`,
    );
  }

  const isLocalDevelopmentHostname = LOCAL_DEVELOPMENT_HOSTNAMES.includes(
    targetWordPressSiteUrl.hostname,
  );

  if (targetWordPressSiteUrl.protocol !== 'https:' && !isLocalDevelopmentHostname) {
    throw new WorkerConfigurationError(
      'TARGET_WORDPRESS_SITE_URL must use https (application passwords require it).',
    );
  }

  if (!environment.SETUP_TOKEN) {
    throw new WorkerConfigurationError('SETUP_TOKEN secret is not set.');
  }

  return {
    targetWordPressSiteUrl,
    setupToken: environment.SETUP_TOKEN,
    workerConfigurationKv: environment.WORKER_CONFIGURATION_KV,
  };
}
