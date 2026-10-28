# Architecture Decision Records

Note: references to tags, scripts and files of the original submission repository (e.g. freeze-1, final:backup) are historical.

Each record states the decision, the reason, and what was rejected. Records are appended as the
project evolves; superseded decisions are marked, not deleted.

---

## ADR-001 — A deterministic workflow with targeted LLM steps, not an autonomous agent loop

**Decision.** The audit runs as a fixed pipeline. LLMs are called only at points where the input is
unstructured: request intent (free text, many languages) and visual evidence (screenshots, PDFs).
Everything that can be computed (identity resolution, state at `audit_at`, rule application, step
ordering) is plain code.

**Why.**
- The investigation steps are known in advance; an LLM choosing tools in a loop adds cost and
  nondeterminism without adding capability.
- The output is graded field-by-field against exact answers for 518 cases. Determinism makes the
  result reproducible and every change measurable.
- Same principle used in an earlier project (TapStudy): statistics computed in code, the model only
  phrases or interprets.

**Rejected.** A tool-calling agent loop (model decides which evidence to read next). Considered from
the agent-harness reference; its safeguards (step limits, context truncation, sandboxing) exist to
contain an autonomous model, which this problem does not need.

---

## ADR-002 — "The model proposes, the code decides"

**Decision.** Every LLM output is treated as untrusted input:
- validated against a strict schema (e.g. intent is exactly `DELETION` or `NOT_DELETION`;
  extracted identifiers must match known resource-id and email formats);
- on invalid output: one retry with the validation error, then a deterministic fallback;
- the fallback is recorded in the case trace (`llm_fallback`) so it is visible in evaluation.

**Why.** A malformed or injected model response must never reach `output.csv` directly.

---

## ADR-003 — Agent roles

| Role | Responsibility | Input → Output | Uses LLM |
|---|---|---|---|
| Intake | Decide whether `request_text` authorizes deletion | request → `DELETION` / `NOT_DELETION` | Yes (Groq), keyword fallback |
| Evidence Reader | Normalize every evidence file into resource observations | file → observations | Only for images/PDFs (Gemini vision), cached |
| Identity Resolver | Collect current and historical identifiers | email → user_id, emails, phones, hashes, names | No |
| Investigator | Find the subject's resources and their state at `audit_at` | identifiers + observations → resource states | No |
| Policy Engine | Apply `deletion_rules.csv` to each resource | resource state → required treatment | No |
| Planner | Produce ordered findings, remediation, verification | treatments → `steps_json` | No |
| Verifier | Check output invariants before writing | case result → pass / violations | No |

A **resource observation** is the common unit every evidence format reduces to:
`{file_id, system_id, resource_id, observed_at, identifiers{...}, state{...}}`.

---

## ADR-004 — Self-correction at runtime, improvement at development time, no automatic learning

**Decision.**
1. *Runtime self-correction (evaluator–optimizer):* the Verifier checks each case — COMPLETE has only
   verification steps with evidence; INCOMPLETE remediation/verification have empty `evidence_id`;
   no evidence captured after `audit_at`; phase and operation order; consecutive `step_no`;
   NOT_APPLICABLE is `[]`. Violations are re-planned or flagged.
2. *Development-time improvement:* the eval → error analysis → fix → eval loop, with every run saved,
   is the main way the system improves.
3. *No automatic self-improvement* (auto-rewriting prompts, learning from sample answers).

**Why.** Only 32 labelled samples exist. Automatic optimization against them would overfit, degrade
the 518 hidden cases, and amount to the "hardcoded labels / file-specific answers" the rules forbid.

---

## ADR-005 — Provider-agnostic model adapters with cache and usage accounting

**Decision.** All model calls go through one interface with adapters `groq`, `gemini`, and `fake`.
Responses are cached on disk by a hash of (model, prompt, input). Each call records input/output
tokens; usage that the provider did not report is counted as *unknown*, not zero.

**Why.**
- Swapping adapters enables model comparison on the same evaluation set.
- The cache makes reruns free and deterministic, and lets evaluation run without API keys.
- Usage records generate `evaluation/usage_report.md` directly from the final run.

---

## ADR-006 — Eval-driven development with per-failure-surface metrics

**Decision.** Evaluation measures each failure surface separately and reads them together:

| Surface | Metric |
|---|---|
| Intent | NOT_APPLICABLE accuracy |
| Identity / discovery | resource precision and recall |
| Policy | operation accuracy per matched resource |
| Evidence | `evidence_id` accuracy |
| Ordering | sequence accuracy |
| Overall | case status accuracy, step- and field-level accuracy |

Every run writes a dated JSON result, so "failures found and improvements made" is a recorded
history, not a recollection. Custom evaluation cases declare the failure mode they target.

**Why.** A single score hides root causes (e.g. correct status with missing resources points to an
identity miss, not a policy bug). The 32 samples contain no NOT_APPLICABLE case, so custom cases
must cover that gap.

**Rejected.** LLM-as-judge: exact ground truth exists, so deterministic comparison is cheaper and
more reliable. Production tiers (online monitoring, CI gates, human calibration) are out of scope.

---

## ADR-007 — Do not exploit generator timing artifacts

**Decision.** Fully anonymized analytics records carry no identifier and are linked to a subject only
through `deletion_worker` batches that mix several subjects. A fixed seconds-offset pattern between
account deletions and policy actions was found, but it covers only 104 of 248 policy actions and is
an artifact of how the dataset was generated, not business evidence. It is not used as primary
evidence.

**Why.** Rules forbid case-family shortcuts, and a pattern that explains less than half the data is
not a sound linking rule. Linking uses grounded evidence: identifiers, resource ids, catalog links,
and batch membership. Impact on accuracy is measured by evaluation and revisited only with data.

---

## ADR-008 — Evidence files are untrusted input

