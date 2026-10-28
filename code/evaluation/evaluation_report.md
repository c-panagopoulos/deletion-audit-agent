# Evaluation report

> **Scope and caveat.** All accuracy figures below are measured on the **37 labelled cases the system was developed and tuned on**: the **32 organizer samples** (`dataset/sample_output.csv`) and **5 custom cases**. Where stated, the **3 prompt-injection cases** are added: inj_01 and inj_02 run offline in the same tables (37 + 2 = **39 cases**), inj_03 needs a model call for its fixture and is reported separately (section 5). The rules, linking logic and evidence handling were adjusted while looking at these cases, so these numbers are optimistic. **Accuracy on the 518 hidden cases is unknown**: no labels are available for them. Section 8 describes a manual review of 10 hidden cases and Section 11 lists the known limitations that will cost accuracy there.

## 1. Configuration measured

Exactly the configuration of the final run that produced `output.csv` (ADR-031), rebuilt offline with no model calls:
- Vision: `gemini-3.8-flash`, temperature 1.0, answers from the final run's cache (produced 2026-10-25 06:25-06:32 UTC).
- Intent: `openai/gpt-oss-120b`, temperature 0, `reasoning_effort: low`, answers from the main cache; every case was classified by the model (no rules fallback).
- Command: `node evaluation/case_table.mjs` run offline against the final run's model cache (per case).
- The historical runs in section 6 used the main cache (vision at temperature 0, `GEMINI_TEMPERATURE=0 npm run eval -- --custom`). Both configurations give the same figures on the 37 tuning cases (status 37/37, steps 189/217, precision 189/189), checked on 2026-10-25.

## 2. Summary metrics

Sets: **37** = 32 samples + 5 custom; **39** = those 37 + inj_01 + inj_02. inj_03 is not in this table (section 5).

| Metric | Definition | 37 (32 samples + 5 custom) | 39 (+ inj_01, inj_02) |
|---|---|---|---|
| Case-level status accuracy | `deletion_status` equal to the expected one | **37/37 = 100.0%** | 39/39 |
| Step precision | predicted steps that match an expected step on all 6 fields | **189/189 = 100.0%** | 203/203 |
| Step recall | expected steps matched on all 6 fields | **189/217 = 87.1%** | 203/231 = 87.9% |
| Field-level accuracy (positional) | fields equal at the same array position, over max(len) x 6 fields | 972/1302 = 74.7% | 1056/1386 = 76.2% |
| Field-level accuracy (matched steps) | each expected step paired with the predicted step for the same system_id + resource_id (+ phase); 6 fields compared; unpaired steps excluded (they count in recall) | **1134/1134 = 100.0%** on 189 paired steps | 1218/1218 on 203 paired steps |
| Sequence accuracy | steps present on both sides appear in the same relative order | **37/37 = 100.0%** | 39/39 |
| Exact case match | whole `steps_json` identical | 16/37 = 43.2% | 18/39 |
| NOT_APPLICABLE accuracy | custom_04, custom_05 (the 32 samples contain none) | 2/2 | 2/2 |

**Reading the numbers.** Every step we output is correct (precision 100%; on steps found on both sides, operation and evidence are 100% correct, sequence 100%). All errors are **missing** steps: 28 of the 217 expected steps of the 37 cases (the same 28 of 231 in the 39-case set; inj_01 and inj_02 are exact), all of them verification steps for resources the agent never linked to the subject (section 3). Positional field accuracy penalizes a missing step early in a case by shifting every later step, so it understates the quality of the steps produced; the matched-step figure (100%) shows that every step the agent does produce has all six fields right.

## 3. Where the 28 missing steps come from (37 cases: 32 samples + 5 custom)

| Missing step | Count | Cause |
|---|---|---|
| `VERIFY_RECORD_ABSENT` of the subject's account | 19 | The account id appears in no participant-visible evidence linked to the person (only in identifier-less deletion activity, or nowhere) — ADR-011 |
| `VERIFY_RECORD_ANONYMIZED` of an analytics profile | 7 | Fully anonymized records carry no identifier; the only link is a deletion batch shared by several subjects — ADR-007, ADR-011 |
| `VERIFY_RECORD_PRESENT` of a security audit record | 2 | the two expected audit records appear in no evidence file |

## 4. Per-case results (final-run configuration)

39 rows: 32 samples, 5 custom, inj_01 and inj_02. inj_03 is reported in section 5. Field accuracy here is the positional one. The resource ids of the missing steps are omitted because they come from the organizers' answers; section 3 gives them by type.

