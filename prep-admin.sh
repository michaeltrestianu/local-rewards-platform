#!/usr/bin/env bash
#
# Ensure the perf admin user exists in identity-service and holds the admin
# role on the seed business. Registration happens through the public API; the
# role promotion is the one unavoidable backdoor (there is no admin-creation
# endpoint) and is an idempotent upsert into the business_members join table.

set -euo pipefail

EMAIL="${ADMIN_EMAIL:-perf-admin@example.com}"
PASSWORD="${ADMIN_PASSWORD:-perf-admin-correct-horse}"
IDENTITY_URL="${IDENTITY_URL:-http://localhost:8080}"
BUSINESS_REF="${BUSINESS_REF:-00000000-0000-0000-0000-000000000001}"

login_status() {
  curl -s -o /dev/null -w '%{http_code}' -X POST "${IDENTITY_URL}/login" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}"
}

if [[ "$(login_status)" != "200" ]]; then
  status=$(curl -s -o /dev/null -w '%{http_code}' -X POST "${IDENTITY_URL}/users" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"${EMAIL}\",\"displayName\":\"Perf Admin\",\"password\":\"${PASSWORD}\"}")
  if [[ "${status}" != "201" ]]; then
    echo "error: could not register perf admin (${status}) and login failed" >&2
    exit 1
  fi
fi

docker compose exec -T postgres psql -U identity -d identity -q -c \
  "INSERT INTO business_members (business_id, user_id, role)
   SELECT b.id, u.id, 'admin'
   FROM users u JOIN businesses b ON b.external_ref = '${BUSINESS_REF}'
   WHERE lower(u.email) = lower('${EMAIL}')
   ON CONFLICT (business_id, user_id) DO UPDATE SET role = 'admin';"

echo "perf admin ready: ${EMAIL}"