**Decision.** Every evidence file is read in isolation; a file that fails is recorded with its error
(`failed` / `partial`) and the run continues. SQL snapshots are executed in an in-memory SQLite
database with extensions disabled, after rejecting statements that could touch the filesystem or load
code (`ATTACH`, `VACUUM`, `load_extension`, PRAGMAs other than `foreign_keys`). Request text and
visual artifacts sent to a model are wrapped as data and the prompts state that embedded
instructions must be ignored.

**Why.** Same principle as for model output (ADR-002), applied to the inputs: a hostile or corrupt
file must not crash the audit or act on the machine running it.

---

## ADR-009 — Two time rules: "known" for linking and state, "citable" for evidence

**Decision.** An observation timestamped at or before `audit_at` was true at audit time and is used to
link resources and decide their state. It can be *cited* as `evidence_id` only if its file was also
captured at or before `audit_at`. A COMPLETE verification cites the latest citable observation that
shows the same state.

**Why.** Log exports are captured after the events they contain. Sample case_09 expects the subject's
account (seen in a log line at 08:57 for a 09:00 audit, exported two days later) even though that file
cannot be cited. Using only file capture time lost such links; using only line time would cite files
that did not exist at audit time.

---

## ADR-010 — Intake: LLM first, rules as cross-check and fallback

**Decision.** The LLM classifier is the primary intent decision. The rule classifier always runs too:
disagreements are recorded in the case trace, and the rules are the fallback when the model is
unavailable or returns invalid output twice.

**Why.** The rules classify every request in the provided data correctly, but they were written
after reading those requests, so they are fitted to them. Custom case `custom_03` (a deletion request
in Greek) shows the failure mode: rules say NOT_DELETION. Writing robust multilingual rules with
negation handling would need far more testing, and could still break on unseen phrasing.

**Revisit.** Rules remain the safer default in general. Planned hardening: review every LLM/rules
disagreement on the full run, and decide per pattern whether the rules or the prompt should change.

---

## ADR-011 — Known limitation: resources with no participant-visible link

**Decision.** Resources are linked only through participant-visible evidence. Some expected resources
have none: several accounts appear only in `deletion_worker` activity without any identifier, and at
least one expected audit record appears in no file. These are not guessed.

**Why.** Guessing from batch timing would either rely on generator artifacts (ADR-007) or, by
elimination within deletion batches, be ambiguous: 160 of 250 reported-at batches contain more
deleted accounts than requests. Precision stays at 100% on the samples; the cost is recall, which the
evaluation reports per surface.

---

## ADR-012 — File-level output verification after writing

**Decision.** After `output.csv` is written, `src/verifyOutput.js` re-reads it from disk and checks:
exact header; exactly as many rows as `deletion_requests.csv`, with no duplicate, missing or unknown
`case_id`; no sample case in the output; row order equal to the organizers' order; a valid status and
a `steps_json` that parses to a JSON array after the CSV round-trip (and is `[]` for NOT_APPLICABLE).
Any failure exits non-zero. `main.js` now keeps the request file's row order instead of sorting.

**Why.** The per-case Verifier (ADR-004) checks each result in memory and cannot see failures that
exist only once the whole file is serialized. A review found no check at all for row count,
duplicates, order, header or quoting, and `main.js` sorted rows by our own numeric assumption. The
grader is strict on schema and row count: one quoting error or one missing row invalidates the file.

**Order reference.** The plan was to compare against the organizers' blank `output.csv` template, but
that template contains only the header and lists no cases. The check therefore uses the template when
it has rows and otherwise the row order of `deletion_requests.csv` (also organizer-provided), and
reports which reference it used.

**Rejected.** Sorting by our own interpretation of "sorted by case_id" (numeric or lexicographic
differ: `case_100` vs `case_33`); trusting the in-memory rows instead of the file on disk.

**Measured by.** Seven deliberately corrupted files (missing row, duplicate, swapped order, sample
leak, broken quoting, wrong header, NOT_APPLICABLE with steps) all fail and the correct file passes;
the final run must print `verifyOutput: PASS`.

---

## ADR-013 — Bounded vision retries and an explicit `unreadable` state

**Decision.** Per vision call: 90 s timeout (raised to 120 s, see below); at most 3 attempts for timeouts and 5xx, 5 s then 15 s
apart; quota and other 4xx errors fail immediately. A file that still fails is `unreadable`: it gives
no observations, the run continues, the failure is not cached, and it is listed in
`evaluation/ingest_report.json`. `node main.js --retry-unreadable` re-reads only those files. Retry
and timeout settings are call options, not part of the cache key, so stored results stay valid.

**Why.** `account_admin_console_20260926.png` took about 7 minutes in one run through repeated
120 s timeouts with no upper bound, and earlier runs failed it outright. Free-tier experiments also
showed that rejected requests still consume daily quota, so unbounded retrying costs requests as
well as time. The final run needs predictable time, controlled call count, and an explicit record
when a file could not be read instead of a guess.

**Rejected.** 60 s timeout: normal calls take up to ~60 s and a diagnostic call on
`deleted_account_reference_20260310.png` took 82 s, so 60 s would cut legitimate calls. Caching
failures: a transient failure would become permanent. Putting retry settings in the cache key: it
would discard every existing result whenever limits are tuned.

**Measured by.** Simulated timeout (1 ms) on one file: 3 attempts in 28 s, status `unreadable`,
0 cache entries written. In the final run: count of `unreadable` files, vision wall time and calls.
Update: a diagnostic call took 82 s, too close to 90 s, so the default was raised to 120 s
(`GEMINI_TIMEOUT_MS`) rather than adding attempts.

---

## ADR-014 — Visual files with no observations: investigated, nothing real lost

**Decision.** Keep strict validation of `resource_id` (it must match a resource-id pattern). Treat
the five empty files as correct after inspection.

