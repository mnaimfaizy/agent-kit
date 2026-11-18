<!-- Pattern guide skeleton: docs/patterns/external-skills-registry.md in Agent-kit.
     The approval list. Copy it next to your project skills, fill in every
     <placeholder>, replace the example entries, and delete this comment. -->

# Approved external skills

Skills written outside this repository that this repository approves. This page is the only list of them. Every other doc links here and does not restate it; `<check command>` fails on a doc that copies an entry.

An approved skill is installed at project scope, into `<project skills folder>`, and committed. It is never hand-edited, and it changes only through the installer, so an upstream change arrives as a diff in a pull request. `<path to skills-lock.json>` is the registry the installer writes; `<check command>` holds it and this list in step in both directions.

There is no personal-scope tier. A skill on one person's machine is missing from every fresh clone and from CI, so nothing may route to it, and nobody here can review it when it changes.

## Approved: project scope, committed

- `example-org/agent-skills@api-style`: <the trigger: when an agent should load it>. Approved <date> by <who>, after <how it was checked: read in full, installed in a throwaway clone>.
- `example-org/agent-skills@release-notes`: <the trigger>. Approved <date> by <who>, after <how it was checked>.

Install a newly approved skill, then commit what the installer wrote:

```sh
<installer command to add one skill at project scope>
```

Refresh every approved skill, read the diff, and commit it:

```sh
<installer command to update project-scope skills>
```

To change an approved skill's behaviour for this repository, do not edit it. Put the rule where it is always true: your always-on instructions for a rule that holds whatever skill runs, or your own skill for a step only one workflow needs.

## Excluded

Skills considered and not approved, with the reason, so the next person to propose one finds the reason before they repeat the evaluation.

- `<owner/repo@skill>`: <why not: it conflicts with a rule here, it duplicates one of your own skills, or it ships nothing usable>.
