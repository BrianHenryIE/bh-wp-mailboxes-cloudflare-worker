/**
 * Worker configuration parsing and validation.
 *
 * The worker refuses to run with an invalid configuration, and refuses to
 * deliver email whose recipient domain does not share a registrable domain
 * (eTLD+1) with the configured WordPress site. E.g. mail to
 * `anything@p.sacramentogaa.org` may only be delivered to
 * `https://sacramentogaa.org`.
 */

import { getDomain } from 'tldts';

export interface WorkerEnvironment {
  TARGET_WORDPRESS_SITE_URL: string;
  SETUP_TOKEN: string;
  WORKER_CONFIGURATION_KV: KVNamespace;
}

export interface WorkerConfiguration {
  targetWordPressSiteUrl: URL;
  setupToken: string;
  workerConfigurationKv: KVNamespace;
}

export class WorkerConfigurationError extends Error {
  override readonly name = 'WorkerConfigurationError';
}

export class RecipientDomainMismatchError extends Error {
  override readonly name = 'RecipientDomainMismatchError';
}

const LOCAL_DEVELOPMENT_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Validate the environment bindings and return a typed configuration object.
 *
 * @throws WorkerConfigurationError when a binding is missing or invalid.
 */
export function parseWorkerConfiguration(environment: WorkerEnvironment): WorkerConfiguration {
  const rawTargetWordPressSiteUrl = environment.TARGET_WORDPRESS_SITE_URL;

  if (!rawTargetWordPressSiteUrl) {
    throw new WorkerConfigurationError('TARGET_WORDPRESS_SITE_URL is not set.');
  }

  let targetWordPressSiteUrl: URL;
  try {
    targetWordPressSiteUrl = new URL(rawTargetWordPressSiteUrl);
  } catch {
    throw new WorkerConfigurationError(
      `TARGET_WORDPRESS_SITE_URL is not a valid URL: "${rawTargetWordPressSiteUrl}".`,
    );
  }

  const isLocalDevelopmentHostname = LOCAL_DEVELOPMENT_HOSTNAMES.includes(
    targetWordPressSiteUrl.hostname,
  );

  if (targetWordPressSiteUrl.protocol !== 'https:' && !isLocalDevelopmentHostname) {
    throw new WorkerConfigurationError(
      'TARGET_WORDPRESS_SITE_URL must use https (application passwords require it).',
    );
  }

  if (!environment.SETUP_TOKEN) {
    throw new WorkerConfigurationError('SETUP_TOKEN secret is not set.');
  }

  return {
    targetWordPressSiteUrl,
    setupToken: environment.SETUP_TOKEN,
    workerConfigurationKv: environment.WORKER_CONFIGURATION_KV,
  };
}

/**
 * Extract the domain part of an email address.
 *
 * @throws RecipientDomainMismatchError when the address has no domain part.
 */
export function getEmailAddressDomain(emailAddress: string): string {
  const atIndex = emailAddress.lastIndexOf('@');
  const domain = atIndex === -1 ? '' : emailAddress.slice(atIndex + 1).trim();

  if (!domain) {
    throw new RecipientDomainMismatchError(
      `Could not extract a domain from email address "${emailAddress}".`,
    );
  }

  return domain.toLowerCase();
}

/**
 * Assert the recipient's email domain and the target WordPress site share the
 * same registrable domain (eTLD+1). Multi-part public suffixes (`.org.uk`,
 * `.com.au`, …) are handled by tldts' public-suffix list.
 *
 * @throws RecipientDomainMismatchError on any mismatch.
 */
export function assertRecipientDomainMatchesTargetWordPressSite(
  recipientEmailAddress: string,
  targetWordPressSiteUrl: URL,
): void {
  const recipientDomain = getEmailAddressDomain(recipientEmailAddress);

  const recipientRegistrableDomain = getDomain(recipientDomain);
  const targetRegistrableDomain = getDomain(targetWordPressSiteUrl.hostname);

  // Local development: allow delivery to localhost regardless of recipient domain.
  if (LOCAL_DEVELOPMENT_HOSTNAMES.includes(targetWordPressSiteUrl.hostname)) {
    return;
  }

  if (!recipientRegistrableDomain || !targetRegistrableDomain) {
    throw new RecipientDomainMismatchError(
      `Could not determine a registrable domain for recipient "${recipientDomain}" or target "${targetWordPressSiteUrl.hostname}".`,
    );
  }

  if (recipientRegistrableDomain !== targetRegistrableDomain) {
    throw new RecipientDomainMismatchError(
      `Recipient domain "${recipientDomain}" (registrable domain "${recipientRegistrableDomain}") does not match target WordPress site "${targetWordPressSiteUrl.hostname}" (registrable domain "${targetRegistrableDomain}").`,
    );
  }
}