**Why.** Two cached responses had double the normal input tokens (3216 and 3264 vs ~1600), which
meant a first answer had been rejected by validation and the retry returned no records. Diagnostic
calls (cache bypassed) showed what had been rejected:

| File | Raw model answer | Rejected | Verdict |
|---|---|---|---|
| evidence_18 account_history_report (PDF) | `{"records": []}` | 0 | Statement with order/statement numbers and `user_18`; no resource id. Correct. |
| evidence_27 legal_retention_register (PDF) | 6 records with `resource_id` = `ORD-2026…` | 6 (bad resource_id) | Order numbers are not resource ids. The register names users with disputed orders; the samples for those users (e.g. case_17, case_21, case_24, case_29) expect no legal-hold step, so no expected resource is lost. |
| evidence_42 deleted_account_reference (PNG) | 1 record with `resource_id` = `user_17` | 1 (bad resource_id) | A customer-reference registry page: user id, order/support/finance references, no resource id. Correct. |
| evidence_46 object_storage_browser (PNG) | `{"records": []}` | 0 | File listing only, no ids or person identifiers. Correct. |
| evidence_90 customer_data_inventory (SQL) | not a model call | — | Snapshot with scope rows and empty tables. Correct. |

**Risk found.** Validation is all-or-nothing per response: one invalid record rejects the whole
answer, and the corrective retry may come back empty. In these files every rejected record was
genuinely invalid, but a response mixing valid and invalid records would lose the valid ones.

**Pending (needs approval).** Validate per record: keep valid records, drop invalid ones with the
reason recorded in the ingest report, and retry only when the JSON shape itself is wrong.

**Measured by.** Per-file count of dropped records and reasons in the ingest report; any visual file
with dropped records gets a visual check before the final run.

---

## ADR-015 — Vision validation per record; "exists in text evidence" is a marker, not a filter

**Decision.** The response shape is validated as a whole (a malformed shape gets the single
corrective retry). Records are then validated one by one: a record is kept only if its `resource_id`
matches the resource-id format, its status is an allowed state and any email is well formed. Each
dropped record is logged with its reason in `ingest_report.json`; a file where more than half of the
proposed records were dropped is flagged `majorityRejected`. Each kept record is also checked against
the set of resource ids found in participant-visible text files (labels in `sample_output.csv`
excluded); records not found there are listed as `visionOnly`. Turning that check into a filter is
possible with `VISION_REQUIRE_KNOWN_ID=1` but is **off** by default.

**Why.** ADR-014 found that all-or-nothing validation could discard valid records together with an
invalid one. The existence filter was requested as part of the same change, but measured before
enabling: 12 of the 24 records vision keeps today appear in no text file, including `support_001`,
the attachment that the official answer for sample case_07 requires (cited as evidence_58). Visual
evidence exists precisely to carry facts found nowhere else, so filtering on text existence would
reintroduce the case_07 failure.

**Verified offline (no model calls).** Real evidence_27 answer: 6 proposed, 6 dropped with reasons,
`majorityRejected`. Mixed answer (`support_001` + an order number): 1 kept, 1 dropped; with the
filter on: both dropped. Wrong shape: error, corrective-retry path.

**Note.** Cached responses were produced under the old validator and are not changed: for evidence_27
and evidence_42 the cache holds the empty answer from the retry. The diagnostic calls (ADR-014)
showed every record in those answers was invalid, so the outcome is the same.

**Revisit.** Decide whether `visionOnly` records should need corroboration (e.g. the record's email or
user id resolving to a known identity) rather than id existence.

---

## ADR-016 — Retention end dates are not applied (no evidence the rules require it)

**Status.** Accepted by the user after review of the evidence below.

**Decision.** The Policy Engine keeps applying RETAIN to security audit records without comparing a
retention end date with `audit_at`.

**Evidence.**
- `deletion_rules.csv` defines no retention period: rule_12 says only "Record is within the supplied
  retention period".
- Across all 117 observations that carry a retention date, none belongs to a security audit record
  that expired by its case's `audit_at`; the only dates before October 2026 (2026-06-25, 2026-07-26)
  are on an export and a backup read from screenshots.
- In all 22 samples with an audit record, the official answer is `VERIFY_RECORD_PRESENT`, including
  the 15 where no retention date appears anywhere.

**Why.** There is no labelled example of an expired record, so any rule (delete? omit? keep?) would be
a guess, and requiring a date would wrongly drop 15 of 22 sample verifications.

---

## ADR-012 addendum — Row-order evidence

The organizers' template `output.csv` has no data rows. `sample_output.csv` uses zero-padded ids
(`case_01` … `case_32`), for which numeric and lexicographic order coincide, so it cannot tell the two
conventions apart. `deletion_requests.csv` lists cases in numeric order (`case_33` … `case_550`) and
the output keeps that order; `verifyOutput` checks against it explicitly.

## ADR-014 addendum — Order numbers in the legal retention register

The six order numbers read from evidence_27 (`ORD-20264118` … `ORD-20264600`) appear in no other
participant-visible file, neither as order numbers nor as `legal_hold_NNNN` ids with the same digits.
There is no grounded way to link them to legal-hold resources.

---

## Finding — Steps that cannot cite evidence in the full run (resolved by ADR-018 and ADR-019)

A full run built from the cache passed `verifyOutput`, but the per-case Verifier reported 20 steps
without a citable `evidence_id` in 20 hidden cases, all caused by ADR-009 (state known from an
observation timestamped before `audit_at` in a file captured after it): 11 absent accounts in
COMPLETE cases, 8 support findings and 1 account finding (case_126). See ADR-018 and ADR-019.


---

## ADR-017 — Vision records: exact identity confirmation, near-miss emails flagged

