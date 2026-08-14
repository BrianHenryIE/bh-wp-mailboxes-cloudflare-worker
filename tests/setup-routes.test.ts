import { describe, expect, it } from 'vitest';

import type { WorkerConfiguration } from '../src/configuration';
import { getSelectedEmailIngressEndpoint } from '../src/selected-email-ingress-endpoint';
import { handleSetupCallbackRequest, handleSetupRequest } from '../src/setup-routes';
import { getTargetWordPressSiteUrl } from '../src/target-wordpress-site-url';
import { getWordPressApplicationPasswordCredential } from '../src/wordpress-application-password';
import { FakeKvNamespace } from './fakes/fake-kv-namespace';
import { fakeSiteIngressEndpointUrl, makeFakeWordPressSite } from './fakes/fake-wordpress-site';

const secondIngressEndpointUrl =
  'https://sacramentogaa.org/wp-json/second-mailbox/v1/incoming-email';

function makeWorkerConfiguration(fakeKvNamespace: FakeKvNamespace): WorkerConfiguration {
  return {
    setupToken: 'correct-token',
    workerConfigurationKv: fakeKvNamespace.asKvNamespace(),
    alertConfiguration: null,
  };
}

async function storeSiteUrl(
  fakeKvNamespace: FakeKvNamespace,
  siteUrl = 'https://sacramentogaa.org/',
): Promise<void> {
  await fakeKvNamespace.put('target_wordpress_site_url', siteUrl);
}

function makeSiteUrlSubmission(formFields: Record<string, string>): Request {
  return new Request('https://worker.example/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(formFields).toString(),
  });
}

