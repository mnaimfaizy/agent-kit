---
status: proposed
---

# Security PoCs are never delivered, rather than never produced

The only PoC rule in the security skills today is `security-finding-triage`'s: never _produce_ weaponized exploit instructions or PoCs. `security-audit` states no PoC rule, because a static audit never runs anything. A **Deep scan** can only confirm a finding by sending crafted input to a running copy of the code, so `security-audit` gains a hard rule that reads **never deliver**. Inside the sandbox the agent may craft and send inputs. Nothing runnable leaves it: no payload, script, request body or step-by-step recipe goes into the report or the draft advisory, not even privately. The triage rule stays "never produce", because triage never runs a sandbox ([ADR 0017](0017-deep-scan-is-a-security-audit-mode-not-its-own-skill.md)). A finding records its **Reproduction** as `Reproduced: yes | no | not attempted` and, when reproduced, a prose `Observation` line. The Observation names the location, the attacker's position, the kind of input in words and the effect seen, and never literal payload values, encoded strings, exact requests, command sequences or timing tricks. The test is this: a maintainer can understand the finding and check a fix from it, but cannot paste it into anything.

Recorded in [#335](https://github.com/mnaimfaizy/agent-kit/issues/335), on the wayfinder map [#332](https://github.com/mnaimfaizy/agent-kit/issues/332), and specified in [#362](https://github.com/mnaimfaizy/agent-kit/issues/362).

## Considered Options

- **Give `security-audit` the triage skill's "never produce" rule: observation-only scanning, with no crafted inputs.** Rejected. It is too weak to confirm anything, so a deep scan would add cost and risk without adding evidence.
- **A runnable reproduction inside the private draft advisory.** Rejected. The advisory outlives the fix and travels with every collaborator added to it, so a working exploit would spread further than the bug.
- **Reproduction as a fourth evidence class.** Rejected. Reproduction is confidence, not a kind of defect, so it sits beside the three evidence classes (`dependency-advisory`, `code-path`, `missing-control`) rather than among them.

## Consequences

- **Only the report leaves the sandbox.** Transcripts, shell history, app logs and scratch scripts stay inside it and are destroyed with it. In CI none of it is printed or uploaded: the Public-log rule, applied to a new source.
- **Reproduction never changes severity.** The Medium floor and the scale stay as they are, and a reproduced Low is still dropped.
- **An unreproduced Medium+ finding is still reported**, as `Reproduced: no` with a one-line reason. Failing to reproduce in a sandbox is weak evidence that the bug is absent, and dropping those findings would make a deep scan see less than the static audit.
