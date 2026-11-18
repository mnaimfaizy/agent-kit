# Pattern guide: a registry of external skills

A way to use skills written outside your repository so that every clone and every CI run has the same version, an upstream change arrives as a diff you review, and the list of what is approved lives in one place that a check keeps true. This is a **Pattern guide** ([ADR 0012](../adr/0012-pattern-guides-are-docs-a-consumer-adapts.md)): you read it, copy the skeleton, and adapt it. Agent-kit does not install or upgrade it.

Skeleton to copy: [`examples/patterns/external-skills-registry/`](../../examples/patterns/external-skills-registry/)

- [`skills-lock.json`](../../examples/patterns/external-skills-registry/skills-lock.json): an example lock file, in the shape one skills installer writes. Yours is whatever your installer writes.
- [`approved-external-skills.md`](../../examples/patterns/external-skills-registry/approved-external-skills.md): the approval list template, with its one approved tier and an excluded section.
- [`external-skills-core.mjs`](../../examples/patterns/external-skills-registry/external-skills-core.mjs): the check's core. Every disagreement it reports is decided by a pure function here.
- [`external-skills-core.test.mjs`](../../examples/patterns/external-skills-registry/external-skills-core.test.mjs): the contract suite, including a test that the example lock file and approval list agree.
- [`check-external-skills.mjs`](../../examples/patterns/external-skills-registry/check-external-skills.mjs): the check's shell, which reads the files and prints what the core finds.
- [`SKILL.md`](../../examples/patterns/external-skills-registry/SKILL.md): the skill an agent follows when it is asked to add, refresh or remove an external skill.

This skeleton has no agent body. Nothing in this pattern drafts or judges: an installer writes, a person approves, and a script checks.

## The problem

Someone else has written a skill you want: a debugging procedure, a style guide for a framework. There are three easy ways to take it, and each goes wrong:

- **Copy it in and edit it.** The copy is now a fork. Upstream improves; the fork does not, and nobody compares them. Within months the fork is behind on a rule upstream added, and the local edits turn out to restate rules that were already in your always-on instructions.
- **Install it on your own machine.** It works for you. It is missing from every fresh clone and from CI, so no other skill can route to it by name, and nobody can review it when it changes. An approval list of personal installs decays without anyone noticing: in one repository, thirteen approved personal-scope skills went four months without a single install, and two of them stopped existing upstream in that time.
- **Install it, then edit the installed copy.** The next refresh overwrites the edit, and nothing warns you.

The list of what is approved has its own problem: it gets copied. A README or an onboarding page restates the list "for convenience", and from then on there are two lists and a check, if there is one, reads only one of them.

## The moving parts

```text
        person                     installer                         check
  ┌─────────────────┐  approve  ┌────────────────┐  writes  ┌──────────────────────┐
  │ approval list:  │─────────▶ │ install at     │────────▶ │ list ⇄ lock, both    │
  │ one tier, each  │           │ project scope; │          │ ways; every locked   │
  │ entry's trigger │           │ refresh only   │          │ skill has a folder;  │
  └────────▲────────┘           │ through it     │          │ no personal tier;    │
           │ link, never copy   └───────┬────────┘          │ no doc restates an   │
  ┌────────┴────────┐                   │                   │ entry                │
  │ every other doc │        ┌──────────▼─────────┐         └──────────▲───────────┘
  │ README, guides  │        │ lock file (the     │                    │
  └─────────────────┘        │ registry) + skill  │────────────────────┘
                             │ folders, committed │
                             └────────────────────┘
```

1. **The installer** is the only thing that writes an external skill's folder. It installs at project scope, into the skills folder your harness reads, and writes a lock file entry for each skill: its source and a hash of what it installed.
2. **The lock file is the registry.** It records which folders are someone else's writing. Anything that needs to know, such as your formatter's ignore list or a scan of your own skills for routing, reads it rather than a hand-kept list.
3. **The approval list** is the human record: each approved skill as `owner/repo@skill`, when an agent should load it, who approved it and how they checked it, plus the skills considered and turned down, with the reason.
4. **The check** runs in CI and a pre-commit hook. It fails when the approval list and the lock file disagree in either direction, when a locked skill's folder is missing, when the list grows a personal-scope tier, or when another doc copies an approval entry.

## The rules, and why each one exists

