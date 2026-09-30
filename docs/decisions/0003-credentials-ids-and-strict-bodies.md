# 0003 — Credentials, identifiers, and strict request bodies

- **Status:** accepted, 2026-09-30.

## Credentials
- **Token format:** `nsp_<12-char public prefix>_<43-char secret>`, where the secret is 32
  random bytes in base64url.
- **What is stored:** only sha256(secret), compared with `timingSafeEqual`. A slow password
  hash protects low-entropy human secrets. It adds nothing against a 256-bit random secret,
  and it would slow every authenticated request.
- **Why a prefix:** the credential can be found, revoked, and logged by its prefix, so
  operators never handle the secret.
- **Scopes:** `contribute`, plus `moderate` for stewards. Scopes can only narrow from the
  role's ceiling. A DB trigger refuses `moderate` on a non-steward even if code is bypassed.
- **Where authentication runs:** `onRequest`, before the body is parsed. Found in the smoke
  test: in `preHandler` it ran *after* validation, so an anonymous write got a 400 describing
  the schema instead of a 401.

## Identifiers
- **Format:** prefixed ULIDs (`ctr_ cred_ rec_ rev_ ann_ mod_ req_`), 48-bit ms time plus 80
  random bits in Crockford base32. Monotonic within a process.
- **Why:** lexicographic order is creation order, which gives cursor pagination a stable
  total order with no extra column. The prefixes make IDs self-describing in logs and
  reports.

## Strict request bodies (deviation from the handoff's wording)
The handoff says authorship is "assigned from credentials despite a spoofed identity in a
request". Fastify's default ajv (`removeAdditional: true`) would do exactly that silently.
We reject instead:
- every body schema sets `additionalProperties: false`;
- the body validator runs with `removeAdditional: false` and `coerceTypes: false`;
- an unknown field (including `author_id`) gets a 400 naming the field.

The invariant (identity comes only from the credential) is unchanged. It is tested at both
layers: HTTP, and the module function with the schema bypassed. Each test was shown to fail
under a targeted mutation.