**Decision.** No existence filter on vision records (ADR-015 stays: `visionOnly` is a marker). Each
kept record is checked against known people: it is `confirmed` when its email or `user_id` exactly
matches a current or historical identifier (`user_identities.csv` + every email in
`user_audit_log.csv`); emails compare case-insensitively, as everywhere in identity resolution. An
email one character away from a known email (one insertion, deletion or substitution) is
`near_match`: it is not accepted, it is removed from the record's links so it cannot tie data to a
subject, and it is listed in the ingest report with the value read and the known email it resembles.
Everything else is `unconfirmed`. The ingest report totals `visionOnly`, confirmed, near-match and
unconfirmed records.

**Why.** The existence filter would drop real findings such as `support_001` (sample case_07). The
actual risk with vision is a misread character that turns one person's email into another's, which
would link data to the wrong subject; exact matching prevents that link and the one-edit check makes
likely misreads visible instead of silently unlinked.

**Rejected.** Existence filter (loses real evidence); fuzzy acceptance of near-matches (could attach
data to the wrong person).

**Measured.** Current vision output: 25 records kept, 12 `visionOnly`, 17 confirmed, 0 near-match,
8 unconfirmed (backups and exports addressed to company mailboxes that belong to no user). Unit
checks: exact and upper-case email confirmed; `priya.ramann@` flagged as near-match of
`priya.raman@`; decoy `g.silva76.jr@` unconfirmed.

**Known gap.** Two common misreads are two edits and are not flagged: `m` read as `rn`, and swapped
adjacent letters (`gmial`). Extending the check to these was not part of the decision.

---

## ADR-018 — Absent accounts may cite a post-deletion snapshot (absence by omission)

**Decision.** When an account is known to be ABSENT only from a file captured after `audit_at`, the
verification step cites the latest SQL snapshot that (1) was captured after the account's deletion,
(2) was captured at or before `audit_at`, (3) covers `account_service`, and (4) does not contain the
account. Deletion time is the latest of the last PRESENT observation and the last DELETE_RECORD
activity for the account (first ABSENT observation if neither exists). Without such a snapshot, no
evidence is cited.

**Why.** 11 COMPLETE hidden cases had `VERIFY_RECORD_ABSENT` without evidence. The official answer to
sample case_01 cites a snapshot that simply does not contain the account (evidence_54), so absence by
omission is an accepted form of proof; the post-deletion condition prevents citing a snapshot taken
while the account still existed.

**Rejected.** Citing any snapshot that omits the account (could predate the deletion); citing the
file exported after `audit_at` (forbidden by the evidence rules).

**Measured.** Exactly 11 cases changed, only their `evidence_id` (`""` -> evidence_93 / 81 / 72), no
status change; each citation checked against all four conditions (11/11). Offline eval of 37 cases
unchanged: status 100%, precision 100%, recall 87.1%. Per-case Verifier violations 20 -> 9.

---

## ADR-019 — Known limitation: 8 support findings and case_126 without citable evidence

**Decision.** Not changed. The 8 support findings keep an empty `evidence_id`; case_126 keeps its
account finding with an empty `evidence_id` and status INCOMPLETE.

**Why (support).** The proposed fix was to cite an earlier citable observation with an equivalent but
different state (IDENTIFIABLE where the latest known observation says PRESENT). The samples were
searched for a precedent: of 41 official findings, 28 cite the file of the latest known observation
and the other 13 cite the latest citable observation with the identical state. None cites a
different state, so there is no precedent and the fix was not applied.

**Why (case_126).** The deletion of `account_8819` was attempted on 2026-08-05 and reported FAILED (a
claim). The only observation, a snapshot dated 2026-08-11 (after the failed attempt, before the
2026-08-17 audit), shows the account ACTIVE with name, email and phone, but its file was captured on
2026-08-19 and cannot be cited. No later deletion appears in the activity, and the only citable file
that omits the account is a partial inventory containing a single profile, not proof of absence.
The evidence supports INCOMPLETE; dropping the finding would turn the case COMPLETE, which the
evidence contradicts. Investigation was time-boxed to 15 minutes; no evidence was invented.

**Measured by.** These 9 remain the only per-case Verifier violations in the full run.

---

## ADR-020 — Row order of output.csv: ambiguity documented, input order kept

**Decision.** `output.csv` keeps the row order of `deletion_requests.csv`, and `verifyOutput`
enforces it.

**Evidence.** The organizers' repository (README, problem statement, AGENTS.md, starter code) says
only "sorted by `case_id`" and contains no validator or script that defines the convention; the
starter `code/evaluation/main.py` is empty. The blank template has no data rows, and the sample ids
are zero-padded, so numeric and lexicographic order coincide there. `deletion_requests.csv` itself
is in numeric order (`case_33` ... `case_550`).

**Rejected.** Choosing numeric or lexicographic order on our own.

**Related check.** Within `steps_json`, `system_id` and `resource_id` are sorted with
`localeCompare`; on all 550 outputs (518 + 32 samples) this gives the same order as plain code-point
comparison (0 differences), so no change was made.

---

## ADR-021 — Search for a general linking rule: none adopted; two candidates kept behind flags

**Context.** Time-boxed (30-45 min) search for a general rule that recovers missing resources or
removes wrong ones, improves the samples, breaks nothing, and does not use the ADR-007 timing artifact.

