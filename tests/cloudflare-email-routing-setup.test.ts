import { describe, expect, it, vi } from 'vitest';

import { configureEmailRouting } from '../src/cloudflare-email-routing-setup';

interface FakeCloudflareApiOptions {
  zoneExists?: boolean;
  alreadyEnabled?: boolean;
  enableSucceeds?: boolean;
  catchAllSucceeds?: boolean;
  tokenValid?: boolean;
}

/**
 * A fake fetch for api.cloudflare.com covering the four calls
 * configureEmailRouting makes, recording requests for assertions.
 */
function makeFakeCloudflareApi({
  zoneExists = true,
  alreadyEnabled = false,
  enableSucceeds = true,
  catchAllSucceeds = true,
  tokenValid = true,
}: FakeCloudflareApiOptions = {}) {
  const requests: Request[] = [];
  let enabled = alreadyEnabled;

  const fakeFetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input.toString(), init);
    requests.push(request);
    const url = request.url;

    const respond = (body: unknown, status = 200) =>
      Promise.resolve(new Response(JSON.stringify(body), { status }));

    if (!tokenValid) {
      return respond({ success: false, errors: [{ message: 'Invalid API Token' }] }, 403);
    }

    if (url.includes('/zones?name=')) {
      return respond({
        success: true,
        errors: [],
        result: zoneExists ? [{ id: 'zone-id-123', name: 'example-mail.com' }] : [],
      });
    }

    if (url.endsWith('/email/routing/enable')) {
      if (!enableSucceeds) {
        return respond({ success: false, errors: [{ message: 'enable failed' }] });
      }
      enabled = true;
      return respond({ success: true, errors: [], result: { enabled: true } });
    }

    if (url.endsWith('/email/routing/rules/catch_all')) {
      if (!catchAllSucceeds) {
        return respond({ success: false, errors: [{ message: 'catch-all failed' }] });
      }
      return respond({ success: true, errors: [], result: { enabled: true } });
    }

    if (url.endsWith('/email/routing')) {
      return respond({ success: true, errors: [], result: { enabled } });
    }

    return respond({ success: false, errors: [{ message: `unexpected URL ${url}` }] }, 404);
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;

  return { fakeFetch, requests };
}

describe('configureEmailRouting', () => {
  it('finds the zone, enables routing, sets the catch-all, and verifies', async () => {
    const { fakeFetch, requests } = makeFakeCloudflareApi();

    const result = await configureEmailRouting(
      'api-token',
      'example-mail.com',
      'my-worker',
      fakeFetch,
    );

    expect(result.ok).toBe(true);
    expect(result.steps.map(({ title, ok }) => ({ title, ok }))).toEqual([
      { title: 'Find zone "example-mail.com"', ok: true },
      { title: 'Enable Email Routing', ok: true },
      { title: 'Catch-all rule → worker "my-worker"', ok: true },
      { title: 'Verify Email Routing is active', ok: true },
    ]);

    // The catch-all rule routes everything to the named worker.
    const catchAllRequest = requests.find((request) =>
      request.url.endsWith('/email/routing/rules/catch_all'),
    );
    if (!catchAllRequest) throw new Error('expected a catch-all request');
    expect(catchAllRequest.method).toBe('PUT');
    const catchAllBody = await catchAllRequest.json<{ matchers: unknown; actions: unknown }>();
    expect(catchAllBody.matchers).toEqual([{ type: 'all' }]);
    expect(catchAllBody.actions).toEqual([{ type: 'worker', value: ['my-worker'] }]);
  });

  it('sends the token as a Bearer authorization header on every call', async () => {
    const { fakeFetch, requests } = makeFakeCloudflareApi();

    await configureEmailRouting('api-token', 'example-mail.com', 'my-worker', fakeFetch);

    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every((request) => request.headers.get('authorization') === 'Bearer api-token'),
    ).toBe(true);
  });

  it('skips the enable call when Email Routing is already enabled', async () => {
    const { fakeFetch, requests } = makeFakeCloudflareApi({ alreadyEnabled: true });

    const result = await configureEmailRouting(
      'api-token',
      'example-mail.com',
      'my-worker',
      fakeFetch,
    );

    expect(result.ok).toBe(true);
    expect(result.steps[1]?.detail).toContain('Already enabled');
    expect(requests.some((request) => request.url.endsWith('/email/routing/enable'))).toBe(false);
  });

  it('fails with guidance when the zone is not found', async () => {
    const { fakeFetch } = makeFakeCloudflareApi({ zoneExists: false });

    const result = await configureEmailRouting(
      'api-token',
      'example-mail.com',
      'my-worker',
      fakeFetch,
    );

    expect(result.ok).toBe(false);
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.detail).toContain('Zone not found');
  });

  it('surfaces Cloudflare error messages for an invalid token', async () => {
    const { fakeFetch } = makeFakeCloudflareApi({ tokenValid: false });

    const result = await configureEmailRouting(
      'api-token',
      'example-mail.com',
      'my-worker',
      fakeFetch,
    );

    expect(result.ok).toBe(false);
    expect(result.steps[0]?.detail).toContain('Invalid API Token');
  });

  it('stops after a failing catch-all step and surfaces the error', async () => {
    const { fakeFetch } = makeFakeCloudflareApi({ catchAllSucceeds: false });

    const result = await configureEmailRouting(
      'api-token',
      'example-mail.com',
      'my-worker',
      fakeFetch,
    );

    expect(result.ok).toBe(false);
    const catchAllStep = result.steps.find(({ title }) => title.includes('Catch-all'));
    expect(catchAllStep?.ok).toBe(false);
    expect(catchAllStep?.detail).toContain('catch-all failed');
  });
});
