import { describe, expect, it, vi } from 'vitest';

import type { WorkerConfiguration } from '../src/configuration';
import { getAlertEmailAddresses, storeAlertEmailAddresses } from '../src/delivery-failure-alerting';
import { getSelectedEmailIngressEndpoint } from '../src/selected-email-ingress-endpoint';
import { handleSetupCallbackRequest, handleSetupRequest } from '../src/setup-routes';
import { verifySetupToken } from '../src/setup-token';
import { getTargetWordPressSiteUrl } from '../src/target-wordpress-site-url';
import { getWordPressApplicationPasswordCredential } from '../src/wordpress-application-password';
import { FakeKvNamespace } from './fakes/fake-kv-namespace';
import { fakeSiteIngressEndpointUrl, makeFakeWordPressSite } from './fakes/fake-wordpress-site';

const secondIngressEndpointUrl =
  'https://sacramentogaa.org/wp-json/second-mailbox/v1/incoming-email';

function makeWorkerConfiguration(
  fakeKvNamespace: FakeKvNamespace,
  alertSendEmailBinding: SendEmail | null = null,
  setupToken: string | null = 'correct-token',
): WorkerConfiguration {
  return {
    setupToken,
    workerConfigurationKv: fakeKvNamespace.asKvNamespace(),
    alertSendEmailBinding,
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

  it('adds https:// automatically when the scheme is omitted', async () => {
    const fakeKvNamespace = new FakeKvNamespace();

    const response = await handleSetupRequest(
      makeSiteUrlSubmission({ token: 'correct-token', site_url: 'sacramentogaa.org' }),
      makeWorkerConfiguration(fakeKvNamespace),
    );

    expect(response.status).toBe(302);

    const storedSiteUrl = await getTargetWordPressSiteUrl(fakeKvNamespace.asKvNamespace());
    expect(storedSiteUrl?.origin).toBe('https://sacramentogaa.org');
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

  it('offers the Email Routing configuration on the endpoint-selected page', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSiteUrl(fakeKvNamespace);

    const response = await handleSetupCallbackRequest(
      new Request(validCallbackUrl),
      makeWorkerConfiguration(fakeKvNamespace),
      makeFakeWordPressSite().fakeFetch,
    );

    expect(await response.text()).toContain('name="cloudflare_api_token"');
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

describe('handleSetupCallbackRequest — alert addresses', () => {
  const validCallbackUrl =
    'https://worker.example/setup/callback?token=correct-token' +
    '&site_url=https%3A%2F%2Fsacramentogaa.org' +
    '&user_login=email-ingress-user' +
    '&password=abcd%20efgh%20ijkl';

  function makeAlertSubmission(formFields: Record<string, string>): Request {
    return new Request('https://worker.example/setup/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(formFields).toString(),
    });
  }

  it('shows the alert form on the confirmation page, pre-filled with the site admin email', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSiteUrl(fakeKvNamespace);
    const { fakeFetch } = makeFakeWordPressSite({
      siteAdminEmailAddress: 'site-admin@example.net',
    });

    const response = await handleSetupCallbackRequest(
      new Request(validCallbackUrl),
      makeWorkerConfiguration(fakeKvNamespace),
      fakeFetch,
    );

    const responseHtml = await response.text();
    expect(responseHtml).toContain('name="alert_recipient_email_address"');
    expect(responseHtml).toContain('value="site-admin@example.net"');
  });

  it("falls back to the authorizing user's email when the settings endpoint is forbidden", async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSiteUrl(fakeKvNamespace);
    const { fakeFetch } = makeFakeWordPressSite({
      siteAdminEmailAddress: null,
      authenticatedUserEmailAddress: 'ingress-user@example.net',
    });

    const response = await handleSetupCallbackRequest(
      new Request(validCallbackUrl),
      makeWorkerConfiguration(fakeKvNamespace),
      fakeFetch,
    );

    expect(await response.text()).toContain('value="ingress-user@example.net"');
  });

  it('leaves the recipient blank when neither WordPress endpoint yields an email', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSiteUrl(fakeKvNamespace);

    const response = await handleSetupCallbackRequest(
      new Request(validCallbackUrl),
      makeWorkerConfiguration(fakeKvNamespace),
      makeFakeWordPressSite().fakeFetch,
    );

    const responseHtml = await response.text();
    expect(responseHtml).toContain(
      'name="alert_recipient_email_address" size="40" placeholder="you@example.net" value=""',
    );
  });

  it('stores submitted alert addresses', async () => {
    const fakeKvNamespace = new FakeKvNamespace();

    const response = await handleSetupCallbackRequest(
      makeAlertSubmission({
        token: 'correct-token',
        alert_recipient_email_address: 'admin@example.net',
        alert_from_email_address: 'worker@p.sacramentogaa.org',
      }),
      makeWorkerConfiguration(fakeKvNamespace),
      makeFakeWordPressSite().fakeFetch,
    );

    expect(response.status).toBe(200);
    expect(await getAlertEmailAddresses(fakeKvNamespace.asKvNamespace())).toEqual({
      fromEmailAddress: 'worker@p.sacramentogaa.org',
      recipientEmailAddress: 'admin@example.net',
    });
  });

  it('clears stored addresses (disables alerts) when both fields are blank', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeAlertEmailAddresses(fakeKvNamespace.asKvNamespace(), {
      fromEmailAddress: 'worker@p.sacramentogaa.org',
      recipientEmailAddress: 'admin@example.net',
    });

    const response = await handleSetupCallbackRequest(
      makeAlertSubmission({
        token: 'correct-token',
        alert_recipient_email_address: '',
        alert_from_email_address: '',
      }),
      makeWorkerConfiguration(fakeKvNamespace),
      makeFakeWordPressSite().fakeFetch,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Alerts disabled');
    expect(await getAlertEmailAddresses(fakeKvNamespace.asKvNamespace())).toBeNull();
  });

  it('re-shows the form with an error for an invalid email address', async () => {
    const fakeKvNamespace = new FakeKvNamespace();

    const response = await handleSetupCallbackRequest(
      makeAlertSubmission({
        token: 'correct-token',
        alert_recipient_email_address: 'not-an-email',
        alert_from_email_address: 'worker@p.sacramentogaa.org',
      }),
      makeWorkerConfiguration(fakeKvNamespace),
      makeFakeWordPressSite().fakeFetch,
    );

    expect(response.status).toBe(400);
    expect(await getAlertEmailAddresses(fakeKvNamespace.asKvNamespace())).toBeNull();
  });

  it('rejects a submission without the setup token', async () => {
    const response = await handleSetupCallbackRequest(
      makeAlertSubmission({ alert_recipient_email_address: 'admin@example.net' }),
      makeWorkerConfiguration(new FakeKvNamespace()),
      makeFakeWordPressSite().fakeFetch,
    );

    expect(response.status).toBe(403);
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

describe('handleSetupCallbackRequest — send test email', () => {
  const storedAlertAddresses = {
    fromEmailAddress: 'worker@p.sacramentogaa.org',
    recipientEmailAddress: 'admin@example.net',
  };

  function makeTestEmailSubmission(formFields: Record<string, string>): Request {
    return new Request('https://worker.example/setup/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(formFields).toString(),
    });
  }

  function makeSendEmailBinding(): SendEmail {
    return { send: vi.fn() };
  }

  it('sends a test email to the stored addresses and reports success', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeAlertEmailAddresses(fakeKvNamespace.asKvNamespace(), storedAlertAddresses);
    const sendAlertEmail = vi.fn().mockResolvedValue(undefined);

    const response = await handleSetupCallbackRequest(
      makeTestEmailSubmission({ token: 'correct-token', send_test_alert_email: '1' }),
      makeWorkerConfiguration(fakeKvNamespace, makeSendEmailBinding()),
      makeFakeWordPressSite().fakeFetch,
      sendAlertEmail,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('admin@example.net');

    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
    const [, addresses, subject] = sendAlertEmail.mock.calls[0] as [
      SendEmail,
      { recipientEmailAddress: string },
      string,
    ];
    expect(addresses).toEqual(storedAlertAddresses);
    expect(subject.toLowerCase()).toContain('test');
  });

  it('neither consumes nor is blocked by the once-per-day alert rate limit', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeAlertEmailAddresses(fakeKvNamespace.asKvNamespace(), storedAlertAddresses);
    // A real alert was already sent today.
    await fakeKvNamespace.put('delivery_failure_alert_sent_recently', new Date().toISOString());
    const sendAlertEmail = vi.fn().mockResolvedValue(undefined);

    await handleSetupCallbackRequest(
      makeTestEmailSubmission({ token: 'correct-token', send_test_alert_email: '1' }),
      makeWorkerConfiguration(fakeKvNamespace, makeSendEmailBinding()),
      makeFakeWordPressSite().fakeFetch,
      sendAlertEmail,
    );

    expect(sendAlertEmail).toHaveBeenCalledTimes(1);
  });

  it('explains the Email Routing verification requirement when sending fails', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeAlertEmailAddresses(fakeKvNamespace.asKvNamespace(), storedAlertAddresses);
    const sendAlertEmail = vi.fn().mockRejectedValue(new Error('recipient not verified'));

    const response = await handleSetupCallbackRequest(
      makeTestEmailSubmission({ token: 'correct-token', send_test_alert_email: '1' }),
      makeWorkerConfiguration(fakeKvNamespace, makeSendEmailBinding()),
      makeFakeWordPressSite().fakeFetch,
      sendAlertEmail,
    );

    expect(response.status).toBe(502);
    const responseHtml = await response.text();
    expect(responseHtml).toContain('recipient not verified');
    expect(responseHtml).toContain('Destination addresses');
  });

  it('rejects when no alert addresses are stored', async () => {
    const sendAlertEmail = vi.fn();

    const response = await handleSetupCallbackRequest(
      makeTestEmailSubmission({ token: 'correct-token', send_test_alert_email: '1' }),
      makeWorkerConfiguration(new FakeKvNamespace(), makeSendEmailBinding()),
      makeFakeWordPressSite().fakeFetch,
      sendAlertEmail,
    );

    expect(response.status).toBe(409);
    expect(sendAlertEmail).not.toHaveBeenCalled();
  });

  it('reports a missing binding', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeAlertEmailAddresses(fakeKvNamespace.asKvNamespace(), storedAlertAddresses);

    const response = await handleSetupCallbackRequest(
      makeTestEmailSubmission({ token: 'correct-token', send_test_alert_email: '1' }),
      makeWorkerConfiguration(fakeKvNamespace),
      makeFakeWordPressSite().fakeFetch,
      vi.fn(),
    );

    expect(response.status).toBe(500);
  });

  it('rejects a submission without the setup token', async () => {
    const response = await handleSetupCallbackRequest(
      makeTestEmailSubmission({ send_test_alert_email: '1' }),
      makeWorkerConfiguration(new FakeKvNamespace(), makeSendEmailBinding()),
      makeFakeWordPressSite().fakeFetch,
      vi.fn(),
    );

    expect(response.status).toBe(403);
  });

  it('offers the test button on the alert form when addresses are already stored', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSiteUrl(fakeKvNamespace);
    await storeAlertEmailAddresses(fakeKvNamespace.asKvNamespace(), storedAlertAddresses);

    const response = await handleSetupCallbackRequest(
      new Request(
        'https://worker.example/setup/callback?token=correct-token' +
          '&site_url=https%3A%2F%2Fsacramentogaa.org&user_login=u&password=p',
      ),
      makeWorkerConfiguration(fakeKvNamespace),
      makeFakeWordPressSite().fakeFetch,
    );

    expect(await response.text()).toContain('name="send_test_alert_email"');
  });

  it('does not offer the test button before addresses are stored', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSiteUrl(fakeKvNamespace);

    const response = await handleSetupCallbackRequest(
      new Request(
        'https://worker.example/setup/callback?token=correct-token' +
          '&site_url=https%3A%2F%2Fsacramentogaa.org&user_login=u&password=p',
      ),
      makeWorkerConfiguration(fakeKvNamespace),
      makeFakeWordPressSite().fakeFetch,
    );

    expect(await response.text()).not.toContain('name="send_test_alert_email"');
  });
});

