---
# Pattern guide skeleton: docs/patterns/planning-chain.md in Agent-kit.
# Copy it to .github/ISSUE_TEMPLATE/ (or your tracker's template folder),
# fill in every <placeholder>, and delete these comment lines.
name: PRD
about: A planned feature, published after its plan was grilled against the glossary and the decision records.
title: "<Feature name>"
labels: ["prd"]
---

<!--
The sections down to Further notes are what your spec-writing Companion skill
writes; keep its headings if they differ from these. The planning chain reads
three things from this issue: the Implementation decisions and Out of scope
sections when slicing, and the Assembled-branch gate section when every slice
is in. Use the glossary's terms throughout, and no file paths: they go stale.
-->

## Problem statement

<The problem, from the user's side.>

## Solution

<The solution, from the user's side.>

## User stories

1. As a <actor>, I want <capability>, so that <benefit>.

## Implementation decisions

<The decisions the grilling settled: modules, interfaces, schema and contract changes. Link each decision record a decision rests on.>

## Testing decisions

<The seams the feature is tested at, and what a good test checks there.>

## Out of scope

- <What this PRD does not cover.>

## Further notes

<Anything else a slice's builder needs. A builder may not be able to read the tracker, so the dispatcher puts this whole body in each slice's brief.>

## Assembled-branch gate

Run once, when every slice is integrated, on the assembled branch against `<default branch>`:

- `<check command>`

The verdict is posted as a comment on this issue. It reports; it does not undo any slice.
