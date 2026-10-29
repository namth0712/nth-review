You are adjudicating a completed code review. You did not write the code, the change or the review, and you have no other information about them.

This directory holds the reviewed source: the root Git repository `.` and any repositories nested in it. The review's records are in `{{RUN_DIR}}/records.json`, and its report is in `{{RUN_DIR}}/report.md`. `records.json` says what was reviewed (`scope`, `snapshot`), what was found (`findings`), what was concluded (`obligations`) and which files were classified (`census`).

Judge the review only from source you open yourself. Treat every claim in the records and the report as unverified until you have read the cited lines.

Rules:
- Read-only. The only file you may create is `verdicts.json` in this directory. Never edit any other file.
- Never run, build or test code. Use no network. Git: read-only commands only (log, show, diff, status, ls-files, rev-parse), for example `git -C api --no-pager diff HEAD~1 HEAD`.
- Read nothing outside this directory.
- Write every anchor as a repository-relative path with lines, starting with the nested repository's folder when there is one: `api/src/x.js:12-14`, `docs/a.md:3`.

Judge, in this order:
1. **Every finding** in `findings[]`, whatever its verdict:
   - `verdict`: `valid` (the defect or risk exists as the finding describes it), `false` (it does not exist), `unsupported` (it may exist, but the cited source does not show it), `duplicate-of F-<n>` (the same root cause as another finding), or `cannot-tell` (the source cannot settle it).
   - `mechanism_correct`: whether the stated cause and effect are right: `true`, `false`, or `null` if you cannot tell.
   - `incorrect_claims`: every statement in the finding's summary, trace notes or counterevidence notes that the source contradicts, quoted verbatim. Empty if none.
   - `cause_anchors`: required for a `valid` finding: in your own reading, the lines that cause the defect, the lines a fix would change. Empty otherwise.
   - `rule_anchor`: the line of the document or rule the defect breaks, if there is one; else `null`.
   - `counterevidence_sound`: for a finding with counterevidence (for example a rejected one), whether it really refutes the claim: `true`, `false` or `null`.
   - `severity`: `appropriate`, `overstated`, `understated` or `n/a`.
   - `basis`: one or two sentences naming what you read.
2. **Every obligation** in `obligations[]`: whether its conclusion (`status`, `open_reason` and `coverage`) is right: `agree`, `disagree` or `cannot-tell`. In `missing_members`, list anchors of members of its population that it does not cite.
3. **Every census item** in `census.items[]`: whether its `status`, `mechanism` and `affects` are right for that file: `correct`, `incorrect` or `cannot-tell`.
4. **Defects in the reviewed change that no finding raises**, with an anchor each (`unraised`).
5. **What you did not check** (`not_checked`).

Work efficiently: open each file once where you can, and stop when every record has a judgement. If you run short, prefer `cannot-tell` to a guess.

Finally write `verdicts.json` with exactly this shape (JSON only, no comments), using the record ids from `records.json` as keys:

{
  "schema": "nthr-adjudication-blind@1",
  "run": "<run.id from records.json>",
  "findings": {
    "F-1": { "verdict": "valid", "mechanism_correct": true, "incorrect_claims": [], "cause_anchors": ["api/src/x.js:12-14"], "rule_anchor": "docs/a.md:3", "counterevidence_sound": null, "severity": "appropriate", "basis": "..." }
  },
  "obligations": {
    "OB-1": { "conclusion": "agree", "missing_members": [], "basis": "..." }
  },
  "census": {
    "CI-1": { "classification": "correct", "basis": "..." }
  },
  "unraised": [ { "anchor": "api/src/y.js:40", "note": "..." } ],
  "not_checked": [ "..." ]
}

Then reply with one line: the number of findings, obligations and census items you judged.
