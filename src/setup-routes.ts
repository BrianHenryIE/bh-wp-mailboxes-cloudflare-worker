/**
 * HTTP routes for the one-time setup flow: site URL, application password,
 * and destination endpoint.
 *
 * `GET /setup?token=…` shows a form asking for the WordPress site URL
 * (pre-filled when re-running setup). Submitting stores the URL in KV and
 * redirects the administrator to that site's
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
 * All routes are gated by the SETUP_TOKEN secret. The password arrives as a
 * query parameter (that is how the core flow works), so these handlers must
 * never log request URLs.
 */

import {
  configureEmailRouting,
  type EmailRoutingConfigurationResult,
} from './cloudflare-email-routing-setup';
import type { WorkerConfiguration } from './configuration';
import {
  deleteAlertEmailAddresses,
  getAlertEmailAddresses,
  sendTestAlertEmail,
  storeAlertEmailAddresses,
  type AlertEmailAddresses,
  type SendAlertEmailFunction,
} from './delivery-failure-alerting';
import { storeSelectedEmailIngressEndpoint } from './selected-email-ingress-endpoint';
import {
  generateSuggestedSetupToken,
  isSetupTokenConfigured,
  MINIMUM_SETUP_TOKEN_LENGTH,
  storeSetupToken,
  verifySetupToken,
} from './setup-token';
import {
  getTargetWordPressSiteUrl,
  InvalidTargetWordPressSiteUrlError,
  parseTargetWordPressSiteUrl,
  storeTargetWordPressSiteUrl,
} from './target-wordpress-site-url';
import {
  buildBasicAuthorizationHeaderValue,
  getWordPressApplicationPasswordCredential,
  storeWordPressApplicationPasswordCredential,
} from './wordpress-application-password';
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

/**
 * The first-run form asking the administrator to choose the setup token
 * (trust on first use — shown only while no token is configured at all).
 */
function setupTokenCreationFormHtml(
  suggestedSetupToken: string,
  errorMessage: string | null = null,
): string {
  return (
    `<h1>Create a setup token</h1>` +
    (errorMessage ? `<p><strong>${escapeHtml(errorMessage)}</strong></p>` : '') +
    `<p>This worker has no setup token yet. Choose one now — it gates this setup flow and ` +
    `is required every time you return here. A random token is suggested below; ` +
    `<strong>save it in a password manager before continuing</strong>.</p>` +
    `<form method="post" action="${SETUP_ROUTE_PATH}">` +
    `<p><label>Setup token <input type="text" name="new_setup_token" size="70" value="${escapeHtml(suggestedSetupToken)}" required></label></p>` +
    `<p><button type="submit">Save token and continue</button></p>` +
    `</form>` +
    `<p>Anyone who can reach this page before a token is set can claim the worker, so do this ` +
    `promptly after deploying. To pre-empt it entirely, set a <code>SETUP_TOKEN</code> secret ` +
    `with wrangler — the secret always takes precedence. Forgot the token later? Delete the ` +
    `<code>setup_token_sha256</code> entry from the worker's KV namespace and this form returns.</p>`
  );
}

/**
 * Store the token chosen on the first-run form. Refused once any token is
 * configured — the web UI can create a token, never replace one.
 */
