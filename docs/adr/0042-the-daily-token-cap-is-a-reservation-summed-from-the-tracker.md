---
status: proposed
---

# The Factory's daily token cap is a reservation summed from the tracker

The Factory limits spend per repository per UTC day in **tokens**, never money ([ADR 0036](0036-a-stage-records-counts-come-from-what-the-kit-runs.md)). The Dispatcher does not read Run Records from the Sink. Instead, each Stage's trusted step writes the run's token total, as the model proxy counted it, into the Claim's release comment. Each sweep adds up the release comments posted since 00:00 UTC. It then **reserves** the per-run `max_tokens` of every Stage still running. A Stage starts only if spent + reserved + that Stage's own cap ≤ the daily cap. The cap therefore holds at all times, not just on average.

Decided in [Kill switch, budgets and spend cap](https://github.com/mnaimfaizy/agent-kit/issues/493), on the map [Wayfinder: Agentic Software Factory](https://github.com/mnaimfaizy/agent-kit/issues/480).

- **Per-run caps** are `limits.<stage>` in the factory config (turns, minutes, tokens), enforced from outside the sandbox: by the harness's own flag, the Launcher and the proxy. The build's token cap is picked by the **Task size** (`s | m | l`) the planner proposes in the Plan header. A limit that fires ends the run as `stopped: <limit>` and counts as an Attempt, so a task that needs more than its size allows reaches `needs-decision` after three runs, and only a person's `A<n>:` answer raises its size.
- **A Stage that does not fit waits**, and a smaller one that fits may start before it. At 00:00 UTC the budget is free again and the sweep's oldest-first order starts the oldest task first. `doctor` refuses a config whose per-run cap exceeds the daily cap, so nothing waits forever.
- **At 100%** the sweep takes no new Claims until 00:00 UTC. Running Stages finish inside their reservations, and the merge gate still merges, since a merge spends no tokens. It is a throttle, not the Kill switch (`AGENT_KIT_FACTORY_ENABLED`).
- **Notices.** At 80% and 100% the sweep posts one comment per day on the Factory control issue, mentioning `budget.notify`.
- **Changing the cap.** `budget.daily_tokens` lives in the factory config, a Guarded path, so changing it takes an approved pull request. The variable `AGENT_KIT_FACTORY_DAILY_TOKENS` overrides it, with no commit. Only a user-owned repository's owner, or an organization repository's admin, can set it, the same people who hold the Kill switch. Per-run caps and sizes change only by pull request.
- **Harnesses the proxy cannot front** are refused for Factory Stages: they have no token count and no per-run cap.

## Considered Options

- **Read Run Records from the Sink.** Rejected: the Dispatcher would need a Sink credential beside `GITHUB_TOKEN` ([ADR 0037](0037-the-workflow-dispatcher-is-one-queued-sweep-over-the-tracker.md)), and the tracker would stop being the only ledger.
- **Count only finished runs** (no reservation). Rejected: parallel Stages started under the cap could together overshoot it by up to `max_running` builds.
- **A money cap.** Rejected: no measured cost exists. The proxy counts tokens, and a harness's cost is an estimate.
- **Cap the build by Risk tier, or one cap for every build.** Rejected: risk and effort are different axes, and one cap either wastes reservation on small tasks or starves large ones.
- **Strict queue order under a tight budget.** Rejected: one large build would leave the day's remaining budget idle.
- **A comment command on the control issue to change the cap.** Rejected: any write user can comment, while only the owner or admin can set a variable.

## Consequences

- The release comment is now evidence the budget depends on. Like any edited evidence it is void ([ADR 0038](0038-label-ownership-is-enforced-by-reconciling-against-evidence.md)): the sweep counts a run with edited or missing totals at its full cap.
- The reservation is pessimistic: a busy day stops starting work before the tokens are actually spent.
- A Consumer that wants a harness the proxy cannot front cannot use it in the Factory.
