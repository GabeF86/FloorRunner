# Provider authentication and authorization — design

**Date:** 2026-09-09
**Status:** approved (Gabriel, 2026-09-09)
**Scope:** subsystems 1 and 2 of four. The onboarding wizard and the provider
dashboard get their own specs.

---

## Why this is urgent, not merely wanted

**Production is unauthenticated.** Verified 2026-09-09:

```
GET https://floor-runner.vercel.app/api/scheduling/organizations
→ 200, 2 rows, no credentials presented
```

Every one of the 67 API routes runs on the service-role key, which bypasses
RLS, and the set includes POST, PATCH and DELETE. So anyone who knows the URL
can read the whole department — rosters, PTO, availability, schedules — and
modify it. `provider_compensation` is empty today, but the tab exists and the
column is `admin_stipend`; the day it is populated, it is populated into a
public endpoint.

CLAUDE.md records auth as deliberately deferred on the grounds that the app is
"internal-only". It is not internal-only. It is on the public internet with no
door.

This changes the ordering of the work: the middleware that closes the door is
worth shipping even before a single provider is invited.

## The four subsystems

1. **Auth and identity binding** — signup by invitation, login, sessions. *This spec.*
2. **Authorization** — roles, deny-by-default routing, provider-scoped RLS. *This spec.*
3. **Onboarding wizard** — the guided questionnaire, with workload answers as proposals.
4. **Provider dashboard** — schedule snapshot and call metrics.

1 and 2 are one security boundary and ship together. 3 and 4 sit on top.

---

## What already exists

The schema was designed for this and then left empty. All of it is unused:

| Object | State |
| --- | --- |
| `scheduling.users` (`id`, `organization_id`, `email`, `is_active`, …) | 0 rows. `id` is meant to be `auth.uid()`. |
| `scheduling.roles` (`name`, `permissions`), `scheduling.user_roles` | 0 rows |
| `scheduling.providers.linked_user_id` | 0 of 83 set |
| `scheduling.current_user_org_id()` | `SELECT organization_id FROM scheduling.users WHERE id = auth.uid()` |
| 28 RLS policies across 30 of 32 tables | Enabled, and **never once executed** — the service-role key bypasses them |
| `@supabase/ssr` | Installed, imported nowhere |
| `auth.users` | 0 rows |

**The policies are org-scoped, not person-scoped.** Every one reduces to
`organization_id = current_user_org_id()`. They implement multi-tenancy — one
group cannot see another. Not one is provider-scoped, so under today's policies
a logged-in physician could read every colleague's employment profile,
availability, requests and compensation. Closing that is the substance of §4.

**There is no identity data to bind against.** 2 of 83 providers have an email
and they share one address. Whatever the invitation flow does, it cannot match
on stored email, because there is nothing stored to match.

---

## 1. Identity model

```
auth.users            credentials only, managed by Supabase Auth
  └─ scheduling.users        id = auth.uid(), carries organization_id
       ├─ scheduling.user_roles → roles         'admin' | 'provider'
       └─ scheduling.providers.linked_user_id   the physician this login IS
```

Two roles to start. A third (a scheduler who is not a physician) is a real
future case but nothing needs it yet, so it is not built.

`providers.linked_user_id` is the one edge that makes a session mean a person.
It is set exactly once, by the invitation-acceptance transaction, and never by
anything a user types.

---

## 2. Invitation

**The chief invites from the provider's profile.** Self-registration is not
built, at Gabriel's direction (2026-09-09) and for a concrete reason: with no
stored identity data, a self-registering user would have to tell the app which
physician they are, and nothing could contradict them. Invitation inverts that
— the binding is asserted by the person who already knows the answer, before a
credential exists.

### The row

```sql
scheduling.provider_invitations
  id            uuid pk
  provider_id   uuid not null → providers(id) on delete cascade
  email         text not null
  token_hash    text not null unique     -- sha256 of the token; never the token
  expires_at    timestamptz not null     -- 14 days
  status        text not null            -- pending | accepted | revoked
  invited_by    uuid → users(id)
  accepted_at   timestamptz
  accepted_user_id uuid → users(id)
```

