/**
 * HTTP routes for the one-time application-password setup flow.
 *
 * `GET /setup?token=…` redirects the site administrator to WordPress core's
 * `/wp-admin/authorize-application.php`. After approval, WordPress redirects
 * back to `GET /setup/callback?token=…&site_url=…&user_login=…&password=…`,
 * and the credential is stored in KV.
 *
 * Both routes are gated by the SETUP_TOKEN secret. The password arrives as a
 * query parameter (that is how the core flow works), so these handlers must
 * never log request URLs.
 */

import type { WorkerConfiguration } from './configuration';
import { storeWordPressApplicationPasswordCredential } from './wordpress-application-password';

export const SETUP_ROUTE_PATH = '/setup';
export const SETUP_CALLBACK_ROUTE_PATH = '/setup/callback';

/**
 * A stable identifier for this application, sent to WordPress so repeat
 * authorizations revoke/replace rather than accumulate.
 */
const APPLICATION_UUID = '31c9c8f6-9d65-4c4d-8b8e-0f2d1a7e5b42';

const APPLICATION_NAME = 'bh-wp-mailboxes Cloudflare email worker';

function isAuthorizedSetupRequest(requestUrl: URL, configuration: WorkerConfiguration): boolean {
  return requestUrl.searchParams.get('token') === configuration.setupToken;
}

/**
 * Redirect the administrator to the WordPress application-password
 * authorization screen.
 */
export function handleSetupRequest(request: Request, configuration: WorkerConfiguration): Response {
  const requestUrl = new URL(request.url);

  if (!isAuthorizedSetupRequest(requestUrl, configuration)) {
    return new Response('Forbidden: missing or incorrect setup token.', { status: 403 });
  }

  const successUrl = new URL(SETUP_CALLBACK_ROUTE_PATH, requestUrl.origin);
  successUrl.searchParams.set('token', configuration.setupToken);

  const authorizationUrl = new URL(
    '/wp-admin/authorize-application.php',
    configuration.targetWordPressSiteUrl,
  );
  authorizationUrl.searchParams.set('app_name', APPLICATION_NAME);
  authorizationUrl.searchParams.set('app_id', APPLICATION_UUID);
  authorizationUrl.searchParams.set('success_url', successUrl.toString());

  return Response.redirect(authorizationUrl.toString(), 302);
}

/**
 * Receive and store the credential WordPress sends back after approval.
 */
export async function handleSetupCallbackRequest(
  request: Request,
  configuration: WorkerConfiguration,
): Promise<Response> {
  const requestUrl = new URL(request.url);

  if (!isAuthorizedSetupRequest(requestUrl, configuration)) {
    return new Response('Forbidden: missing or incorrect setup token.', { status: 403 });
  }

  const siteUrl = requestUrl.searchParams.get('site_url');
  const userLogin = requestUrl.searchParams.get('user_login');
  const applicationPassword = requestUrl.searchParams.get('password');

  if (!siteUrl || !userLogin || !applicationPassword) {
    return new Response(
      'Bad request: expected site_url, user_login and password query parameters from WordPress.',
      { status: 400 },
    );
  }

  let siteUrlOrigin: string;
  try {
    siteUrlOrigin = new URL(siteUrl).origin;
  } catch {
    return new Response('Bad request: site_url is not a valid URL.', { status: 400 });
  }

  if (siteUrlOrigin !== configuration.targetWordPressSiteUrl.origin) {
    return new Response(
      'Bad request: site_url does not match the configured TARGET_WORDPRESS_SITE_URL.',
      { status: 400 },
    );
  }

  await storeWordPressApplicationPasswordCredential(configuration.workerConfigurationKv, {
    userLogin,
    applicationPassword,
  });

  return new Response(
    `Application password for "${userLogin}" stored. Incoming email will now be delivered to ${configuration.targetWordPressSiteUrl.origin}. You can close this window.`,
    { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } },
  );
}
