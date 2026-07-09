import { describe, expect, it } from 'vitest';

import workerEntrypoint from '../src/index';

describe('worker entrypoint scaffold', () => {
  it('exports a default handler object', () => {
    expect(workerEntrypoint).toBeTypeOf('object');
  });
});
