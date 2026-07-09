# Cloudflare Email Worker — Implementation Plan

A Cloudflare Worker that receives email via Cloudflare Email Routing and delivers the raw
MIME message to a WordPress REST API endpoint provided by the bh-wp-mailboxes plugin.

## Decisions (from design discussion)

| Topic                      | Decision                                                                                                                                                                                                                    |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payload format             | Flat raw MIME (`Content-Type: message/rfc822`), streamed unmodified. WordPress parses with `zbateson/mail-mime-parser`. No parsing in the worker.                                                                           |
| Envelope data              | SMTP envelope passed as HTTP request headers: `X-Envelope-From`, `X-Envelope-To`, `X-Message-Raw-Size`.                                                                                                                     |
| Idempotency                | The email's `Message-ID` header is the idempotency key. WordPress upserts; sender retries and worker retries must not create duplicates.                                                                                    |
| Retry/durability           | Synchronous delivery only. On failure the `email()` handler throws, Cloudflare returns a transient SMTP error, and the sending mail server retries on its own schedule. No Queues, no R2.                                   |
| Endpoint discovery         | `Link: <…>; rel="https://api.w.org/"` header → `/wp-json/` index → custom `email_ingress_endpoints` key (added by the plugin via the `rest_index` filter). Namespace-agnostic. Cached in KV; re-discovered on HTTP 404/410. |
| Multiple ingress endpoints | v1 supports exactly one; more than one discovered endpoint is a configuration error. KV shape allows recipient-based mapping later.                                                                                         |
| Authentication             | WordPress application password, obtained via the core `/wp-admin/authorize-application.php` flow, initiated from the worker's `fetch()` handler and stored in KV. Sent as HTTP Basic auth.                                  |
| Domain constraint          | The recipient domain (`message.to`) and the configured WordPress site must share the same registrable domain (eTLD+1, via `tldts`). E.g. mail to `*@p.sacramentogaa.org` may only deliver to `sacramentogaa.org`.           |
| Language/tooling           | TypeScript (strict). ESLint (typescript-eslint, type-aware) + Prettier. Vitest for unit tests. Lint + typecheck + tests must pass before every commit.                                                                      |
| Naming                     | Verbose, unambiguous names throughout (e.g. `TARGET_WORDPRESS_SITE_URL`, `deliverRawEmailToWordPress`).                                                                                                                     |

## Ingress contract (worker ⇄ plugin)

The plugin advertises its endpoint in the REST index:

```json
{
  "email_ingress_endpoints": [
    {
      "version": 1,
      "namespace": "bh-wp-mailboxes/v1",
      "url": "https://example.org/wp-json/bh-wp-mailboxes/v1/incoming-email",
      "accepts": "message/rfc822",
      "max_message_size_bytes": 33554432
    }
  ]
}
```

The worker POSTs:

```
POST {url}
Authorization: Basic base64(user_login:application_password)
Content-Type: message/rfc822
X-Envelope-From: sender@example.com
X-Envelope-To: recipient@p.example.org
X-Message-Raw-Size: 12345

<raw RFC 5322 message bytes>
```

Success: HTTP 2xx. Any other response (or network error) causes the worker to throw so the
sending server retries. A 404/410 additionally invalidates the cached endpoint and triggers
one re-discovery + single retry within the same invocation.

## Worker bindings and configuration

| Name                        | Kind         | Purpose                                                            |
| --------------------------- | ------------ | ------------------------------------------------------------------ |
| `TARGET_WORDPRESS_SITE_URL` | env var      | Base URL of the WordPress site (e.g. `https://sacramentogaa.org`). |
| `SETUP_TOKEN`               | secret       | One-time token protecting the `/setup` route.                      |
| `WORKER_CONFIGURATION_KV`   | KV namespace | Stores discovered endpoint + application-password credential.      |

## Steps

Each step is one commit. Lint, typecheck, and unit tests run and pass before each commit.

1. **Plan** — this document.
2. **Scaffold** — `package.json`, strict `tsconfig.json`, `wrangler.jsonc`, ESLint + Prettier
   config, Vitest config, npm scripts (`lint`, `format`, `typecheck`, `test`, `check`),
   `.gitignore`.
3. **Config module** (`src/configuration.ts`) — parse/validate env; registrable-domain
   check between recipient domain and target site. Unit tests: valid/invalid URLs,
   multi-part TLDs (`.org.uk`), subdomain cases, mismatches.
4. **Discovery module** (`src/wordpress-rest-api-discovery.ts`) — Link-header follow, index
   fetch, `email_ingress_endpoints` parsing, KV cache, invalidation. Unit tests with mocked
   `fetch`: zero/one/multiple endpoints, malformed index, missing Link header, cache hit/miss.
5. **Credentials module** (`src/wordpress-application-password.ts` +
   `src/setup-routes.ts`) — Basic-auth header builder; `/setup` (token-gated redirect to
   `authorize-application.php` with `success_url`); `/callback` (validate + store
   `user_login`/`password` in KV, never logged). Unit tests: token gating, callback
   validation, storage round-trip.
6. **Delivery module** (`src/deliver-raw-email-to-wordpress.ts`) — stream raw MIME with
   envelope headers; size guard against `max_message_size_bytes`; 404 → re-discover →
   retry once; non-2xx → throw. Unit tests: success, non-2xx, 404-rediscovery path,
   oversize rejection, header correctness.
7. **Handlers** (`src/index.ts`) — `email()` composing steps 3–6; `fetch()` routing
   `/setup` + `/callback`. Tests drive the exported handlers with fake
   `ForwardableEmailMessage` and `.eml` fixtures in `tests/fixtures/`.
8. **Docs, scripts, CI** — `README.md` (setup, config reference, three test tiers);
   `scripts/send-fixture-local.sh` (POST fixture to `wrangler dev`'s
   `/cdn-cgi/handler/email`), `scripts/send-fixture-live.sh` (swaks/curl SMTP),
   `scripts/verify-delivery.sh` (poll WordPress REST for the fixture's Message-ID);
   GitHub Actions workflow running lint + typecheck + tests on `cloudflare-worker/**`.

## Out of scope (v1)

- Cloudflare Queues / R2 persistence (removed from plan by decision).
- Multiple ingress endpoints / recipient-based routing (KV shape reserves room).
- Forwarding a fallback copy to a verified address.
- The WordPress-plugin side of the contract (separate work in the plugin codebase).

## Manual live-test procedure (summary)

1. Deploy: `npx wrangler deploy`.
2. Send a fixture: `scripts/send-fixture-live.sh tests/fixtures/plain-text-simple.eml test@p.sacramentogaa.org`.
3. Watch: `npx wrangler tail`.
4. Verify: `scripts/verify-delivery.sh "<message-id-from-fixture>"` (polls the plugin REST API).

Note: authenticated SMTP relays rewrite some headers (`From:`, DKIM). Live tests validate
the pipeline; exact MIME handling is validated by unit tests and the local-dev tier.
