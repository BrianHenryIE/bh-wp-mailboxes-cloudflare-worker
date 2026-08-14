import { describe, expect, it, vi } from 'vitest';

import {
  discoverEmailIngressEndpoints,
  parseWordPressRestIndexUrlFromLinkHeader,
  WordPressRestApiDiscoveryError,
} from '../src/wordpress-rest-api-discovery';

const targetWordPressSiteUrl = new URL('https://sacramentogaa.org');

const advertisedEndpoint = {
  version: 1,
  namespace: 'bh-wp-mailboxes/v1',
  url: 'https://sacramentogaa.org/wp-json/bh-wp-mailboxes/v1/incoming-email',
  accepts: 'message/rfc822',
  max_message_size_bytes: 33554432,
};

function makeFakeFetch({
  linkHeader = '<https://sacramentogaa.org/wp-json/>; rel="https://api.w.org/"',
  restIndexBody = JSON.stringify({ email_ingress_endpoints: [advertisedEndpoint] }),
  restIndexStatus = 200,
}: {
  linkHeader?: string | null;
  restIndexBody?: string;
  restIndexStatus?: number;
} = {}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    if (init?.method === 'HEAD') {
      const headers = new Headers();
      if (linkHeader) {
        headers.set('link', linkHeader);
      }
      return Promise.resolve(new Response(null, { status: 200, headers }));
    }
    if (url.includes('/wp-json')) {
      return Promise.resolve(new Response(restIndexBody, { status: restIndexStatus }));
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('parseWordPressRestIndexUrlFromLinkHeader', () => {
  it('parses the rest index url', () => {
    expect(
      parseWordPressRestIndexUrlFromLinkHeader(
        '<https://example.org/wp-json/>; rel="https://api.w.org/"',
      ),
    ).toBe('https://example.org/wp-json/');
  });

  it('finds the api.w.org relation among multiple links', () => {
    expect(
      parseWordPressRestIndexUrlFromLinkHeader(
        '<https://example.org/?p=1>; rel=shortlink, <https://example.org/index.php?rest_route=/>; rel="https://api.w.org/"',
      ),
    ).toBe('https://example.org/index.php?rest_route=/');
  });

  it('returns null for a missing header', () => {
    expect(parseWordPressRestIndexUrlFromLinkHeader(null)).toBeNull();
  });

  it('returns null when the relation is absent', () => {
    expect(
      parseWordPressRestIndexUrlFromLinkHeader('<https://example.org/?p=1>; rel=shortlink'),
    ).toBeNull();
  });
});

describe('discoverEmailIngressEndpoints', () => {
  it('discovers the advertised endpoint via the Link header', async () => {
    const fakeFetch = makeFakeFetch();

    const endpoints = await discoverEmailIngressEndpoints(targetWordPressSiteUrl, fakeFetch);

    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.url).toBe(advertisedEndpoint.url);
    expect(endpoints[0]?.maxMessageSizeBytes).toBe(advertisedEndpoint.max_message_size_bytes);
    expect(endpoints[0]?.namespace).toBe('bh-wp-mailboxes/v1');
  });

  it('falls back to /wp-json/ when there is no Link header', async () => {
    const fakeFetch = makeFakeFetch({ linkHeader: null });

    const endpoints = await discoverEmailIngressEndpoints(targetWordPressSiteUrl, fakeFetch);

    expect(endpoints[0]?.url).toBe(advertisedEndpoint.url);
    expect(fakeFetch).toHaveBeenCalledWith(
      'https://sacramentogaa.org/wp-json/',
      expect.objectContaining({ redirect: 'follow' }),
    );
  });

  it('throws when no endpoints are advertised (plugin inactive)', async () => {
    const fakeFetch = makeFakeFetch({
      restIndexBody: JSON.stringify({ email_ingress_endpoints: [] }),
    });

    await expect(discoverEmailIngressEndpoints(targetWordPressSiteUrl, fakeFetch)).rejects.toThrow(
      /No email_ingress_endpoints/,
    );
  });

  it('throws when the key is entirely missing from the index', async () => {
    const fakeFetch = makeFakeFetch({
      restIndexBody: JSON.stringify({ namespaces: ['wp/v2'] }),
    });

    await expect(discoverEmailIngressEndpoints(targetWordPressSiteUrl, fakeFetch)).rejects.toThrow(
      WordPressRestApiDiscoveryError,
    );
  });

  it('returns every advertised endpoint when multiple are advertised', async () => {
    const secondAdvertisedEndpoint = {
      ...advertisedEndpoint,
      url: 'https://sacramentogaa.org/wp-json/bh-wp-mailboxes-2/v1/incoming-email',
      namespace: 'bh-wp-mailboxes-2/v1',
      max_message_size_bytes: 1048576,
    };
    const fakeFetch = makeFakeFetch({
      restIndexBody: JSON.stringify({
        email_ingress_endpoints: [advertisedEndpoint, secondAdvertisedEndpoint],
      }),
    });

    const endpoints = await discoverEmailIngressEndpoints(targetWordPressSiteUrl, fakeFetch);

    expect(endpoints).toHaveLength(2);
    expect(endpoints[0]?.url).toBe(advertisedEndpoint.url);
    expect(endpoints[1]?.url).toBe(secondAdvertisedEndpoint.url);
    expect(endpoints[1]?.maxMessageSizeBytes).toBe(1048576);
  });

  it('rejects when any one of multiple advertised endpoints is on a foreign domain', async () => {
    const fakeFetch = makeFakeFetch({
      restIndexBody: JSON.stringify({
        email_ingress_endpoints: [
          advertisedEndpoint,
          { ...advertisedEndpoint, url: 'https://evil.example/ingress' },
        ],
      }),
    });

    await expect(discoverEmailIngressEndpoints(targetWordPressSiteUrl, fakeFetch)).rejects.toThrow(
      /not on the target site's registrable domain/,
    );
  });

  it('throws on a malformed endpoint entry', async () => {
    const fakeFetch = makeFakeFetch({
      restIndexBody: JSON.stringify({
        email_ingress_endpoints: [{ url: 123 }],
      }),
    });

    await expect(discoverEmailIngressEndpoints(targetWordPressSiteUrl, fakeFetch)).rejects.toThrow(
      /Malformed email_ingress_endpoints entry/,
    );
  });

  it('throws when the REST index is not JSON', async () => {
    const fakeFetch = makeFakeFetch({ restIndexBody: '<html>maintenance</html>' });

    await expect(discoverEmailIngressEndpoints(targetWordPressSiteUrl, fakeFetch)).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it.each(['null', '"an error string"', '[]', '123'])(
    'throws a descriptive error (not a TypeError) when the REST index JSON is %s',
    async (restIndexBody) => {
      const fakeFetch = makeFakeFetch({ restIndexBody });

      await expect(
        discoverEmailIngressEndpoints(targetWordPressSiteUrl, fakeFetch),
      ).rejects.toThrow(WordPressRestApiDiscoveryError);
    },
  );

  it('throws a descriptive error when the advertised endpoint URL is not a valid URL', async () => {
    const fakeFetch = makeFakeFetch({
      restIndexBody: JSON.stringify({
        email_ingress_endpoints: [
          { ...advertisedEndpoint, url: '/wp-json/bh-wp-mailboxes/v1/incoming-email' },
        ],
      }),
    });

    await expect(discoverEmailIngressEndpoints(targetWordPressSiteUrl, fakeFetch)).rejects.toThrow(
      /not a valid absolute URL/,
    );
  });

  it('resolves the fallback REST index under a subdirectory WordPress install', async () => {
    const subdirectorySiteUrl = new URL('https://sacramentogaa.org/blog');
    const fakeFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (init?.method === 'HEAD') {
        // No Link header — forces the wp-json/ fallback.
        return Promise.resolve(new Response(null, { status: 200 }));
      }
      if (url === 'https://sacramentogaa.org/blog/wp-json/') {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              email_ingress_endpoints: [
                {
                  ...advertisedEndpoint,
                  url: 'https://sacramentogaa.org/blog/wp-json/bh-wp-mailboxes/v1/incoming-email',
                },
              ],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(new Response('not found', { status: 404 }));
    }) as unknown as typeof fetch;

    const endpoints = await discoverEmailIngressEndpoints(subdirectorySiteUrl, fakeFetch);

    expect(endpoints[0]?.url).toBe(
      'https://sacramentogaa.org/blog/wp-json/bh-wp-mailboxes/v1/incoming-email',
    );
  });

  it('throws when the REST index request fails', async () => {
    const fakeFetch = makeFakeFetch({ restIndexStatus: 503 });

    await expect(discoverEmailIngressEndpoints(targetWordPressSiteUrl, fakeFetch)).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it('rejects an advertised endpoint on a foreign domain', async () => {
    const fakeFetch = makeFakeFetch({
      restIndexBody: JSON.stringify({
        email_ingress_endpoints: [{ ...advertisedEndpoint, url: 'https://evil.example/ingress' }],
      }),
    });

    await expect(discoverEmailIngressEndpoints(targetWordPressSiteUrl, fakeFetch)).rejects.toThrow(
      /not on the target site's registrable domain/,
    );
  });
});
