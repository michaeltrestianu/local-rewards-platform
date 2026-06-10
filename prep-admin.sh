#!/usr/bin/env bash
#
# Ensure the perf admin user exists in identity-service and holds the admin
# role. Registration happens through the public API; the role promotion is the
# one unavoidable backdoor (there is no admin-creation endpoint) and is an
# idempotent insert into the user_roles join table.

set -euo pipefail

EMAIL="${ADMIN_EMAIL:-perf-admin@example.com}"
PASSWORD="${ADMIN_PASSWORD:-perf-admin-correct-horse}"
IDENTITY_URL="${IDENTITY_URL:-http://localhost:8080}"

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
  "INSERT INTO user_roles (user_id, role_id)
   SELECT u.id, r.id FROM users u JOIN roles r ON r.name = 'admin'
   WHERE lower(u.email) = lower('${EMAIL}')
   ON CONFLICT DO NOTHING;"

echo "perf admin ready: ${EMAIL}"
