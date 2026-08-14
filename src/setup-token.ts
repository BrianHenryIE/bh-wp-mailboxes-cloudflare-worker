/**
 * The setup token gating the `/setup` routes.
 *
 * Two sources, in precedence order:
 *
 * 1. The `SETUP_TOKEN` secret (optional): when set with
 *    `wrangler secret put SETUP_TOKEN`, it is authoritative and the web UI
 *    never offers to create a token.
 * 2. KV, chosen on the web UI: on the first visit to `/setup` after deploy,
 *    the administrator is asked to create a token (trust on first use). Only
 *    its SHA-256 hash is stored; presented tokens are hashed and compared.
 *
 * Trust on first use means whoever reaches `/setup` first claims the worker —
 * deploy and claim promptly, or pre-set the secret. To reset a KV token,
 * delete the `setup_token_sha256` KV entry (or set the secret).
 */

const SETUP_TOKEN_HASH_KV_KEY = 'setup_token_sha256';

export const MINIMUM_SETUP_TOKEN_LENGTH = 16;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * A random 64-hex-character token to suggest on the creation form.
 */
export function generateSuggestedSetupToken(): string {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  return [...randomBytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Whether a setup token exists at all — the secret, or a claimed KV token.
 */
export async function isSetupTokenConfigured(
  workerConfigurationKv: KVNamespace,
  environmentSetupToken: string | null,
): Promise<boolean> {
  if (environmentSetupToken) {
    return true;
  }
  return (await workerConfigurationKv.get(SETUP_TOKEN_HASH_KV_KEY)) !== null;
}

/**
 * Store the hash of a token chosen on the web UI.
 */
export async function storeSetupToken(
  workerConfigurationKv: KVNamespace,
  setupToken: string,
): Promise<void> {
  await workerConfigurationKv.put(SETUP_TOKEN_HASH_KV_KEY, await sha256Hex(setupToken));
}

/**
 * Verify a presented token against the secret (authoritative when set) or
 * the stored KV hash. False when no token is configured at all.
 */
export async function verifySetupToken(
  workerConfigurationKv: KVNamespace,
  environmentSetupToken: string | null,
  presentedSetupToken: string | null,
): Promise<boolean> {
  if (!presentedSetupToken) {
    return false;
  }

  if (environmentSetupToken) {
    return presentedSetupToken === environmentSetupToken;
  }

  const storedSetupTokenHash = await workerConfigurationKv.get(SETUP_TOKEN_HASH_KV_KEY);
  if (!storedSetupTokenHash) {
    return false;
  }

  return (await sha256Hex(presentedSetupToken)) === storedSetupTokenHash;
}
