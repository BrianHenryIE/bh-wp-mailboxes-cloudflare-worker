/**
 * HTTP routes for the one-time setup flow: application password + destination.
 *
 * `GET /setup?token=…` redirects the site administrator to WordPress core's
 * `/wp-admin/authorize-application.php`. After approval, WordPress redirects
 * back to `GET /setup/callback?token=…&site_url=…&user_login=…&password=…`;
 * the credential is stored in KV, the site's advertised
 * `email_ingress_endpoints` are discovered, and:
 *
 * - exactly one endpoint → it is selected automatically and confirmed;
 * - several endpoints → an HTML form asks the administrator which one this
 *   worker delivers to; the form POSTs back to the same callback route and
 *   the choice is stored in KV.
 *
 * Both routes are gated by the SETUP_TOKEN secret. The password arrives as a
 * query parameter (that is how the core flow works), so these handlers must
 * never log request URLs.
 */

import type { WorkerConfiguration } from './configuration';
import { storeSelectedEmailIngressEndpoint } from './selected-email-ingress-endpoint';
import { storeWordPressApplicationPasswordCredential } from './wordpress-application-password';
import {
  discoverEmailIngressEndpoints,
  type EmailIngressEndpoint,
} from './wordpress-rest-api-discovery';

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

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function htmlPageResponse(bodyHtml: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${APPLICATION_NAME}</title></head><body>${bodyHtml}</body></html>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}

function formatEndpointLabelHtml(endpoint: EmailIngressEndpoint): string {
  return `<code>${escapeHtml(endpoint.url)}</code> (namespace <code>${escapeHtml(endpoint.namespace)}</code>, max message size ${String(endpoint.maxMessageSizeBytes)} bytes)`;
}

/**
 * The HTML form asking the administrator which advertised endpoint this
 * worker delivers to.
 */
function endpointSelectionFormHtml(
  emailIngressEndpoints: EmailIngressEndpoint[],
  setupToken: string,
): string {
  const radioInputs = emailIngressEndpoints
    .map(
      (endpoint, index) =>
        `<p><label><input type="radio" name="endpoint_url" value="${escapeHtml(endpoint.url)}"${index === 0 ? ' checked' : ''}> ${formatEndpointLabelHtml(endpoint)}</label></p>`,
    )
    .join('');

  return (
    `<h1>Select the destination mailbox</h1>` +
    `<p>The site advertises ${String(emailIngressEndpoints.length)} email ingress endpoints. Incoming email will be delivered to the one you select, and nowhere else.</p>` +
    `<form method="post" action="${SETUP_CALLBACK_ROUTE_PATH}">` +
    `<input type="hidden" name="token" value="${escapeHtml(setupToken)}">` +
    radioInputs +
    `<p><button type="submit">Deliver email to this endpoint</button></p>` +
    `</form>`
  );
}

function endpointSelectedConfirmationHtml(endpoint: EmailIngressEndpoint): string {
  return (
    `<h1>Setup complete</h1>` +
    `<p>Incoming email will be delivered to ${formatEndpointLabelHtml(endpoint)}.</p>` +
    `<p>You can close this window.</p>`
  );
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
 * Receive and store the credential WordPress sends back after approval, then
 * discover the advertised ingress endpoints and select the destination:
 * automatically when there is exactly one, otherwise via the selection form.
 */
export async function handleSetupCallbackRequest(
  request: Request,
  configuration: WorkerConfiguration,
  fetchFunction: typeof fetch = fetch,
): Promise<Response> {
  if (request.method === 'POST') {
    return handleEndpointSelectionSubmission(request, configuration, fetchFunction);
  }

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

  // Credential stored; now choose the destination.
  let emailIngressEndpoints: EmailIngressEndpoint[];
  try {
    emailIngressEndpoints = await discoverEmailIngressEndpoints(
      configuration.targetWordPressSiteUrl,
      fetchFunction,
    );
  } catch (error) {
    return htmlPageResponse(
      `<h1>Application password stored</h1>` +
        `<p>The password for "${escapeHtml(userLogin)}" was stored, but the site's email ingress endpoints could not be discovered: ${escapeHtml(error instanceof Error ? error.message : String(error))}</p>` +
        `<p>Check that the receiving plugin is active, then re-open the setup link.</p>`,
    );
  }

  const singleEndpoint = emailIngressEndpoints.length === 1 ? emailIngressEndpoints[0] : undefined;
  if (singleEndpoint) {
    await storeSelectedEmailIngressEndpoint(configuration.workerConfigurationKv, singleEndpoint);
    return htmlPageResponse(endpointSelectedConfirmationHtml(singleEndpoint));
  }

  return htmlPageResponse(
    endpointSelectionFormHtml(emailIngressEndpoints, configuration.setupToken),
  );
}

/**
 * Store the endpoint the administrator chose on the selection form.
 *
 * The submitted URL is resolved against a fresh discovery, so only an
 * endpoint the site actually advertises can be selected (and the stored
 * entry carries the advertised metadata, e.g. the size limit).
 */
async function handleEndpointSelectionSubmission(
  request: Request,
  configuration: WorkerConfiguration,
  fetchFunction: typeof fetch,
): Promise<Response> {
  const formData = await request.formData();

  if (formData.get('token') !== configuration.setupToken) {
    return new Response('Forbidden: missing or incorrect setup token.', { status: 403 });
  }

  const selectedEndpointUrl = formData.get('endpoint_url');

  if (typeof selectedEndpointUrl !== 'string' || selectedEndpointUrl === '') {
    return new Response('Bad request: expected an endpoint_url form field.', { status: 400 });
  }

  let emailIngressEndpoints: EmailIngressEndpoint[];
  try {
    emailIngressEndpoints = await discoverEmailIngressEndpoints(
      configuration.targetWordPressSiteUrl,
      fetchFunction,
    );
  } catch (error) {
    return htmlPageResponse(
      `<h1>Discovery failed</h1>` +
        `<p>The site's email ingress endpoints could not be re-discovered: ${escapeHtml(error instanceof Error ? error.message : String(error))}</p>` +
        `<p>Check that the receiving plugin is active, then re-open the setup link.</p>`,
      502,
    );
  }

  const selectedEndpoint = emailIngressEndpoints.find(
    (endpoint) => endpoint.url === selectedEndpointUrl,
  );

  if (!selectedEndpoint) {
    return htmlPageResponse(
      `<h1>Endpoint not advertised</h1>` +
        `<p>The site no longer advertises <code>${escapeHtml(selectedEndpointUrl)}</code>. Choose again:</p>` +
        endpointSelectionFormHtml(emailIngressEndpoints, configuration.setupToken),
      409,
    );
  }

  await storeSelectedEmailIngressEndpoint(configuration.workerConfigurationKv, selectedEndpoint);

  return htmlPageResponse(endpointSelectedConfirmationHtml(selectedEndpoint));
}
