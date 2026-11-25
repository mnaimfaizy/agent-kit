---
status: proposed
---

# The Factory sweep runs from a Kit-owned bundle, and its GitHub-side setup is a separate `factory setup` command

On the Workflow engine, the Dispatcher's sweep, the merge gate's core, the record writer and the factory config's schema ship as one bundled file in a new **Kit-owned path**, `.github/agent-factory/`. `init` copies it, `upgrade` replaces it whole, and `doctor` checks it against the tag, the same way `.github/agent-runtime/` works. The reusable `factory-dispatcher` workflow runs the sweep from the Consumer's checkout. The CLI's `agent-kit factory sweep`, used by the Orchestrate engine, is built from the same module.

`agent-kit init --factory` keeps the promise that `init` **writes only local files**. Everything on GitHub's side goes to a new command, `agent-kit factory setup`: the labels, the pinned Factory control issue, the GitHub App manifest flow, the App's key in the `factory-publish` environment secret, the client ID variable and the default-branch ruleset. It needs a terminal and an admin `gh` login, refuses in CI, shows and confirms each write, and can be run again safely. No command ever sets the Kill switch `AGENT_KIT_FACTORY_ENABLED`. It stays the last step, run by hand after the Callers are reviewed and pushed.

Decided in [Packaging the Factory blueprint](https://github.com/mnaimfaizy/agent-kit/issues/496), on the map [Wayfinder: Agentic Software Factory](https://github.com/mnaimfaizy/agent-kit/issues/480).

## Considered Options

- **Run the sweep with `npx @mnaimfaizy/agent-kit@<version> factory sweep`.** Rejected for three reasons: it fetches from npm on every sweep (every 15 minutes and on every event); the code that runs is pinned by a version string beside the `uses:` pin rather than by the tag `doctor` verified; and the two pins can drift apart.
- **Vendor the sweep into a Consumer-owned file.** Rejected: the Consumer would own code they must never edit, and `upgrade` could not replace it whole.
- **Let `init --factory` do the GitHub writes itself.** Rejected: `init` runs in places with no admin login and no browser, and it is safe to run because it writes only local files. The App manifest flow also needs a person signed in to GitHub to click **Create**, and then to install the App.
- **Let `factory setup` turn the Factory on.** Rejected: switching it on is the human's go-ahead after reviewing what was written, as with every other flow's Kill switch.

## Consequences

- A Factory repository has one more Kit-owned path, and `kit-owned-paths.txt` lists it.
- Setting up a Factory takes two commands and a hand-set variable, not one command.
- On the Orchestrate engine, `factory setup` writes the labels, the control issue and the ruleset, and creates no App or environment. `.github/agent-factory/` is not written, since the CLI carries the sweep.
