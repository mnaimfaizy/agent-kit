# Pattern guide: tiered quality gates

A way to decide how much checking a change gets before an agent touches a file, so that a rename costs one lint run and a new feature gets a builder, a reviewer and a test run, and a specialist that keeps failing turns into a recorded incident instead of a loop. This is a **Pattern guide** ([ADR 0012](../adr/0012-pattern-guides-are-docs-a-consumer-adapts.md)): you read it, copy the skeleton, and adapt it. Agent-kit does not install or upgrade it.

Skeleton to copy: [`examples/patterns/tiered-quality-gates/`](../../examples/patterns/tiered-quality-gates/)

- [`checklist.md`](../../examples/patterns/tiered-quality-gates/checklist.md): the tiers, the mechanical criteria, the red flags, and what each file type gets at each tier.
- [`SKILL.md`](../../examples/patterns/tiered-quality-gates/SKILL.md): the skill that picks the tier and routes between the specialists, with the retry cap.
- [`builder.agent.md`](../../examples/patterns/tiered-quality-gates/builder.agent.md) and [`reviewer.agent.md`](../../examples/patterns/tiered-quality-gates/reviewer.agent.md): one example builder and reviewer pair, for one file type.
- [`gate-runner.sh`](../../examples/patterns/tiered-quality-gates/gate-runner.sh): the runner stub, the deterministic checks every tier ends with.

## The problem

A repository that cares about quality writes rules like "every component change goes through the builder and the reviewer, no exceptions". That works for structural work, and goes wrong in two directions:

- **Too much for small work.** A one-line fixture retarget pays for a test writer, a test reviewer and a test runner. Each hop re-reads the conventions, and the cost is in the number of calls and handoffs, not in the model's size.
- **Too little when the rule bends.** The agent, faced with that cost, decides the change is "trivial" and edits the file itself. Now nothing marks the line between a real mechanical edit and a behaviour change that skipped its reviewer.
- **Loops.** A reviewer rejects, the builder "fixes" it, the reviewer rejects for the same reason, and the cycle repeats until something times out. Each round costs as much as the first and teaches nothing.
- **Reports nobody reads.** A specialist returns a page of checklist output, and the main agent's context fills with it.
- **Model size used as the depth dial.** Running the full chain on a cheaper model looks like savings, but the handoffs, not the model, dominate the cost; and running a big model with no reviewer is not the same as reviewing.

## The moving parts

```text
                    checklist                main agent                  specialists
               ┌────────────────┐ tier   ┌────────────────┐ spec   ┌──────────────────┐
               │ criteria, red  │──────▶ │ states tier,   │──────▶ │ builder: writes, │
               │ flags, file    │        │ edits only on  │◀report─│ reports, stops   │
               │ type x tier    │        │ mechanical,    │        ├──────────────────┤
               └────────────────┘        │ counts cycles, │──────▶ │ reviewer: runs   │
                                         │ records an     │◀verdict│ runner, judges   │
                                         │ incident       │        └──────────────────┘
                                         └───────┬────────┘
                                                 │ paths   ┌──────────────────┐
                                                 └───────▶ │ runner: focused  │
                                                           │ checks, verdict  │
                                                           └──────────────────┘
```

1. **The checklist** is one page the agent reads before its first edit. It defines the three tiers, the four mechanical criteria, the red flags that promote a change, and a table of what each file type gets at each tier.
2. **The main agent** chooses the tier, says it out loud, edits directly only on `mechanical`, and otherwise routes. It is the only part that decides the next hop and the only part that counts cycles.
3. **The specialists** are one-shot: a builder writes one thing from a spec, reports in a fixed form, and stops; its reviewer runs the checks, judges, and returns a verdict. Neither calls another agent.
4. **The runner** is one script that runs the deterministic checks for the changed paths by file type, and ends with a verdict block. Every tier ends with it.

### The three tiers

| Tier         | When                                                                                                    | Who edits                         | Gates                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------- |
| `mechanical` | Every mechanical criterion holds: a retarget, a rename, a dead-code delete, an import fix               | The main agent, directly          | The runner's focused checks. A short report.                                            |
| `standard`   | One behaviour change on one surface: one component's props, one schema field, one assertion suite       | One specialist for that file type | That specialist, then its reviewer **or** the runner, once. No second chain by default. |
| `full`       | A new module, a high-risk area, a public contract, behaviour across files, or behaviour that is unclear | The whole chain for each type     | Builder → Reviewer → Runner for each file type, then the end-of-change review once.     |

A change is `mechanical` only if **all four** hold:

1. No new behaviour and no change to a public contract.
2. The diff is small and in one place (two files, say, or more only for a pure rename or delete).
3. Tests and assertions are unchanged, or only retargeted to a change that already landed.
4. Deterministic checks alone can say whether it worked.

## The rules, and why each one exists

