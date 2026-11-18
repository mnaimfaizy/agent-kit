# What GitLab can hold a Team Run's Shared Board in

Research for wayfinder ticket [#304](https://github.com/mnaimfaizy/agent-kit/issues/304) on map [#302](https://github.com/mnaimfaizy/agent-kit/issues/302): which GitLab surfaces (gitlab.com and self-managed) could hold the **Shared Board** of a **Team Run** of the `orchestrate` skill, and what each costs in tier, permissions, concurrent-edit behaviour and rate limits. It recommends nothing; the choice belongs to grilling ticket [#305](https://github.com/mnaimfaizy/agent-kit/issues/305).

- **Read on:** 2026-11-19. docs.gitlab.com pages carry no publish date, so each fact is dated by this read. Version numbers quoted are the ones the docs give.
- **Sources:** primary only: docs.gitlab.com (user docs, REST API, GraphQL reference, administration and rate-limit pages) and the `glab` CLI docs hosted there (docs.gitlab.com/cli). Links are given per fact.
- **Nothing was created or run** on any GitLab instance; no API call was made.
- **UNCONFIRMED** marks anything no source read here states. All are listed again at the end.

## What a Shared Board row needs

From [RUN.md](../../.claude/skills/orchestrate/RUN.md) and the map: per ticket, at least the ticket, its **assignee** (set by people; `unassigned` when none), its **state** (`planned`, `parked`, `running`, `waiting`, `reported`, `verified`, `ready to merge`, `merged`, and the rest), its branch and merge request, open Decision Requests, and whether it is **blocked by** another ticket, read from the tracker. Each teammate's Chief of Staff writes its own rows and reads everyone's, on a heartbeat every few minutes.

## Summary table

| Surface | Tier | Who can write it | Concurrent edits | Reads as, in GitLab's UI |
| --- | --- | --- | --- | --- |
| Epic with spec issues as child items | Premium, Ultimate | Add issue to epic: Guest+, with edit rights on the issue | Parent/child links are per-edge, no shared text | Epic page lists child items |
| Issue board + plain labels | Free | Labels and card moves: Planner+ (Guest only at creation) | `add_labels`/`remove_labels` are deltas; but plain labels are not exclusive, so a stale writer can leave two state labels | Board columns = label lists |
| Issue board + scoped labels (`state::running`) | Premium, Ultimate | Same as above | Adding `key::b` removes `key::a` server-side | Board columns; one state per item |
| Work item **Status** widget | Premium, Ultimate (GA 18.4) | Planner+, or author/assignee | Single field per item | Status in sidebar; status lists on boards (Premium) |
| Linked items: `relates to` | Free | Guest+ on both projects (since 17.0) | Per-edge | "Linked items" section |
| Linked items: `blocks` / `is blocked by` | Premium, Ultimate | Guest+ on both projects | Per-edge | Blocked icon on lists and boards |
| A board in one issue/epic **description** | Free (issue), Premium (epic) | Planner+ (Guest: only own or assigned) | **Last write wins**; no optimistic lock on writes | Rendered Markdown |
| One **note** (comment) per teammate | Free | Guest+ to comment; only the author (or Maintainer+) edits it | Each note has one writer | Comment thread |
| Work item **custom fields** | Premium, Ultimate (GA 18.0) | Define: Maintainer/Owner of top-level group; set: Planner+ | Single field per item | Sidebar fields |

## 1. Epics and their child issues

- Epics need **Premium or Ultimate**, on GitLab.com, Self-Managed and Dedicated; multi-level epics (epics under epics) are **Ultimate** only ([Epics](https://docs.gitlab.com/user/group/epics/)).
- "An epic is a type of work item"; generally available as a work item in GitLab 18.1 ([Epics](https://docs.gitlab.com/user/group/epics/)). The **Epics REST API** "was deprecated in GitLab 17.0", is "planned for removal in v5 of the API", and from 18.1 the Work Items (GraphQL) API is the replacement ([Epics API](https://docs.gitlab.com/api/epics/)). The Epic Issues REST API is labelled deprecated in the docs navigation ([Epics API](https://docs.gitlab.com/api/epics/)).
- An epic can be the parent of issues, including issues from another group hierarchy ([Epics](https://docs.gitlab.com/user/group/epics/)). Adding issues to an epic: Guest+, but it needs permission to view the epic and edit the issue ([Permissions](https://docs.gitlab.com/user/permissions/)). REST: `epic_id` on issue edit, Premium/Ultimate ([Issues API](https://docs.gitlab.com/api/issues/)); GraphQL: `hierarchyWidget` on `workItemUpdate` ([GraphQL mutations](https://docs.gitlab.com/api/graphql/reference/mutations/)). Adding child items is rate-limited at 300/min per user ([Rate limits](https://docs.gitlab.com/security/rate_limits/)).
- **On Free**, an issue's child items are **tasks** (Free, Premium, Ultimate), not issues ([Tasks](https://docs.gitlab.com/user/tasks/)). Whether an issue can be the parent of another issue on any tier: **UNCONFIRMED** (the hierarchy rules page was not read; the Work items page does not list the allowed pairings).

## 2. Issue boards and scoped labels

- Project issue boards, multiple per project, are **Free**; Free gets one group board, Premium/Ultimate multiple ([Issue boards](https://docs.gitlab.com/user/project/issue_board/)).
- **Label lists** are not tier-gated; **assignee, milestone, iteration and status lists**, and configurable (scoped) boards, are **Premium/Ultimate** ([Issue boards](https://docs.gitlab.com/user/project/issue_board/)).
- A board is a view, not storage: dragging a card between label lists removes the source label and adds the target label; dragging to Closed closes the issue; assignee and status lists change the assignee or status ([Issue boards](https://docs.gitlab.com/user/project/issue_board/)). So the board's state lives in labels (or status) on each ticket.
- Creating boards, editing lists, moving cards: Planner+ ([Issue boards](https://docs.gitlab.com/user/project/issue_board/); "Manage issue boards" row in [Permissions](https://docs.gitlab.com/user/permissions/)).
- **Scoped labels** (`key::value`) are **Premium/Ultimate**. An item "can't carry two scoped labels with the same key"; adding one with the same key replaces the old one ([Labels](https://docs.gitlab.com/user/project/labels/)). On Free, plain labels are not exclusive, so moving `state-running` to `state-reported` takes an add and a remove (both possible in one REST `PUT` with `add_labels` and `remove_labels`, [Issues API](https://docs.gitlab.com/api/issues/)).
- Creating project/group labels: Planner+ since 17.7 ([Labels](https://docs.gitlab.com/user/project/labels/)). Applying labels to an existing issue is "metadata", Planner+; a Guest "can only set metadata when creating an issue" ([Permissions](https://docs.gitlab.com/user/permissions/)). The REST edit creates a missing label as a project label ([Issues API](https://docs.gitlab.com/api/issues/)).
- A Boards REST API exists in GitLab's API docs: **UNCONFIRMED** (the boards user page does not mention it, and it was not read). A Team Run would not need it: reading items by label and assignee is enough.

## 3. Work item Status

- **Premium/Ultimate**; introduced 18.2, generally available in **18.4**. Default statuses: To do, In progress, Done, Won't do, Duplicate (not modifiable). Custom statuses are defined on the top-level group by a Maintainer or Owner; 70 per top-level group, 30 per lifecycle. Done and Canceled categories close the item ([Status](https://docs.gitlab.com/user/work_items/status/)).
- Set by Planner+, or by the item's author or assignee ([Status](https://docs.gitlab.com/user/work_items/status/)).
- GraphQL: `statusWidget` on `workItemUpdate`, marked "Introduced as an experiment in GitLab 17.11" in the reference ([GraphQL mutations](https://docs.gitlab.com/api/graphql/reference/mutations/)). `glab work-items update --status` takes `todo`, `in-progress`, `done`, `wont-do`, `duplicate` and "needs the status widget, which is Premium and Ultimate only" ([glab work-items update](https://docs.gitlab.com/cli/work-items/update/)).
- The five default statuses are far fewer than RUN.md's states; mapping them needs custom statuses (top-level-group Maintainer), or Status for the coarse phase plus labels for the fine state. Whether a REST endpoint sets Status: **UNCONFIRMED**.

## 4. Linked items and blocking

- "Relates to" links are **Free**; **blocking relationships ("blocks", "is blocked by") need Premium or Ultimate**; on GitLab.com, Self-Managed and Dedicated. Links are bi-directional and can span projects and groups; a user sees a link only if they can view both issues ([Linked issues](https://docs.gitlab.com/user/project/issues/related_issues/)).
- Adding a link: Guest+ on **both** projects since GitLab 17.0 (Reporter before) ([Linked issues](https://docs.gitlab.com/user/project/issues/related_issues/)). The REST create requires the user to be allowed to update both issues ([Issue links API](https://docs.gitlab.com/api/issue_links/)).
- UI: a blocked issue shows an icon next to its title in issue lists and on boards; it clears when the blocker closes or the link is removed; closing an issue with open blockers warns ([Linked issues](https://docs.gitlab.com/user/project/issues/related_issues/)).
- REST: `GET/POST /projects/:id/issues/:issue_iid/links`, `link_type` one of `relates_to` (default), `blocks`, `is_blocked_by` ([Issue links API](https://docs.gitlab.com/api/issue_links/)). The API page is badged Free, Premium, Ultimate; whether a Free instance rejects or silently downgrades `blocks`: **UNCONFIRMED**.
- GraphQL: `workItemAddLinkedItems` (`linkType`: `RELATED`, `BLOCKS`, `BLOCKED_BY`; at most 10 ids per call; marked experiment since 16.3). The linked-items widget exposes `blocked`, `blockedByCount`, `blockingCount`, and `linkedItems(filter: BLOCKED_BY)` ([GraphQL mutations](https://docs.gitlab.com/api/graphql/reference/mutations/), [objects](https://docs.gitlab.com/api/graphql/reference/objects/), [enums](https://docs.gitlab.com/api/graphql/reference/enums/)).
- **Merged-or-not of a blocker**: blocking clears on the blocker *issue* closing, not on its merge request merging. The merge requests that will close an issue are listed by `GET /projects/:id/issues/:issue_iid/closed_by` ([Issues API](https://docs.gitlab.com/api/issues/)); a Chief of Staff would read the MR's merged state from there.

## 5. Issue description vs a note

**Description** (one shared board text in a "board issue", or in the epic):

- Up to 1,048,576 characters via REST ([Issues API](https://docs.gitlab.com/api/issues/)).
- Editing another person's issue description: Planner+; a Guest can edit only issues they authored or are assigned to ([Permissions](https://docs.gitlab.com/user/permissions/)).
- **No optimistic locking on writes.** The REST edit endpoint has no `lock_version`-style parameter ([Issues API](https://docs.gitlab.com/api/issues/)); GraphQL `workItemUpdate` has none in its inputs, though the `WorkItem` object exposes a read-only `lockVersion` "incremented each time the work item is updated" ([GraphQL mutations](https://docs.gitlab.com/api/graphql/reference/mutations/), [objects](https://docs.gitlab.com/api/graphql/reference/objects/)). Several teammates rewriting one description is therefore last-writer-wins; re-reading `lockVersion` before a write narrows the race but does not close it. Whether the web UI warns on a conflicting edit: **UNCONFIRMED** (no doc found).

**Notes** (one comment per teammate, each holding that teammate's rows):

- `POST` and `PUT /projects/:id/issues/:issue_iid/notes[/:note_id]`, body up to 1,000,000 characters, all tiers ([Notes API](https://docs.gitlab.com/api/notes/)).
- Commenting: Guest+. Editing **another user's** comment: Maintainer+ ([Permissions](https://docs.gitlab.com/user/permissions/)). So a note per teammate has a single writer by construction.
- **Caution:** on create and update GitLab "runs and removes quick actions", removes carriage returns and strips trailing whitespace, so a later GET can differ from what was sent ([Notes API](https://docs.gitlab.com/api/notes/)). A board line beginning with `/` (for example `/close`) would be executed as a quick action. Whether descriptions edited via API also run quick actions: **UNCONFIRMED**.
- Note creation is rate-limited (see section 8); editing an existing note each heartbeat avoids that limit, as it creates nothing (whether `PUT` on a note counts toward the note-creation limit: **UNCONFIRMED**).

## 6. Work items and custom fields

- Issues are work items; the Work items list "replaces the separate Issues and Epics lists", and `/issues/:iid` and `/epics/:iid` URLs redirect to `/work_items/:iid` ([Work items](https://docs.gitlab.com/user/work_items/)).
- **Custom fields**: **Premium/Ultimate**, GA in 18.0. Types: single-select, multi-select, number, text (type fixed at creation). Created, edited, archived by Maintainer/Owner of the **top-level group**; values set by Planner+ (Guests only at creation). Limits: 50 active fields per top-level group, 10 per work item type, 50 options per select, 1,024 characters per text value ([Custom fields](https://docs.gitlab.com/user/work_items/custom_fields/)).
- API: GraphQL `customFieldsWidget` on `workItemUpdate`, marked "Introduced as an experiment in GitLab 17.10" in the reference ([GraphQL mutations](https://docs.gitlab.com/api/graphql/reference/mutations/)). A REST way to set custom fields: **UNCONFIRMED** (none found). `glab work-items update` has no custom-field flag ([glab work-items update](https://docs.gitlab.com/cli/work-items/update/)).
- A single-select custom field could carry the RUN.md state per item with exact values, but setting it up needs a top-level-group Maintainer and Premium.

## 7. `glab` CLI support

- `glab issue`: `board`, `close`, `create`, `delete`, `list`, `note`, `reopen`, `subscribe`, `unsubscribe`, `update`, `view` ([glab issue](https://docs.gitlab.com/cli/issue/)).
- `glab issue update`: `-a/--assignee` (prefix `+`/`-`/`!` to add or remove, else replace), `--unassign`, `-l/--label`, `-u/--unlabel`, `-d/--description`, `--description-file` (`-` for stdin), weight, milestone, `--lock-discussion` ([glab issue update](https://docs.gitlab.com/cli/issue/update/)).
- `glab issue list`: `-a/--assignee` (`@me`, `@none`, `@any`), `--not-assignee`, `-l/--label`, `--not-label`, `-O json`, `--jq`, `-P/--per-page` (default 30), `--updated-after`/`--updated-before` ([glab issue list](https://docs.gitlab.com/cli/issue/list/)).
- `glab work-items` (`create`, `delete`, `list`, `update`) is marked "an experiment and is not ready for production use" ([glab work-items](https://docs.gitlab.com/cli/work-items/)); `update` has `--status`, `--parent`, `--assignee`, description flags, `-F json`, `--jq`, but no label, linked-item or custom-field flag ([glab work-items update](https://docs.gitlab.com/cli/work-items/update/)).
- No `glab` command for linked items or blocking appeared in the pages read; `glab api` covers the gap: any REST v4 path, or `graphql` as the endpoint, with `-f`/`-F` fields, `-X` method and `--paginate` ([glab api](https://docs.gitlab.com/cli/api/)). A dedicated linked-items command: **UNCONFIRMED** (not found, not ruled out).

## 8. Rate limits for a heartbeat every few minutes

**GitLab.com** ([GitLab.com rate limits](https://docs.gitlab.com/user/gitlab_com/rate_limits/)):

- Current: authenticated API 2,000 requests/min per user on all plans; issue creation 200/min; **note creation on issues and MRs 60/min**; unauthenticated 500/min per IP.
- Proposed per-plan limits, stated as not yet in effect: authenticated API Free 5,000/h with 100/min burst, Premium 15,000/h with 1,250/min, Ultimate 25,000/h with 2,000/min; the lower limit applies. The Free burst of 100/min is the one a large Team Run could feel.
- GraphQL limits are not listed there. GraphQL itself: complexity 250 authenticated, 100 nodes per page, 30 s timeout, 10,000-character queries ([GraphQL API](https://docs.gitlab.com/api/graphql/)).

**Endpoint limits, all offerings** ([Rate limits](https://docs.gitlab.com/security/rate_limits/)): issue, epic and work item updates 1,000/min per user (shared across UI, REST and GraphQL; 429 when exceeded, also stated on [Issues API](https://docs.gitlab.com/api/issues/)); add child items 300/min; move/clone 30/min. The page notes many of these are in beta, disabled by default, or behind feature flags.

**Self-managed defaults**: authenticated API rate limit **disabled by default** (7,200 per 3,600 s once enabled); responses carry `RateLimit-*` headers, and a 429 carries `Retry-After` ([User and IP rate limits](https://docs.gitlab.com/administration/settings/user_and_ip_rate_limits/)). Issue creation limit disabled by default; **note creation enabled at 300/min per user** ([Content creation rate limits](https://docs.gitlab.com/rate_limits/content_creation/)). Admins can change all of these, so a given instance may differ.

**Reading of the numbers** (arithmetic, not a source claim): a heartbeat that lists the spec's issues with one paginated call (`labels=` / `updated_after=`, up to 100 per page) plus a handful of edits per teammate per beat stays far below every limit above, even the proposed Free burst of 100/min, as long as each Chief of Staff does not re-read every issue's links and notes one by one each beat.

## 9. Assignees and "blocked by"

- **Assignees**: Free allows **one assignee** per issue ("Users on GitLab Free can assign one user to an issue"); multiple assignees need Premium/Ultimate ([Multiple assignees](https://docs.gitlab.com/user/project/issues/multiple_assignees_for_issues/)). REST create: `assignee_id` (Free) vs `assignee_ids` (Premium/Ultimate) ([Issues API](https://docs.gitlab.com/api/issues/)). Listing by assignee: REST `assignee_username` (on CE, one value only) and `assignee_id`; `glab issue list -a <user>|@me|@none` ([Issues API](https://docs.gitlab.com/api/issues/), [glab issue list](https://docs.gitlab.com/cli/issue/list/)). `@none` gives the map's `unassigned` directly. Assigning is "metadata", Planner+ (a Guest only at creation) ([Permissions](https://docs.gitlab.com/user/permissions/)); the map settles that people, not a Chief of Staff, assign.
- **Blocked by**: a `blocks`/`is_blocked_by` issue link, **Premium/Ultimate** (section 4). Read via REST `GET .../issues/:iid/links` (filter `link_type == "is_blocked_by"`) or GraphQL `linkedItems(filter: BLOCKED_BY)` / `blocked` / `blockedByCount`. **On Free there is no blocking relationship**: a Team Run on Free would have to express "blocked by" another way (a `relates_to` link plus a convention, a label, or a line in the description); which way is for #305.

## Unconfirmed

1. Whether an issue can be the parent of another issue (as opposed to tasks) on any tier.
2. Whether a Boards REST API exists (not needed for a Team Run).
3. Whether a REST endpoint sets work item Status.
4. Whether `POST .../links` with `link_type=blocks` is rejected or downgraded on a Free instance (the API page is badged Free; the user docs say blocking is Premium).
5. Whether the web UI warns on concurrent description edits (the `lockVersion` field exists, but no doc describes the UI behaviour).
6. Whether quick actions run on descriptions set through the API (documented for notes).
7. Whether editing a note (`PUT`) counts toward the note-creation rate limit.
8. A REST way to set custom fields.
9. A dedicated `glab` command for linked items.
10. GraphQL-specific rate limits on GitLab.com.
