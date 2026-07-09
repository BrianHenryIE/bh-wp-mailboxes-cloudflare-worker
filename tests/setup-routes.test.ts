import { describe, expect, it } from 'vitest';

import type { WorkerConfiguration } from '../src/configuration';
import { handleSetupCallbackRequest, handleSetupRequest } from '../src/setup-routes';
import { getWordPressApplicationPasswordCredential } from '../src/wordpress-application-password';
import { FakeKvNamespace } from './fakes/fake-kv-namespace';

function makeWorkerConfiguration(fakeKvNamespace: FakeKvNamespace): WorkerConfiguration {
  return {
    targetWordPressSiteUrl: new URL('https://sacramentogaa.org'),
    setupToken: 'correct-token',
    workerConfigurationKv: fakeKvNamespace.asKvNamespace(),
  };
}

describe('handleSetupRequest', () => {
  it('rejects a missing token', () => {
    const response = handleSetupRequest(
      new Request('https://worker.example/setup'),
      makeWorkerConfiguration(new FakeKvNamespace()),
    );

    expect(response.status).toBe(403);
  });

  it('rejects an incorrect token', () => {
    const response = handleSetupRequest(
      new Request('https://worker.example/setup?token=wrong'),
      makeWorkerConfiguration(new FakeKvNamespace()),
    );

    expect(response.status).toBe(403);
  });

  it('redirects to the WordPress authorization screen', () => {
    const response = handleSetupRequest(
      new Request('https://worker.example/setup?token=correct-token'),
      makeWorkerConfiguration(new FakeKvNamespace()),
    );

    expect(response.status).toBe(302);

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
    );

    expect(response.status).toBe(403);
  });

  it('stores the credential and confirms', async () => {
    const fakeKvNamespace = new FakeKvNamespace();

    const response = await handleSetupCallbackRequest(
      new Request(validCallbackUrl),
      makeWorkerConfiguration(fakeKvNamespace),
    );

    expect(response.status).toBe(200);

    const credential = await getWordPressApplicationPasswordCredential(
      fakeKvNamespace.asKvNamespace(),
    );
    expect(credential.userLogin).toBe('email-ingress-user');
    expect(credential.applicationPassword).toBe('abcd efgh ijkl');
  });

  it('does not echo the password in the response body', async () => {
    const response = await handleSetupCallbackRequest(
      new Request(validCallbackUrl),
      makeWorkerConfiguration(new FakeKvNamespace()),
    );

    expect(await response.text()).not.toContain('abcd efgh ijkl');
  });

  it('rejects a callback with missing parameters', async () => {
    const response = await handleSetupCallbackRequest(
      new Request('https://worker.example/setup/callback?token=correct-token&user_login=u'),
      makeWorkerConfiguration(new FakeKvNamespace()),
    );

    expect(response.status).toBe(400);
  });

  it('rejects a callback whose site_url does not match the configured site', async () => {
    const response = await handleSetupCallbackRequest(
      new Request(
        'https://worker.example/setup/callback?token=correct-token' +
          '&site_url=https%3A%2F%2Fevil.example&user_login=u&password=p',
      ),
      makeWorkerConfiguration(new FakeKvNamespace()),
    );

    expect(response.status).toBe(400);
  });

  it('rejects a callback whose site_url is not a URL', async () => {
    const response = await handleSetupCallbackRequest(
      new Request(
        'https://worker.example/setup/callback?token=correct-token' +
          '&site_url=not-a-url&user_login=u&password=p',
      ),
      makeWorkerConfiguration(new FakeKvNamespace()),
    );

    expect(response.status).toBe(400);
  });
});