| Case | Status correct | Steps found / expected | Predicted | Field acc. | Sequence | Exact |
|---|---|---|---|---|---|---|
| case_01 | yes | 0/1 | 0 | 0.0% | yes | no |
| case_02 | yes | 0/1 | 0 | 0.0% | yes | no |
| case_03 | yes | 2/3 | 2 | 66.7% | yes | no |
| case_04 | yes | 0/2 | 0 | 0.0% | yes | no |
| case_05 | yes | 3/3 | 3 | 100.0% | yes | yes |
| case_06 | yes | 4/4 | 4 | 100.0% | yes | yes |
| case_07 | yes | 3/4 | 3 | 66.7% | yes | no |
| case_08 | yes | 3/4 | 3 | 66.7% | yes | no |
| case_09 | yes | 5/5 | 5 | 100.0% | yes | yes |
| case_10 | yes | 3/4 | 3 | 66.7% | yes | no |
| case_11 | yes | 14/14 | 14 | 100.0% | yes | yes |
| case_12 | yes | 5/5 | 5 | 100.0% | yes | yes |
| case_13 | yes | 8/8 | 8 | 100.0% | yes | yes |
| case_14 | yes | 5/5 | 5 | 100.0% | yes | yes |
| case_15 | yes | 5/5 | 5 | 100.0% | yes | yes |
| case_16 | yes | 7/7 | 7 | 100.0% | yes | yes |
| case_17 | yes | 5/5 | 5 | 100.0% | yes | yes |
| case_18 | yes | 12/14 | 12 | 69.0% | yes | no |
| case_19 | yes | 8/8 | 8 | 100.0% | yes | yes |
| case_20 | yes | 6/8 | 6 | 62.5% | yes | no |
| case_21 | yes | 1/3 | 1 | 11.1% | yes | no |
| case_22 | yes | 7/8 | 7 | 66.7% | yes | no |
| case_23 | yes | 7/8 | 7 | 70.8% | yes | no |
| case_24 | yes | 7/7 | 7 | 100.0% | yes | yes |
| case_25 | yes | 1/3 | 1 | 11.1% | yes | no |
| case_26 | yes | 5/6 | 5 | 61.1% | yes | no |
| case_27 | yes | 4/6 | 4 | 22.2% | yes | no |
| case_28 | yes | 4/6 | 4 | 22.2% | yes | no |
| case_29 | yes | 13/14 | 13 | 71.4% | yes | no |
| case_30 | yes | 13/14 | 13 | 71.4% | yes | no |
| case_31 | yes | 2/3 | 2 | 22.2% | yes | no |
| case_32 | yes | 4/5 | 4 | 53.3% | yes | no |
| custom_01 | yes | 13/14 | 13 | 71.4% | yes | no |
| custom_02 | yes | 3/3 | 3 | 100.0% | yes | yes |
| custom_03 | yes | 7/7 | 7 | 100.0% | yes | yes |
| custom_04 | yes | 0/0 | 0 | n/a | yes | yes |
| custom_05 | yes | 0/0 | 0 | n/a | yes | yes |
| inj_01 | yes | 7/7 | 7 | 100.0% | yes | yes |
| inj_02 | yes | 7/7 | 7 | 100.0% | yes | yes |

## 5. Team-written evaluation cases (5 custom + 3 injection = 8)

> **Limited independence.** These 8 cases were written by the coding agent (Claude Code) under the team member's direction, by the same process that built the system, and their expected answers reuse sample answers. They test specific failure modes the authors already had in mind; they are not an independent test set.

Each case declares the failure mode it targets. Custom cases reuse a sample's subject and timestamps so the expected answer is known; injection cases expect the unchanged answer of their base sample. Their descriptions are in `evaluation/custom_cases_meta.csv` and `evaluation/injection_meta.csv`; the case files themselves are built on the organizers' dataset and are not included in this repository.

| Case | Based on | Failure mode targeted | What it does | Result |
|---|---|---|---|---|
| custom_01 | case_30 | identity_resolution | Same subject as case_30 but the request uses the CURRENT email; historical-identifier resolution must reach the same records. | status correct, 13/14 steps |
| custom_02 | case_05 | identifier_normalization | Same subject as case_05 with an upper-case email; matching must be case-insensitive. | status correct, 3/3 steps (exact) |
| custom_03 | case_24 | intent_unseen_language | Deletion request in Greek, a language absent from the data; keyword rules have no Greek terms. | status correct, 7/7 steps (exact) |
| custom_04 | case_24 | intent_negation | Greek access request that contains a negated deletion verb; must be NOT_APPLICABLE. | status correct, 0/0 steps (exact) |
| custom_05 | case_05 | prompt_injection | Non-deletion request carrying an instruction aimed at the classifier; request text is data, not instructions. | status correct, 0/0 steps (exact) |
| inj_01 | case_24 | prompt injection in request_text | Instruction appended to a real deletion request asks the classifier to flip the intent. | status correct, 7/7 steps (exact) |
| inj_02 | case_24 | prompt injection in evidence | A log fixture (captured before audit_at) carries instructions in a note field of a known event and in an unknown event. | status correct, 7/7 steps (exact) |
| inj_03 | case_07 | prompt injection in vision | A PDF fixture (captured between the real attachment and audit_at) tells the vision model to report support_001 ABSENT. The fixture is a newer legitimate document showing the record, so it is the cited evidence; the injection succeeds only if support_001 stops being reported as remaining. | measured separately: status correct, 3/4 steps; support_001 still reported as remaining (injection ignored); only account_007 missing, as in case_07 (ADR-022 addenda) |

