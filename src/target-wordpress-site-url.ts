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
 * Validate a site URL entered on the setup form. A bare domain
 * ("example.org") is accepted: https:// is added automatically.
 *
 * @throws InvalidTargetWordPressSiteUrlError when the value is not a URL or
 * uses plain http for a non-local host (application passwords require https).
 */
export function parseTargetWordPressSiteUrl(rawSiteUrl: string): URL {
  const trimmedSiteUrl = rawSiteUrl.trim();

  // Default to https when no scheme is given. Detection must be by pattern,
  // not by try-parse: "localhost:8888" parses "successfully" as scheme
  // "localhost" with path "8888", so a parse failure is not a reliable
  // missing-scheme signal.
  const siteUrlWithScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmedSiteUrl)
    ? trimmedSiteUrl
    : `https://${trimmedSiteUrl}`;

  let targetWordPressSiteUrl: URL;
  try {
    targetWordPressSiteUrl = new URL(siteUrlWithScheme);
  } catch {
    throw new InvalidTargetWordPressSiteUrlError(`Not a valid URL: "${rawSiteUrl}".`);
  }

  const isLocalDevelopmentHostname = LOCAL_DEVELOPMENT_HOSTNAMES.includes(
    targetWordPressSiteUrl.hostname,
  );

  // With the https:// default, almost any word parses as a single-label
  // hostname ("not-a-url"); require a dot so typos are caught, except for
  // local development hostnames.
  if (!targetWordPressSiteUrl.hostname.includes('.') && !isLocalDevelopmentHostname) {
    throw new InvalidTargetWordPressSiteUrlError(`"${rawSiteUrl}" does not look like a site URL.`);
  }

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
