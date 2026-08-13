/**
 * WordPress REST API endpoint discovery.
 *
 * Namespace-agnostic: rather than assuming a plugin namespace, the worker
 * follows the standard WordPress discovery chain and then reads a custom
 * `email_ingress_endpoints` key which the receiving plugin adds to the REST
 * index via the `rest_index` filter.
 *
 * Chain: site URL → `Link: <…>; rel="https://api.w.org/"` header →
 * REST index (`/wp-json/`) → `email_ingress_endpoints`.
 *
 * A site may advertise multiple endpoints (one per mailbox/library
 * instance); every advertised endpoint receives every email (fan-out —
 * delivery is idempotent per endpoint, keyed on Message-ID). The discovered
 * endpoints are cached in KV as one list. Callers should invalidate the
 * cache and re-discover when an endpoint returns HTTP 404/410.
 */

import { getDomain } from 'tldts';

export interface EmailIngressEndpoint {
  version: number;
  namespace: string;
  url: string;
  accepts: string;
  maxMessageSizeBytes: number;
}

export class WordPressRestApiDiscoveryError extends Error {
  override readonly name = 'WordPressRestApiDiscoveryError';
}

const EMAIL_INGRESS_ENDPOINTS_KV_KEY = 'email_ingress_endpoints';
/** Pre-fan-out cache key (single endpoint); deleted on invalidation so stale singles never linger. */
const LEGACY_EMAIL_INGRESS_ENDPOINT_KV_KEY = 'email_ingress_endpoint';
const WORDPRESS_REST_API_LINK_RELATION = 'https://api.w.org/';

/**
 * Parse the REST index URL out of a Link header, e.g.
 * `<https://example.org/wp-json/>; rel="https://api.w.org/"`.
 */
export function parseWordPressRestIndexUrlFromLinkHeader(
  linkHeaderValue: string | null,
): string | null {
  if (!linkHeaderValue) {
    return null;
  }

  for (const linkEntry of linkHeaderValue.split(',')) {
    const match = /<\s*(?<url>[^>]+)\s*>\s*;\s*rel="?(?<relation>[^";]+)"?/.exec(linkEntry);
    if (match?.groups?.url && match.groups.relation === WORDPRESS_REST_API_LINK_RELATION) {
      return match.groups.url.trim();
    }
  }

  return null;
}

interface RawEmailIngressEndpoint {
  version?: unknown;
  namespace?: unknown;
  url?: unknown;
  accepts?: unknown;
  max_message_size_bytes?: unknown;
}

function parseEmailIngressEndpoint(rawEndpoint: RawEmailIngressEndpoint): EmailIngressEndpoint {
  if (
    typeof rawEndpoint.version !== 'number' ||
    typeof rawEndpoint.namespace !== 'string' ||
    typeof rawEndpoint.url !== 'string' ||
    typeof rawEndpoint.accepts !== 'string' ||
    typeof rawEndpoint.max_message_size_bytes !== 'number'
  ) {
    throw new WordPressRestApiDiscoveryError(
      `Malformed email_ingress_endpoints entry: ${JSON.stringify(rawEndpoint)}.`,
    );
  }

  return {
    version: rawEndpoint.version,
    namespace: rawEndpoint.namespace,
    url: rawEndpoint.url,
    accepts: rawEndpoint.accepts,
    maxMessageSizeBytes: rawEndpoint.max_message_size_bytes,
  };
}

/**
 * Discover the email ingress endpoints advertised by the WordPress site.
 *
 * @throws WordPressRestApiDiscoveryError when discovery fails, when no
 * endpoint is advertised, or when any advertised entry is malformed or on
 * a foreign domain.
 */
