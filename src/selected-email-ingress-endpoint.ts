/**
 * KV storage of the ingress endpoint this worker delivers to.
 *
 * A site may advertise several ingress endpoints (one per mailbox/library
 * instance) in its REST index; the administrator selects exactly one during
 * the setup flow (auto-selected when only one is advertised). The worker
 * delivers to that endpoint and nowhere else — if it stops accepting,
 * delivery fails loudly (and alerts) rather than re-routing to a different
 * mailbox.
 */

import type { EmailIngressEndpoint } from './wordpress-rest-api-discovery';

const SELECTED_EMAIL_INGRESS_ENDPOINT_KV_KEY = 'selected_email_ingress_endpoint';

export class MissingSelectedEndpointError extends Error {
  override readonly name = 'MissingSelectedEndpointError';

  constructor() {
    super(
      'No ingress endpoint has been selected. Visit the worker /setup route to authorize and choose a destination.',
    );
  }
}

export async function storeSelectedEmailIngressEndpoint(
  workerConfigurationKv: KVNamespace,
  emailIngressEndpoint: EmailIngressEndpoint,
): Promise<void> {
  await workerConfigurationKv.put(
    SELECTED_EMAIL_INGRESS_ENDPOINT_KV_KEY,
    JSON.stringify(emailIngressEndpoint),
  );
}

/**
 * The endpoint selected during setup, or null when setup has not completed.
 */
export async function getSelectedEmailIngressEndpoint(
  workerConfigurationKv: KVNamespace,
): Promise<EmailIngressEndpoint | null> {
  const selectedEndpointJson = await workerConfigurationKv.get(
    SELECTED_EMAIL_INGRESS_ENDPOINT_KV_KEY,
  );

  if (!selectedEndpointJson) {
    return null;
  }

  try {
    return JSON.parse(selectedEndpointJson) as EmailIngressEndpoint;
  } catch {
    return null;
  }
}
