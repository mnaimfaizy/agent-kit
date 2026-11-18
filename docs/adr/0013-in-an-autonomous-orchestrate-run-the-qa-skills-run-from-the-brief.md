---
status: accepted
---

# In an autonomous orchestrate run, the QA skills run from the brief

`qa-plan` and `manual-qa` are user-invoked (`disable-model-invocation: true`), and they stay so. Their rules wait on a person: "the person has seen the draft", "post only on a yes", "ask which issue is the subject". Until now an orchestrate QA Delegation's session was sent `/qa-plan <n>` and later `/manual-qa <plan file>` as messages. On the Claude Code desktop harness a message does not run as the human's invocation, so the human typed both commands in every QA session, `go autonomous` or not. With no QA config, every QA session also asked the readiness question: in the spec #253 run the human answered it six times, once also relayed as a Decision Request. A run meant to go on without the human still needed them at every QA step.

So, in a `go autonomous` run on a `target: stack` plan, the QA brief carries each QA skill's instructions, its `SKILL.md` and folder from the same install as its helper scripts, as the CI reviewer's brief carries `code-review`. The QA session follows `qa-plan` as a phase of its brief, and once the plan is delivered, `manual-qa`, and nobody types either command. This is part of the autonomous handover, so the Dispatch Plan's **Decision authority** line says so, and the split stays all or nothing. Outside an autonomous run the skills stay invoked by a person.

Each QA skill owns its run mapping. A "Run from an autonomous brief" section in each `SKILL.md` lists every step where the skill waits on the person, and what replaces the wait: the delivery of the QA Plan is a Ruling; the subject issue and an `unknown` row are Rulings under the evidence bar, or the human's when the evidence does not settle them; "Add the test" is a send-back Ruling to the building Delegation, which adds the test, so its head moves and this QA is void; nothing is uploaded; the report is posted only as a routine write the Dispatch Plan approved, and otherwise waits as a queued write. orchestrate's brief only says to follow that section. The skill owns it because only the skill knows where it waits, and a contract test fails when a step that waits on the person is missing from it.

The readiness question moves to the Dispatch Plan, in every run: asked once, beside the "go", for this run only or to save a config, and written to the run folder as `qa-readiness.json`. `qa-plan` takes it with `--answers <file>`, by the rules its runner's `--answers` already had, and its draft shows the line "Readiness answers reused from <file>: <values>", so the human sees the answers where the plan is approved. Readiness answers are facts about the repository, so they are never a Ruling. They are reused only within the run, and only for a pull request with the base branch they were given for, since an answer can set `plan.base_ref`. In a plain `go` run, the human is told the exact command to type, with `--answers`.

**Hosted targets stay with a person.** A `target: url` plan never runs from the brief. Confirming the host and giving role test values for a hosted environment are the safeguards `manual-qa` keeps against signing in somewhere real, and both must come from a person typing in the session: a brief is a file, and a file is exactly what those rules refuse to trust. That QA Delegation falls back to the typed route and is `waiting`, and the run goes on.

## Considered Options

- **Make the QA skills model-invocable for everyone.** Rejected. It would undo the person-gates for every user of the skills, not only inside an autonomous run, where the human has handed those questions over.
- **Keep the human typing the QA commands in autonomous runs** (the rule until now). Rejected. The run is not away-from-keyboard if a person must be at every QA session, twice.
- **Put the run mapping in orchestrate's brief.** Rejected. The brief would have to track every place each skill waits, and would drift from the skills as they change; a section in each skill moves with it.
- **Run hosted targets from the brief too.** Rejected, for the safeguards above.

## Consequences

- `orchestrate`'s DESIGN.md now says the QA skills are invoked only by a person **outside an autonomous run**. HARNESSES.md still says a QA Delegation is never a sub-agent: it needs a working copy and a browser of its own.
- Each harness file's QA start names both routes: typed by the human with `go`, briefed with `go autonomous`.
- A QA session on the brief route never invokes a QA skill, so how a harness runs a slash command sent as a message no longer matters for it.
- `manual-qa`'s own run answers have no `--answers` input yet: in an autonomous run, a run need is a Decision Request the human keeps.