describe('handleSetupRequest — site URL form', () => {
  it('rejects a missing token', async () => {
    const response = await handleSetupRequest(
      new Request('https://worker.example/setup'),
      makeWorkerConfiguration(new FakeKvNamespace()),
    );

    expect(response.status).toBe(403);
  });

  it('rejects an incorrect token', async () => {
    const response = await handleSetupRequest(
      new Request('https://worker.example/setup?token=wrong'),
      makeWorkerConfiguration(new FakeKvNamespace()),
    );

    expect(response.status).toBe(403);
  });

  it('shows the site URL form', async () => {
    const response = await handleSetupRequest(
      new Request('https://worker.example/setup?token=correct-token'),
      makeWorkerConfiguration(new FakeKvNamespace()),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const responseHtml = await response.text();
    expect(responseHtml).toContain('<form method="post" action="/setup">');
    expect(responseHtml).toContain('name="site_url"');
  });

  it('pre-fills the form with the stored site URL when re-running setup', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSiteUrl(fakeKvNamespace);

    const response = await handleSetupRequest(
      new Request('https://worker.example/setup?token=correct-token'),
      makeWorkerConfiguration(fakeKvNamespace),
    );

    expect(await response.text()).toContain('value="https://sacramentogaa.org/"');
  });

  it('rejects a submission without the setup token', async () => {
    const response = await handleSetupRequest(
      makeSiteUrlSubmission({ site_url: 'https://sacramentogaa.org' }),
      makeWorkerConfiguration(new FakeKvNamespace()),
    );

    expect(response.status).toBe(403);
  });

  it('re-shows the form with an error for an invalid site URL', async () => {
    const fakeKvNamespace = new FakeKvNamespace();

    const response = await handleSetupRequest(
      makeSiteUrlSubmission({ token: 'correct-token', site_url: 'not-a-url' }),
      makeWorkerConfiguration(fakeKvNamespace),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('name="site_url"');
    expect(await getTargetWordPressSiteUrl(fakeKvNamespace.asKvNamespace())).toBeNull();
  });

  it('re-shows the form with an error for plain http on a non-local host', async () => {
    const response = await handleSetupRequest(
      makeSiteUrlSubmission({ token: 'correct-token', site_url: 'http://sacramentogaa.org' }),
      makeWorkerConfiguration(new FakeKvNamespace()),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('https');
  });

  it('stores the site URL and redirects to the WordPress authorization screen', async () => {
    const fakeKvNamespace = new FakeKvNamespace();

    const response = await handleSetupRequest(
      makeSiteUrlSubmission({ token: 'correct-token', site_url: 'https://sacramentogaa.org' }),
      makeWorkerConfiguration(fakeKvNamespace),
    );

    expect(response.status).toBe(302);

    const storedSiteUrl = await getTargetWordPressSiteUrl(fakeKvNamespace.asKvNamespace());
    expect(storedSiteUrl?.origin).toBe('https://sacramentogaa.org');

    const redirectLocation = new URL(response.headers.get('location') ?? '');
    expect(redirectLocation.origin).toBe('https://sacramentogaa.org');
    expect(redirectLocation.pathname).toBe('/wp-admin/authorize-application.php');
    expect(redirectLocation.searchParams.get('app_name')).toContain('bh-wp-mailboxes');
    expect(redirectLocation.searchParams.get('app_id')).toMatch(/^[0-9a-f-]{36}$/);

    const successUrl = new URL(redirectLocation.searchParams.get('success_url') ?? '');
    expect(successUrl.origin).toBe('https://worker.example');
    expect(successUrl.pathname).toBe('/setup/callback');
    expect(successUrl.searchParams.get('token')).toBe('correct-token');
  });
});

describe('handleSetupCallbackRequest', () => {
  const validCallbackUrl =
    'https://worker.example/setup/callback?token=correct-token' +
    '&site_url=https%3A%2F%2Fsacramentogaa.org' +
    '&user_login=email-ingress-user' +
    '&password=abcd%20efgh%20ijkl';

  it('rejects a missing token', async () => {
    const response = await handleSetupCallbackRequest(
      new Request('https://worker.example/setup/callback?user_login=u&password=p&site_url=s'),
      makeWorkerConfiguration(new FakeKvNamespace()),
      makeFakeWordPressSite().fakeFetch,
    );

    expect(response.status).toBe(403);
  });

  it('directs to the setup form when no site URL is stored', async () => {
    const response = await handleSetupCallbackRequest(
      new Request(validCallbackUrl),
      makeWorkerConfiguration(new FakeKvNamespace()),
      makeFakeWordPressSite().fakeFetch,
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain('/setup');
  });

  it('stores the credential', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSiteUrl(fakeKvNamespace);

    const response = await handleSetupCallbackRequest(
      new Request(validCallbackUrl),
      makeWorkerConfiguration(fakeKvNamespace),
      makeFakeWordPressSite().fakeFetch,
    );

    expect(response.status).toBe(200);

    const credential = await getWordPressApplicationPasswordCredential(
      fakeKvNamespace.asKvNamespace(),
    );
    expect(credential.userLogin).toBe('email-ingress-user');
    expect(credential.applicationPassword).toBe('abcd efgh ijkl');
  });

  it('does not echo the password in the response body', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSiteUrl(fakeKvNamespace);

    const response = await handleSetupCallbackRequest(
      new Request(validCallbackUrl),
      makeWorkerConfiguration(fakeKvNamespace),
      makeFakeWordPressSite().fakeFetch,
    );

    expect(await response.text()).not.toContain('abcd efgh ijkl');
  });

  it('auto-selects the endpoint when exactly one is advertised', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSiteUrl(fakeKvNamespace);

    const response = await handleSetupCallbackRequest(
      new Request(validCallbackUrl),
      makeWorkerConfiguration(fakeKvNamespace),
      makeFakeWordPressSite().fakeFetch,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(fakeSiteIngressEndpointUrl);

    const selectedEndpoint = await getSelectedEmailIngressEndpoint(fakeKvNamespace.asKvNamespace());
    expect(selectedEndpoint?.url).toBe(fakeSiteIngressEndpointUrl);
  });

  it('presents a selection form when several endpoints are advertised, selecting none', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSiteUrl(fakeKvNamespace);
    const { fakeFetch } = makeFakeWordPressSite({
      advertisedEndpointsPerDiscovery: [
        [{ url: fakeSiteIngressEndpointUrl }, { url: secondIngressEndpointUrl }],
      ],
    });

    const response = await handleSetupCallbackRequest(
      new Request(validCallbackUrl),
      makeWorkerConfiguration(fakeKvNamespace),
      fakeFetch,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');

    const responseHtml = await response.text();
    expect(responseHtml).toContain('<form method="post" action="/setup/callback">');
    expect(responseHtml).toContain(fakeSiteIngressEndpointUrl);
    expect(responseHtml).toContain(secondIngressEndpointUrl);

    expect(await getSelectedEmailIngressEndpoint(fakeKvNamespace.asKvNamespace())).toBeNull();
  });

  it('still stores the credential when discovery fails, and says so', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSiteUrl(fakeKvNamespace);
    const { fakeFetch } = makeFakeWordPressSite({
      advertisedEndpointsPerDiscovery: [[]],
    });

    const response = await handleSetupCallbackRequest(
      new Request(validCallbackUrl),
      makeWorkerConfiguration(fakeKvNamespace),
      fakeFetch,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('could not be discovered');

    const credential = await getWordPressApplicationPasswordCredential(
      fakeKvNamespace.asKvNamespace(),
    );
    expect(credential.userLogin).toBe('email-ingress-user');
  });

  it('rejects a callback with missing parameters', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSiteUrl(fakeKvNamespace);

    const response = await handleSetupCallbackRequest(
      new Request('https://worker.example/setup/callback?token=correct-token&user_login=u'),
      makeWorkerConfiguration(fakeKvNamespace),
      makeFakeWordPressSite().fakeFetch,
    );

    expect(response.status).toBe(400);
  });

  it('rejects a callback whose site_url does not match the stored site', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSiteUrl(fakeKvNamespace);

    const response = await handleSetupCallbackRequest(
      new Request(
        'https://worker.example/setup/callback?token=correct-token' +
          '&site_url=https%3A%2F%2Fevil.example&user_login=u&password=p',
      ),
      makeWorkerConfiguration(fakeKvNamespace),
      makeFakeWordPressSite().fakeFetch,
    );

    expect(response.status).toBe(400);
  });

  it('rejects a callback whose site_url is not a URL', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSiteUrl(fakeKvNamespace);

    const response = await handleSetupCallbackRequest(
      new Request(
        'https://worker.example/setup/callback?token=correct-token' +
          '&site_url=not-a-url&user_login=u&password=p',
      ),
      makeWorkerConfiguration(fakeKvNamespace),
      makeFakeWordPressSite().fakeFetch,
    );

    expect(response.status).toBe(400);
  });
});

