import { describe, expect, it } from 'vitest';

import {
  generateSuggestedSetupToken,
  isSetupTokenConfigured,
  storeSetupToken,
  verifySetupToken,
} from '../src/setup-token';
import { FakeKvNamespace } from './fakes/fake-kv-namespace';

describe('generateSuggestedSetupToken', () => {
  it('generates a 64-character hex token', () => {
    expect(generateSuggestedSetupToken()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('generates a different token each time', () => {
    expect(generateSuggestedSetupToken()).not.toBe(generateSuggestedSetupToken());
  });
});

describe('isSetupTokenConfigured', () => {
  it('is false on a fresh deployment', async () => {
    expect(await isSetupTokenConfigured(new FakeKvNamespace().asKvNamespace(), null)).toBe(false);
  });

  it('is true when the SETUP_TOKEN secret is set', async () => {
    expect(
      await isSetupTokenConfigured(new FakeKvNamespace().asKvNamespace(), 'env-secret-token'),
    ).toBe(true);
  });

  it('is true once a token has been claimed via the web UI', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSetupToken(fakeKvNamespace.asKvNamespace(), 'chosen-on-the-web-ui');

    expect(await isSetupTokenConfigured(fakeKvNamespace.asKvNamespace(), null)).toBe(true);
  });
});

describe('verifySetupToken', () => {
  it('verifies a claimed KV token', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSetupToken(fakeKvNamespace.asKvNamespace(), 'chosen-on-the-web-ui');

    expect(
      await verifySetupToken(fakeKvNamespace.asKvNamespace(), null, 'chosen-on-the-web-ui'),
    ).toBe(true);
    expect(await verifySetupToken(fakeKvNamespace.asKvNamespace(), null, 'wrong-token')).toBe(
      false,
    );
  });

  it('stores only a hash, never the token itself', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSetupToken(fakeKvNamespace.asKvNamespace(), 'chosen-on-the-web-ui');

    const storedValue = await fakeKvNamespace.get('setup_token_sha256');
    expect(storedValue).toMatch(/^[0-9a-f]{64}$/);
    expect(storedValue).not.toContain('chosen-on-the-web-ui');
  });

  it('the SETUP_TOKEN secret is authoritative when set, ignoring any KV token', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await storeSetupToken(fakeKvNamespace.asKvNamespace(), 'kv-token');

    expect(
      await verifySetupToken(fakeKvNamespace.asKvNamespace(), 'env-secret', 'env-secret'),
    ).toBe(true);
    expect(await verifySetupToken(fakeKvNamespace.asKvNamespace(), 'env-secret', 'kv-token')).toBe(
      false,
    );
  });

  it('rejects everything when no token is configured', async () => {
    expect(await verifySetupToken(new FakeKvNamespace().asKvNamespace(), null, 'anything')).toBe(
      false,
    );
    expect(await verifySetupToken(new FakeKvNamespace().asKvNamespace(), null, null)).toBe(false);
  });
});