describe('handleSetupRequest — first-run setup token creation', () => {
  function makeUnclaimedConfiguration(fakeKvNamespace: FakeKvNamespace): WorkerConfiguration {
    return makeWorkerConfiguration(fakeKvNamespace, null, null);
  }

  function makeTokenCreationSubmission(newSetupToken: string): Request {
    return new Request('https://worker.example/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ new_setup_token: newSetupToken }).toString(),
    });
  }

  it('offers to create a token on the first visit, with a random suggestion', async () => {
    const response = await handleSetupRequest(
      new Request('https://worker.example/setup'),
      makeUnclaimedConfiguration(new FakeKvNamespace()),
    );

    expect(response.status).toBe(200);
    const responseHtml = await response.text();
    expect(responseHtml).toContain('name="new_setup_token"');
    expect(responseHtml).toMatch(/value="[0-9a-f]{64}"/);
    expect(responseHtml).toContain('SETUP_TOKEN');
  });

  it('stores the chosen token and continues to the site URL form', async () => {
    const fakeKvNamespace = new FakeKvNamespace();

    const response = await handleSetupRequest(
      makeTokenCreationSubmission('my-chosen-setup-token'),
      makeUnclaimedConfiguration(fakeKvNamespace),
    );

    expect(response.status).toBe(200);
    const responseHtml = await response.text();
    expect(responseHtml).toContain('my-chosen-setup-token');
    expect(responseHtml).toContain('name="site_url"');

    expect(
      await verifySetupToken(fakeKvNamespace.asKvNamespace(), null, 'my-chosen-setup-token'),
    ).toBe(true);
  });

  it('the claimed token then gates the setup routes', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await handleSetupRequest(
      makeTokenCreationSubmission('my-chosen-setup-token'),
      makeUnclaimedConfiguration(fakeKvNamespace),
    );

    const withToken = await handleSetupRequest(
      new Request('https://worker.example/setup?token=my-chosen-setup-token'),
      makeUnclaimedConfiguration(fakeKvNamespace),
    );
    expect(withToken.status).toBe(200);
    expect(await withToken.text()).toContain('name="site_url"');

    const withoutToken = await handleSetupRequest(
      new Request('https://worker.example/setup'),
      makeUnclaimedConfiguration(fakeKvNamespace),
    );
    expect(withoutToken.status).toBe(403);

    const wrongToken = await handleSetupRequest(
      new Request('https://worker.example/setup?token=wrong'),
      makeUnclaimedConfiguration(fakeKvNamespace),
    );
    expect(wrongToken.status).toBe(403);
  });

  it('refuses to create a token once one is claimed', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await handleSetupRequest(
      makeTokenCreationSubmission('my-chosen-setup-token'),
      makeUnclaimedConfiguration(fakeKvNamespace),
    );

    const response = await handleSetupRequest(
      makeTokenCreationSubmission('attacker-replacement-token'),
      makeUnclaimedConfiguration(fakeKvNamespace),
    );

    expect(response.status).toBe(403);
    expect(
      await verifySetupToken(fakeKvNamespace.asKvNamespace(), null, 'my-chosen-setup-token'),
    ).toBe(true);
  });

  it('refuses to create a token when the SETUP_TOKEN secret is set', async () => {
    const response = await handleSetupRequest(
      makeTokenCreationSubmission('web-ui-token'),
      makeWorkerConfiguration(new FakeKvNamespace()),
    );

    expect(response.status).toBe(403);
  });

  it('never offers the creation form when the SETUP_TOKEN secret is set', async () => {
    const response = await handleSetupRequest(
      new Request('https://worker.example/setup'),
      makeWorkerConfiguration(new FakeKvNamespace()),
    );

    expect(response.status).toBe(403);
  });

  it('rejects a too-short token', async () => {
    const fakeKvNamespace = new FakeKvNamespace();

    const response = await handleSetupRequest(
      makeTokenCreationSubmission('short'),
      makeUnclaimedConfiguration(fakeKvNamespace),
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain('name="new_setup_token"');
    expect(await verifySetupToken(fakeKvNamespace.asKvNamespace(), null, 'short')).toBe(false);
  });
});

