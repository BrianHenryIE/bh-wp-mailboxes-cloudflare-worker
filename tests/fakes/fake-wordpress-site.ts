import { vi } from 'vitest';

export const fakeSiteIngressEndpointUrl =
  'https://sacramentogaa.org/wp-json/bh-wp-mailboxes/v1/incoming-email';

export interface FakeWordPressSiteOptions {
  endpointResponseStatuses?: number[];
  maxMessageSizeBytes?: number;
  advertisedUrlPerDiscovery?: string[];
}

/**
 * A fake fetch that serves WordPress discovery (HEAD site with Link header,
 * GET /wp-json/ index) and the ingress endpoint POST, recording endpoint
 * requests for assertions.
 */
export function makeFakeWordPressSite({
  endpointResponseStatuses = [201],
  maxMessageSizeBytes = 1024,
  advertisedUrlPerDiscovery = [fakeSiteIngressEndpointUrl],
}: FakeWordPressSiteOptions = {}) {
  const endpointRequests: Request[] = [];
  let discoveryCount = 0;
  let endpointResponseIndex = 0;

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
      const advertisedUrl =
        advertisedUrlPerDiscovery[Math.min(discoveryCount, advertisedUrlPerDiscovery.length - 1)];
      discoveryCount += 1;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            email_ingress_endpoints: [
              {
                version: 1,
                namespace: 'bh-wp-mailboxes/v1',
                url: advertisedUrl,
                accepts: 'message/rfc822',
                max_message_size_bytes: maxMessageSizeBytes,
              },
            ],
          }),
          { status: 200 },
        ),
      );
    }

    endpointRequests.push(request);
    const status =
      endpointResponseStatuses[
        Math.min(endpointResponseIndex, endpointResponseStatuses.length - 1)
      ] ?? 500;
    endpointResponseIndex += 1;
    return Promise.resolve(new Response(null, { status }));
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

  return { fakeFetch, endpointRequests };
}
