<!--
The release notes template. `scripts/prepare-release.sh` copies everything
below the template-end line to `release-notes/<tag>.md` and fills in the tag.
Replace every TODO(release-notes) line; neither the prepare commit nor the cut
accepts notes that still have one. Model: release-notes/v1.0.0-beta.5.md.
-->
<!-- template-end -->

TODO(release-notes): one paragraph. Which {{STAGE}} on the line this is, its bump class (Major, Minor or Patch, per docs/releases.md), and what ships, in a sentence or two.

### Consumer action

- TODO(release-notes): what a Consumer must do, or **None required.** Upgrade the `uses:` pins and the Kit-owned paths together, as always. From a clean branch in your repository:

  ```bash
  npx @mnaimfaizy/agent-kit@{{VERSION}} upgrade --tag {{TAG}}
  ```

  It replaces the Kit-owned paths, rewrites the Agent-kit pins, prints the `examples/` diff for you to apply to your Callers by hand, and runs the `doctor --ci` checks. It commits nothing; review `git diff` and commit.

### TODO(release-notes): a heading per change

- TODO(release-notes): what changed, for a Consumer, with its issue link.

See `CHANGELOG.md` for the full list. Pin reusable workflows with `uses: <owner>/agent-kit/.github/workflows/<file>@{{TAG}}` and copy every path in `kit-owned-paths.txt` from the same tag. See `docs/adopt.md`.