export async function discoverEmailIngressEndpoints(
  targetWordPressSiteUrl: URL,
  fetchFunction: typeof fetch = fetch,
): Promise<EmailIngressEndpoint[]> {
  // 1. Find the REST index URL from the Link header; fall back to wp-json/
  // resolved relative to the site URL, so WordPress installed in a
  // subdirectory (https://example.org/blog/) is handled correctly.
  const siteUrlWithTrailingSlash = targetWordPressSiteUrl.toString().endsWith('/')
    ? targetWordPressSiteUrl.toString()
    : `${targetWordPressSiteUrl.toString()}/`;
  let restIndexUrl = new URL('wp-json/', siteUrlWithTrailingSlash).toString();

  const siteResponse = await fetchFunction(targetWordPressSiteUrl.toString(), {
    method: 'HEAD',
    redirect: 'follow',
  });
  const linkHeaderRestIndexUrl = parseWordPressRestIndexUrlFromLinkHeader(
    siteResponse.headers.get('link'),
  );
  if (linkHeaderRestIndexUrl) {
    restIndexUrl = linkHeaderRestIndexUrl;
  }

  // 2. Fetch the REST index.
  const restIndexResponse = await fetchFunction(restIndexUrl, { redirect: 'follow' });
  if (!restIndexResponse.ok) {
    throw new WordPressRestApiDiscoveryError(
      `REST index request to ${restIndexUrl} failed with HTTP ${String(restIndexResponse.status)}.`,
    );
  }

  let restIndex: unknown;
  try {
    restIndex = await restIndexResponse.json();
  } catch {
    throw new WordPressRestApiDiscoveryError(`REST index at ${restIndexUrl} is not valid JSON.`);
  }

  // The index may legitimately be any JSON value (null, string, array) if
  // the site is broken or proxied; only read the key from a non-null object.
  const emailIngressEndpointsRaw =
    restIndex !== null && typeof restIndex === 'object' && 'email_ingress_endpoints' in restIndex
      ? restIndex.email_ingress_endpoints
      : undefined;

  if (!Array.isArray(emailIngressEndpointsRaw) || emailIngressEndpointsRaw.length === 0) {
    throw new WordPressRestApiDiscoveryError(
      `No email_ingress_endpoints advertised in the REST index at ${restIndexUrl}. Is the receiving plugin active?`,
    );
  }

  const emailIngressEndpoints = emailIngressEndpointsRaw.map((rawEndpoint) =>
    parseEmailIngressEndpoint(rawEndpoint as RawEmailIngressEndpoint),
  );

  // 3. Defence in depth: every endpoint must live on the same registrable
  // domain as the configured site.
  const siteRegistrableDomain = getDomain(targetWordPressSiteUrl.hostname);
  const isLocalDevelopment = ['localhost', '127.0.0.1', '[::1]'].includes(
    targetWordPressSiteUrl.hostname,
  );

  for (const emailIngressEndpoint of emailIngressEndpoints) {
    let endpointUrl: URL;
    try {
      endpointUrl = new URL(emailIngressEndpoint.url);
    } catch {
      throw new WordPressRestApiDiscoveryError(
        `Advertised endpoint URL is not a valid absolute URL: "${emailIngressEndpoint.url}".`,
      );
    }
    const endpointRegistrableDomain = getDomain(endpointUrl.hostname);

    if (!isLocalDevelopment && endpointRegistrableDomain !== siteRegistrableDomain) {
      throw new WordPressRestApiDiscoveryError(
        `Advertised endpoint ${emailIngressEndpoint.url} is not on the target site's registrable domain (${siteRegistrableDomain ?? 'unknown'}).`,
      );
    }
  }

  return emailIngressEndpoints;
}

/**
 * Return the cached endpoints from KV, or discover and cache them.
 */
export async function getCachedOrDiscoverEmailIngressEndpoints(
  workerConfigurationKv: KVNamespace,
  targetWordPressSiteUrl: URL,
  fetchFunction: typeof fetch = fetch,
): Promise<EmailIngressEndpoint[]> {
  const cachedEndpointsJson = await workerConfigurationKv.get(EMAIL_INGRESS_ENDPOINTS_KV_KEY);

  if (cachedEndpointsJson) {
    try {
      const cachedEndpoints = JSON.parse(cachedEndpointsJson) as unknown;
      if (Array.isArray(cachedEndpoints) && cachedEndpoints.length > 0) {
        return cachedEndpoints as EmailIngressEndpoint[];
      }
      // An empty or non-array cache entry is corrupt; fall through.
    } catch {
      // Fall through to re-discovery on a corrupt cache entry.
    }
  }

  const discoveredEndpoints = await discoverEmailIngressEndpoints(
    targetWordPressSiteUrl,
    fetchFunction,
  );

  await workerConfigurationKv.put(
    EMAIL_INGRESS_ENDPOINTS_KV_KEY,
    JSON.stringify(discoveredEndpoints),
  );

  return discoveredEndpoints;
}

export async function invalidateCachedEmailIngressEndpoints(
  workerConfigurationKv: KVNamespace,
): Promise<void> {
  await workerConfigurationKv.delete(EMAIL_INGRESS_ENDPOINTS_KV_KEY);
  await workerConfigurationKv.delete(LEGACY_EMAIL_INGRESS_ENDPOINT_KV_KEY);
}
