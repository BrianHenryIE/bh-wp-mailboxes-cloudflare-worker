# Setup automation plan

Plan for a CLI tool that performs the worker's one-time setup — everything the
README's Setup section does by hand — against the Cloudflare API with an API
token. Not yet implemented; this documents the verified API calls the tool
will wrap.

## What the tool automates

| README step                                               | Automation                                                                       |
| --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1. Create KV namespace                                    | `wrangler kv namespace create` (already CLI), write the id into `wrangler.jsonc` |
| 2. Deploy + set secret                                    | `wrangler deploy`, then generate and set `SETUP_TOKEN` (see below)               |
| 3. Enable Email Routing + catch-all to worker             | REST API calls (verified below)                                                  |
| 4. Web setup flow (site URL, authorize, pick destination) | Stays in the browser — the tool prints the `/setup?token=…` link                 |
| 5. (Optional) alerting                                    | Create the destination address via API; verification click stays manual          |

## Token generation

The setup token is normally chosen on the `/setup` web UI on first visit
(trust on first use; stored hashed in KV). A tool that wants to pre-set it
instead can use the optional `SETUP_TOKEN` secret, which takes precedence:

```sh
TOKEN=$(openssl rand -hex 32)
echo "$TOKEN" | npx wrangler secret put SETUP_TOKEN   # requires the worker to be deployed first
```

The tool should keep the token in memory to print the final `/setup` link;
Cloudflare secrets are write-only and cannot be retrieved later (re-running
`wrangler secret put` resets it, with no effect on stored KV state). A
web-UI-claimed token is reset by deleting the `setup_token_sha256` KV entry.

## Step 3 via the REST API (verified against the API reference)

Now implemented in the worker's setup UI (`src/cloudflare-email-routing-setup.ts`):
the `/setup` page takes a Cloudflare API token, uses it in request memory only, and
performs these calls server-side. The curl equivalents remain for scripting:

Wrangler has no Email Routing commands; these are plain REST calls.

```sh
export CLOUDFLARE_API_TOKEN=...   # permissions below
ZONE_NAME=example-mail.com
WORKER_NAME=bh-wp-mailboxes-incoming-email-worker

# Zone id for the receiving domain
ZONE_ID=$(curl -s "https://api.cloudflare.com/client/v4/zones?name=${ZONE_NAME}" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" | jq -r '.result[0].id')

# Enable Email Routing (adds and locks the MX + SPF records)
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/enable" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"

# Catch-all rule → send to the worker
curl -s -X PUT "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing/rules/catch_all" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "name": "Send all mail to bh-wp-mailboxes worker",
    "enabled": true,
    "matchers": [ { "type": "all" } ],
    "actions":  [ { "type": "worker", "value": ["'"${WORKER_NAME}"'"] } ]
  }'

# Verify
curl -s "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/email/routing" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}"   # expect "enabled": true
```

Related endpoints:

- `GET /zones/{zone_id}/email/routing/dns` — the DNS records Email Routing
  requires (useful for a preflight check / diagnostics output).
- `GET /zones/{zone_id}/email/routing/rules/catch_all` — current catch-all,
  for idempotent re-runs.

## Optional alerting destination address

```sh
ACCOUNT_ID=...
curl -s -X POST "https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/email/routing/addresses" \
  -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{ "email": "admin@example.net" }'
```

This sends the verification email; **the recipient must click the
confirmation link** — that half cannot be automated. The tool can poll
`GET /accounts/{account_id}/email/routing/addresses` until the address shows
`"verified"`; the alert addresses themselves are entered on the worker's
setup UI (stored in KV), so no vars/redeploy are involved.

## API token permissions

Custom token, scoped to the receiving zone:

- _Zone → Email Routing Rules → Edit_ — enable + rules.
- _Zone → Zone → Read_ — resolve the zone id by name.
- _Zone → DNS → Edit_ — the enable step writes the MX/SPF records.
- _Account → Email Routing Addresses → Edit_ — only if configuring alerting.

(`wrangler` steps use its own OAuth login or `CLOUDFLARE_API_TOKEN` with
Workers Scripts + Workers KV Storage edit permissions.)

## What stays manual, by design

- The WordPress side of setup: logging in on `authorize-application.php` and
  approving, and choosing the destination mailbox when several ingress
  endpoints are advertised. These are deliberate human decisions in the
  worker's web setup flow; the tool ends by printing the
  `https://<worker-host>/setup?token=<SETUP_TOKEN>` link.
- The alert destination address verification click (anti-spam measure).

## CLI design notes (for when it is built)

- Idempotent: safe to re-run — check current state (`GET …/email/routing`,
  `GET …/rules/catch_all`, `wrangler kv namespace list`) before mutating.
- Inputs: receiving zone name, worker name (default from `wrangler.jsonc`),
  optional alert addresses. Everything else is derived or generated.
- Email Routing does not support subdomains: validate the zone is a root
  domain up front and fail with a clear message.
- Fits naturally as an npm script here (e.g. `npm run setup`) implemented in
  TypeScript with the same lint/test toolchain as the worker.
