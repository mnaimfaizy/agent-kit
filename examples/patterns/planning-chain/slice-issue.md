---
# Pattern guide skeleton: docs/patterns/planning-chain.md in Agent-kit.
# Copy it to .github/ISSUE_TEMPLATE/ (or your tracker's template folder),
# fill in every <placeholder>, and delete these comment lines.
name: Slice
about: One vertical slice of a PRD, which a builder can finish and verify on its own.
title: "<Feature name>: <the behaviour this slice makes work>"
labels: []
---

<!--
Publish it as a sub-issue of its PRD. Then give it, from labels.json:
- exactly one tier label: tier:mechanical, tier:standard or tier:full;
- exactly one of afk or hitl;
- the dispatch label (ready-for-agent) only if it is afk, or ready-for-human
  if it is hitl.
Record each blocking edge once: here under Blocked by, or as the tracker's
native dependency link, never both. Publish blockers first, so each edge can
name a real issue.
-->

## Parent

<#PRD issue number>

## What to build

<The end-to-end behaviour this slice makes work, from the user's side: a narrow path through every layer, not one layer.>

## Acceptance criteria

- [ ] <Criterion a builder can check on its own.>

## Decision needed

<Only on a hitl slice: the decision a person makes before a builder can start, and who makes it. Delete this section on an afk slice.>

## Blocked by

- <#issue number>: <what this slice needs from it>

<Or, with no blockers: - None. A reference only counts as an edge when it starts a list item.>
