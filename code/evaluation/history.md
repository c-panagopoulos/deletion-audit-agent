# Evaluation history

One line per change that affects results. Metrics are from `npm run eval` on the 32 samples
(37 cases once the custom cases were added); each run's full record is in `evaluation/runs/<timestamp>.json`.
This file feeds "failures found and improvements made" in `evaluation_report.md`.

| Run (UTC) | Cases | Status | Step precision | Step recall | Resource recall | N/A acc. | Change | Failure that motivated it |
|---|---|---|---|---|---|---|---|---|
| 2026-10-24 15:39 | 32 | 75.0% | 99.2% | 65.8% | 55.0% | n/a | Baseline: rules intake, no vision | — |
| 2026-10-24 15:42 | 32 | 96.9% | 100.0% | 84.5% | 74.8% | n/a | Two time rules (ADR-009), one primary account per subject, broader intake rules | Accounts seen in logs exported after `audit_at` were dropped; a stale 404 lookup added a wrong account (case_17); "deleting", "removed", "is gone" missed by intake |
| 2026-10-24 16:00 | 32 | 96.9% | 100.0% | 84.5% | 74.8% | n/a | LLM layer wired, no API keys (rules fallback) | Regression check only: no change expected, none observed |
| 2026-10-24 16:01 | 37 | 94.6% | 100.0% | 82.5% | 73.6% | 100.0% | 5 custom cases added | Samples contain no NOT_APPLICABLE case; custom_03 (Greek deletion) fails under rules |
| 2026-10-24 16:40 | 37 | 97.3% | 100.0% | 85.7% | 76.0% | 100.0% | LLM-first intake (gpt-oss-120b), rules as cross-check (ADR-010); vision partly available | custom_03 now correct |
| 2026-10-24 18:08 | 37 | 100.0% | 100.0% | 87.1% | 76.9% | 100.0% | All 15 visual files read (gemini-3.8-flash); vision retry policy (ADR-013); file-level verifier (ADR-012) | case_07: the attachment existed only in a PDF (evidence_58) |
| 2026-10-24 18:30 | 37 | 100.0% | 100.0% | 87.1% | 76.9% | 100.0% | Vision identity confirmation (ADR-017); post-deletion omission citation for absent accounts (ADR-018) | Regression check: sample metrics unchanged, as expected |

## Changes not visible in sample metrics

| Date (UTC) | Change | How it is measured |
|---|---|---|
| 2026-10-24 | `main.js` keeps the organizers' row order instead of our own numeric sort | `verifyOutput` row-order check on the final `output.csv` |
| 2026-10-24 | Intake on all 518 requests: 518/518 by LLM, 0 LLM-vs-rules disagreements, 508 deletion / 10 not | Disagreement count in case traces of the final run |
| 2026-10-24 | Vision: 90 s timeout, max 3 attempts, `unreadable` status, `--retry-unreadable` | `unreadable` count in `ingest_report.json`; vision wall time and calls in the final run |
| 2026-10-24 | Vision timeout raised to 120 s (a diagnostic call took 82 s) | Same as above |
| 2026-10-24 | Vision validation per record (ADR-015); text-existence check as marker only | Dropped records and reasons per file in `ingest_report.json`; no change on cached answers (offline eval unchanged) |
| 2026-10-24 | First full output from cache: 518 rows, verifyOutput PASS, 355 INCOMPLETE / 153 COMPLETE / 10 NOT_APPLICABLE; per-case Verifier: 20 steps without citable evidence | Copy in `artifacts/`; violations analysed in decisions.md (pending decision) |
| 2026-10-24 | Absent accounts cite a post-deletion snapshot (ADR-018): 11 hidden cases, `evidence_id` only, no status change | Per-case Verifier violations in the full run: 20 -> 9; diff against `artifacts/output_before_adr017-020.csv` |
| 2026-10-24 | 8 support findings and case_126 left without citable evidence (ADR-019) | Remaining per-case Verifier violations: 9 |
| 2026-10-24 | Status mix of the full run: 153 COMPLETE / 355 INCOMPLETE / 10 NOT_APPLICABLE; among deletion requests 30.1% / 69.9%, samples 31.3% / 68.8% | Recomputed on every full run |
| 2026-10-24 | Per-case Verifier flags COMPLETE with no verification step (ADR-023) | Flags case_61 (hidden) and samples case_01, case_02, case_04; outputs unchanged |
| 2026-10-24 | Injection guards and 3 injection cases (ADR-022); eval with `--injection` now 38 cases offline (inj_01, inj_03 pending model calls) | inj_02 identical to case_24; status 100%, precision 100%, recall 87.5% (extra passing case, not an improvement) |
| 2026-10-24 | Experimental linking flags (ADR-021), both off | 404 rule: 1 hidden case changes (case_46); category rule: 1 hidden case changes (case_34); samples unchanged for both |
| 2026-10-24 | Flag `LINK_404_REQUIRES_PRIOR_DELETE` rejected (produces COMPLETE without steps); `CATEGORY_TEXT_OVER_VISION` left off (0 samples with `attachment_pii_scan`) | ADR-021 addendum |
| 2026-10-24 | inj_01 measured with 1 Groq call: unchanged answer (DELETION, identical to case_24) | Eval with `--injection --injection-only inj_01`: 38 cases, status 100%, precision 100% |
| 2026-10-24 | Generation settings added to the cache key (ADR-026) | Offline rebuild byte-identical; main cache still fully used |
| 2026-10-24 | Gemini temperature 1.0 experiment on 15 visual files, separate cache | 13/15 identical, 1 extra unlinked record, output byte-identical; decision pending |
| 2026-10-24 | Gemini thinking tokens recorded and counted as output; Groq reasoning tokens recorded (ADR-027) | Usage records only; cache key unchanged |
| 2026-10-24 | Daily-quota errors stop the run cleanly (exit 2, no output, cache kept) | Mocked Groq TPD 429: 1 attempt, no output file |
| 2026-10-24 | Gemini temperature 1.0 chosen for the final run; inj_03 measured (decision unchanged) | All 3 injection cases pass |
| 2026-10-24 | Rehearsal: keys/models, offline rebuild byte-identical, Groq smoke 5/5 identical decisions | 5 Groq calls, 2,258 tokens |
| 2026-10-24 | Pre-freeze regression (offline, main cache) | 37 cases: status 100%, precision 100%, recall 87.1% |
| 2026-10-24 | Backup final-run mode (fresh vision, cached intents, provenance in usage report) (ADR-029) | Mechanics verified offline: byte-identical output, clean stop on a missing intent |
| 2026-10-24 | Cold-run cost counts each distinct answer once (was counting repeated identical requests) | Cold run: 390 calls, ~168.5K Groq tokens (was 518 calls, 213K) |
| 2026-10-24 | inj_03 expectation: only the cited evidence of one finding changed; decision criterion unchanged | Git diff of injection_expected.csv (ADR-022 addendum 2) |
| 2026-10-25 | Final run attempt with qwen intent stopped by qwen's daily token limit (consumed by the ADR-030 experiment); no output written | ADR-031 |
| 2026-10-25 | Final backup run (ADR-029): fresh Gemini t=1.0 vision, gpt-oss intents from cache; completed 06:32:15 UTC | verifyOutput PASS; 0 cases changed vs freeze-1; byte-identical (sha256 e57fd795…); 10 per-case Verifier flags (known) |