| Rule                                                                                                                                                                                                                                                  | Why                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An external skill is installed at project scope and committed.                                                                                                                                                                                        | Every clone and every CI run has it, so your own skills may route to it by name and link into its files. An upstream change arrives as a diff in a pull request, with a hash, instead of as a silent update on each machine.                          |
| It is never hand-edited, and it changes only through the installer.                                                                                                                                                                                   | An edit is overwritten at the next refresh, without a warning. Routing every change through the installer keeps the lock file's hash true and the folder identical to upstream's version.                                                             |
| A refresh gets its own pull request, and someone reads the diff.                                                                                                                                                                                      | The diff is prose your agents will execute. Mixed into other work it gets skimmed; on its own it can be read like any other change to instructions.                                                                                                   |
| The lock file is the registry of which folders are upstream's. Tools that need the list read the lock file.                                                                                                                                           | A second hand-kept list is the lock file with manual synchronisation, which is strictly worse. Your formatter, if it is not told to skip those folders, reformats them and forks them on the first commit.                                            |
| A person-written approval list names each approved external, its trigger, and how it was checked.                                                                                                                                                     | The lock file says what is installed, not why or when to use it. The trigger is what keeps an approval from sitting unused; the check record says what a future reviewer can rely on.                                                                 |
| The check holds the approval list and the lock file in step, in both directions, and checks every locked skill has its folder.                                                                                                                        | An approval without an install describes something that did not happen. An install without an approval is an unreviewed supplier. A lock entry without a folder means a fresh clone is missing a skill the repository thinks it has.                  |
| There is one approved tier: project scope, committed. A personal-scope tier is refused by the check.                                                                                                                                                  | Nothing may route to a skill that is missing from a fresh clone or from CI, and nobody here can review it when it changes. "Recommended for your machine" is an approval no one owns.                                                                 |
| Content you forked from an upstream skill moves out of the fork: a rule that holds whatever skill runs goes in your always-on instructions; a step only one workflow needs goes in your own skill. The fork is then replaced by the upstream install. | A fork's local content is usually one of these two, and in the fork it is in the wrong place. A safety rule kept inside one skill's fork, such as "never paste a secret into chat", holds only while that skill runs, so it has holes.                |
| A local wrapper around an external skill is not the way to keep local content.                                                                                                                                                                        | A wrapper needs its own name and a description that triggers on the same requests. With two skills claiming the same requests, which one loads is a coin flip, and making the wrapper win means editing upstream's description, which is a hand edit. |
| Every other doc links to the approval list and never restates it. The check fails on a doc that copies an entry.                                                                                                                                      | A copy is a second list that nothing keeps in step. The worked example below is what that costs.                                                                                                                                                      |
| A skill turned down stays in an excluded section, with the reason.                                                                                                                                                                                    | The next person to propose it finds the reason before they repeat the evaluation, such as a conflict with one of your own rules.                                                                                                                      |

### Worked example: the README that restated the list

One repository kept its approval list next to its skills, and a check compared that list with the lock file. The skills folder also had a README, and the README listed the approved externals by name, as a convenience.

Then two skills that the repository had kept as forks were replaced by upstream installs. The change did everything it was supposed to: it installed the two skills, so the lock file gained them, and it added them to the approval list. The check passed, because the check compared the approval list with the lock file and nothing else. The README was not in any check, and nobody edited it.

For about three months the README named four of the six approved skills. Anyone who read it to learn what was available learned the old answer. It was found by a person reading it, not by a check. The fix was to replace the README's list with a link to the approval list. Adding the README to the check would have fixed that one copy and left the next one unguarded.

That is why the rule is "link, never restate", and why the skeleton's check reads every doc for a copied entry rather than one named file.

## Failure modes

- **A restatement by bare name.** The check catches a copied `owner/repo@skill` entry. A list of bare skill names looks like any doc that routes to a skill by name, so the check cannot tell them apart. Reviewers catch that one; the rule to point at is the link.
- **A skill copied in by hand.** A folder with no lock entry looks like one of your own skills. The check cannot tell it apart from a native one; your own skill checks (a required description, a review of new skills) are where it shows up.
- **The formatter forks upstream.** A formatter that rewrites the installed folders produces a diff on every refresh and a fork on every commit. Add each locked folder to the formatter's ignore list, and if you can, have a check compare that list with the lock file.
- **An upstream rename breaks a link.** One of your skills links into a file inside an external skill; upstream renames the file; your skill still loads and points at nothing. Check that every link from your own skills into a locked folder resolves.
- **The installer drops a skill quietly.** Some installers skip a skill whose frontmatter does not parse and report a smaller count. You approved it, so the approval-without-install check fails, which is the point. Read the installer's output on every add.
- **A skill that runs code.** Most skills are prose. One that runs a package at use time or sends telemetry is a supplier of executable code, and its approval needs the review you would give a dependency: its licence, what it runs, and how to turn the telemetry off.

## Adopting it

1. **Pick the installer and the skills folder.** Use an installer that writes a lock file and can install at project scope into the folder your harness reads.
2. **Copy the skeleton.** Put the approval list next to your project skills, the core, its suite and the shell wherever your scripts live, and the `SKILL.md` in your skills directory. The example lock file shows one installer's shape; use the one your installer writes.
3. **Fill in every placeholder.** Each is written `<like this>` or as a `TODO(adopt)` line. They cover the lock file's path and shape, the approval list's path and its approved heading, the skills folder, the doc roots the check reads, and the installer's add and update commands.
4. **Move what you have.** Install each external you use at project scope, approve it in the list with its trigger, and for each fork, move its local content to where it is always true before you replace the fork with the install. Replace any other list of externals with a link.
5. **Wire it in.** Run the check in CI and in a pre-commit hook. Add the locked folders to your formatter's ignore list.
6. **Try it on purpose.** Remove one approval and check that the check fails on the lock entry. Paste one approval entry into your README and check that it fails there. Add a `## Personal scope` heading and check that it is refused.
