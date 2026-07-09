import { describe, expect, it, vi } from 'vitest';

import {
  discoverEmailIngressEndpoint,
  getCachedOrDiscoverEmailIngressEndpoint,
  invalidateCachedEmailIngressEndpoint,
  parseWordPressRestIndexUrlFromLinkHeader,
  WordPressRestApiDiscoveryError,
} from '../src/wordpress-rest-api-discovery';
import { FakeKvNamespace } from './fakes/fake-kv-namespace';

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

describe('discoverEmailIngressEndpoint', () => {
  it('discovers the advertised endpoint via the Link header', async () => {
    const fakeFetch = makeFakeFetch();

    const endpoint = await discoverEmailIngressEndpoint(targetWordPressSiteUrl, fakeFetch);

    expect(endpoint.url).toBe(advertisedEndpoint.url);
    expect(endpoint.maxMessageSizeBytes).toBe(advertisedEndpoint.max_message_size_bytes);
    expect(endpoint.namespace).toBe('bh-wp-mailboxes/v1');
  });

  it('falls back to /wp-json/ when there is no Link header', async () => {
    const fakeFetch = makeFakeFetch({ linkHeader: null });

    const endpoint = await discoverEmailIngressEndpoint(targetWordPressSiteUrl, fakeFetch);

    expect(endpoint.url).toBe(advertisedEndpoint.url);
    expect(fakeFetch).toHaveBeenCalledWith(
      'https://sacramentogaa.org/wp-json/',
      expect.objectContaining({ redirect: 'follow' }),
    );
  });

  it('throws when no endpoints are advertised (plugin inactive)', async () => {
    const fakeFetch = makeFakeFetch({
      restIndexBody: JSON.stringify({ email_ingress_endpoints: [] }),
    });

    await expect(discoverEmailIngressEndpoint(targetWordPressSiteUrl, fakeFetch)).rejects.toThrow(
      /No email_ingress_endpoints/,
    );
  });

  it('throws when the key is entirely missing from the index', async () => {
    const fakeFetch = makeFakeFetch({
      restIndexBody: JSON.stringify({ namespaces: ['wp/v2'] }),
    });

    await expect(discoverEmailIngressEndpoint(targetWordPressSiteUrl, fakeFetch)).rejects.toThrow(
      WordPressRestApiDiscoveryError,
    );
  });

  it('throws when multiple endpoints are advertised (v1 supports one)', async () => {
    const fakeFetch = makeFakeFetch({
      restIndexBody: JSON.stringify({
        email_ingress_endpoints: [advertisedEndpoint, advertisedEndpoint],
      }),
    });

    await expect(discoverEmailIngressEndpoint(targetWordPressSiteUrl, fakeFetch)).rejects.toThrow(
      /Multiple email_ingress_endpoints/,
    );
  });

  it('throws on a malformed endpoint entry', async () => {
    const fakeFetch = makeFakeFetch({
      restIndexBody: JSON.stringify({
        email_ingress_endpoints: [{ url: 123 }],
      }),
    });

    await expect(discoverEmailIngressEndpoint(targetWordPressSiteUrl, fakeFetch)).rejects.toThrow(
      /Malformed email_ingress_endpoints entry/,
    );
  });

  it('throws when the REST index is not JSON', async () => {
    const fakeFetch = makeFakeFetch({ restIndexBody: '<html>maintenance</html>' });

    await expect(discoverEmailIngressEndpoint(targetWordPressSiteUrl, fakeFetch)).rejects.toThrow(
      /not valid JSON/,
    );
  });

  it.each(['null', '"an error string"', '[]', '123'])(
    'throws a descriptive error (not a TypeError) when the REST index JSON is %s',
    async (restIndexBody) => {
      const fakeFetch = makeFakeFetch({ restIndexBody });

      await expect(discoverEmailIngressEndpoint(targetWordPressSiteUrl, fakeFetch)).rejects.toThrow(
        WordPressRestApiDiscoveryError,
      );
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

    await expect(discoverEmailIngressEndpoint(targetWordPressSiteUrl, fakeFetch)).rejects.toThrow(
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

    const endpoint = await discoverEmailIngressEndpoint(subdirectorySiteUrl, fakeFetch);

    expect(endpoint.url).toBe(
      'https://sacramentogaa.org/blog/wp-json/bh-wp-mailboxes/v1/incoming-email',
    );
  });

  it('throws when the REST index request fails', async () => {
    const fakeFetch = makeFakeFetch({ restIndexStatus: 503 });

    await expect(discoverEmailIngressEndpoint(targetWordPressSiteUrl, fakeFetch)).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it('rejects an advertised endpoint on a foreign domain', async () => {
    const fakeFetch = makeFakeFetch({
      restIndexBody: JSON.stringify({
        email_ingress_endpoints: [{ ...advertisedEndpoint, url: 'https://evil.example/ingress' }],
      }),
    });

    await expect(discoverEmailIngressEndpoint(targetWordPressSiteUrl, fakeFetch)).rejects.toThrow(
      /not on the target site's registrable domain/,
    );
  });
});

describe('getCachedOrDiscoverEmailIngressEndpoint', () => {
  it('discovers and caches on a cold cache', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    const fakeFetch = makeFakeFetch();

    const endpoint = await getCachedOrDiscoverEmailIngressEndpoint(
      fakeKvNamespace.asKvNamespace(),
      targetWordPressSiteUrl,
      fakeFetch,
    );

    expect(endpoint.url).toBe(advertisedEndpoint.url);
    expect(await fakeKvNamespace.get('email_ingress_endpoint')).toContain(advertisedEndpoint.url);
  });

  it('serves from cache without fetching', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    const fakeFetch = makeFakeFetch();

    await getCachedOrDiscoverEmailIngressEndpoint(
      fakeKvNamespace.asKvNamespace(),
      targetWordPressSiteUrl,
      fakeFetch,
    );
    fakeFetch.mockClear();

    const endpoint = await getCachedOrDiscoverEmailIngressEndpoint(
      fakeKvNamespace.asKvNamespace(),
      targetWordPressSiteUrl,
      fakeFetch,
    );

    expect(endpoint.url).toBe(advertisedEndpoint.url);
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  it('re-discovers after invalidation', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    const fakeFetch = makeFakeFetch();

    await getCachedOrDiscoverEmailIngressEndpoint(
      fakeKvNamespace.asKvNamespace(),
      targetWordPressSiteUrl,
      fakeFetch,
    );
    await invalidateCachedEmailIngressEndpoint(fakeKvNamespace.asKvNamespace());
    fakeFetch.mockClear();

    await getCachedOrDiscoverEmailIngressEndpoint(
      fakeKvNamespace.asKvNamespace(),
      targetWordPressSiteUrl,
      fakeFetch,
    );

    expect(fakeFetch).toHaveBeenCalled();
  });

  it('re-discovers when the cached entry is corrupt', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await fakeKvNamespace.put('email_ingress_endpoint', '{not json');
    const fakeFetch = makeFakeFetch();

    const endpoint = await getCachedOrDiscoverEmailIngressEndpoint(
      fakeKvNamespace.asKvNamespace(),
      targetWordPressSiteUrl,
      fakeFetch,
    );

    expect(endpoint.url).toBe(advertisedEndpoint.url);
  });
});
