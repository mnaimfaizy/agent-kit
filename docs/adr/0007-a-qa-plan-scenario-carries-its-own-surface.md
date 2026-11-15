---
status: accepted
---

# A QA Plan scenario carries its own Surface

A QA Plan has one **Surface** in its Run brief: what its scenarios drive (`web`, `desktop`, `mobile` or `api`). From `format=2`, a scenario may carry its own **Surface:**, right after its sign-in field, which overrides the Run brief's for that scenario. The Run brief's becomes the plan's default, the surface most scenarios use. `qa-plan` picks each scenario's surface from what its expected result must observe: response headers, cookies, status codes and bodies on `api`; rendered copy, flows and layout on `web`. `manual-qa` finds a **Driver** per scenario from its effective surface, and the QA Report's **Run:** line names each surface used and its driver.

In a pilot run, a `Set-Cookie: Max-Age` and `HttpOnly` promise was planned on `web`, the config's `run.surface`, where no driver could see it, and a promise about explainer copy that needed another surface was dropped. One surface per plan made the composer pick the wrong one for some scenarios, or leave them out.

Recorded in [#203](https://github.com/mnaimfaizy/agent-kit/issues/203), part of [#184](https://github.com/mnaimfaizy/agent-kit/issues/184).

## Considered Options

- **One plan per surface.** Rejected. Delivery finds and edits one plan per subject (the tracker issue or pull request comment that carries its marker), and a pull request carries one QA Report comment. Two plans for one change would need two of each, and a revision would have to find and replace both.
- **Keep one Surface per plan, and let the composer pick it from the scenarios.** Rejected. A change with both an API promise and a screen promise still has scenarios on two surfaces; one of them would be planned where no driver can see it.
- **A per-scenario field with no format change.** Rejected. The plan reader ignores labels it does not know, so an older copy of `manual-qa` would run an `api` scenario on the Run brief's surface without a word. `format=2` makes that copy refuse the plan with a clear message ([ADR 0003](0003-qa-is-two-skills-joined-by-a-copied-plan-format.md)).

## Consequences

- **The composer writes `format=2`.** The reader accepts `format=1` and `format=2`; a `format=1` plan carries no per-scenario field, so a per-scenario **Surface:** there is a plan problem. A copy that reads `format=1` only refuses a `format=2` plan: update the skill.
- **A revision still finds the plan it replaces.** Delivery accepts a tracker issue or comment whose marker says `format=1` or `format=2`.
- **Target stays one per plan.** Every scenario runs against the one build at the one address the run checked; only what it drives there changes.
- **One run can need several drivers.** A scenario whose surface has no driver here is left for a person, as before; the others still run.
