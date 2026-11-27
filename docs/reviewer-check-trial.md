# Reviewer-written checks: manual phase 0

After release, Ada home runs this once from the release checkout with the production
`SITE_DATA_DIR` and provider keys, using `npm run librarian-smoke -- --reviewer-checks`.
The worker must not make a paid call. This flag cannot be combined with other smoke flags.

The mode selects all known-bad `CANARIES`, then ten current published, reviewed revisions
with nonblank bodies, ordered by creation time descending and id descending as a tie-breaker.
It prints their ids before calling a model and refuses an undersized published sample.
The SQLite connection is read-only; no migration, moderation or content write runs.

Each item gets one draft from Claude Opus 5.5 medium and one from GPT-6 Sol medium,
each with 4,000 maximum output tokens. Each usable draft (including `no_check`) is judged
once by the other model. Invalid/refused drafts are recorded without a judgement.
Both prompts are trial-only; the nightly rubric, rotation and combination rule are unchanged.
The annotation canary remains an annotation, and nontechnical items may warrant `no_check`.

Every returned call, including malformed output and refusal, is charged to the nightly
`librarian-spend.jsonl`. Before each call, the mode reserves its worst-case cost and stops
if it could bring this trial to $1. A transport or ledger error stops immediately without
retrying; the outstanding reservation is retained as potentially billed spend. Investigate
that unknown charge before retrying manually. This is a per-run cap, so repeated invocations
would each have a new allowance.

The console table includes the promise, command, expected observations or abstention reason,
cross-judgement and combined draft/judgement cost. A private JSON report is atomically saved
after every result under `SITE_DATA_DIR/trials/reviewer-checks/`, with a unique filename.
Partial runs retain the selected items, parsed responses, statuses, actual known spend and
reserved spend. Exit status 1 means incomplete calls, invalid output or a budget/error stop;
it does not mean the check failed. Generated commands are untrusted text and are never run.

For manual scoring, use `CATCH_NOTES` in `src/librarian/reviewer-check-trial.ts` as the answer
key. It covers every known-bad canary and is never sent to either reviewer. For each draft,
record whether it would catch the planted bug (or appropriately abstain on manipulation
and nontechnical content), with a reason. For published revisions, separately score whether
the command is runnable under the stated conditions and observes the promise independently
of the author's test and the files the fix edits. Do not equate `accepts` with a passing
independent check. Compare the manual assessment with the cross-judgement, count agreements,
and count invalid output, missing judgements and `no_check` separately from actual commands.

Ada home records the results next to the research proposal, reports them to Randall, and
prepares the short forum results reply. Posting its wording still requires Randall's OK.
