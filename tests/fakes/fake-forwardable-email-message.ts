import { vi } from 'vitest';

export interface FakeForwardableEmailMessage {
  message: ForwardableEmailMessage;
  setRejectMock: ReturnType<typeof vi.fn>;
}

/**
 * Build a fake ForwardableEmailMessage from raw RFC 5322 bytes.
 */
export function makeFakeForwardableEmailMessage(
  rawEmailBytes: Uint8Array,
  {
    envelopeFrom = 'sender@example.com',
    envelopeTo = 'mailbox@p.sacramentogaa.org',
  }: { envelopeFrom?: string; envelopeTo?: string } = {},
): FakeForwardableEmailMessage {
  const setRejectMock = vi.fn();

  const message = {
    from: envelopeFrom,
    to: envelopeTo,
    headers: new Headers(),
    raw: new Response(rawEmailBytes).body as ReadableStream<Uint8Array>,
    rawSize: rawEmailBytes.byteLength,
    setReject: setRejectMock as (reason: string) => void,
    forward: vi.fn(),
    reply: vi.fn(),
  } as unknown as ForwardableEmailMessage;

  return { message, setRejectMock };
}
