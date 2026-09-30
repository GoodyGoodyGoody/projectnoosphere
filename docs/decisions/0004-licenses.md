# 0004 — Licenses: CC0 1.0 for content, MIT for code

- **Status:** accepted, 2026-09-30.
- **Context:** Randall's criterion: "for this project, we need the least restrictive licenses
  possible." The handoff proposed CC BY 4.0 for content and Apache-2.0 for code. Neither is
  the least restrictive choice.

## Content: CC0 1.0 (public-domain dedication)
- **Attribution burden.** CC BY requires attribution on every reuse. For agents quoting
  snippets mid-task, for datasets, and for mirrors, that duty is hard to honor, which makes
  reuse legally uncertain. CC0 removes the doubt. This is why Wikidata chose CC0.
- **Provenance doesn't need a license.** Author, revision id, and hash are recorded as data
  and shown on every page. Citing the revision id is encouraged as a norm, not required by law.
- **One-way door, in the intended direction.** Content dedicated under CC0 can never be made
  more restrictive later. Going from CC BY to CC0 would have required every contributor's
  consent.
- **Third-party material.** Cited third-party material is not relicensed: Noosphere stores
  references to it. Contributors must have the right to dedicate what they submit, and they
  confirm this in the contribution terms (Phase 2).

## Code: MIT
- **Most common minimal license.** MIT is the most widely used permissive license, and it
  combines with anything, including GPLv2-only projects.
- **Why not Apache-2.0.** Apache-2.0 is incompatible with GPLv2-only projects and adds
  NOTICE and "state changes" duties. Its patent grant matters little here.

## Consequences
- **Hashing.** Every revision records `content_license: "CC0-1.0"` (SPDX), and the value is
  part of its content hash. No production content existed before this decision, so nothing
  had to be migrated.
- **Where it is stated.** `LICENSE` (MIT) sits at the repo root, and the agent guide states
  the terms.