async function handleSetupTokenCreation(
  formData: FormData,
  configuration: WorkerConfiguration,
): Promise<Response> {
  if (await isSetupTokenConfigured(configuration.workerConfigurationKv, configuration.setupToken)) {
    return new Response('Forbidden: a setup token is already configured.', { status: 403 });
  }

  const newSetupToken = (formData.get('new_setup_token') ?? '').trim();

  if (newSetupToken.length < MINIMUM_SETUP_TOKEN_LENGTH) {
    return htmlPageResponse(
      setupTokenCreationFormHtml(
        generateSuggestedSetupToken(),
        `The setup token must be at least ${String(MINIMUM_SETUP_TOKEN_LENGTH)} characters.`,
      ),
      400,
    );
  }

  await storeSetupToken(configuration.workerConfigurationKv, newSetupToken);

  return htmlPageResponse(
    `<h1>Setup token saved</h1>` +
      `<p>Your setup token: <code>${escapeHtml(newSetupToken)}</code></p>` +
      `<p><strong>Save it now</strong> — only its hash is stored, so it cannot be shown again. ` +
      `You will need it at <code>${SETUP_ROUTE_PATH}?token=…</code> to re-run setup.</p>` +
      siteUrlFormHtml(newSetupToken, null),
  );
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

const DEFAULT_WORKER_NAME = 'bh-wp-mailboxes-incoming-email-worker';

/**
 * Deep link to the dashboard's Create Custom Token screen with the needed
 * permission groups pre-selected. The query parameters are undocumented but
 * widely used (external-dns, cert-manager); if Cloudflare ever ignores them,
 * the link degrades gracefully to the plain token page.
 */
const CLOUDFLARE_API_TOKEN_CREATION_URL =
  'https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22zone%22%2C%22type%22%3A%22read%22%7D%2C%7B%22key%22%3A%22zone_settings%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22dns_records%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22email_routing_rules%22%2C%22type%22%3A%22edit%22%7D%2C%7B%22key%22%3A%22email_routing_addresses%22%2C%22type%22%3A%22edit%22%7D%5D&name=bh-wp-mailboxes+email+worker+setup';

/**
 * The form that configures Cloudflare Email Routing for the receiving zone
 * using a transient API token. The token is used for one request's API calls
 * and never stored, logged, or echoed back — on a retry it must be pasted
 * again.
 */
function emailRoutingConfigurationFormHtml(
  setupToken: string,
  zoneName = '',
  workerName: string = DEFAULT_WORKER_NAME,
  errorMessage: string | null = null,
): string {
  return (
    `<h2>Cloudflare Email Routing</h2>` +
    (errorMessage ? `<p><strong>${escapeHtml(errorMessage)}</strong></p>` : '') +
    `<p>Optionally, let the worker configure the receiving zone for you: enable ` +
    `<strong>Email Routing</strong> (adds and locks the MX + SPF DNS records) and point the ` +
    `zone's <strong>catch-all rule</strong> at this worker. Equivalent to the manual dashboard ` +
    `steps in the README.</p>` +
    `<p><a href="${CLOUDFLARE_API_TOKEN_CREATION_URL}" target="_blank" rel="noopener">Create the API token in the Cloudflare dashboard</a> ` +
    `— the link pre-selects the permissions (<em>Zone → Zone → Read</em>, ` +
    `<em>Zone → Zone Settings → Edit</em>, <em>Zone → DNS → Edit</em>, ` +
    `<em>Zone → Email Routing Rules → Edit</em>, ` +
    `<em>Account → Email Routing Addresses → Edit</em>; verify them if the pre-selection ` +
    `does not appear). Under <em>Zone Resources</em> scope it to the receiving zone, create ` +
    `the token, and paste it here. It is used in memory for this one request and is ` +
    `<strong>never stored, logged, or echoed back</strong> — you may delete it from ` +
    `Cloudflare immediately afterwards.</p>` +
    `<form method="post" action="${SETUP_ROUTE_PATH}">` +
    `<input type="hidden" name="token" value="${escapeHtml(setupToken)}">` +
    `<p><label>Cloudflare API token <input type="password" name="cloudflare_api_token" size="45" autocomplete="off" required></label></p>` +
    `<p><label>Receiving zone <input type="text" name="zone_name" size="30" placeholder="example-mail.com" value="${escapeHtml(zoneName)}" required></label><br>` +
    `Must be a root domain — Email Routing does not support subdomains. It can differ from the WordPress site's domain.</p>` +
    `<p><label>Worker name <input type="text" name="worker_name" size="45" value="${escapeHtml(workerName)}" required></label><br>` +
    `As shown in the Cloudflare dashboard (change this only if you renamed the worker when deploying).</p>` +
    `<p>Routing rule:</p>` +
    `<p><label><input type="radio" name="routing_mode" value="catch_all" checked> ` +
    `<strong>Catch-all</strong> — every address on the zone reaches this worker</label><br>` +
    `<label><input type="radio" name="routing_mode" value="single_address"> ` +
    `<strong>One address only</strong>: <input type="text" inputmode="email" name="incoming_email_address" size="30" placeholder="mailbox@example-mail.com"></label></p>` +
    `<p><label>Alert destination address (optional) <input type="text" inputmode="email" name="alert_destination_email_address" size="40" placeholder="you@example.net"></label><br>` +
    `Registers the address in Email Routing so delivery-failure alerts can reach it — ` +
    `Cloudflare emails a verification link you must click. Needs the additional token scope ` +
    `<em>Account → Email Routing Addresses → Edit</em>.</p>` +
    `<p><button type="submit">Configure Email Routing</button></p>` +
    `</form>`
  );
}

function emailRoutingConfigurationResultHtml(result: EmailRoutingConfigurationResult): string {
  const stepItems = result.steps
    .map(
      (step) =>
        `<li>${step.ok ? '✅' : '❌'} <strong>${escapeHtml(step.title)}</strong> — ${escapeHtml(step.detail)}</li>`,
    )
    .join('');

  return (
    `<h1>${result.ok ? 'Email Routing configured' : 'Email Routing configuration failed'}</h1>` +
    `<ul>${stepItems}</ul>` +
    (result.ok
      ? `<p>Mail to the zone now reaches this worker. The API token was not stored — you can delete it from Cloudflare.</p>`
      : `<p>Fix the failing step and try again (the API token must be pasted again — it is never stored).</p>`)
  );
}

/**
 * The form asking for the WordPress site URL, shown at the start of setup.
 */
function siteUrlFormHtml(
  setupToken: string,
  currentSiteUrl: URL | null,
  errorMessage: string | null = null,
): string {
  return (
    `<h1>WordPress site</h1>` +
    (errorMessage ? `<p><strong>${escapeHtml(errorMessage)}</strong></p>` : '') +
    `<p>Enter the URL of the WordPress site that will receive incoming email. ` +
    `You will be redirected there to authorize this worker.</p>` +
    `<form method="post" action="${SETUP_ROUTE_PATH}">` +
    `<input type="hidden" name="token" value="${escapeHtml(setupToken)}">` +
    // type="text", not type="url": browsers reject a bare domain ("example.org")
    // in url inputs client-side, but the server adds https:// automatically.
    `<p><label>Site URL <input type="text" inputmode="url" name="site_url" size="40" placeholder="example.org" value="${currentSiteUrl ? escapeHtml(currentSiteUrl.toString()) : ''}" required></label></p>` +
    `<p><button type="submit">Continue to WordPress authorization</button></p>` +
    `</form>`
  );
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

/**
 * Cloudflare will only deliver to registered, verified destination
 * addresses; explain that wherever an alert recipient is shown or entered.
 */
function emailRoutingVerificationNoteHtml(): string {
  return (
    `<p>Cloudflare only delivers to addresses registered in <strong>Email Routing</strong>: ` +
    `the Cloudflare Email Routing section on the <a href="${SETUP_ROUTE_PATH}">setup page</a> ` +
    `can register the address for you (or add it in the dashboard under the receiving zone → ` +
    `<strong>Email Routing</strong> → <strong>Destination addresses</strong>) — then click the ` +
    `link in the verification email Cloudflare sends. Until the address is verified, sending ` +
    `fails.</p>`
  );
}

/**
 * A one-button form that sends a test email to the stored alert addresses.
 */
function sendTestAlertEmailButtonHtml(setupToken: string): string {
  return (
    `<form method="post" action="${SETUP_CALLBACK_ROUTE_PATH}">` +
    `<input type="hidden" name="token" value="${escapeHtml(setupToken)}">` +
    `<input type="hidden" name="send_test_alert_email" value="1">` +
    `<p><button type="submit">Send test email</button></p>` +
    `</form>`
  );
}

/**
 * The form asking where to send delivery-failure alerts, shown after the
 * destination endpoint is chosen. Both fields blank disables alerting.
 */
function alertAddressesFormHtml(
  setupToken: string,
  currentAddresses: AlertEmailAddresses | null,
  suggestedRecipientEmailAddress: string | null,
  errorMessage: string | null = null,
): string {
  const recipientValue =
    currentAddresses?.recipientEmailAddress ?? suggestedRecipientEmailAddress ?? '';
  const fromValue = currentAddresses?.fromEmailAddress ?? '';

  return (
    `<h2>Delivery-failure alerts</h2>` +
    (errorMessage ? `<p><strong>${escapeHtml(errorMessage)}</strong></p>` : '') +
    `<p>When delivery to WordPress is failing, the worker can email you — at most once per ` +
    `day, sent through Cloudflare Email Routing so it works even when the site is down.</p>` +
    `<form method="post" action="${SETUP_CALLBACK_ROUTE_PATH}">` +
    `<input type="hidden" name="token" value="${escapeHtml(setupToken)}">` +
    `<p><label>Send alerts to <input type="text" inputmode="email" name="alert_recipient_email_address" size="40" placeholder="you@example.net" value="${escapeHtml(recipientValue)}"></label></p>` +
    emailRoutingVerificationNoteHtml() +
    `<p><label>Send alerts from <input type="text" inputmode="email" name="alert_from_email_address" size="40" placeholder="worker@your-email-zone.example" value="${escapeHtml(fromValue)}"></label><br>` +
    `An address on the worker's Email Routing zone (the domain that receives the mail).</p>` +
    `<p><button type="submit">Save alert settings</button> — or leave both blank and save to disable alerts.</p>` +
    `</form>` +
    (currentAddresses ? sendTestAlertEmailButtonHtml(setupToken) : '')
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
 * Suggest the WordPress administrator's email address as the alert
 * recipient, now that setup holds an application password.
 *
 * `/wp/v2/settings` exposes the site admin email but requires
 * `manage_options`; `/wp/v2/users/me?context=edit` returns the authorizing
 * user's own email for any authenticated user. Best effort — null on any
 * failure.
 */
async function fetchSuggestedAlertRecipientEmailAddress(
  targetWordPressSiteUrl: URL,
  workerConfigurationKv: KVNamespace,
  fetchFunction: typeof fetch,
): Promise<string | null> {
  try {
    const credential = await getWordPressApplicationPasswordCredential(workerConfigurationKv);
    const authorizationHeaderValue = buildBasicAuthorizationHeaderValue(credential);
    const siteUrlWithTrailingSlash = targetWordPressSiteUrl.toString().endsWith('/')
      ? targetWordPressSiteUrl.toString()
      : `${targetWordPressSiteUrl.toString()}/`;

    for (const restPath of ['wp-json/wp/v2/settings', 'wp-json/wp/v2/users/me?context=edit']) {
      const response = await fetchFunction(new URL(restPath, siteUrlWithTrailingSlash).toString(), {
        headers: { authorization: authorizationHeaderValue },
      });
      if (!response.ok) {
        continue;
      }
      const responseJson: unknown = await response.json();
      if (responseJson !== null && typeof responseJson === 'object' && 'email' in responseJson) {
        const { email } = responseJson;
        if (typeof email === 'string' && email !== '') {
          return email;
        }
      }
    }
  } catch {
    // Best effort only.
  }
  return null;
}

/**
 * The page shown once the destination endpoint is stored: confirmation plus
 * the alert-addresses form.
 */
async function endpointSelectedResponse(
  endpoint: EmailIngressEndpoint,
  configuration: WorkerConfiguration,
  setupToken: string,
  targetWordPressSiteUrl: URL,
  fetchFunction: typeof fetch,
): Promise<Response> {
  const currentAlertAddresses = await getAlertEmailAddresses(configuration.workerConfigurationKv);
  const suggestedRecipientEmailAddress = currentAlertAddresses
    ? null
    : await fetchSuggestedAlertRecipientEmailAddress(
        targetWordPressSiteUrl,
        configuration.workerConfigurationKv,
        fetchFunction,
      );

  return htmlPageResponse(
    endpointSelectedConfirmationHtml(endpoint) +
      alertAddressesFormHtml(setupToken, currentAlertAddresses, suggestedRecipientEmailAddress) +
      emailRoutingConfigurationFormHtml(setupToken),
  );
}

/**
 * `GET /setup` shows the site URL form; submitting it (POST) stores the URL
 * and redirects the administrator to the WordPress application-password
 * authorization screen.
 */
export async function handleSetupRequest(
  request: Request,
  configuration: WorkerConfiguration,
  fetchFunction: typeof fetch = fetch,
): Promise<Response> {
  if (request.method === 'POST') {
    const formData = await request.formData();

    if (formData.has('new_setup_token')) {
      return handleSetupTokenCreation(formData, configuration);
    }

    const setupToken = formData.get('token');
    if (
      typeof setupToken !== 'string' ||
      !(await verifySetupToken(
        configuration.workerConfigurationKv,
        configuration.setupToken,
        setupToken,
      ))
    ) {
      return new Response('Forbidden: missing or incorrect setup token.', { status: 403 });
    }

    if (formData.has('cloudflare_api_token')) {
      return handleEmailRoutingConfigurationSubmission(formData, setupToken, fetchFunction);
    }

    return handleSiteUrlSubmission(
      formData,
      new URL(request.url).origin,
      configuration,
      setupToken,
    );
  }

  // First run: no secret and no claimed token — offer to create one.
  if (
    !(await isSetupTokenConfigured(configuration.workerConfigurationKv, configuration.setupToken))
  ) {
    return htmlPageResponse(setupTokenCreationFormHtml(generateSuggestedSetupToken()));
  }

  const requestUrl = new URL(request.url);
  const setupToken = requestUrl.searchParams.get('token');

  if (
    !setupToken ||
    !(await verifySetupToken(
      configuration.workerConfigurationKv,
      configuration.setupToken,
      setupToken,
    ))
  ) {
    return new Response('Forbidden: missing or incorrect setup token.', { status: 403 });
  }

  const currentSiteUrl = await getTargetWordPressSiteUrl(configuration.workerConfigurationKv);

  return htmlPageResponse(
    siteUrlFormHtml(setupToken, currentSiteUrl) + emailRoutingConfigurationFormHtml(setupToken),
  );
}

/**
 * Run the Email Routing configuration with the transient API token from the
 * form. The token exists only in this request's memory: it is not stored in
 * KV, not logged, and not included in the response.
 */
async function handleEmailRoutingConfigurationSubmission(
  formData: FormData,
  setupToken: string,
  fetchFunction: typeof fetch,
): Promise<Response> {
  const cloudflareApiToken = (formData.get('cloudflare_api_token') ?? '').trim();
  const zoneName = (formData.get('zone_name') ?? '').trim();
  const workerName = (formData.get('worker_name') ?? '').trim();
  const routingMode =
    formData.get('routing_mode') === 'single_address' ? 'single_address' : 'catch_all';
  const incomingEmailAddress = (formData.get('incoming_email_address') ?? '').trim();
  const alertDestinationEmailAddress = (
    formData.get('alert_destination_email_address') ?? ''
  ).trim();

  const validationError =
    cloudflareApiToken === '' || zoneName === '' || workerName === ''
      ? 'The API token, zone and worker name are required (the API token must be pasted again — it is never stored).'
      : routingMode === 'single_address' && incomingEmailAddress === ''
        ? 'Enter the incoming email address to route, or choose catch-all.'
        : null;

  if (validationError) {
    return htmlPageResponse(
      emailRoutingConfigurationFormHtml(
        setupToken,
        zoneName,
        workerName === '' ? DEFAULT_WORKER_NAME : workerName,
        validationError,
      ),
      400,
    );
  }

  const result = await configureEmailRouting(
    cloudflareApiToken,
    zoneName,
    workerName,
    {
      routingMode,
      incomingEmailAddress: incomingEmailAddress === '' ? null : incomingEmailAddress,
      alertDestinationEmailAddress:
        alertDestinationEmailAddress === '' ? null : alertDestinationEmailAddress,
    },
    fetchFunction,
  );

  return htmlPageResponse(
    emailRoutingConfigurationResultHtml(result) +
      (result.ok
        ? `<p><a href="${SETUP_ROUTE_PATH}?token=${encodeURIComponent(setupToken)}">Back to setup</a></p>`
        : emailRoutingConfigurationFormHtml(setupToken, zoneName, workerName)),
    result.ok ? 200 : 502,
  );
}

/**
 * Store the submitted site URL, then redirect to that site's authorization
 * screen.
 */
async function handleSiteUrlSubmission(
  formData: FormData,
  requestOrigin: string,
  configuration: WorkerConfiguration,
  setupToken: string,
): Promise<Response> {
  const rawSiteUrl = formData.get('site_url');

  if (typeof rawSiteUrl !== 'string' || rawSiteUrl === '') {
    return htmlPageResponse(
      siteUrlFormHtml(setupToken, null, 'Enter the WordPress site URL.'),
      400,
    );
  }

  let targetWordPressSiteUrl: URL;
  try {
    targetWordPressSiteUrl = parseTargetWordPressSiteUrl(rawSiteUrl);
  } catch (error) {
    const errorMessage =
      error instanceof InvalidTargetWordPressSiteUrlError
        ? error.message
        : 'The site URL is not valid.';
    return htmlPageResponse(siteUrlFormHtml(setupToken, null, errorMessage), 400);
  }

  await storeTargetWordPressSiteUrl(configuration.workerConfigurationKv, targetWordPressSiteUrl);

  const successUrl = new URL(SETUP_CALLBACK_ROUTE_PATH, requestOrigin);
  successUrl.searchParams.set('token', setupToken);

  const authorizationUrl = new URL('/wp-admin/authorize-application.php', targetWordPressSiteUrl);
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
  sendAlertEmailFunction?: SendAlertEmailFunction,
): Promise<Response> {
  if (request.method === 'POST') {
    const formData = await request.formData();

    const setupToken = formData.get('token');
    if (
      typeof setupToken !== 'string' ||
      !(await verifySetupToken(
        configuration.workerConfigurationKv,
        configuration.setupToken,
        setupToken,
      ))
    ) {
      return new Response('Forbidden: missing or incorrect setup token.', { status: 403 });
    }

    if (formData.has('endpoint_url')) {
      return handleEndpointSelectionSubmission(formData, configuration, setupToken, fetchFunction);
    }

    if (formData.has('send_test_alert_email')) {
      return handleTestAlertEmailSubmission(configuration, setupToken, sendAlertEmailFunction);
    }

    if (formData.has('alert_recipient_email_address') || formData.has('alert_from_email_address')) {
      return handleAlertAddressesSubmission(formData, configuration, setupToken);
    }

    return new Response('Bad request: unrecognised form submission.', { status: 400 });
  }

  const requestUrl = new URL(request.url);
  const setupToken = requestUrl.searchParams.get('token');

  if (
    !setupToken ||
    !(await verifySetupToken(
      configuration.workerConfigurationKv,
      configuration.setupToken,
      setupToken,
    ))
  ) {
    return new Response('Forbidden: missing or incorrect setup token.', { status: 403 });
  }

  const targetWordPressSiteUrl = await getTargetWordPressSiteUrl(
    configuration.workerConfigurationKv,
  );

  if (!targetWordPressSiteUrl) {
    return htmlPageResponse(
      `<h1>Setup has not started</h1>` +
        `<p>No WordPress site URL is stored. Start at the <a href="${SETUP_ROUTE_PATH}?token=${escapeHtml(setupToken)}">setup form</a>.</p>`,
      409,
    );
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

  if (siteUrlOrigin !== targetWordPressSiteUrl.origin) {
    return new Response('Bad request: site_url does not match the site URL entered during setup.', {
      status: 400,
    });
  }

  await storeWordPressApplicationPasswordCredential(configuration.workerConfigurationKv, {
    userLogin,
    applicationPassword,
  });

  // Credential stored; now choose the destination.
  let emailIngressEndpoints: EmailIngressEndpoint[];
  try {
    emailIngressEndpoints = await discoverEmailIngressEndpoints(
      targetWordPressSiteUrl,
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
    return endpointSelectedResponse(
      singleEndpoint,
      configuration,
      setupToken,
      targetWordPressSiteUrl,
      fetchFunction,
    );
  }

  return htmlPageResponse(endpointSelectionFormHtml(emailIngressEndpoints, setupToken));
}

/**
 * Store the endpoint the administrator chose on the selection form.
 *
 * The submitted URL is resolved against a fresh discovery, so only an
 * endpoint the site actually advertises can be selected (and the stored
 * entry carries the advertised metadata, e.g. the size limit).
 */
async function handleEndpointSelectionSubmission(
  formData: FormData,
  configuration: WorkerConfiguration,
  setupToken: string,
  fetchFunction: typeof fetch,
): Promise<Response> {
  const selectedEndpointUrl = formData.get('endpoint_url');

  if (typeof selectedEndpointUrl !== 'string' || selectedEndpointUrl === '') {
    return new Response('Bad request: expected an endpoint_url form field.', { status: 400 });
  }

  const targetWordPressSiteUrl = await getTargetWordPressSiteUrl(
    configuration.workerConfigurationKv,
  );

  if (!targetWordPressSiteUrl) {
    return htmlPageResponse(
      `<h1>Setup has not started</h1>` +
        `<p>No WordPress site URL is stored. Start at the <a href="${SETUP_ROUTE_PATH}?token=${escapeHtml(setupToken)}">setup form</a>.</p>`,
      409,
    );
  }

  let emailIngressEndpoints: EmailIngressEndpoint[];
  try {
    emailIngressEndpoints = await discoverEmailIngressEndpoints(
      targetWordPressSiteUrl,
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
        endpointSelectionFormHtml(emailIngressEndpoints, setupToken),
      409,
    );
  }

  await storeSelectedEmailIngressEndpoint(configuration.workerConfigurationKv, selectedEndpoint);

  return endpointSelectedResponse(
    selectedEndpoint,
    configuration,
    setupToken,
    targetWordPressSiteUrl,
    fetchFunction,
  );
}

const SIMPLE_EMAIL_ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Store (or clear, when both fields are blank) the delivery-failure alert
 * addresses entered on the setup UI.
 */
async function handleAlertAddressesSubmission(
  formData: FormData,
  configuration: WorkerConfiguration,
  setupToken: string,
): Promise<Response> {
  const recipientEmailAddress = (formData.get('alert_recipient_email_address') ?? '').trim();
  const fromEmailAddress = (formData.get('alert_from_email_address') ?? '').trim();

  if (recipientEmailAddress === '' && fromEmailAddress === '') {
    await deleteAlertEmailAddresses(configuration.workerConfigurationKv);
    return htmlPageResponse(
      `<h1>Alerts disabled</h1>` +
        `<p>No delivery-failure alert emails will be sent; failures are only logged. ` +
        `Re-run setup to enable alerts later.</p>` +
        `<p>You can close this window.</p>`,
    );
  }

  const invalidField =
    (SIMPLE_EMAIL_ADDRESS_PATTERN.test(recipientEmailAddress) ? null : 'Send alerts to') ??
    (SIMPLE_EMAIL_ADDRESS_PATTERN.test(fromEmailAddress) ? null : 'Send alerts from');

  if (invalidField) {
    return htmlPageResponse(
      alertAddressesFormHtml(
        setupToken,
        { fromEmailAddress, recipientEmailAddress },
        null,
        `"${invalidField}" must be an email address (or leave both fields blank to disable alerts).`,
      ),
      400,
    );
  }

  await storeAlertEmailAddresses(configuration.workerConfigurationKv, {
    fromEmailAddress,
    recipientEmailAddress,
  });

  return htmlPageResponse(
    `<h1>Alerts configured</h1>` +
      `<p>Delivery-failure alerts will be sent to <code>${escapeHtml(recipientEmailAddress)}</code> ` +
      `from <code>${escapeHtml(fromEmailAddress)}</code>, at most once per day.</p>` +
      emailRoutingVerificationNoteHtml() +
      sendTestAlertEmailButtonHtml(setupToken) +
      `<p>You can close this window.</p>`,
  );
}

/**
 * Send a test email to the stored alert addresses and report the outcome.
 *
 * Bypasses (and does not consume) the once-per-day alert rate limit, and
 * surfaces send errors — the most likely being an unverified destination
 * address — instead of swallowing them.
 */
async function handleTestAlertEmailSubmission(
  configuration: WorkerConfiguration,
  setupToken: string,
  sendAlertEmailFunction?: SendAlertEmailFunction,
): Promise<Response> {
  const alertEmailAddresses = await getAlertEmailAddresses(configuration.workerConfigurationKv);

  if (!alertEmailAddresses) {
    return htmlPageResponse(
      `<h1>No alert addresses configured</h1>` +
        `<p>Save alert addresses first, then send a test email.</p>`,
      409,
    );
  }

  if (!configuration.alertSendEmailBinding) {
    return htmlPageResponse(
      `<h1>Alerting binding missing</h1>` +
        `<p>The ALERT_EMAIL send_email binding is not deployed; redeploy the worker with the ` +
        `binding in wrangler.jsonc.</p>`,
      500,
    );
  }

  try {
    await sendTestAlertEmail(
      configuration.alertSendEmailBinding,
      alertEmailAddresses,
      sendAlertEmailFunction,
    );
  } catch (error) {
    return htmlPageResponse(
      `<h1>Test email failed</h1>` +
        `<p><code>${escapeHtml(error instanceof Error ? error.message : String(error))}</code></p>` +
        emailRoutingVerificationNoteHtml() +
        `<p>Also check the sender address is on the worker's Email Routing zone.</p>` +
        sendTestAlertEmailButtonHtml(setupToken),
      502,
    );
  }

  return htmlPageResponse(
    `<h1>Test email sent</h1>` +
      `<p>Sent to <code>${escapeHtml(alertEmailAddresses.recipientEmailAddress)}</code> from ` +
      `<code>${escapeHtml(alertEmailAddresses.fromEmailAddress)}</code> — check the inbox ` +
      `(and spam folder).</p>` +
      `<p>If it does not arrive:</p>` +
      emailRoutingVerificationNoteHtml() +
      sendTestAlertEmailButtonHtml(setupToken) +
      `<p>You can close this window.</p>`,
  );
}