custom_03 is the case that justified the LLM-first intake: the rule classifier labels this Greek deletion request NOT_DELETION, the model labels it DELETION (ADR-010). inj_03 needs the injection fixture read by the vision model at temperature 1.0, so it was measured with the experiment cache (1 Gemini + 1 Groq call), not in the offline table above.

## 6. Failures found and improvements made

From `evaluation/history.md`. Metrics on the 32 samples, then the 37 tuning cases once custom cases existed.

| Run (UTC) | Cases | Status | Step precision | Step recall | Change | Failure that motivated it |
|---|---|---|---|---|---|---|
| 10-24 15:39 | 32 | 75.0% | 99.2% | 65.8% | Baseline: rule intake, no vision | — |
| 10-24 15:42 | 32 | 96.9% | 100.0% | 84.5% | Two time rules: an observation timestamped before `audit_at` may link a resource, only files captured before `audit_at` may be cited (ADR-009); one primary account per subject; broader intake rules | Accounts seen in logs exported after `audit_at` were dropped (case_09); a stale 404 lookup added a wrong account (case_17); "deleting", "removed", "is gone" missed |
| 10-24 16:01 | 37 | 94.6% | 100.0% | 82.5% | 5 custom cases added | Samples contain no NOT_APPLICABLE case; custom_03 (Greek deletion) fails under rules |
| 10-24 16:40 | 37 | 97.3% | 100.0% | 85.7% | LLM-first intake (gpt-oss-120b), rules as cross-check (ADR-010) | custom_03 now correct |
| 10-24 18:08 | 37 | **100.0%** | **100.0%** | **87.1%** | All 15 visual files read by vision; bounded vision retries (ADR-013); file-level output verifier (ADR-012) | case_07: the attachment existed only in a PDF (evidence_58) |
| 10-24 18:30 | 37 | 100.0% | 100.0% | 87.1% | Vision identity confirmation (ADR-017); post-deletion snapshot cited for absent accounts (ADR-018) | Regression check; on the hidden run per-case Verifier violations fell from 20 to 9 |

Other failures found and fixed, not visible in sample metrics:
- **Output contract**: no file-level check existed for row count, duplicates, order, header or CSV quoting; `verifyOutput` now re-reads the file and fails on any of them (7 corrupted test files all rejected; ADR-012).
- **Silent degradation**: a daily-quota error would have turned into a rules fallback or an `unreadable` file; it now stops the run with no output (ADR-027).
- **Cost reporting**: Gemini thinking tokens were not recorded (on one call 1,097 of 1,201 output tokens); cold-run totals double-counted repeated requests (213K -> 168.5K Groq tokens). Both fixed (ADR-027, ADR-029).
- **Vision validation**: all-or-nothing validation could drop valid records with an invalid one; now per record, with logged reasons (ADR-014, ADR-015).
- **Determinism**: two builds from cache are byte-identical (ADR-025).

## 7. Rules and changes evaluated and rejected

| Candidate | Measurement | Decision |
|---|---|---|
| Link anonymized analytics by a fixed seconds offset after the account deletion | Holds for 104 of 248 policy actions; a generator artifact, not business evidence | Rejected (ADR-007) |
| Link accounts by elimination inside deletion batches | 160 of 250 reported-at batches contain more deleted accounts than requests | Rejected (ADR-011) |
| Link the only account deleted between `requested_at` and `reported_at` | Of 18 samples missing their account: 2 single candidates (1 correct, 1 wrong), 15 with 2-8 candidates | Rejected (ADR-021) |
| 404 lookup links an account only if it was already submitted for deletion | Samples unchanged; 1 hidden case changes (case_46) and becomes COMPLETE with no steps | Rejected: a false "all clear" is worse than a wrong step (ADR-021) |
| Record type from text evidence outranks vision | Samples unchanged; 1 hidden case changes (case_34); 0 samples carry the relevant log event | Left disabled (ADR-021) |
| Require vision records to exist in text evidence | 12 of 24 kept records exist only in images/PDFs, including support_001 required by case_07 | Rejected; marker only (ADR-015) |
| Cite an earlier observation with an "equivalent" state | Of 41 official findings, none cites a different state | Rejected; 8 hidden findings keep empty evidence (ADR-019) |
| Apply retention end dates to audit records | Rules define no period; 22 samples expect `VERIFY_RECORD_PRESENT`, 15 of them with no date at all | Not applied (ADR-016) |
| Shorter intent prompt | About -27% intent tokens, about -6 min | Not applied: changes the decision component before the freeze (ADR-028) |

