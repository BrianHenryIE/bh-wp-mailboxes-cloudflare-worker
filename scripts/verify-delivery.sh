#!/usr/bin/env bash
#
# Poll the WordPress REST API until an email with the given Message-ID has
# been stored, or time out. Exits 0 on success, 1 on timeout — usable as a
# pass/fail gate after send-fixture-live.sh.
#
# Usage:
#   scripts/verify-delivery.sh '<plain-text-simple-fixture@bh-wp-mailboxes.test>'
#
# Environment (all required):
#   TARGET_WORDPRESS_SITE_URL          e.g. https://sacramentogaa.org
#   WORDPRESS_USERNAME                 WordPress user with read access to the mailbox
#   WORDPRESS_APPLICATION_PASSWORD     Application password for that user
#
# Optional:
#   VERIFY_TIMEOUT_SECONDS   How long to poll (default 120)
#   VERIFY_QUERY_ROUTE       REST route queried with ?message_id=…
#                            (default /wp-json/bh-wp-mailboxes/v1/emails)

set -euo pipefail

MESSAGE_ID="${1:?Usage: $0 '<message-id>'}"

: "${TARGET_WORDPRESS_SITE_URL:?Set TARGET_WORDPRESS_SITE_URL}"
: "${WORDPRESS_USERNAME:?Set WORDPRESS_USERNAME}"
: "${WORDPRESS_APPLICATION_PASSWORD:?Set WORDPRESS_APPLICATION_PASSWORD}"

VERIFY_TIMEOUT_SECONDS="${VERIFY_TIMEOUT_SECONDS:-120}"
VERIFY_QUERY_ROUTE="${VERIFY_QUERY_ROUTE:-/wp-json/bh-wp-mailboxes/v1/emails}"
POLL_INTERVAL_SECONDS=5

QUERY_URL="${TARGET_WORDPRESS_SITE_URL}${VERIFY_QUERY_ROUTE}"

DEADLINE=$(( $(date +%s) + VERIFY_TIMEOUT_SECONDS ))

echo "Polling ${QUERY_URL} for Message-ID ${MESSAGE_ID} (timeout ${VERIFY_TIMEOUT_SECONDS}s)…"

while [ "$(date +%s)" -lt "${DEADLINE}" ]; do
  RESPONSE_BODY=$(curl --silent --get \
    --user "${WORDPRESS_USERNAME}:${WORDPRESS_APPLICATION_PASSWORD}" \
    --data-urlencode "message_id=${MESSAGE_ID}" \
    "${QUERY_URL}" || true)

  if [ -n "${RESPONSE_BODY}" ] && [ "${RESPONSE_BODY}" != '[]' ] \
    && printf '%s' "${RESPONSE_BODY}" | grep -qF "${MESSAGE_ID}"; then
    echo 'Delivered: the email was found in WordPress.'
    exit 0
  fi

  sleep "${POLL_INTERVAL_SECONDS}"
done

echo "Timed out: no stored email with Message-ID ${MESSAGE_ID} after ${VERIFY_TIMEOUT_SECONDS}s." >&2
exit 1
