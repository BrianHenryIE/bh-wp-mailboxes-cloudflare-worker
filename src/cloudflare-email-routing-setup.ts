/**
 * Configure Cloudflare Email Routing for the receiving zone from the setup
 * UI: enable Email Routing (adds/locks the MX + SPF records) and point the
 * zone's catch-all rule at this worker.
 *
 * The Cloudflare API token is TRANSIENT: it arrives with the form
 * submission, is held in request memory for these API calls, and is never
 * written to KV, never logged, and never echoed back in a response. The
 * browser cannot call api.cloudflare.com itself (no CORS), which is the only
 * reason the token passes through the worker at all.
 *
 * Suggested token scopes (zone-scoped to the receiving zone):
 * Zone → Zone → Read; Zone → DNS → Edit; Zone → Email Routing Rules → Edit.
 */

const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';

export interface EmailRoutingConfigurationStep {
  title: string;
  ok: boolean;
  detail: string;
}

export interface EmailRoutingConfigurationResult {
  ok: boolean;
  steps: EmailRoutingConfigurationStep[];
}

interface CloudflareApiEnvelope {
  success?: unknown;
  errors?: unknown;
  result?: unknown;
}

interface CloudflareApiCallResult {
  ok: boolean;
  /** Joined error messages when ok is false. */
  errorDetail: string;
  result: unknown;
}

function joinCloudflareErrors(errors: unknown): string {
  if (!Array.isArray(errors) || errors.length === 0) {
    return 'Unknown Cloudflare API error.';
  }
  return errors
    .map((error: unknown) =>
      error !== null && typeof error === 'object' && 'message' in error
        ? String(error.message)
        : JSON.stringify(error),
    )
    .join('; ');
}

async function cloudflareApiRequest(
  cloudflareApiToken: string,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  requestBody: unknown,
  fetchFunction: typeof fetch,
): Promise<CloudflareApiCallResult> {
  let response: Response;
  try {
    response = await fetchFunction(`${CLOUDFLARE_API_BASE_URL}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${cloudflareApiToken}`,
        'content-type': 'application/json',
      },
      ...(requestBody === undefined ? {} : { body: JSON.stringify(requestBody) }),
    });
  } catch (error) {
    return {
      ok: false,
      errorDetail: `Network error calling the Cloudflare API: ${error instanceof Error ? error.message : String(error)}`,
      result: undefined,
    };
  }

  let envelope: CloudflareApiEnvelope;
  try {
    envelope = await response.json();
  } catch {
    return {
      ok: false,
      errorDetail: `Cloudflare API returned HTTP ${String(response.status)} with a non-JSON body.`,
      result: undefined,
    };
  }

  if (envelope.success !== true) {
    return { ok: false, errorDetail: joinCloudflareErrors(envelope.errors), result: undefined };
  }

  return { ok: true, errorDetail: '', result: envelope.result };
}

function isEmailRoutingEnabled(result: unknown): boolean {
  return (
    result !== null && typeof result === 'object' && 'enabled' in result && result.enabled === true
  );
}

/**
 * Enable Email Routing on the zone and set its catch-all rule to send to
 * this worker. Idempotent: safe to run again.
 */
export async function configureEmailRouting(
  cloudflareApiToken: string,
  zoneName: string,
  workerName: string,
  fetchFunction: typeof fetch = fetch,
): Promise<EmailRoutingConfigurationResult> {
  const steps: EmailRoutingConfigurationStep[] = [];

  // 1. Resolve the zone id from its name.
  const zoneLookup = await cloudflareApiRequest(
    cloudflareApiToken,
    'GET',
    `/zones?name=${encodeURIComponent(zoneName)}`,
    undefined,
    fetchFunction,
  );

  const zones = Array.isArray(zoneLookup.result) ? zoneLookup.result : [];
  const zoneId =
    zones[0] !== null && typeof zones[0] === 'object' && 'id' in (zones[0] as object)
      ? String((zones[0] as { id: unknown }).id)
      : null;

  if (!zoneLookup.ok || !zoneId) {
    steps.push({
      title: `Find zone "${zoneName}"`,
      ok: false,
      detail: zoneLookup.ok
        ? 'Zone not found. Is the domain on this Cloudflare account, and is the API token scoped to it (Zone → Zone → Read)?'
        : zoneLookup.errorDetail,
    });
    return { ok: false, steps };
  }

  steps.push({ title: `Find zone "${zoneName}"`, ok: true, detail: `Zone id ${zoneId}.` });

  // 2. Enable Email Routing, unless it already is.
  const routingSettings = await cloudflareApiRequest(
    cloudflareApiToken,
    'GET',
    `/zones/${zoneId}/email/routing`,
    undefined,
    fetchFunction,
  );

  if (routingSettings.ok && isEmailRoutingEnabled(routingSettings.result)) {
    steps.push({ title: 'Enable Email Routing', ok: true, detail: 'Already enabled.' });
  } else {
    const enable = await cloudflareApiRequest(
      cloudflareApiToken,
      'POST',
      `/zones/${zoneId}/email/routing/enable`,
      {},
      fetchFunction,
    );
    steps.push({
      title: 'Enable Email Routing',
      ok: enable.ok,
      detail: enable.ok
        ? 'Enabled — the required MX and SPF DNS records were added and locked.'
        : enable.errorDetail,
    });
    if (!enable.ok) {
      return { ok: false, steps };
    }
  }

  // 3. Point the catch-all rule at this worker.
  const catchAll = await cloudflareApiRequest(
    cloudflareApiToken,
    'PUT',
    `/zones/${zoneId}/email/routing/rules/catch_all`,
    {
      name: `Send all mail to the ${workerName} worker`,
      enabled: true,
      matchers: [{ type: 'all' }],
      actions: [{ type: 'worker', value: [workerName] }],
    },
    fetchFunction,
  );
  steps.push({
    title: `Catch-all rule → worker "${workerName}"`,
    ok: catchAll.ok,
    detail: catchAll.ok
      ? 'Every email to the zone is now routed to the worker.'
      : catchAll.errorDetail,
  });
  if (!catchAll.ok) {
    return { ok: false, steps };
  }

  // 4. Verify.
  const verification = await cloudflareApiRequest(
    cloudflareApiToken,
    'GET',
    `/zones/${zoneId}/email/routing`,
    undefined,
    fetchFunction,
  );
  const verified = verification.ok && isEmailRoutingEnabled(verification.result);
  steps.push({
    title: 'Verify Email Routing is active',
    ok: verified,
    detail: verified
      ? 'Email Routing reports enabled.'
      : verification.ok
        ? 'Email Routing does not report enabled yet — DNS records may still be settling; check the Cloudflare dashboard.'
        : verification.errorDetail,
  });

  return { ok: steps.every((step) => step.ok), steps };
}
