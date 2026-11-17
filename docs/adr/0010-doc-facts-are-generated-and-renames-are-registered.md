---
status: accepted
---

# Doc facts are generated from code, renames are registered once, and prose drift is a review finding

Docs drifted each time a change renamed or added something a Consumer reads: the #246 variable rename left old names in nine pages, the dogfood Review response paragraph (#251) listed protected paths from memory, and the implementer's limits (#252) were never documented. So a list or table that has one source in code (a Doc fact: Stage variables, protected paths, each agent's tool limits, Trigger labels) is written into a Generated block by one generator with a `--check` mode, and CI fails when a block is stale. Each removed or renamed name goes into one Deprecation register, which a test reads to fail on any mention outside the paths allowed to keep it, `prepare-release.sh` reads for the release notes' old-to-new table, and `doctor`'s rename map must equal. Hand-written prose is not gated by CI: the `code-review` skill's Standards pass reports a Docs-impact finding, using the repository's Docs map when it has one.

The gate covers the Consumer docs (`README.md`, `docs/` apart from `docs/research/` and `docs/agents/`, `cli/README.md`, `examples/`, the reusable workflows' header comments) and `CONTRIBUTING.md`, `GLOSSARY.md` and `AGENTS.md`. History (ADRs, `CHANGELOG.md`, `release-notes/`) is exempt: it is meant to keep old names. It adds no CI job and no agent run: the checks run in the existing Tests job, and the docs-impact check rides on `agent:review`.

## Considered Options

- **A contract test per fact, as #249 did for the variable rename.** Rejected as the general rule. Each test is written after the drift is found, and the list in the doc still has to be typed by hand. Kept only for facts that appear in running prose.
- **New generated pages, like `docs/reference.md`.** Rejected for these facts. A list makes sense only beside the prose that explains it, so the block lives inside the page that already describes the area.
- **Fail CI on prose drift too.** Rejected. Judging prose by script gives false positives a PR can't fix, and an agent job on every PR would add cost the kit avoids.
- **`doctor` reads the register from the pinned tag.** Rejected. The CLI holds only code and has no YAML parser; a constant with an equality test keeps the register the single source without a new read.
- **A "deprecated, still works" state.** Deferred to `1.0.0`, with a deprecation policy. In beta a rename is a clean cut (ADR 0009).

## Consequences

- An author who adds a new kind of list fact adds its Generated block in the same pull request. CONTRIBUTING says how, and the docs-impact check flags an unmarked hand-written copy of a code constant.
- The `code-review` skill is Kit-owned, so its new check reaches Consumers. For them the Docs map is optional.