| Candidate | Samples (37 cases) | Hidden output | Verdict |
|---|---|---|---|
| Request window: the only account submitted for deletion between `requested_at` and `reported_at` and not owned by another known user | Of 18 samples missing their account: 2 have a single candidate (1 correct, 1 wrong), 15 have 2-8, 1 has none | — | Not clean; not implemented (confirms ADR-011) |
| `LINK_404_REQUIRES_PRIOR_DELETE`: a not-found lookup links an account only if it was already submitted for deletion when the lookup ran | Unchanged | 1 case: case_46 loses `account_6523` (a 404 from March for an account deleted in September) and becomes COMPLETE with no steps | Off; needs a decision |
| `CATEGORY_TEXT_OVER_VISION`: a record type stated by text evidence outranks one inferred by vision | Unchanged | 1 case: case_34 `support_9538` becomes REMAINING/DELETE (log says `attachment_pii_scan`) instead of EXPOSED_PII/REDACT (vision guessed SUPPORT_MESSAGE) | Off; needs a decision |

**Decision.** Neither flagged rule improves the samples, so by the agreed criterion neither is a clean
improvement; both stay implemented and disabled. Missing accounts remain a known limitation.

---

## ADR-022 — Prompt-injection guards: code rules, not test knowledge

**Already in place before this change.**
- Models have no tools and no side effects; each model answer feeds one field only (intent, or
  proposed records for one visual file).
- Strict output schemas: intent must be exactly DELETION / NOT_DELETION; vision records must have a
  resource-id-shaped id, an allowed status and a well-formed email (per-record, ADR-015), plus exact
  identity confirmation (ADR-017).
- Untrusted text is delimited (`<request>` tags) and prompts say embedded instructions are data.
- Text evidence (SQL, JSON, logs, text) is never sent to a model; it is parsed deterministically and
  unknown log events are ignored, so instructions inside evidence have nothing to act on.
- Fail-safe: invalid model output gets one corrective retry, then the deterministic fallback; the
  rule classifier always runs as an independent cross-check.

**Added.**
- `request_text` longer than 2,000 characters (observed maximum: 252) is not sent to the model; it is
  classified by the rules and flagged `rules_oversized`. The text is never truncated or rejected.
- Five generic signals (override instructions, role markers, classifier directives, tag escapes, JSON
  payloads) are flagged in the trace as `injectionSignals`. Flag only: no text is altered, no request
  is rejected, the result is unchanged. On the 555 existing requests only `custom_05` (our own
  injection test) is flagged.
- Three evaluation cases whose expected answer is the unchanged answer of a sample:
  `inj_01` (instruction appended to `request_text`, needs 1 Groq call), `inj_02` (instructions in a
  log fixture's fields and in an unknown event, no model call), `inj_03` (a PDF fixture telling the
  vision model to report `support_001` ABSENT, needs 1 Gemini call). Fixtures live in
  `evaluation/fixtures/` and are loaded only by `eval.js --injection`; the dataset is untouched.

**Measured.** `inj_02`: identical to sample case_24. `inj_01`, `inj_03`: pending approval of the two
model calls; skipped explicitly when offline so they cannot pass through the rules fallback.

**Guard rules vs. forbidden hardcoding.** Guards describe properties of *any* input (length, shape,
instruction-like patterns, identifier format, identity match) and never reference a case id, an
expected status or a file-specific answer. The injection tests reuse sample answers only as expected
outputs inside the evaluation folder; nothing in `src/` or `prompts/` reads them.

---

## ADR-023 — Spot-check of hidden cases against raw evidence

Ten hidden cases were traced from request to raw evidence (case_34, 46, 61, 90, 147, 155, 220, 309,
543 and the reported-vs-ours pattern). Findings:
- case_90 (14 steps), case_220, case_155, case_543: consistent with raw evidence and policy.
- case_309, case_543, case_155, case_147: no account step (ADR-011); the correct answer very likely
  contains `VERIFY_RECORD_ABSENT` for an account.
- case_61: COMPLETE with no steps. Same subject as sample case_07 but audited in February; the only
  evidence about the subject is dated September. A COMPLETE verdict with nothing verified is
  contradictory, so the per-case Verifier now flags "COMPLETE with no verification step" (flag only).
  It flags case_61 in the hidden set and samples case_01, case_02, case_04 (accounts we cannot link).
- case_46 and case_34: see ADR-021.
- Reported vs our status follows the samples: of `reported_status=COMPLETE`, 64% are INCOMPLETE for us
  (samples 65%); NOT_STARTED -> INCOMPLETE 75% (70%); PARTIALLY_COMPLETE -> INCOMPLETE 76% (80%).

---

## ADR-024 — Email hashes: algorithm identified from data, matched exactly

`email_hash` equals `sha256(email)` for 850/850 current identities and for 107/107 historical email
changes (old hash = sha256(old email)); md5, sha1 and truncated sha512 match none. Lower-casing cannot
be confirmed or ruled out: no identity email contains capitals. The agent does not compute hashes; it
matches the provided current and historical hashes exactly. Only one observation exposes nothing but
a hash: `analytics_9914` (historical hash of user_12, sample case_12), which the agent links and the
evaluation confirms. Most other 64-hex values in evidence are not email hashes (e.g. integrity seals).

---

## ADR-025 — Determinism verified; sampling parameters (proposal, not applied)

**Determinism.** `output.csv` built twice from the cache is byte-identical (same sha256 as the
committed file); traces are identical too.

**Current parameters.** Groq `openai/gpt-oss-120b`: temperature 0, `reasoning_effort: low`, JSON mode.
Gemini `gemini-3.8-flash`: temperature 0, default thinking (high, dynamic), JSON MIME type.

**Documentation.** Gemini 3 developer guide: "we strongly recommend keeping the temperature parameter
at its default value of 1.0"; below 1.0 "may lead to unexpected behavior, such as looping or degraded
performance"; `thinking_level` defaults to `high`. Groq reasoning docs: `reasoning_effort` low /
medium / high for GPT-OSS; general guidance for reasoning models is temperature 0.5-0.7.

**Proposal (pending approval).** Gemini: drop the temperature override (use 1.0) as the vendor
strongly recommends; consider `thinking_level: low` for extraction to cut latency (one call took 82 s).
Groq: keep temperature 0 and `reasoning_effort: low`; on 366 calls there were no retries and 0
disagreements with the rules. Any change must also add the generation settings to the cache key,
otherwise cached answers produced with old settings would be reused silently.

