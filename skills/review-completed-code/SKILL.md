---
name: review-completed-code
description: Review an AI-implemented change after its checks pass, when the rated-review-loop hook requests it, and record the owner's explicit rating of each finding. Propose; never refactor automatically.
---

# Review completed code

Review only a run whose packet shows `phase: awaiting-review`, which means every configured check passed.
Do not treat drafts or skeletons as finished work, even when asked manually.

## Scope

- The `changes[].before/after` in the packet are the scope. Do not substitute a HEAD diff: it may contain the
  owner's earlier uncommitted edits. Read callers and related documents as needed, but never edit files.
- Compare the change against the project guidelines listed in the packet and against existing implementations
  of the same area in the repository.
- Look for: state coupled with derived data, branches that hide missing cases, unclear split between decisions
  and I/O, and abstractions that add coupling without reducing what a reader must keep in mind.
- Do not repeat what checks already cover (formatting, types, obvious import violations).

## Each finding

- Give the location, the project rule or a reproducible defect as evidence, the concrete impact, and the
  smallest change that fixes it.
- When claiming behavior is preserved, state which behavior must stay the same.
- When quality criteria conflict, list the options and their costs instead of deciding for the owner.
- Taste, line count, or splitting files are not evidence on their own.
- Do not aim for a number of findings. If nothing is well-founded, submit an empty `findings` array.
- Write in the language given by `language` in the packet.

## Report

```json
{
  "summary": "What was reviewed and the conclusion",
  "findings": [
    {
      "file": "src/example/controller.ts",
      "line": 12,
      "title": "The specific problem",
      "rule": "The project rule or the confirmed defect it rests on",
      "impact": "Which behavior or maintenance task it affects, and how",
      "suggestion": "What must keep working, and the minimal fix; options if criteria conflict"
    }
  ]
}
```

`line` is the line in the file after the change; for a deleted file, use the line before the change.
A no-findings review does not prove the change is correct; do not describe it that way.

## After submitting

Tell the owner the run id, each finding id (F1, F2, ...), the suggestion and its evidence.
If there are findings, end the final message with the `evaluationQuestion` exactly as returned.
Do not move it to an interim update or soften it into an optional request. The Stop hook checks for it and
reminds once if it is missing. When reminded, do not rerun checks or the review; only restate the report and
the question, then end the turn. Never answer the question yourself.

## Ratings

Record only ratings the owner actually gave: `rate <run-id> <F#> <label> [note]`.

| Label | Meaning |
| --- | --- |
| `useful` | Valid and worth acting on |
| `out-of-scope` | Valid, but not for this change |
| `unsupported` | Taste or weak evidence |
| `incorrect` | Factually wrong |
| `deferred` | Undecided for now |

"I won't apply it" alone does not make a finding incorrect. If the owner's answer is ambiguous, leave it unrated.
When reporting `stats`, always give the denominator, unrated and deferred counts. No findings or no ratings is
not 100% accuracy, and missed defects are not measured by this loop.
