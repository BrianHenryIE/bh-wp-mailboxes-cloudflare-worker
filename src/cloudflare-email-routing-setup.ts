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

export interface EmailRoutingConfigurationOptions {
  /** Route every address on the zone (catch-all) or only one specific address. */
  routingMode: 'catch_all' | 'single_address';
  /** The address to route when routingMode is 'single_address'. */
  incomingEmailAddress: string | null;
  /**
   * Optionally register this address as an Email Routing destination address
   * (required before alert emails can be delivered to it). Cloudflare sends
   * a verification email; the recipient must click its link.
   */
  alertDestinationEmailAddress: string | null;
}

function extractZoneAccountId(zone: unknown): string | null {
  if (zone !== null && typeof zone === 'object' && 'account' in zone) {
    const account = zone.account;
    if (account !== null && typeof account === 'object' && 'id' in account) {
      return String(account.id);
    }
  }
  return null;
}

/**
 * Find an existing routing rule whose matcher is a literal "to" match for
 * the given address.
 */
function findExistingLiteralRule(rulesResult: unknown, incomingEmailAddress: string): boolean {
  if (!Array.isArray(rulesResult)) {
    return false;
  }
  return rulesResult.some((rule) => {
    if (rule === null || typeof rule !== 'object' || !('matchers' in rule)) {
      return false;
    }
    const matchers = (rule as { matchers: unknown }).matchers;
    return (
      Array.isArray(matchers) &&
      matchers.some(
        (matcher: unknown) =>
          matcher !== null &&
          typeof matcher === 'object' &&
          (matcher as { type?: unknown }).type === 'literal' &&
          (matcher as { field?: unknown }).field === 'to' &&
          (matcher as { value?: unknown }).value === incomingEmailAddress,
      )
    );
  });
}

/**
 * Enable Email Routing on the zone and route mail to this worker — the
 * catch-all rule, or a rule for one specific address. Optionally register
 * the alert destination address. Idempotent: safe to run again.
 */
export async function configureEmailRouting(
  cloudflareApiToken: string,
  zoneName: string,
  workerName: string,
  options: EmailRoutingConfigurationOptions = {
    routingMode: 'catch_all',
    incomingEmailAddress: null,
    alertDestinationEmailAddress: null,
  },
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

  const accountId = extractZoneAccountId(zones[0]);

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

  // 3. Route mail to this worker: the catch-all rule, or one specific address.
  if (options.routingMode === 'single_address' && options.incomingEmailAddress) {
    const incomingEmailAddress = options.incomingEmailAddress;
    const stepTitle = `Route ${incomingEmailAddress} → worker "${workerName}"`;

    const existingRules = await cloudflareApiRequest(
      cloudflareApiToken,
      'GET',
      `/zones/${zoneId}/email/routing/rules?per_page=50`,
      undefined,
      fetchFunction,
    );

    if (existingRules.ok && findExistingLiteralRule(existingRules.result, incomingEmailAddress)) {
      steps.push({
        title: stepTitle,
        ok: true,
        detail: 'A routing rule for this address already exists.',
      });
    } else {
      const createRule = await cloudflareApiRequest(
        cloudflareApiToken,
        'POST',
        `/zones/${zoneId}/email/routing/rules`,
        {
          name: `Send ${incomingEmailAddress} to the ${workerName} worker`,
          enabled: true,
          matchers: [{ type: 'literal', field: 'to', value: incomingEmailAddress }],
          actions: [{ type: 'worker', value: [workerName] }],
        },
        fetchFunction,
      );
      steps.push({
        title: stepTitle,
        ok: createRule.ok,
        detail: createRule.ok
          ? `Email to ${incomingEmailAddress} is now routed to the worker.`
          : createRule.errorDetail,
      });
      if (!createRule.ok) {
        return { ok: false, steps };
      }
    }
  } else {
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

  // 5. Optionally register the alert destination address (account-level).
  if (options.alertDestinationEmailAddress) {
    const alertDestinationEmailAddress = options.alertDestinationEmailAddress;
    const stepTitle = `Register alert destination address ${alertDestinationEmailAddress}`;

    if (!accountId) {
      steps.push({
        title: stepTitle,
        ok: false,
        detail:
          'Could not determine the Cloudflare account id from the zone; add the address in the dashboard instead.',
      });
    } else {
      const existingAddresses = await cloudflareApiRequest(
        cloudflareApiToken,
        'GET',
        `/accounts/${accountId}/email/routing/addresses?per_page=50`,
        undefined,
        fetchFunction,
      );

      const addressList: unknown[] = Array.isArray(existingAddresses.result)
        ? existingAddresses.result
        : [];
      const existingAddress = addressList.find(
        (address) =>
          address !== null &&
          typeof address === 'object' &&
          (address as { email?: unknown }).email === alertDestinationEmailAddress,
      );

      if (existingAddress) {
        const isVerified =
          typeof existingAddress === 'object' &&
          'verified' in existingAddress &&
          Boolean(existingAddress.verified);
        steps.push({
          title: stepTitle,
          ok: true,
          detail: isVerified
            ? 'Already registered and verified — alerts can be delivered.'
            : 'Already registered but NOT yet verified — click the link in the verification email Cloudflare sent (alerts fail until then).',
        });
      } else {
        const createAddress = await cloudflareApiRequest(
          cloudflareApiToken,
          'POST',
          `/accounts/${accountId}/email/routing/addresses`,
          { email: alertDestinationEmailAddress },
          fetchFunction,
        );
        steps.push({
          title: stepTitle,
          ok: createAddress.ok,
          detail: createAddress.ok
            ? `Registered — Cloudflare sent a verification email to ${alertDestinationEmailAddress}; click its link or alert delivery will fail. (Requires the token scope Account → Email Routing Addresses → Edit.)`
            : createAddress.errorDetail,
        });
      }
    }
  }

  return { ok: steps.every((step) => step.ok), steps };
}