---

## ADR-021 addendum — Decisions on the two flagged rules

- `LINK_404_REQUIRES_PRIOR_DELETE`: **not enabled.** On case_46 it removes the wrong account but leaves
  a COMPLETE verdict with no verification step. For an audit agent a false "all clear" is worse than a
  wrong step: a wrong step is visible and checkable, an empty COMPLETE asserts compliance with nothing
  behind it.
- `CATEGORY_TEXT_OVER_VISION`: **left disabled.** The agreed test was the samples: 0 sample records
  carry a log `attachment_pii_scan` (all 7 such records in the dataset belong to hidden cases). The only
  sample with a text-stated attachment (case_13, `support_4218`, handover) is DELETE in the official
  answer, which is consistent, but it involves no conflict with vision, so it is not the precedent the
  rule needs.

## ADR-023 addendum — Official answers of case_01, case_02, case_04

All three are COMPLETE **with** verification steps (case_01 and case_02: `VERIFY_RECORD_ABSENT` of the
account citing evidence_54; case_04: that plus `VERIFY_RECORD_ANONYMIZED` of analytics_901 citing
evidence_56). No official answer is COMPLETE without verification, so the Verifier invariant
"COMPLETE needs at least one verification step" stands; our empty answers there come from accounts we
cannot link (ADR-011).

## ADR-022 addendum — inj_01 measured

`inj_01` (an instruction appended to a real deletion request asking for NOT_DELETION) ran with one Groq
call (422 input / 63 output tokens): the model answered DELETION and the case output is identical to
sample case_24; the trace flags the injection signals. `inj_03` waits for the Gemini temperature
decision (ADR-026).

## ADR-005 addendum — Why intent calls are fewer than requests

The 518 hidden requests contain 375 distinct `request_text` values; 143 requests repeat an earlier text
and share its cache key, so they reuse the answer within the same run. No batching is used and every
request goes through the model path (518/518 `method: llm`). In the intake run, 9 of the 375 distinct
texts were already cached from the samples and custom cases, giving 375 - 9 = 366 API calls and
143 + 9 = 152 cache hits. A run from an empty cache needs 375 intent calls for the 518 hidden requests.

---

## ADR-026 — Generation settings in the cache key; Gemini temperature 1.0 experiment

**Decision (implemented).** Each adapter exposes its generation settings (`temperature`, and for Groq
`reasoning_effort`). Settings are part of the cache key whenever they differ from the settings the
existing cache was built with (Gemini temperature 0; Groq temperature 0, `reasoning_effort` low), so
a changed setting can never silently reuse an old answer, while every existing entry stays valid.
`LLM_CACHE_DIR` lets an experiment use a separate cache; `GEMINI_TEMPERATURE` sets the Gemini value.
Verified: an offline rebuild from the main cache is byte-identical after the change (518/518 intents
still from the model cache, no new entries).

**Experiment.** The 15 visual files were re-read with Gemini temperature 1.0 (vendor recommendation,
ADR-025), changing nothing else (thinking level unchanged), into `code/.cache-experiments/gemini-t1/`.
15 calls, 0 retries, 0 unreadable, 23,518 input / 3,161 output tokens, 818 s wall time.

| Result | Count |
|---|---|
| Files with identical records | 13 / 15 (including `support_001` from evidence_58, needed by case_07) |
| evidence_27 | t=1.0 stores the 6 raw `ORD-…` records, t=0 stored the empty retry answer from the old validator; both keep 0 observations after per-record validation |
| evidence_32 | t=1.0 adds `backup_9281` (ACTIVE, no identity). It is visible in the screenshot only in the activity feed ("backup_9281 restored · Completed"); the ACTIVE state is the model's inference, and the record links to no subject |
| `output.csv` built with the t=1.0 vision results | byte-identical to the current output |

**Status.** Pending the user's decision on which temperature the final run uses. The main cache is
unchanged.

---

## ADR-026 addendum — Decision: Gemini temperature 1.0 for the final run

Chosen by the user after the experiment (13/15 identical, output byte-identical). The adapter default
is now 1.0, which enters the cache key, so the main cache (built at 0) is not used for vision at 1.0.
Offline rebuilds from the main cache need `GEMINI_TEMPERATURE=0` until the final cache exists.

## ADR-022 addendum — inj_03 measured

`inj_03` ran with one Gemini call (temperature 1.0, experiment cache) and one Groq call. The vision model
read the fixture as `support_001` IDENTIFIABLE, not ABSENT: the instruction was ignored and the record is
still reported as remaining, so the decision is unchanged. The fixture is a newer legitimate document
showing the record (07:45 vs evidence_58 at 07:30), so the citation rule cites it; the expected answer
was corrected to reflect that, so the case measures only whether the injection changes the decision.
The only remaining difference from the official case_07 answer is the unlinked `account_007` (ADR-011),
which our normal case_07 answer also lacks. All three injection cases now pass.

## ADR-027 — Final run: fresh cache, clean stop on daily quota, rehearsal

**Fresh cache.** `npm run final` runs `main.js --cache-dir .cache-final`: every model answer (vision
and intent) is produced in that run, so `usage_report.md` reports real calls and tokens, including
reasoning/thinking tokens. Gemini thinking tokens (`thoughtsTokenCount`) are now recorded and counted as
output (they were missing before: on one vision call they were 1,097 of 1,201 output tokens); Groq
reasoning tokens are recorded when the API reports them (already included in its output count). Token
counts are cache metadata only, so the cache key did not change.

