# Run Record v0 (draft shape to fill by hand)

Safe-to-publish rule: only counts, ids, SHAs, issue/PR numbers, timestamps, durations, enum values and outcomes. NEVER issue text, ticket titles, commit messages, command output, file contents, review comment text, or free-text reasons. A field you would need prose for is a finding, not something to paste.

```json
{
  "schema": "run-record/0",
  "run": {
    "id": "2026-11-19-spec-344",
    "kind": "spec | tickets | team",
    "spec": 344, "tickets": [348, 349],
    "harness": "claude-code-desktop", "support_level": "verified",
    "decision_authority": "relay | autonomous",
    "landing": "integration-branch | per-ticket",
    "started_at": "ISO-8601 or null", "plan_approved_at": "...", "closed_at": "...",
    "outcome": "merged | partly-merged | abandoned",
    "pull_requests": [387]
  },
  "plan": { "routine_writes_approved": ["open-final-pr"], "qa_required": "none | report | ..." },
  "delegations": [{
    "id": "d348", "issue": 348, "kind": "building | fix | qa | analysis",
    "executor": "live-session | sub-agent | headless", "model": "default", "wave": 1,
    "start_route": "direct | card", "started_at": null, "landed_at": null, "ended_at": null,
    "outcome": "landed | sent-back | abandoned | qa-pass | qa-fail",
    "send_backs": 0, "decision_requests": 0, "rulings": 0
  }],
  "human_interventions": [{
    "at": null, "delegation": "d350 | null",
    "kind": "plan-approval | card-start | decision-request | write-as-human | typed-command | readiness-answer | permission-refusal | merge | close-out | other",
    "waited_minutes": null
  }],
  "reviews": [{ "pr": 387, "head": "75aa766", "round": 1, "findings": 7, "fixed": 7, "answered": 0 }],
  "ci": [{ "pr": 387, "head": "75aa766", "result": "pass | fail", "failed_checks": 0 }],
  "rulings": { "made": 0, "upheld": 0, "overturned": 0 },
  "qa": [{ "delegation": "d255-qa", "target": "stack | url", "route": "brief | typed", "result": "pass | fail | waiting" }],
  "heartbeats": { "firings": 0, "no_change": 0 }
}
```
