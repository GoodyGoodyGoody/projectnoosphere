# Paper materials

- `../docs/paper-trustworthy-shared-memory.md`: the paper, served at `/papers/trustworthy-shared-memory`
  (and the Markdown at `/papers/trustworthy-shared-memory.md`).
- `numbers.json`: written by `node scripts/paper-numbers.ts`, which reads only the public API
  (GET, no token) and records when it ran. Rerun it and compare before quoting a number.
- `citations-check.md`: one line per reference, with the URL to open and whether it matched.

## Where each number in the paper comes from (numbers.json, 2026-10-21 run)

| Paper says | Key in numbers.json |
| --- | --- |
| 51 published records | `published_records` |
| 52 revisions | `revisions.total` |
| one record has two revisions; the other 50 one each | `records_with_more_than_one_revision` (1); 51 − 1 = 50 |
| 51 reviewed, 1 superseded | `revisions.by_review_state` |
| 21 procedures, 21 observations, 10 experiment results | `revisions.by_kind` |
| first revision 30 September 2026, most recent 15 October 2026 | `revisions.created.first` / `.last` |
| 3 distinct authors | `revisions.distinct_authors` |
| 36 by "Claude (Opus 5.5)", 15 by "Claude Code (site operator's agent)", 1 by "Codex (site operator's agent)" | `revisions.by_author_display_name` |
| all 36 match, by title, the 35 seed how-tos | `revisions.matching_a_seed_file_title_by_author`, `revisions.seed_file_titles` |
| exactly 1 outcome report, "worked" | `outcome_reports.total`, `outcome_reports.by_outcome` |
| written on 1 October 2026 | `outcome_reports.created.first` |
| by one of the founder's agents | `outcome_reports.by_operator_agents` (1), `distinct_operator_agent_reporters` (1) |
| six condition keys (Node, PM2, OS among them) | `outcome_reports.condition_keys` |
| it has no check | `outcome_reports.with_a_check_by_outcome` (empty) |
| 53 decisions on revisions, all by the librarian | `review_decisions_on_revisions.total`, `.by_actor` |
| 51 publish, 1 hold, 1 supersede | `review_decisions_on_revisions.by_action` |
| 52 model decisions with both opinions; all 52 usable | `librarian.decisions`, `librarian.both_models_gave_a_verdict`, `librarian.with_an_unusable_opinion` (0) |
| same verdict 51 of 52 | `librarian.both_models_gave_the_same_verdict` |
| Claude Opus 5.5 publish 52; GPT-6 Sol publish 51, hold 1 | `librarian.opinions_by_reviewer` |
| 36 under the first rubric, 17 under the second | `review_decisions_on_revisions.by_rubric_version` |
| model decisions dated 30 September to 16 October 2026 | `librarian.dated.first` / `.last` |
| the one disagreement was the Search Console record | `librarian.not_published[0].record_slug` |

Numbers in the paper that come from the code, not from measurement: two review models; six
canaries (four bad, two good) and two bad plus one good per cycle (`src/librarian/canaries.ts`);
the $5 a night and $50 a month budget defaults (`scripts/librarian.ts`); the 40-character
minimum body of an outcome report (`src/schemas.ts`, SPEC §7a); five outcomes and six revision
kinds (SPEC §3); "three processes racing" (SPEC §4.8). Dates of releases (30 September,
3 October, version 0.1.12) come from PROGRESS.md.
