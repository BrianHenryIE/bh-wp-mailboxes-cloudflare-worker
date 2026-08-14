/**
 * KV storage of the WordPress site URL this worker delivers to.
 *
 * The site URL is entered on the `/setup` form (not a deploy-time env var),
 * so the same deployed worker can be pointed at a site — or re-pointed —
 * entirely from the browser. It is stored before the application-password
 * authorization redirect, and read back by the setup callback, endpoint
 * selection, and failure alerting.
 */

export class InvalidTargetWordPressSiteUrlError extends Error {
  override readonly name = 'InvalidTargetWordPressSiteUrlError';
}

const TARGET_WORDPRESS_SITE_URL_KV_KEY = 'target_wordpress_site_url';

const LOCAL_DEVELOPMENT_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Validate a site URL entered on the setup form.
 *
 * @throws InvalidTargetWordPressSiteUrlError when the value is not a URL or
 * uses plain http for a non-local host (application passwords require https).
 */
export function parseTargetWordPressSiteUrl(rawSiteUrl: string): URL {
  let targetWordPressSiteUrl: URL;
  try {
    targetWordPressSiteUrl = new URL(rawSiteUrl);
  } catch {
    throw new InvalidTargetWordPressSiteUrlError(`Not a valid URL: "${rawSiteUrl}".`);
  }

  const isLocalDevelopmentHostname = LOCAL_DEVELOPMENT_HOSTNAMES.includes(
    targetWordPressSiteUrl.hostname,
  );

  if (targetWordPressSiteUrl.protocol !== 'https:' && !isLocalDevelopmentHostname) {
    throw new InvalidTargetWordPressSiteUrlError(
      'The site URL must use https (application passwords require it).',
    );
  }

  return targetWordPressSiteUrl;
}

export async function storeTargetWordPressSiteUrl(
  workerConfigurationKv: KVNamespace,
  targetWordPressSiteUrl: URL,
): Promise<void> {
  await workerConfigurationKv.put(
    TARGET_WORDPRESS_SITE_URL_KV_KEY,
    targetWordPressSiteUrl.toString(),
  );
}

/**
 * The site URL entered during setup, or null when setup has not started.
 */
export async function getTargetWordPressSiteUrl(
  workerConfigurationKv: KVNamespace,
): Promise<URL | null> {
  const storedSiteUrl = await workerConfigurationKv.get(TARGET_WORDPRESS_SITE_URL_KV_KEY);

  if (!storedSiteUrl) {
    return null;
  }

  try {
    return new URL(storedSiteUrl);
  } catch {
    return null;
  }
}
