import { describe, expect, it } from 'vitest';

import {
  buildBasicAuthorizationHeaderValue,
  getWordPressApplicationPasswordCredential,
  MissingCredentialError,
  storeWordPressApplicationPasswordCredential,
} from '../src/wordpress-application-password';
import { FakeKvNamespace } from './fakes/fake-kv-namespace';

describe('application password credential storage', () => {
  it('round-trips a credential through KV', async () => {
    const fakeKvNamespace = new FakeKvNamespace();

    await storeWordPressApplicationPasswordCredential(fakeKvNamespace.asKvNamespace(), {
      userLogin: 'email-ingress-user',
      applicationPassword: 'abcd efgh ijkl mnop qrst uvwx',
    });

    const credential = await getWordPressApplicationPasswordCredential(
      fakeKvNamespace.asKvNamespace(),
    );

    expect(credential.userLogin).toBe('email-ingress-user');
    expect(credential.applicationPassword).toBe('abcd efgh ijkl mnop qrst uvwx');
  });

  it('throws MissingCredentialError when nothing is stored', async () => {
    const fakeKvNamespace = new FakeKvNamespace();

    await expect(
      getWordPressApplicationPasswordCredential(fakeKvNamespace.asKvNamespace()),
    ).rejects.toThrow(MissingCredentialError);
  });
});

describe('buildBasicAuthorizationHeaderValue', () => {
  it('builds an RFC 7617 Basic header', () => {
    const headerValue = buildBasicAuthorizationHeaderValue({
      userLogin: 'user',
      applicationPassword: 'pass word',
    });

    expect(headerValue).toBe(`Basic ${btoa('user:pass word')}`);
  });
});