describe('handleSetupCallbackRequest — endpoint selection form submission', () => {
  function makeSelectionRequest(formFields: Record<string, string>): Request {
    return new Request('https://worker.example/setup/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(formFields).toString(),
    });
  }

  const twoAdvertisedEndpoints = {
    advertisedEndpointsPerDiscovery: [
      [
        { url: fakeSiteIngressEndpointUrl },
        { url: secondIngressEndpointUrl, maxMessageSizeBytes: 2048 },
      ],
    ],
  };

  it('rejects a submission without the setup token', async () => {
    const response = await handleSetupCallbackRequest(
      makeSelectionRequest({ endpoint_url: fakeSiteIngressEndpointUrl }),
      makeWorkerConfiguration(new FakeKvNamespace()),
      makeFakeWordPressSite(twoAdvertisedEndpoints).fakeFetch,
    );

    expect(response.status).toBe(403);
  });

  it('rejects a submission without an endpoint_url', async () => {
    const response = await handleSetupCallbackRequest(
      makeSelectionRequest({ token: 'correct-token' }),
      makeWorkerConfiguration(new FakeKvNamespace()),
      makeFakeWordPressSite(twoAdvertisedEndpoints).fakeFetch,
    );

    expect(response.status).toBe(400);
  });

  it('directs to the setup form when no site URL is stored', async () => {
    const response = await handleSetupCallbackRequest(
      makeSelectionRequest({ token: 'correct-token', endpoint_url: fakeSiteIngressEndpointUrl }),
      makeWorkerConfiguration(new FakeKvNamespace()),
      makeFakeWordPressSite(twoAdvertisedEndpoints).fakeFetch,
    );

    expect(response.status).toBe(409);
  });

  it('stores the chosen endpoint with its advertised metadata', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSiteUrl(fakeKvNamespace);

    const response = await handleSetupCallbackRequest(
      makeSelectionRequest({ token: 'correct-token', endpoint_url: secondIngressEndpointUrl }),
      makeWorkerConfiguration(fakeKvNamespace),
      makeFakeWordPressSite(twoAdvertisedEndpoints).fakeFetch,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain(secondIngressEndpointUrl);

    const selectedEndpoint = await getSelectedEmailIngressEndpoint(fakeKvNamespace.asKvNamespace());
    expect(selectedEndpoint?.url).toBe(secondIngressEndpointUrl);
    // The stored entry carries the advertised metadata, not client input.
    expect(selectedEndpoint?.maxMessageSizeBytes).toBe(2048);
  });

  it('re-presents the form when the submitted endpoint is not advertised', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSiteUrl(fakeKvNamespace);

    const response = await handleSetupCallbackRequest(
      makeSelectionRequest({
        token: 'correct-token',
        endpoint_url: 'https://sacramentogaa.org/wp-json/gone/v1/incoming-email',
      }),
      makeWorkerConfiguration(fakeKvNamespace),
      makeFakeWordPressSite(twoAdvertisedEndpoints).fakeFetch,
    );

    expect(response.status).toBe(409);
    expect(await response.text()).toContain('<form method="post" action="/setup/callback">');
    expect(await getSelectedEmailIngressEndpoint(fakeKvNamespace.asKvNamespace())).toBeNull();
  });
});