| Rule                                                                                                                          | Why                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depth scales with risk, chosen per change, not with file type alone.                                                          | A test file can hold a fixture rename or a new behaviour. The file type says which specialist; the tier says whether one runs at all.                                                                                                      |
| The deterministic checks run at every tier, `mechanical` included.                                                            | They are cheap and they are facts. A tier removes reviewers, never the type check, linter or focused tests.                                                                                                                                |
| `mechanical` requires all four criteria; one false promotes it.                                                               | The criteria are the escape hatch, so they must be strict. A loose one turns every change the agent finds tedious into a mechanical one.                                                                                                   |
| When unsure, promote. Never demote.                                                                                           | Promoting costs some calls. Demoting by mistake costs a behaviour change with no reviewer, found later in production. The asymmetry decides the default.                                                                                   |
| The agent states the tier in its first reply, with the criterion that decided it, and the user can override.                  | A stated tier can be challenged before work starts. An unstated one shows up only as a missing review. A planned issue can carry the tier as a label instead, chosen when the work was split.                                              |
| On `standard` and `full`, the main agent does not edit files of a type that has a builder.                                    | Editing them itself is how a reviewer gets skipped quietly. Delegate first.                                                                                                                                                                |
| A specialist is one-shot: it writes, reports and stops. Only the main agent decides the next hop.                             | A specialist that schedules the next one turns a chain into a recursion nobody can see. Keeping routing in one place keeps the cycle count in one place.                                                                                   |
| Some work gets one-shot specialists in sequence with no reviewer loop, such as a schema writer, then a contract writer.       | When the reason to delegate is to protect the main agent's context, not to add a second opinion, a reviewer loop adds rounds and no quality. The main agent patches a small miss itself, or stops if the specialist missed the assignment. |
| Reports are `PASS`, `FAIL` or `ESCALATE`, at most five bullets, and the exact commands run.                                   | The main agent's context is the scarce resource. A fixed short form is cheap to read and cheap to parse, and the commands make the claim checkable.                                                                                        |
| A check that checked nothing is `NOT RUN`, never `PASS`.                                                                      | An unresolved project, a missing config or zero files checked all exit cleanly on some tools. Reporting that as a pass is a green gate over red code.                                                                                      |
| Reject cycles are capped (two is a good default); at the cap, the main agent fixes it and records an incident.                | A third round on the same finding is the same finding behind another layer. One retry catches a typo; past that, the specialist cannot see what is wrong, and repeating it is a loop.                                                      |
| An incident is also recorded for a repeated finding, a "fix" that hides a finding, or a reviewer `PASS` then a runner `FAIL`. | Each one means a gate let something through or cannot see something. Written down, it tells you which gate to improve; lost in a transcript, it repeats.                                                                                   |
| The tier sets pipeline depth; model size is a separate choice, in each agent's definition.                                    | They answer different questions: how many checks, and how capable each worker needs to be. A small model on `full` and a large one on `mechanical` are both reasonable, and tying them together removes that choice.                       |
| An end-of-change review (such as `code-review`) runs once, after the checks are green, not after every hop.                   | It reads the whole diff against the spec and catches what a per-file reviewer cannot. Run after every hop, it re-reads a half-built change; skipped, nobody reads the whole.                                                               |

## Failure modes

- **Everything becomes mechanical.** The agent reads the criteria generously. Watch the stated tiers for a while; if mechanical changes keep needing follow-up fixes, tighten the criterion they slipped through, usually the second or third.
- **Everything becomes full.** "When unsure, promote" with an unclear checklist promotes all work, and the tiers save nothing. Add the file-type rows and red flags your repository actually has, so the agent is less often unsure.
- **The reviewer re-derives the checks.** A reviewer that reads the file to judge what the linter already decides spends tokens and disagrees with the linter. Make it run the runner first and stop on a `FAIL`.
- **A broader fallback command.** A reviewer that cannot resolve the project's lint target runs the linter with the root config, and project rules go unenforced. The reviewer's rule is `NOT RUN`, never a fallback.
- **The incident is never read.** Incidents posted where nobody looks change nothing. Review them when you change a specialist's definition, and add a check when the same trigger keeps recurring.
- **The cap is counted per conversation, not per builder.** Two builders in one `full` change each get the cap. Count per builder, per change.

## Adopting it

1. **Copy the skeleton.** Put `checklist.md` next to your always-on instructions, `builder.agent.md` and `reviewer.agent.md` where your harness reads agent definitions (renamed for the file type they cover), `SKILL.md` in your skills directory, and `gate-runner.sh` wherever your scripts live.
2. **Fill in every placeholder.** Each is written `<like this>` or as a `TODO(adopt)` line. They cover: your file types and their paths, your high-risk areas, the specialists for each file type and tier, the checks the runner runs for each type, the retry cap, and where incidents go.
3. **Add one builder and reviewer pair per file type that needs one.** Start with the type where a missed review has cost you most. Every type without a pair is direct edit at every tier, still gated by the runner.
4. **Wire it into your instructions.** Your always-on agent instructions say to read the checklist and state a tier before the first edit, and name the skill.
5. **Try it on purpose.** Ask for a pure rename, and check that the agent says `mechanical` and runs only the runner. Ask for a new prop on a component, and check that it says `standard` and calls the builder and reviewer without editing the file itself.
