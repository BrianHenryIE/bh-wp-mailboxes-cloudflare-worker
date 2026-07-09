/**
 * WordPress REST API endpoint discovery.
 *
 * Namespace-agnostic: rather than assuming a plugin namespace, the worker
 * follows the standard WordPress discovery chain and then reads a custom
 * `email_ingress_endpoints` key which the receiving plugin adds to the REST
 * index via the `rest_index` filter.
 *
 * Chain: site URL → `Link: <…>; rel="https://api.w.org/"` header →
 * REST index (`/wp-json/`) → `email_ingress_endpoints[0]`.
 *
 * The discovered endpoint is cached in KV. Callers should invalidate the
 * cache and re-discover when the endpoint returns HTTP 404/410.
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

const EMAIL_INGRESS_ENDPOINT_KV_KEY = 'email_ingress_endpoint';
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
 * Discover the email ingress endpoint advertised by the WordPress site.
 *
 * @throws WordPressRestApiDiscoveryError when discovery fails, when no
 * endpoint is advertised, or when more than one is advertised (v1 supports
 * exactly one).
 */
export async function discoverEmailIngressEndpoint(
  targetWordPressSiteUrl: URL,
  fetchFunction: typeof fetch = fetch,
): Promise<EmailIngressEndpoint> {
  // 1. Find the REST index URL from the Link header; fall back to /wp-json/.
  let restIndexUrl = new URL('/wp-json/', targetWordPressSiteUrl).toString();

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

  const emailIngressEndpointsRaw = (restIndex as { email_ingress_endpoints?: unknown })
    .email_ingress_endpoints;

  if (!Array.isArray(emailIngressEndpointsRaw) || emailIngressEndpointsRaw.length === 0) {
    throw new WordPressRestApiDiscoveryError(
      `No email_ingress_endpoints advertised in the REST index at ${restIndexUrl}. Is the receiving plugin active?`,
    );
  }

  if (emailIngressEndpointsRaw.length > 1) {
    throw new WordPressRestApiDiscoveryError(
      `Multiple email_ingress_endpoints advertised (${String(emailIngressEndpointsRaw.length)}); v1 supports exactly one.`,
    );
  }

  const emailIngressEndpoint = parseEmailIngressEndpoint(
    emailIngressEndpointsRaw[0] as RawEmailIngressEndpoint,
  );

  // 3. Defence in depth: the endpoint must live on the same registrable
  // domain as the configured site.
  const endpointRegistrableDomain = getDomain(new URL(emailIngressEndpoint.url).hostname);
  const siteRegistrableDomain = getDomain(targetWordPressSiteUrl.hostname);
  const isLocalDevelopment = ['localhost', '127.0.0.1', '[::1]'].includes(
    targetWordPressSiteUrl.hostname,
  );

  if (!isLocalDevelopment && endpointRegistrableDomain !== siteRegistrableDomain) {
    throw new WordPressRestApiDiscoveryError(
      `Advertised endpoint ${emailIngressEndpoint.url} is not on the target site's registrable domain (${siteRegistrableDomain ?? 'unknown'}).`,
    );
  }

  return emailIngressEndpoint;
}

/**
 * Return the cached endpoint from KV, or discover and cache it.
 */
export async function getCachedOrDiscoverEmailIngressEndpoint(
  workerConfigurationKv: KVNamespace,
  targetWordPressSiteUrl: URL,
  fetchFunction: typeof fetch = fetch,
): Promise<EmailIngressEndpoint> {
  const cachedEndpointJson = await workerConfigurationKv.get(EMAIL_INGRESS_ENDPOINT_KV_KEY);

  if (cachedEndpointJson) {
    try {
      return JSON.parse(cachedEndpointJson) as EmailIngressEndpoint;
    } catch {
      // Fall through to re-discovery on a corrupt cache entry.
    }
  }

  const discoveredEndpoint = await discoverEmailIngressEndpoint(
    targetWordPressSiteUrl,
    fetchFunction,
  );

  await workerConfigurationKv.put(
    EMAIL_INGRESS_ENDPOINT_KV_KEY,
    JSON.stringify(discoveredEndpoint),
  );

  return discoveredEndpoint;
}

export async function invalidateCachedEmailIngressEndpoint(
  workerConfigurationKv: KVNamespace,
): Promise<void> {
  await workerConfigurationKv.delete(EMAIL_INGRESS_ENDPOINT_KV_KEY);
}