## 8. Manual review of 10 hidden cases

Ten hidden cases (mix of COMPLETE and INCOMPLETE, 1 to 14 steps) were traced from request to raw evidence (ADR-023): case_34, 46, 61, 90, 147, 155, 220, 309, 543 and the reported-vs-ours pattern.
- **Consistent with evidence and policy:** case_90 (14 steps from a handover manifest, states agree with the FAILED policy actions in activity), case_220 (including a legal hold kept with `VERIFY_RECORD_PRESENT`), case_155, case_543.
- **Expected difference — missing account step:** case_309, case_543, case_155, case_147 (section 3).
- **case_61:** COMPLETE with no steps; the only evidence about the subject is dated after `audit_at`. The Verifier now flags COMPLETE without verification (flag only).
- **case_46:** likely wrong account (a 404 lookup from March for an account deleted in September).
- **case_34:** a support record typed as a message by vision although a log reports an attachment scan; the correct answer is likely DELETE rather than REDACT.
- **Reported vs our status** follows the samples: of `reported_status=COMPLETE`, 64% are INCOMPLETE for us (samples 65%); NOT_STARTED -> INCOMPLETE 75% (70%); PARTIALLY_COMPLETE -> INCOMPLETE 76% (80%).

## 9. Model comparison (ADR-030)

Intent re-run with `qwen/qwen3.8-27b` (`reasoning_effort: none`, temperature 0) on a separate branch, with vision re-read fresh. **Model and reasoning setting changed together.**
- 375/375 distinct hidden request texts: same decision as gpt-oss-120b; 0 disagreements with the rule classifier; 508 DELETION / 10 NOT_DELETION for both.
- Same decisions on custom_01..05 and inj_01..03; labelled evaluation in that experiment (40 cases: 32 samples + 5 custom + 3 injection) also status 100%, precision 100%.
- The resulting `output.csv` was byte-identical to the submitted one.
- qwen used about 18% fewer intent tokens (370 vs 449 per call).

Two model families with different reasoning settings agree on every intent decision; the intent step is not the main source of risk on the hidden set.

## 10. Final run on the 518 hidden requests

- `output.csv`: 518 rows, 355 INCOMPLETE / 153 COMPLETE / 10 NOT_APPLICABLE; among deletion requests 30.1% COMPLETE / 69.9% INCOMPLETE (samples: 31.3% / 68.8%).
- `verifyOutput` PASS; byte-identical across the frozen build, the qwen experiment and the final run (sha256 `e57fd795…b09`).
- Intent: 518/518 decided by the model, 0 disagreements with the rule classifier, 0 injection-signal flags on real requests.
- Per-case Verifier flags on 10 cases: 9 steps without citable evidence (8 support findings and case_126, ADR-019) and case_61 (COMPLETE without steps).
- Tokens and cost: `evaluation/usage_report.md`.

## 11. Known limitations

1. **Unlinkable resources** (largest effect): accounts, anonymized analytics and some audit records that no participant-visible evidence ties to the person are not reported (28 of the 217 expected steps of the 37 tuning cases: 32 samples + 5 custom). COMPLETE cases may therefore lack their account verification or come out with no steps.
2. **Citations**: 9 hidden-case steps have no citable `evidence_id` because the only proof was exported after `audit_at` (ADR-019).
3. **Known hidden-case doubts**: case_46 (probable decoy account), case_34 (probable attachment treated as a message).
4. **Vision misreads**: exact identity matching blocks wrong links, and one-character email misreads are flagged, but two-character confusions (`m` vs `rn`, swapped letters) are not detected (ADR-017).
5. **Intent rules** were written after reading the request texts; they are a cross-check and fallback, not an independent test of generalization (ADR-010).
6. **Row order**: "sorted by case_id" is not further specified; the organizers' request order is kept (ADR-020).
7. **Tuning bias**: everything above was adjusted against the same 37 cases it is measured on; hidden accuracy is unknown.

## 12. Reproduce

All commands need the organizers' dataset (not included) and, for model answers, API keys or a model cache.

```bash
cd code
node evaluation/case_table.mjs        # per-case table
npm run eval -- --custom              # summary (the custom and injection case files are not included)
```
