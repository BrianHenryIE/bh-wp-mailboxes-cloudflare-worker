import { vi } from 'vitest';

export const fakeSiteIngressEndpointUrl =
  'https://sacramentogaa.org/wp-json/bh-wp-mailboxes/v1/incoming-email';

export interface FakeAdvertisedEndpoint {
  url: string;
  maxMessageSizeBytes?: number;
}

export interface FakeWordPressSiteOptions {
  /** Global response-status sequence for endpoint POSTs, in call order. */
  endpointResponseStatuses?: number[];
  /** Per-endpoint response-status sequences, keyed by URL; takes precedence over the global sequence. */
  endpointResponseStatusesByUrl?: Record<string, number[]>;
  maxMessageSizeBytes?: number;
  advertisedUrlPerDiscovery?: string[];
  /**
   * Full control of the advertised endpoint list, one list per discovery
   * round (the last list repeats). Takes precedence over
   * advertisedUrlPerDiscovery.
   */
  advertisedEndpointsPerDiscovery?: FakeAdvertisedEndpoint[][];
}

/**
 * A fake fetch that serves WordPress discovery (HEAD site with Link header,
 * GET /wp-json/ index) and the ingress endpoint POSTs, recording endpoint
 * requests for assertions.
 */
export function makeFakeWordPressSite({
  endpointResponseStatuses = [201],
  endpointResponseStatusesByUrl = {},
  maxMessageSizeBytes = 1024,
  advertisedUrlPerDiscovery = [fakeSiteIngressEndpointUrl],
  advertisedEndpointsPerDiscovery,
}: FakeWordPressSiteOptions = {}) {
  const endpointRequests: Request[] = [];
  let discoveryCount = 0;
  let endpointResponseIndex = 0;
  const endpointResponseIndexByUrl: Record<string, number> = {};

  const fakeFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input.toString(), init);

    if (request.method === 'HEAD') {
      return Promise.resolve(
        new Response(null, {
          status: 200,
          headers: { link: '<https://sacramentogaa.org/wp-json/>; rel="https://api.w.org/"' },
        }),
      );
    }

    if (request.url === 'https://sacramentogaa.org/wp-json/') {
      const advertisedEndpoints: FakeAdvertisedEndpoint[] = advertisedEndpointsPerDiscovery
        ? (advertisedEndpointsPerDiscovery[
            Math.min(discoveryCount, advertisedEndpointsPerDiscovery.length - 1)
          ] ?? [])
        : [
            {
              url:
                advertisedUrlPerDiscovery[
                  Math.min(discoveryCount, advertisedUrlPerDiscovery.length - 1)
                ] ?? fakeSiteIngressEndpointUrl,
            },
          ];
      discoveryCount += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            email_ingress_endpoints: advertisedEndpoints.map((advertisedEndpoint) => ({
              version: 1,
              namespace: 'bh-wp-mailboxes/v1',
              url: advertisedEndpoint.url,
              accepts: 'message/rfc822',
              max_message_size_bytes: advertisedEndpoint.maxMessageSizeBytes ?? maxMessageSizeBytes,
            })),
          }),
          { status: 200 },
        ),
      );
    }

    endpointRequests.push(request);

    const perUrlStatuses = endpointResponseStatusesByUrl[request.url];
    let status: number;
    if (perUrlStatuses) {
      const perUrlIndex = endpointResponseIndexByUrl[request.url] ?? 0;
      status = perUrlStatuses[Math.min(perUrlIndex, perUrlStatuses.length - 1)] ?? 500;
      endpointResponseIndexByUrl[request.url] = perUrlIndex + 1;
    } else {
      status =
        endpointResponseStatuses[
          Math.min(endpointResponseIndex, endpointResponseStatuses.length - 1)
        ] ?? 500;
      endpointResponseIndex += 1;
    }
    return Promise.resolve(new Response(null, { status }));
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

  return { fakeFetch, endpointRequests };
}
