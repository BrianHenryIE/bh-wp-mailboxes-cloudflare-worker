#!/usr/bin/env bash
#
# Send a .eml fixture to a locally running `wrangler dev` email handler.
#
# Usage:
#   scripts/send-fixture-local.sh tests/fixtures/plain-text-simple.eml [recipient] [sender]
#
# Environment:
#   WRANGLER_DEV_URL  Base URL of wrangler dev (default http://localhost:8787)
#
# The fixture must be raw RFC 5322 and include a Message-ID header.

set -euo pipefail

FIXTURE_FILE="${1:?Usage: $0 <fixture.eml> [recipient] [sender]}"
RECIPIENT_EMAIL_ADDRESS="${2:-mailbox@p.sacramentogaa.org}"
SENDER_EMAIL_ADDRESS="${3:-sender@example.com}"
WRANGLER_DEV_URL="${WRANGLER_DEV_URL:-http://localhost:8787}"

if ! grep -qi '^Message-ID:' "${FIXTURE_FILE}"; then
  echo "Error: ${FIXTURE_FILE} has no Message-ID header; wrangler dev requires one." >&2
  exit 1
fi

curl --fail-with-body --silent --show-error --request POST \
  --url-query "from=${SENDER_EMAIL_ADDRESS}" \
  --url-query "to=${RECIPIENT_EMAIL_ADDRESS}" \
  --data-binary "@${FIXTURE_FILE}" \
  "${WRANGLER_DEV_URL}/cdn-cgi/handler/email"

echo "Sent ${FIXTURE_FILE} to the local email handler as ${RECIPIENT_EMAIL_ADDRESS}."