describe('handleSetupRequest — Cloudflare Email Routing configuration', () => {
  function makeEmailRoutingSubmission(formFields: Record<string, string>): Request {
    return new Request('https://worker.example/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(formFields).toString(),
    });
  }

  function makeFakeCloudflareApi() {
    return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input.toString(), init);
      const respond = (body: unknown) =>
        Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
      if (request.url.includes('/zones?name=')) {
        return respond({
          success: true,
          errors: [],
          result: [{ id: 'zone-id-123', account: { id: 'account-id-9' } }],
        });
      }
      if (request.url.includes('/email/routing/rules?')) {
        return respond({ success: true, errors: [], result: [] });
      }
      if (request.url.includes('/email/routing/addresses') && request.method !== 'POST') {
        return respond({ success: true, errors: [], result: [] });
      }
      return respond({ success: true, errors: [], result: { enabled: true } });
    }) as unknown as typeof fetch;
  }

  it('offers the Email Routing form on the setup page', async () => {
    const response = await handleSetupRequest(
      new Request('https://worker.example/setup?token=correct-token'),
      makeWorkerConfiguration(new FakeKvNamespace()),
    );

    const responseHtml = await response.text();
    expect(responseHtml).toContain('name="cloudflare_api_token"');
    expect(responseHtml).toContain('never stored');
    // Pre-filled token-creation deep link into the Cloudflare dashboard.
    expect(responseHtml).toContain('https://dash.cloudflare.com/profile/api-tokens?');
    expect(responseHtml).toContain('permissionGroupKeys');
  });

  it('configures Email Routing and reports each step', async () => {
    const response = await handleSetupRequest(
      makeEmailRoutingSubmission({
        token: 'correct-token',
        cloudflare_api_token: 'transient-api-token',
        zone_name: 'example-mail.com',
        worker_name: 'my-worker',
      }),
      makeWorkerConfiguration(new FakeKvNamespace()),
      makeFakeCloudflareApi(),
    );

    expect(response.status).toBe(200);
    const responseHtml = await response.text();
    expect(responseHtml).toContain('Email Routing configured');
    expect(responseHtml).toContain('example-mail.com');
  });

  it('never stores the API token in KV and never echoes it back', async () => {
    const fakeKvNamespace = new FakeKvNamespace();

    const response = await handleSetupRequest(
      makeEmailRoutingSubmission({
        token: 'correct-token',
        cloudflare_api_token: 'transient-api-token',
        zone_name: 'example-mail.com',
        worker_name: 'my-worker',
      }),
      makeWorkerConfiguration(fakeKvNamespace),
      makeFakeCloudflareApi(),
    );

    expect(await response.text()).not.toContain('transient-api-token');
    expect(fakeKvNamespace.storedKeys()).toEqual([]);
  });

  it('does not echo the token on the failure page either', async () => {
    const failingCloudflareApi = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ success: false, errors: [{ message: 'Invalid API Token' }] }),
          { status: 403 },
        ),
      ),
    ) as unknown as typeof fetch;

    const response = await handleSetupRequest(
      makeEmailRoutingSubmission({
        token: 'correct-token',
        cloudflare_api_token: 'transient-api-token',
        zone_name: 'example-mail.com',
        worker_name: 'my-worker',
      }),
      makeWorkerConfiguration(new FakeKvNamespace()),
      failingCloudflareApi,
    );

    expect(response.status).toBe(502);
    const responseHtml = await response.text();
    expect(responseHtml).toContain('Invalid API Token');
    expect(responseHtml).not.toContain('transient-api-token');
    // The form is offered again for a retry.
    expect(responseHtml).toContain('name="cloudflare_api_token"');
  });

  it('requires all three fields', async () => {
    const response = await handleSetupRequest(
      makeEmailRoutingSubmission({
        token: 'correct-token',
        cloudflare_api_token: 'transient-api-token',
        zone_name: '',
        worker_name: 'my-worker',
      }),
      makeWorkerConfiguration(new FakeKvNamespace()),
      makeFakeCloudflareApi(),
    );

    expect(response.status).toBe(400);
  });

  it('offers routing-mode and destination-address fields on the form', async () => {
    const response = await handleSetupRequest(
      new Request('https://worker.example/setup?token=correct-token'),
      makeWorkerConfiguration(new FakeKvNamespace()),
    );

    const responseHtml = await response.text();
    expect(responseHtml).toContain('name="routing_mode"');
    expect(responseHtml).toContain('name="incoming_email_address"');
    expect(responseHtml).toContain('name="alert_destination_email_address"');
  });

  it('routes a single address and registers the alert destination when requested', async () => {
    const response = await handleSetupRequest(
      makeEmailRoutingSubmission({
        token: 'correct-token',
        cloudflare_api_token: 'transient-api-token',
        zone_name: 'example-mail.com',
        worker_name: 'my-worker',
        routing_mode: 'single_address',
        incoming_email_address: 'mailbox@example-mail.com',
        alert_destination_email_address: 'admin@example.net',
      }),
      makeWorkerConfiguration(new FakeKvNamespace()),
      makeFakeCloudflareApi(),
    );

    expect(response.status).toBe(200);
    const responseHtml = await response.text();
    expect(responseHtml).toContain('mailbox@example-mail.com');
    expect(responseHtml).toContain('admin@example.net');
  });

  it('requires the incoming address in single-address mode', async () => {
    const response = await handleSetupRequest(
      makeEmailRoutingSubmission({
        token: 'correct-token',
        cloudflare_api_token: 'transient-api-token',
        zone_name: 'example-mail.com',
        worker_name: 'my-worker',
        routing_mode: 'single_address',
        incoming_email_address: '',
      }),
      makeWorkerConfiguration(new FakeKvNamespace()),
      makeFakeCloudflareApi(),
    );

    expect(response.status).toBe(400);
  });

  it('rejects a submission without the setup token', async () => {
    const response = await handleSetupRequest(
      makeEmailRoutingSubmission({
        cloudflare_api_token: 'transient-api-token',
        zone_name: 'example-mail.com',
        worker_name: 'my-worker',
      }),
      makeWorkerConfiguration(new FakeKvNamespace()),
      makeFakeCloudflareApi(),
    );

    expect(response.status).toBe(403);
  });
});
