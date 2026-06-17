#!/usr/bin/env bash
#
# Promote an existing identity-service account to superadmin — the single
# platform-owner role that gates spotlight management and image uploads in
# content-service. Mirrors prep-admin.sh: there is deliberately no promotion
# endpoint, so this is an idempotent insert into identity's roles/user_roles
# tables. The admin role is granted alongside, since the platform owner also
# curates the rewards catalogue and posting reasons.
#
# The account must already exist — register through the app first.
#
#   SUPERADMIN_EMAIL=you@example.com ./prep-superadmin.sh

set -euo pipefail

EMAIL="${SUPERADMIN_EMAIL:?set SUPERADMIN_EMAIL to the account to promote}"

docker compose exec -T postgres psql -U identity -d identity -q <<SQL
INSERT INTO roles (name) VALUES ('superadmin')
ON CONFLICT (name) DO NOTHING;

INSERT INTO user_roles (user_id, role_id)
SELECT u.id, r.id FROM users u JOIN roles r ON r.name IN ('superadmin', 'admin')
WHERE lower(u.email) = lower('${EMAIL}')
ON CONFLICT DO NOTHING;
SQL

granted=$(docker compose exec -T postgres psql -U identity -d identity -tA -c \
  "SELECT count(*) FROM user_roles ur
   JOIN users u ON u.id = ur.user_id
   JOIN roles r ON r.id = ur.role_id AND r.name = 'superadmin'
   WHERE lower(u.email) = lower('${EMAIL}');")

if [[ "${granted}" != "1" ]]; then
  echo "error: no identity account found for ${EMAIL} — register through the app first" >&2
  exit 1
fi

echo "superadmin ready: ${EMAIL}"
