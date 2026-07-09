#!/usr/bin/env bash
#
# Send a .eml fixture through a real, authenticated SMTP relay to a live
# Email-Routing address, exercising the deployed worker end to end.
#
# Usage:
#   scripts/send-fixture-live.sh tests/fixtures/plain-text-simple.eml mailbox@p.sacramentogaa.org
#
# Environment (all required):
#   SMTP_SERVER    Relay host[:port], e.g. smtp.fastmail.com:587
#   SMTP_USERNAME  Relay username
#   SMTP_PASSWORD  Relay password (use an app-specific password)
#   SMTP_FROM      Envelope sender the relay permits
#
# Requires swaks: https://github.com/jetmore/swaks (brew install swaks).
#
# Note: relays rewrite some headers (From:, DKIM signatures). This validates
# the pipeline; byte-exact MIME handling is covered by the unit and local
# test tiers.

set -euo pipefail

FIXTURE_FILE="${1:?Usage: $0 <fixture.eml> <recipient>}"
RECIPIENT_EMAIL_ADDRESS="${2:?Usage: $0 <fixture.eml> <recipient>}"

: "${SMTP_SERVER:?Set SMTP_SERVER, e.g. smtp.fastmail.com:587}"
: "${SMTP_USERNAME:?Set SMTP_USERNAME}"
: "${SMTP_PASSWORD:?Set SMTP_PASSWORD}"
: "${SMTP_FROM:?Set SMTP_FROM to an envelope sender the relay permits}"

command -v swaks >/dev/null || {
  echo 'Error: swaks not found. Install with: brew install swaks' >&2
  exit 1
}

swaks \
  --to "${RECIPIENT_EMAIL_ADDRESS}" \
  --from "${SMTP_FROM}" \
  --server "${SMTP_SERVER}" \
  --auth \
  --auth-user "${SMTP_USERNAME}" \
  --auth-password "${SMTP_PASSWORD}" \
  -tls \
  --data "@${FIXTURE_FILE}"

echo "Sent ${FIXTURE_FILE} to ${RECIPIENT_EMAIL_ADDRESS} via ${SMTP_SERVER}."
echo "Watch the worker with: npx wrangler tail"
