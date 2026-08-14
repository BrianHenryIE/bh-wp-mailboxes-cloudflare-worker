# Cloudflare Email Worker — Implementation Plan

A Cloudflare Worker that receives email via Cloudflare Email Routing and delivers the raw
MIME message to a WordPress REST API endpoint provided by the bh-wp-mailboxes plugin.

## Decisions (from design discussion)

| Topic                      | Decision                                                                                                                                                                                                                                                                                                              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payload format             | Flat raw MIME (`Content-Type: message/rfc822`), streamed unmodified. WordPress parses with `zbateson/mail-mime-parser`. No parsing in the worker.                                                                                                                                                                     |
| Envelope data              | SMTP envelope passed as HTTP request headers: `X-Envelope-From`, `X-Envelope-To`, `X-Message-Raw-Size`.                                                                                                                                                                                                               |
| Idempotency                | The email's `Message-ID` header is the idempotency key. WordPress upserts; sender retries and worker retries must not create duplicates.                                                                                                                                                                              |
| Retry/durability           | Synchronous delivery only. On failure the `email()` handler throws, Cloudflare returns a transient SMTP error, and the sending mail server retries on its own schedule. No Queues, no R2.                                                                                                                             |
| Endpoint discovery         | `Link: <…>; rel="https://api.w.org/"` header → `/wp-json/` index → custom `email_ingress_endpoints` key (added by the plugin via the `rest_index` filter). Namespace-agnostic. Discovery runs during setup only; the selected endpoint is stored in KV.                                                               |
| Multiple ingress endpoints | A site may advertise several (one per mailbox/library instance). The administrator selects the destination on the setup callback's HTML form (auto-selected when exactly one is advertised); the worker delivers to that endpoint and nowhere else. Changing the destination = re-running setup.                      |
| Authentication             | WordPress application password, obtained via the core `/wp-admin/authorize-application.php` flow, initiated from the worker's `fetch()` handler and stored in KV. Sent as HTTP Basic auth.                                                                                                                            |
| Domain constraint          | None. (An earlier version required the recipient domain and the WordPress site to share a registrable domain, but Cloudflare Email Routing does not support subdomains, so the receiving domain must be able to differ from the site's domain. The zone's Email Routing rules control which mail reaches the worker.) |
| Language/tooling           | TypeScript (strict). ESLint (typescript-eslint, type-aware) + Prettier. Vitest for unit tests. Lint + typecheck + tests must pass before every commit.                                                                                                                                                                |
| Naming                     | Verbose, unambiguous names throughout (e.g. `WORKER_CONFIGURATION_KV`, `deliverRawEmailToWordPress`).                                                                                                                                                                                                                 |

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
sending server retries — including 404/410: the selected endpoint is the worker's only
destination, so a moved or disabled endpoint means re-running setup, not re-routing.
On failure the worker also emails the administrator (at most once per day) through the
`send_email` binding, independent of the WordPress site.

## Worker bindings and configuration

| Name                                                         | Kind                          | Purpose                                                                      |
| ------------------------------------------------------------ | ----------------------------- | ---------------------------------------------------------------------------- |
| Site URL                                                     | KV (via `/setup` form)        | Base URL of the WordPress site, entered in the setup web UI.                 |
| `SETUP_TOKEN`                                                | secret                        | One-time token protecting the `/setup` route.                                |
| `WORKER_CONFIGURATION_KV`                                    | KV namespace                  | Stores selected endpoint, application-password credential, alert rate limit. |
| `ALERT_EMAIL`                                                | send_email binding (optional) | Delivery-failure alert emails via Email Routing.                             |
| `ALERT_FROM_EMAIL_ADDRESS` / `ALERT_RECIPIENT_EMAIL_ADDRESS` | env vars (optional)           | Alert sender/recipient addresses.                                            |

## Steps

Each step is one commit. Lint, typecheck, and unit tests run and pass before each commit.

1. **Plan** — this document.
2. **Scaffold** — `package.json`, strict `tsconfig.json`, `wrangler.jsonc`, ESLint + Prettier
   config, Vitest config, npm scripts (`lint`, `format`, `typecheck`, `test`, `check`),
   `.gitignore`.
3. **Config module** (`src/configuration.ts`) — parse/validate env. Unit tests:
   valid/invalid URLs, missing bindings, localhost http allowance. (The
   registrable-domain check between recipient and target site originally built here
   was later removed — see "Domain constraint" above.)
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
- Recipient-based routing (fan-out to all advertised endpoints is implemented; mapping specific recipients to specific endpoints is not).
- Forwarding a fallback copy to a verified address.
- The WordPress-plugin side of the contract (separate work in the plugin codebase).

## Manual live-test procedure (summary)

1. Deploy: `npx wrangler deploy`.
2. Send a fixture: `scripts/send-fixture-live.sh tests/fixtures/plain-text-simple.eml test@p.sacramentogaa.org`.
3. Watch: `npx wrangler tail`.
4. Verify: `scripts/verify-delivery.sh "<message-id-from-fixture>"` (polls the plugin REST API).

Note: authenticated SMTP relays rewrite some headers (`From:`, DKIM). Live tests validate
the pipeline; exact MIME handling is validated by unit tests and the local-dev tier.
