---
status: accepted
---

# A promise that needs two Surfaces is planned as two scenarios

A scenario still drives exactly one **Surface**, with one Driver, as [ADR 0007](0007-a-qa-plan-scenario-carries-its-own-surface.md) set up. When a promise needs something only `api` sees (a status, a body, a cookie) and something only a screen sees, `qa-plan` writes one scenario per Surface, each with its own setup so neither depends on the other's state. A scenario whose **Observes:** no single Surface's drivers can see is a plan problem that says to split it. The config's `run.surface` may name a list: the Surfaces this run may drive, not a matrix that drives every scenario on each.

Decided in [#378](https://github.com/mnaimfaizy/agent-kit/issues/378), from a session-revocation change on `fastapi_rbac` whose promise needed both a refresh-cookie check on `api` and a redirect on `web`.

## Considered Options

- **One scenario on several Surfaces** (`Surface: api, web`, each step naming its Surface). Rejected. It needs `format=3`, so an older reader refuses rather than misreads the plan ([ADR 0003](0003-qa-is-two-skills-joined-by-a-copied-plan-format.md)); two Drivers sharing one scenario's state; and a merged Capture and verdict for a scenario that passes on one Surface and fails on the other.
- **`run.surface` as a matrix**, driving every scenario without its own Surface once per listed Surface. Rejected: it doubles the run, and a screen-only result has nothing to check over `api`. The plan, not the config, decides what each scenario drives.

## Consequences

- With a list, the surface question is asked only when the Run brief's Surface is not in it, and offers the brief's Surface and each listed one. When each side names exactly one, the question is unchanged. The answer is still one Surface.
- A scenario's own **Surface:** outside the list is kept, as before.
- The posted QA Report summary names every Surface the run drove.
