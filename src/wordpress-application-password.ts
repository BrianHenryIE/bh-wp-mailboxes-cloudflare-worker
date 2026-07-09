/**
 * Storage and use of the WordPress application-password credential.
 *
 * The credential is obtained via the core WordPress authorization flow
 * (see setup-routes.ts) and stored in KV. It is sent as HTTP Basic auth
 * when delivering email to the WordPress REST API.
 *
 * The application password must never be logged.
 */

export interface WordPressApplicationPasswordCredential {
  userLogin: string;
  applicationPassword: string;
}

export class MissingCredentialError extends Error {
  override readonly name = 'MissingCredentialError';
}

const APPLICATION_PASSWORD_CREDENTIAL_KV_KEY = 'wordpress_application_password_credential';

export async function storeWordPressApplicationPasswordCredential(
  workerConfigurationKv: KVNamespace,
  credential: WordPressApplicationPasswordCredential,
): Promise<void> {
  await workerConfigurationKv.put(
    APPLICATION_PASSWORD_CREDENTIAL_KV_KEY,
    JSON.stringify(credential),
  );
}

export async function getWordPressApplicationPasswordCredential(
  workerConfigurationKv: KVNamespace,
): Promise<WordPressApplicationPasswordCredential> {
  const credentialJson = await workerConfigurationKv.get(APPLICATION_PASSWORD_CREDENTIAL_KV_KEY);

  if (!credentialJson) {
    throw new MissingCredentialError(
      'No WordPress application-password credential is stored. Visit the worker /setup route to authorize.',
    );
  }

  return JSON.parse(credentialJson) as WordPressApplicationPasswordCredential;
}

export function buildBasicAuthorizationHeaderValue(
  credential: WordPressApplicationPasswordCredential,
): string {
  return `Basic ${btoa(`${credential.userLogin}:${credential.applicationPassword}`)}`;
}
