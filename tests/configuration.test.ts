import { describe, expect, it } from 'vitest';

import {
  assertRecipientDomainMatchesTargetWordPressSite,
  getEmailAddressDomain,
  parseWorkerConfiguration,
  RecipientDomainMismatchError,
  WorkerConfigurationError,
  type WorkerEnvironment,
} from '../src/configuration';

const fakeKvNamespace = {} as KVNamespace;

function makeWorkerEnvironment(overrides: Partial<WorkerEnvironment> = {}): WorkerEnvironment {
  return {
    TARGET_WORDPRESS_SITE_URL: 'https://sacramentogaa.org',
    SETUP_TOKEN: 'a-setup-token',
    WORKER_CONFIGURATION_KV: fakeKvNamespace,
    ...overrides,
  };
}

describe('parseWorkerConfiguration', () => {
  it('parses a valid environment', () => {
    const workerConfiguration = parseWorkerConfiguration(makeWorkerEnvironment());

    expect(workerConfiguration.targetWordPressSiteUrl.hostname).toBe('sacramentogaa.org');
    expect(workerConfiguration.setupToken).toBe('a-setup-token');
    expect(workerConfiguration.workerConfigurationKv).toBe(fakeKvNamespace);
  });

  it('throws when TARGET_WORDPRESS_SITE_URL is missing', () => {
    expect(() =>
      parseWorkerConfiguration(makeWorkerEnvironment({ TARGET_WORDPRESS_SITE_URL: '' })),
    ).toThrow(WorkerConfigurationError);
  });

  it('throws when TARGET_WORDPRESS_SITE_URL is not a URL', () => {
    expect(() =>
      parseWorkerConfiguration(
        makeWorkerEnvironment({ TARGET_WORDPRESS_SITE_URL: 'not a url at all' }),
      ),
    ).toThrow(/not a valid URL/);
  });

  it('rejects plain http for non-local hosts', () => {
    expect(() =>
      parseWorkerConfiguration(
        makeWorkerEnvironment({ TARGET_WORDPRESS_SITE_URL: 'http://sacramentogaa.org' }),
      ),
    ).toThrow(/https/);
  });

  it('allows plain http for localhost during local development', () => {
    const workerConfiguration = parseWorkerConfiguration(
      makeWorkerEnvironment({ TARGET_WORDPRESS_SITE_URL: 'http://localhost:8888' }),
    );

    expect(workerConfiguration.targetWordPressSiteUrl.port).toBe('8888');
  });

  it('throws when SETUP_TOKEN is missing', () => {
    expect(() => parseWorkerConfiguration(makeWorkerEnvironment({ SETUP_TOKEN: '' }))).toThrow(
      /SETUP_TOKEN/,
    );
  });
});

describe('getEmailAddressDomain', () => {
  it('extracts the domain part', () => {
    expect(getEmailAddressDomain('someone@p.sacramentogaa.org')).toBe('p.sacramentogaa.org');
  });

  it('lower-cases the domain', () => {
    expect(getEmailAddressDomain('someone@P.SacramentoGAA.ORG')).toBe('p.sacramentogaa.org');
  });

  it('uses the last @ (quoted local parts can contain @)', () => {
    expect(getEmailAddressDomain('"odd@local"@example.org')).toBe('example.org');
  });

  it('throws when there is no domain part', () => {
    expect(() => getEmailAddressDomain('not-an-email')).toThrow(RecipientDomainMismatchError);
  });
});

describe('assertRecipientDomainMatchesTargetWordPressSite', () => {
  it('accepts a recipient subdomain of the target site', () => {
    expect(() => {
      assertRecipientDomainMatchesTargetWordPressSite(
        'mailbox@p.sacramentogaa.org',
        new URL('https://sacramentogaa.org'),
      );
    }).not.toThrow();
  });

  it('accepts the exact same domain', () => {
    expect(() => {
      assertRecipientDomainMatchesTargetWordPressSite(
        'mailbox@sacramentogaa.org',
        new URL('https://sacramentogaa.org'),
      );
    }).not.toThrow();
  });

  it('accepts a www target for a bare recipient domain', () => {
    expect(() => {
      assertRecipientDomainMatchesTargetWordPressSite(
        'mailbox@sacramentogaa.org',
        new URL('https://www.sacramentogaa.org'),
      );
    }).not.toThrow();
  });

  it('handles multi-part public suffixes (.org.uk)', () => {
    expect(() => {
      assertRecipientDomainMatchesTargetWordPressSite(
        'mailbox@mail.example.org.uk',
        new URL('https://example.org.uk'),
      );
    }).not.toThrow();

    // Same suffix, different registrable domain — must be rejected.
    expect(() => {
      assertRecipientDomainMatchesTargetWordPressSite(
        'mailbox@other.org.uk',
        new URL('https://example.org.uk'),
      );
    }).toThrow(RecipientDomainMismatchError);
  });

  it('rejects an unrelated domain', () => {
    expect(() => {
      assertRecipientDomainMatchesTargetWordPressSite(
        'mailbox@attacker.example',
        new URL('https://sacramentogaa.org'),
      );
    }).toThrow(RecipientDomainMismatchError);
  });

  it('rejects a lookalike sibling domain sharing only the TLD', () => {
    expect(() => {
      assertRecipientDomainMatchesTargetWordPressSite(
        'mailbox@sacramentogaa.org.evil.org',
        new URL('https://sacramentogaa.org'),
      );
    }).toThrow(RecipientDomainMismatchError);
  });

  it('allows any recipient when the target is localhost (local development)', () => {
    expect(() => {
      assertRecipientDomainMatchesTargetWordPressSite(
        'mailbox@p.sacramentogaa.org',
        new URL('http://localhost:8888'),
      );
    }).not.toThrow();
  });
});
