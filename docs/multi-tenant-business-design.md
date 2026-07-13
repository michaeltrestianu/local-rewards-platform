# Multi-tenant "business" layer — cross-service design

Status: ready for development
Date: 2026-06-17

## 1. Root problem

Today the platform is a *single* rewards programme. There is one points economy
(`ledger.accounts` keyed on `user_ref` alone → one balance per user, platform-wide),
one redemption catalogue (`ledger.blocks`), one set of posting reasons, and one
admin tier (`identity.roles`: `user`/`admin`/`superadmin`, all global).

We want to make **business** a first-class tenant that sits *above* the existing
experience: many businesses live on the platform, a user can browse them all and
drop *into* any one of them to see the points / catalogue / history they hold
**at that business**. The current single-programme experience becomes "what you
see once you're inside one business".

The hard requirement is **tenant isolation on the admin side**: a user may see
every business (it's a public directory), but one business must never see another
business's customers or data.

## 2. Decisions locked (from alignment)

| # | Decision | Choice |
|---|----------|--------|
| 1 | What is a "business" vs the existing `spotlights`? | Brand-new top-level tenant. **Spotlights stay exactly as they are** — global featured-business adverts, unrelated to tenancy. |
| 2 | Points scope across businesses | **Separate balance per business.** Ledger account re-keys to `(business_ref, user_ref)`. `blocks` and `reasons` become per-business. Points earned at A are not spendable at B. |
| 3 | Membership & admin model | **Per-business roles** (a business owner/admin administers only their own business) beneath the **platform superadmin** who sits above all. Users hold a membership per business. |
| 4 | Business registry home | **Inside identity-service** — it already owns users/roles/user_roles; business + membership + business-scoped roles extend that model with no 5th service and no extra auth hop. |
| 5 | How `business_ref` reaches a request | **Explicit per-request parameter.** Any signed-in user can list/join all businesses; isolation bites on admin actions. |
| 6 | How the business-scoped role is authorised | **Keep the existing `roles` claim (platform roles), additively introduce a `businesses` claim carrying only *elevated* (admin) business roles**, verified **locally** in each service (preserving the "no cross-service hop on the hot path" design + ledger perf thresholds). Consumer reads of own data need no business claim — they authorise on the token subject. *Not* a per-request callout to identity. |
| 7 | Other services' reference to a business | An **opaque `business_ref` UUID, no cross-DB FK** — identical to how ledger already holds `user_ref` without reaching into identity. Identity is the source of truth; everyone else stores the ref. |
| 8 | Who creates a business | **Platform superadmin onboards businesses.** `POST /businesses` is gated on the global `superadmin` role. No self-serve business signup. |
| 9 | How a user joins a business | **Open self-join from the directory.** Any signed-in user can join any business via `POST /businesses/{businessRef}/members`; no invite/approval. |
| 10 | When a member's ledger account is created | **Lazily**, on first ledger interaction (existing `ensureAccount` pattern); a balance read for a member with no entries yet returns zero. Joining only writes membership in identity — ledger is never called on join, preserving the no-cross-service-coupling rule. |
| 11 | Business lifecycle | Businesses carry a `status`; `inactive` hides them from the directory and freezes postings. **Hard-delete is not supported** in v1 (the ledger holds real balances; no cross-DB cascade). |

## 3. Tenancy model

`business_ref` (UUID) is the tenant key that flows across the platform, mirroring
the existing `user_ref` (which is identity's `users.external_ref`). identity owns
the registry; ledger/content/analytics treat `business_ref` as an opaque value.

```
identity-service (source of truth)
  users (existing)
  businesses            id, external_ref(UUID, unique), name, status, ... (profile minimal in v1)
  business_members      business_id, user_id, role            -- PK(business_id, user_id)
  roles / user_roles    (existing) -> now PLATFORM scope only: 'superadmin', base 'user'

ledger-service (opaque business_ref)
  accounts        PK (business_ref, user_ref)        -- was PK(user_ref)
  ledger_entries  + business_ref                     -- reference idempotency scoped per business
  blocks          + business_ref
  reasons         + business_ref                     -- active starter set seeded per new business (lazy, once)

content-service     UNCHANGED (spotlights stay global, already gated on superadmin)
rewards-analytics   one-line re-gate only: spotlight report moves from the
                    retiring global 'admin' role to 'superadmin' (data stays global)
```

### Role split

- **Platform roles** (`identity.roles` / `user_roles`, global): `superadmin` only
  (plus the base `user`). Superadmin can administer any business.
- **Business roles** (`identity.business_members.role`, scoped to one business):
  proposed `admin` / `member`. The previous global `admin` role **retires** in
  favour of a business-scoped `admin` (see §6 for the analytics knock-on). A
  "member" is simply a user who has joined and holds a per-business balance.
- **Membership is not a token claim.** Plain membership lives only in
  `business_members` and authorises nothing by itself — reading your own balance
  is authorised by the token *subject*. Only *elevated* (`admin`) roles ride in
  the token (see §4).

## 4. Token / claims evolution

The change is **additive**: the existing `roles` claim is kept (it is the
platform-roles claim — `superadmin`, base `user`), and a `businesses` claim is
added carrying **only businesses where the user holds an elevated role**. Keeping
`roles` is what makes content-service genuinely unchanged and confines
rewards-analytics to a one-line re-gate.

Current claim (all services share an identical `token` package):

```go
type claims struct {
    jwt.RegisteredClaims
    Roles []string `json:"roles"`   // e.g. ["user","admin"] — platform roles
}
```

Proposed:

```go
type claims struct {
    jwt.RegisteredClaims
    Roles      []string        `json:"roles"`                // platform roles, e.g. ["user","superadmin"]
    Businesses []businessClaim  `json:"businesses,omitempty"` // elevated business roles only
}
type businessClaim struct {
    Ref   string   `json:"ref"`   // business external_ref (UUID)
    Roles []string `json:"roles"` // e.g. ["admin"] — NOT plain membership
}
```

`token.Identity` gains `BusinessRoles map[uuid.UUID][]string` (business_ref →
elevated roles). ledger's `auth` package replaces `isAdmin(r)` with
`HasBusinessRole(ctx, businessRef, "admin")`, with platform `superadmin` as a
global override. content/analytics keep using `HasRole` against `roles` unchanged.

### Why membership is *not* in the token

Reading your own data — `GET /me/businesses/{ref}/points`, history, the public
catalogue — is authorised by the token **subject** (`user_ref`) plus scoping the
query to `(business_ref, user_ref)`, exactly as `/me/points` works today. No
per-business claim is needed for the consumer path. Therefore the `businesses`
claim holds only *elevated* roles, which means:

- The ordinary user (member of many businesses, admin of none) carries an
  **empty** `businesses` claim — no token bloat, no per-membership growth.
- The source of truth for "which businesses am I in" stays in
  `business_members`, surfaced by `GET /me/businesses` (drives the switcher) —
  never replicated wholesale into the token.

### Claim freshness (self-join + local verification)

Because claims are baked into the access token and verified locally, a change to
a user's *elevated* roles (superadmin onboarding a business and naming its admin)
does not reach an already-issued token. This affects **admin grants only** —
consumer self-join needs no claim and is effective immediately. To bound the
staleness:

- Access tokens stay **short-lived**; the **refresh flow re-reads
  `business_members`** so a new admin grant propagates on the next refresh
  without a full re-login. identity already has a `refresh_tokens` table, so the
  mechanism exists — we commit to it (confirm the access-token TTL during build).
- If finer immediacy is ever required, the escape hatch remains the
  *scoped-token-re-minted-on-switch* model; the additive claim shape keeps that
  swap localised to identity + the verifier.

## 5. business_ref propagation & routing

`business_ref` is a path parameter on tenant-scoped resources (clearer for chi
routing and resource semantics than a header):

**ledger-service**
```
POST /businesses/{businessRef}/points/award        (business admin)
POST /businesses/{businessRef}/points/deduct        (business admin)
GET  /businesses/{businessRef}/accounts/{userRef}/balance   (business admin)
GET  /me/businesses/{businessRef}/points             (the member, own balance)
GET  /me/businesses/{businessRef}/points/history     (the member)
GET  /businesses/{businessRef}/blocks                (member: active catalogue)
GET  /businesses/{businessRef}/blocks/all            (business admin)
POST/PUT/DELETE /businesses/{businessRef}/blocks...  (business admin)
GET/POST/PUT    /businesses/{businessRef}/reasons... (members read active / admin writes)
```

The handler reads `businessRef` from the path, authorises against the claim
(`HasBusinessRole` or superadmin), then scopes every query by `business_ref`.

**identity-service**
```
POST /businesses                        create a business (superadmin only)
GET  /businesses                        public directory (any signed-in user)
GET  /businesses/{businessRef}          single business detail
POST /businesses/{businessRef}/members  open self-join (any signed-in user)
GET  /me/businesses                     businesses I'm a member of (drives switcher)
```

## 6. Migration / backfill strategy

The existing single programme must not break — it becomes a seed "default"
business:

1. identity: create `businesses`, `business_members`; insert one seed business
   with a fresh `external_ref`; migrate every current `admin` in `user_roles`
   into `business_members(seed, user, 'admin')`; keep `superadmin` global. The
   global `admin` role is **retired** — left inert in the `roles` table (deleting
   a referenced row is needless migration risk) and removed from minted tokens.
2. rewards-analytics: re-gate the spotlight report from the retiring global
   `admin` role to `superadmin` (one line; the data stays global). This is the
   *only* change to a service we otherwise leave alone, and it must ship before
   `admin` stops being minted.
3. ledger: add `business_ref` to `accounts`/`ledger_entries`/`blocks`/`reasons`,
   backfill all existing rows to the seed `business_ref`, then re-key
   `accounts` PK to `(business_ref, user_ref)` and make `reference` unique per
   `(business_ref, reference)`. (Bonus: the composite PK means
   `getAccountForUpdate`'s row lock no longer contends across businesses.)
   **Starter reasons:** rather than the historical inactive `Unspecified` row
   (vestigial — nothing references it), a new business is seeded with a small
   set of *active* starter reasons (`Purchase`/award, `Reward redemption`/deduct)
   the first time its reasons are listed — done lazily in ledger (migration
   `0006` adds a `business_reason_seed` marker; seeded exactly once, guarded so
   clearing reasons never re-seeds), preserving decision #10 (no ledger call on
   business create). Businesses that already had reasons are marked seeded by the
   migration, so established programmes are untouched.
4. The seed `business_ref` is configuration shared into ledger's migration (or a
   one-off data migration script in this platform repo, mirroring `prep-*.sh`).

Each service migrates independently (one DB per service). Ordering matters for
the claim change: **analytics re-gate → identity stops minting `admin`** so the
spotlight report never loses its gate; ledger re-key carries the seed
`external_ref` across.

## 7. Frontend contract (out of scope for first build, described for completeness)

- **rewards-app**: new business directory + a business switcher. Once "inside" a
  business, the existing **points / history / catalogue** screens render scoped
  to that `business_ref`. The **spotlight** screen stays global (spotlights are
  not tenant-scoped) and sits outside the per-business view. `GET /me/businesses`
  drives the switcher.
- **rewards-admin**: a business selector; a business admin is pinned to their
  business(es); the superadmin can act across all. The spotlight/superadmin
  panels are unchanged (spotlights stay global).
- **Business profile is minimal in v1** (name + text). A logo/imagery story is
  deferred: image upload currently lives in content-service, not identity, so a
  rich business profile is a later content-service concern rather than duplicated
  upload logic in identity (see §8).

## 8. Open questions

Closed:

- ~~Who creates a business~~ → superadmin onboards (decision #8).
- ~~How a user joins~~ → open self-join from the directory (decision #9).
- ~~Account creation on join vs first award~~ → lazy (decision #10).

Remaining (low-stakes; sensible defaults proposed, confirm during build):

1. **`reference` idempotency scope** — proposed unique per `(business_ref,
   reference)` so two businesses can reuse a caller-supplied reference.
2. **Naming of business roles** — proposed `admin`/`member` only (drop `owner`
   unless ownership/billing is a distinct concern from administration).
3. **Spotlights later** — confirmed *not* tenant-scoped now; note if/when a
   business should curate its own spotlights (decision #1 alt. C), as that's a
   future content-service change.
4. **Business logo/imagery** — deferred. A rich directory wants logos, but image
   upload lives in content-service while the registry lives in identity. Decide
   later whether business imagery belongs in content-service or warrants upload
   support in identity; v1 profile is name + text only.

## 9. Suggested build sequencing (when we proceed)

1. rewards-analytics: re-gate the spotlight report `admin` → `superadmin` (must
   land before identity stops minting `admin`).
2. identity: `businesses` + `business_members` + directory/join/`me/businesses`
   APIs + additive `businesses` claim + verifier + refresh re-reads memberships.
3. ledger: schema re-key + backfill + business-scoped routing/authz.
4. frontends: directory + switcher (app), business selector (admin).

Per the agreed scope, **stop here for sign-off** before any of the above.