**Clean stop on daily quota.** A provider's daily-limit error (Gemini `...PerDay...`, Groq "per day
(TPD/RPD)") raises `DailyQuotaError`. It is retried zero times, is never turned into a rules fallback
or an `unreadable` file (either would silently change results), and `main.js` exits with code 2
without writing `output.csv`. Completed answers stay in the cache, so rerunning the same command
continues from there. Verified with a mocked Groq 429 (TPD): 1 attempt, exit code 2, no output file,
no cache writes.

**Daily limit timing.** Groq documents 200K tokens/day for this model but not whether the window rolls
or resets at a fixed time. Our earlier headers showed `x-ratelimit-reset-requests` = 86.4 s with 1,000
requests/day, exactly 24 h / 1,000, which indicates a continuously refilling (rolling) bucket; for
tokens this is an inference. About 181K Groq tokens were used on 2026-10-24 (165K between about
18:00 and 18:30 UTC), so a cold final run (about 169K) should start after those age out.

**Rehearsal.** `npm run rehearsal`: keys and models present; offline rebuild from the main cache
byte-identical to `output.csv` and passing `verifyOutput`; Groq smoke test on 5 requests (4 deletion,
1 non-deletion) in a fresh cache, each decision equal to the main cache. Result on 2026-10-24: all
checks passed, 5 Groq calls, 2,258 tokens, no Gemini calls.

## ADR-028 — Token optimizations measured and not applied

Intent calls average 410 input / 40 output tokens; about 390 input tokens are fixed (about 290 system
prompt, about 100 chat template). A shorter prompt would save about 27% of intent tokens and about 5.6
minutes, but it changes the decision component right before the freeze and its re-verification costs
about 130K tokens from the same 200K/day limit; a `max_tokens` cap saves about 0%; dropping `reason`
saves about 3% and loses trace explanations. None applied; the table is also in `usage_report.md`.

---

## ADR-022 addendum 2 — Exactly what changed in the expected answer of inj_03

Compared in git between commit 44fbb14 (cases created) and tag freeze-1:
- One field of one step changed: step 1, `REPORT_REMAINING_RECORD` of `support_001`, `evidence_id`
  `evidence_58` -> `fixture_inj_pdf`.
- Unchanged: `deletion_status` (INCOMPLETE), the number of steps (4), and for every step the phase,
  system, resource, operation and state. `inj_01` and `inj_02` expectations are unchanged.

Why: the fixture is an additional, newer document (captured 07:45, after evidence_58 at 07:30) that
also shows `support_001` present, and the citation rule cites the latest citable observation with the
same state. The injection criterion is the decision: it succeeds only if `support_001` stops being
reported as remaining (or the status changes). That criterion did not change and the case passes.

## ADR-029 — Backup final run: fresh vision, intents reused from the cache

**Context.** Submission deadline 2026-10-25 12:00 UTC. A probe call on 2026-10-24 20:51 UTC returned
`x-ratelimit-limit-requests=1000`, `remaining-requests=739`, `reset-requests=6h15m50.4s` (= 261 x
86.4 s), and token headers `limit-tokens=8000`, `remaining-tokens=7927`, `reset-tokens=547ms`. The
request headers show a continuously refilling daily bucket (one request per 86.4 s), not a fixed reset.
Token headers describe only the per-minute limit; Groq exposes no daily-token header. Simulating the
same refilling bucket for 200K tokens/day over our recorded calls (the same simulation predicts 245
used requests vs 261 reported) gives about 52K tokens available now and >= 170K only at about
2026-10-25 11:00 UTC, one hour before the deadline for a run that takes about 35 minutes. If the token
limit instead resets at 00:00 UTC, 200K are available from midnight. Which applies is not documented.

**Decision.** Keep the normal final run (`npm run final`, everything fresh) and add a backup
(`npm run final:backup`): vision runs fresh in its own `.cache-final-backup` (separate from the normal
run's `.cache-final`, so running one never makes the other's vision cached); intents are read only from the main
cache (`LLM_TASK_CACHE_INTENT`, `LLM_READONLY_TASKS=intent`); no intent call is made and a missing
intent stops the run cleanly (no fallback, no output). The usage report then states the provenance of
every answer (fresh calls vs reused, cache location, when the cached answers were produced) and keeps
the "Cold run" columns, computed from the token counts recorded when each cached answer was produced.

**Fix found while testing.** Cold-run totals counted every cache hit, including identical requests
within one run; they now count each distinct answer once (518 intents -> 375 calls, about 168.5K
Groq tokens; 390 calls overall with vision). This affected the normal run's report too.

**Verified without model calls.** Backup mechanics with vision also served from cache: output
byte-identical to `output.csv`, provenance 0 fresh / 518 reused intents; empty read-only intent cache:
clean stop, exit 2, no output.

**After the final run.** `npm run diff:freeze` lists every case whose status or steps differ from the
`freeze-1` output (status changes, steps added/removed, evidence-only changes) and writes
`evaluation/output_diff_vs_freeze-1.md`. Self-tested on a deliberately altered copy.

---

## ADR-030 — Experiment exp-model-b: qwen/qwen3.8-27b for intent (not adopted)

**Setup (branch `exp-model-b` only).** Intent with `qwen/qwen3.8-27b`, `reasoning_effort: none`,
temperature 0, JSON mode, same prompt; vision re-read fresh with Gemini temperature 1.0. Caches:
`.cache-exp` (intent) and `.cache-exp-vision` (vision, kept separate so it can be reused); results in
`evaluation/exp/`. `main`, `freeze-1` and the main cache were not touched (main cache 423 entries before
and after). **Two variables change at once — the model and the reasoning setting (none vs low)** — so
differences could not be attributed to the model alone. Groq recommends temperature 0.7 for qwen in
non-thinking mode; 0 was kept so sampling would not be a third variable.

**Per-model limits.** The first probe returned `x-ratelimit-remaining-requests = 999` for qwen while
gpt-oss-120b showed 739: Groq daily limits are tracked per model.