Plus a partial unique index on `(provider_id) WHERE status = 'pending'`: one
live invitation per provider, so "invite again" cannot leave two valid tokens
in circulation.

### The token

32 random bytes, base64url, delivered only in the link. **Stored hashed
(SHA-256).** A database read — a backup, a leaked dump, a curious query —
yields no usable invitation. Lookup is by hash of the presented token, so the
plaintext exists only in the email and the URL.

Single-use. Expires. Re-inviting revokes the outstanding row before writing a
new one.

### Acceptance

`/join/<token>` resolves the hash → invitation → provider. The email is shown
but not editable; the invitee chooses a password. On submit, one transaction:

1. create the `auth.users` record
2. insert `scheduling.users` with the provider's `organization_id`
3. insert `user_roles` → `provider`
4. set `providers.linked_user_id`
5. mark the invitation accepted

If any step fails the whole thing rolls back and the token stays usable. A
half-accepted invitation — an auth user with no provider link — is the one
outcome that would strand someone in a session that resolves to nobody, and
§4's helpers would then deny them everything with no way to recover.

### Delivery

Supabase's built-in SMTP is rate-limited to a few messages per hour and is
explicitly not for production; 83 invitations would not get through it. A real
sender is required. Until one is configured, the invite dialog **shows the link
for the chief to copy**, which is also the permanent fallback for a bounced
address. The link is equivalent to the email — same token, same expiry — so
this is not a lesser path, just a manual one.

---

## 3. Authorization — deny by default

The obvious approach is an admin check at the top of each of the 67 routes.
Rejected: that is 67 chances to omit one, the omission is invisible, and every
future route inherits the same trap.

**Instead, middleware in front of everything, which denies unless told
otherwise.**

```
src/middleware.ts
  PUBLIC        → /login, /join/*, /api/auth/*, /api/requests/submit/*   (no session)
  PROVIDER OK   → /me/*, /api/scheduling/me/*
  everything else under /api/scheduling/* and the app pages → ADMIN ONLY
```

A new route is chief-only because doing nothing denies it. Exposing something
to providers requires naming it in one short list, which is a diff a reviewer
sees.

**The provider-facing API is a namespace, not an allow-list of existing
routes.** Every provider-reachable endpoint lives under `/api/scheduling/me/`
and derives `provider_id` from the session. This is why the allow-list is one
prefix rather than a growing enumeration — and it structurally prevents the
obvious mistake of exposing `/api/scheduling/providers/[id]/burden` and
trusting the `[id]`.

### Why not move all 67 routes to user-scoped clients

Considered and rejected for now. It would make 28 never-executed policies
load-bearing in a single cutover, on a live system, with no test coverage of
those policies. The hybrid keeps service-role for the chief surface — which is
already gated to one trusted role by the middleware — and puts real RLS
underneath the new, small, provider surface where the person boundary actually
matters. Migrating the rest later is a mechanical follow-up, not a prerequisite.

Note `makeServerClient` silently falls back to the anon key when
`SUPABASE_SERVICE_ROLE_KEY` is absent. With RLS engaged that degrades to
"reads nothing" rather than "fails loudly". Out of scope to fix here, recorded
as a residual.

---

## 4. Provider-scoped RLS

Two new helper functions, both `STABLE SECURITY DEFINER`, mirroring the
existing `current_user_org_id()`:

```sql
scheduling.current_provider_id()  -- SELECT id FROM providers WHERE linked_user_id = auth.uid()
scheduling.is_admin()             -- EXISTS (user_roles ⋈ roles WHERE name = 'admin')
```

New policies on the person-scoped tables — `provider_employment_profiles`,
`provider_availability`, `provider_requests`, `provider_compensation`,
`provider_custom_field_values`, `provider_site_credentials`, and `assignments`
— of the shape:

```sql
USING (scheduling.is_admin() OR provider_id = scheduling.current_provider_id())
```

The existing org-scoped policies stay exactly as they are. They are the tenant
boundary and remain correct; these are added beneath them as the person
boundary. **A provider must satisfy both.**

Writes are narrower than reads. A provider may insert their own availability
requests and update their own contact fields; they may not write
`provider_employment_profiles` at all, because that table holds `fte_value`,
`work_days_fte` and `call_taker` — the fields that set their own workload. The
wizard's route to those fields is the proposals queue in subsystem 3, never a
direct write.

---

## 5. Sequencing — not locking Gabriel out

RLS with zero users means nobody reads anything. The order is therefore:

1. **Migrations only.** Tables, helpers, policies, roles seeded. Nothing enforced;
   the app still runs entirely on the service key and behaves identically.
2. **Bootstrap the first admin** with a local script using the service key and
   the Supabase Admin API: create the auth user, the `scheduling.users` row,
   the admin role, and link it to the Farkas provider record. A script rather
   than an HTTP endpoint, so no privileged bootstrap route ever exists in
   production.
3. **Verify that account** can log in and that `is_admin()` returns true for it,
   *before* anything starts denying.
4. **Turn on the middleware.** From here the app requires a login — and stops
   being publicly readable.
5. **Build the `/me` surface**, test it with a second account bound to a real
   provider record.
6. **Invite providers**, in batches.

Steps 1–4 are shippable on their own and are the ones that close the exposure.

---

## 6. What providers reach

`/me` — dashboard (subsystem 4), onboarding (subsystem 3), and the request
intake. That last one is worth calling out: `/requests/submit/[token]` today
takes `provider_id` **from the request body**, with the route's own comment
conceding "the token in the URL is the trust boundary (this app has no auth)".
Anyone holding a shared window link can submit as any colleague. Once providers
have logins, the authenticated intake derives the provider from the session and
that hole closes.

The tokenized route keeps working during the transition so open request windows
are not broken mid-block; retiring it is a follow-up once providers are on
logins.

---

## Testing

vitest, `environment: 'node'`, no jsdom — so the assertions live in pure
modules and injected-client helpers, per the house convention.

| What | How |
| --- | --- |
| Token hashing | A generated token never appears in the stored row; hash is stable and 64 hex chars |
| Invitation state machine | pending → accepted; expired rejected; revoked rejected; second use of an accepted token rejected |
| Re-invite | Writes a new pending row and revokes the prior one; the old token stops resolving |
| Acceptance atomicity | An injected failure at each step leaves no auth user, no link, and a still-pending invitation |
| Route classification | A table-driven test over the real path lists: every `/api/scheduling/*` path that is not `/me/*` classifies ADMIN; unknown paths classify ADMIN; only the named public paths classify PUBLIC |
| Deny-by-default | A synthesised "new route" path with no entry anywhere classifies ADMIN, not PUBLIC |
| RLS helpers | SQL-level assertions run against the live DB during the patch, not vitest |

The route classifier is deliberately a **pure function** taking a pathname and
a role, so the deny-by-default property is a unit test rather than a claim
about middleware behaviour.

---

## Out of scope

- The onboarding wizard and the profile-proposals queue (subsystem 3).
- The provider dashboard (subsystem 4).
- Migrating the 67 chief-facing routes off the service-role key.
- Retiring the tokenized request-window intake.
- Password reset and email change flows — Supabase Auth provides these; wiring
  them is a follow-up once a real SMTP sender exists.
- A `scheduler` role.

## Residuals

- `makeServerClient` falls back to the anon key when the service key is missing,
  which under RLS degrades silently to empty reads instead of failing loudly.
- The 28 existing org-scoped policies remain untested by execution; this work
  exercises only the new person-scoped ones.
- Until an SMTP sender is configured, invitation delivery is copy-a-link.
