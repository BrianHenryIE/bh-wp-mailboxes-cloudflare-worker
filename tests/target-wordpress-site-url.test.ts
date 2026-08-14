import { describe, expect, it } from 'vitest';

import {
  getTargetWordPressSiteUrl,
  InvalidTargetWordPressSiteUrlError,
  parseTargetWordPressSiteUrl,
  storeTargetWordPressSiteUrl,
} from '../src/target-wordpress-site-url';
import { FakeKvNamespace } from './fakes/fake-kv-namespace';

describe('parseTargetWordPressSiteUrl', () => {
  it('parses a valid https URL', () => {
    expect(parseTargetWordPressSiteUrl('https://sacramentogaa.org').hostname).toBe(
      'sacramentogaa.org',
    );
  });

  it('throws when the value is not a URL', () => {
    expect(() => parseTargetWordPressSiteUrl('not-a-url')).toThrow(
      InvalidTargetWordPressSiteUrlError,
    );
  });

  it('rejects plain http for non-local hosts', () => {
    expect(() => parseTargetWordPressSiteUrl('http://sacramentogaa.org')).toThrow(/https/);
  });

  it('allows plain http for localhost during local development', () => {
    expect(parseTargetWordPressSiteUrl('http://localhost:8888').port).toBe('8888');
  });
});

describe('storeTargetWordPressSiteUrl / getTargetWordPressSiteUrl', () => {
  it('round-trips the stored URL', async () => {
    const fakeKvNamespace = new FakeKvNamespace();

    await storeTargetWordPressSiteUrl(
      fakeKvNamespace.asKvNamespace(),
      new URL('https://sacramentogaa.org'),
    );

    const storedUrl = await getTargetWordPressSiteUrl(fakeKvNamespace.asKvNamespace());
    expect(storedUrl?.origin).toBe('https://sacramentogaa.org');
  });

  it('returns null when setup has not started', async () => {
    expect(await getTargetWordPressSiteUrl(new FakeKvNamespace().asKvNamespace())).toBeNull();
  });

  it('returns null for a corrupt stored value', async () => {
    const fakeKvNamespace = new FakeKvNamespace();
    await fakeKvNamespace.put('target_wordpress_site_url', 'not-a-url');

    expect(await getTargetWordPressSiteUrl(fakeKvNamespace.asKvNamespace())).toBeNull();
  });
});