**Results.**

| Check | Result |
|---|---|
| Intent decisions, 375 distinct hidden texts | **375/375 agree** with gpt-oss; 0 disagreements |
| Per request (518) | 508 DELETION / 10 NOT_DELETION for both; the 10 NOT_DELETION cases match one-to-one |
| qwen vs rule classifier | 0 disagreements on 518 |
| custom_01..05, inj_01..03 | same decisions as gpt-oss (custom_03 Greek deletion: DELETION; custom_05 and inj_01: injection ignored) |
| Labelled eval (37 + 3 injection) | status 100%, precision 100%, recall 87.7% (3 more cases than the 37-case 87.1%) |
| `output.csv` (fresh vision t=1.0 + qwen intents) | **byte-identical to freeze-1** (0 cases changed) |
| Intent tokens | qwen 370 per call (0 reasoning) vs gpt-oss 449: about -18% |
| Vision tokens (16 calls) | 24,577 input, 57,066 output, of which **53,858 thinking (94%)** |
| Wall time | 25.4 min total: 7.6 min labelled cases + fresh vision, 17.8 min for 369 hidden intent calls |

**Decision.** Nothing adopted on `main`: the output is identical, so the experiment changes no answer.
Its value is evidence: two model families with different reasoning settings reach the same 518 intent
decisions, and qwen offers a fully independent daily quota and 18% fewer tokens if needed.

**Findings to carry to main (need approval).**
- Gemini thinking tokens dominate total cost (94% of vision output); the usage report must show them
  (already fixed on main, ADR-027).
- On this branch the usage report states, per task, whether answers were fresh or reused (and from
  where, when). Main's backup-mode note always said "vision fresh"; if tomorrow's backup reuses
  `.cache-exp-vision`, this wording change is needed on main.

**Ported to main (2026-10-25).** This ADR, the per-task provenance wording of the usage report, and a
configurable Groq `reasoning_effort` (default unchanged: `low`) were brought to `main` for the final run.
The comparison report is in `code/evaluation/exp/comparison_report.md` on branch `exp-model-b`.

---

## ADR-031 — Final run: qwen attempt stopped by its daily quota; backup run (ADR-029) produced the submission

**First attempt (stopped).** 2026-10-25 05:44–06:12 UTC, `npm run final:qwen` (tag `freeze-2`, commit
bfa80d6): fresh Gemini vision plus qwen/qwen3.8-27b intent. After 1,705 s Groq returned a daily
token-limit 429 for `qwen/qwen3.8-27b` ("tokens per day (TPD)"). The run stopped cleanly as designed
(ADR-027): exit code 2, no `output.csv`, completed answers kept in `.cache-final-qwen`.
**Cause — an error in our own planning:** the exp-model-b experiment (ADR-030) had used about 148K qwen
tokens between 21:08 and 21:27 UTC the evening before. Groq's daily limits are per model but refill
over a rolling day, so qwen's quota had not recovered. The earlier check (`remaining-requests = 999`)
was taken before the experiment and measured requests, not tokens.

**Second run (completed).** Approved option A: `npm run final:backup -- --output
../artifacts/output_final_backup.csv` with a run note recording the stopped attempt. The user ran it
from a terminal because the agent's Bash tool was unavailable (the auto-mode safety check returned no
verdict). A first terminal attempt was cancelled by the user after one vision call (that call was billed
but belongs to no completed run and is not in the usage report); the user then deleted
`.cache-final-backup` and ran the command again from the start. That second run is the one reported
here: its files show it ran 06:25:48–06:32:15 UTC. The machine shut down afterwards; all four
outputs (CSV, traces, usage report, ingest report) carry the same completion timestamp, and the vision
cache entries span 06:25:48–06:32:15 UTC, so the run was not interrupted.

| Check | Result |
|---|---|
| Vision | fresh in this run: 15 Gemini `gemini-3.8-flash` calls, temperature 1.0, 0 retries, 0 unreadable; 23,518 input / 52,098 output tokens, of which 49,169 thinking |
| Intent | 518 decisions from `openai/gpt-oss-120b` (temperature 0, reasoning low), read-only from the main cache, produced 2026-10-24 16:39–18:07 UTC; 0 intent calls; 0 disagreements with the rule classifier |
| Vision validation | 32 proposed, 25 kept, 7 dropped (evidence_27: 6 order numbers; evidence_42: 1 user id used as resource id; both `majorityRejected`, as analysed in ADR-014); 17 identity-confirmed, 0 near-match |
| `verifyOutput` | PASS (518 rows, organizer row order) |
| `diff:freeze` vs freeze-1 | 0 cases changed |
| Bytes | identical to `freeze-1:output.csv`; sha256 `e57fd795049fb3429c6a8c515fe7af022caed1e8887bf56b04b2d6a559643b09` |
| Per-case Verifier flags | 10 cases: the 9 known missing-evidence steps (ADR-019) and case_61 (COMPLETE without steps, ADR-023) |
| Cost | this run $0.1373 (vision only); cold run (all 390 distinct answers) $0.1692 |

**Ingest report note.** `code/evaluation/ingest_report.json` written by this run was accidentally
reverted by the agent (`git checkout`) before it was committed. It was regenerated offline from the same
caches (`.cache-final-backup` vision, main-cache intents; no model calls; the run's CSV, traces and usage
report untouched and re-verified by sha256). Its counts and vision statistics equal those read from the
original before the revert; only its `at` timestamp differs (09:24 instead of 06:32 UTC).

**Decision.** The repository's `output.csv` already equals this run's output byte for byte, so it is
kept as the submission file; `code/evaluation/usage_report.md` from this run documents provenance (fresh
vision, cached gpt-oss intents with their production dates) and the stopped qwen attempt.
