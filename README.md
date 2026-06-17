# local-rewards-platform

Shared local infrastructure for the identity-service, ledger-service,
content-service and rewards-analytics repos: one Postgres container hosting
**one database per service** (separate databases and roles — services share the
server, never each other's data), joined by a fixed-name Docker network
(`platform`) that each service's compose project attaches to as an external
network.

## Usage

```bash
make up    # postgres on :5432, network "platform", databases identity + ledger + content + analytics
make down  # stop and remove, including the data volume
```

Then in each service repo:

```bash
make up-platform    # joins the platform network instead of starting its own postgres
make down-platform
```

Ports when the services run in platform mode: identity-service on **:8080**,
ledger-service on **:8081**, content-service on **:8082**, rewards-analytics on
**:8083** (remapped to avoid clashes), postgres on **:5432**. This matches the
rewards-app's documented defaults (`EXPO_PUBLIC_IDENTITY_URL=:8080`,
`EXPO_PUBLIC_LEDGER_URL=:8081`, `EXPO_PUBLIC_CONTENT_URL=:8082`,
`EXPO_PUBLIC_ANALYTICS_URL=:8083`), so the mobile app needs no configuration to
run against the platform stack. The rewards-admin panel reads the spotlight
report from the same `:8083` (`VITE_ANALYTICS_URL`).

## Superadmin promotion

Spotlight management in content-service is gated on the `superadmin` role,
held by exactly one person — the platform owner. Like the admin role, there is
deliberately no promotion endpoint; `prep-superadmin.sh` promotes an existing
identity-service account with an idempotent insert into identity's `roles` /
`user_roles` tables:

```bash
SUPERADMIN_EMAIL=you@example.com ./prep-superadmin.sh
```

The account must already exist (register through the app first). The script
also grants `admin`, since the platform owner curates the rewards catalogue
and posting reasons too.

## Combined e2e load test

`perf/e2e.js` drives the real cross-service flow: sessions minted by
identity-service are spent against ledger-service. 100 concurrent customers
(with think time) read their account and points, while the platform awards and
redeems points through an admin user — a real identity login promoted to the
admin role by `prep-admin.sh` (an idempotent `user_roles` insert; the only
step that bypasses the public API, since there is no admin-creation endpoint).

```bash
make perf          # both services must be up in platform mode (~3.5 min)
SMOKE=1 make perf  # quick harness check
```

k6 runs via the `grafana/k6` Docker image. Thresholds: journey reads
p99 < 300ms, postings p99 < 500ms, logins p99 < 800ms, error rate < 1%.
Each repo also has an isolated harness (`make perf` in the repo) for clean
attribution when one service looks slow here.

## Notes

- `init-databases.sql` runs only when the data volume is first created. After
  editing it, `make down && make up` to re-initialise.
- Each repo's integration tests can also point at this Postgres (same
  credentials and port as their own compose defaults) — but they truncate
  tables, so don't run them against data you care about.
- Standalone mode in each repo (`make up`) is unchanged and unaffected; this
  setup is additive. CI in both repos uses GitHub Actions service containers
  and never touches any of this.
- The services authenticate cross-service with the shared throwaway dev
  keypair from the repos' `.env.example` files — identity signs, ledger,
  content and analytics verify. The pairs must match for platform mode to work.
