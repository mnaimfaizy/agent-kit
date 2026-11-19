"""Contract test: the Security Response Run, as `security-response` and its run doc define it.

The skill is prose, so this pins the sentences a run relies on (where the run
folder lives, the ignore gate, the layout, the board, the state lists and what
is final, the modes, reconcile: its sources, who wins, and the rules that it
never deletes a row, keeps a contradicted final row final and moves nothing on
an unavailable source), the closed `record` set and what each form verifies,
the gates on publishing, closing and requesting a CVE, and `close`: the
preview, one ledger PR, `closing` → `closed`, the Row → line mapping and
append only, not what they mean. What a sentence means is for review.
It also keeps the retired status-format file gone, with nothing linking to it.
The Deprecation register records that path too, but it matches only the full
path: a relative link from inside the skill folder, or the file itself coming
back, would pass it, so this test stays.
"""

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SKILL_DIR = ROOT / ".claude" / "skills" / "security-response"
SKILL = SKILL_DIR / "SKILL.md"
RUN = SKILL_DIR / "RUN.md"
TRIAGE_DIR = ROOT / ".claude" / "skills" / "security-finding-triage"
TRIAGE = TRIAGE_DIR / "SKILL.md"
OUTCOME_FORMAT = TRIAGE_DIR / "OUTCOME-FORMAT.md"
LEDGER_SKELETON = ROOT / "examples" / "threat-pack" / "findings-ledger.md"
OUTCOMES = ["confirmed", "rejected", "below-floor", "accepted-risk", "duplicate"]
RETIRED = "STATUS-FORMAT.md"
MODES = "status | next | triage <target> | fix <target> | reconcile | record <what> | close"
MODE_NAMES = ["status", "next", "triage <target>", "fix <target>", "reconcile", "record <what>", "close"]
EVIDENCE = ["untriaged", "confirmed", "rejected", "duplicate", "below-floor"]
DELIVERY = ["open", "fix PR open", "merged", "released", "fixed", "accepted-risk"]
ADVISORY_STATES = ["draft", "published", "closed"]
FINDINGS_COLUMNS = "| Concept id | Advisory | Severity | Evidence | Delivery | Record | Next |"
ADVISORIES_COLUMNS = "| Advisory | Created | Rows | State | CVE | Fork clone | Next |"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def section(text: str, heading: str) -> str:
    """The body under `## <heading>`, up to the next `## ` heading."""
    assert f"\n## {heading}\n" in text, f"missing section: ## {heading}"
    return text.split(f"\n## {heading}\n", 1)[1].split("\n## ", 1)[0]


def subsection(text: str, heading: str) -> str:
    """The body under `### <heading>`, up to the next `### ` heading."""
    assert f"\n### {heading}\n" in text, f"missing subsection: ### {heading}"
    return text.split(f"\n### {heading}\n", 1)[1].split("\n### ", 1)[0]


def item(text: str, starts_with: str) -> str:
    """The `- ` list item of `text` that starts with `starts_with`."""
    return next(s for s in text.split("- ") if s.startswith(starts_with))


def flat(text: str) -> str:
    """The text with each run of whitespace made one space, so a sentence is found however it wraps."""
    return re.sub(r"\s+", " ", text)


def frontmatter(text: str) -> str:
    return text.split("---\n", 2)[1]


def code_values(line: str) -> list[str]:
    return re.findall(r"`([^`]+)`", line)


def test_argument_hint_and_mode_list() -> None:
    assert f'argument-hint: "{MODES}"' in frontmatter(read(SKILL)), "argument-hint must read the seven modes"
    modes = section(read(SKILL), "Modes")
    listed = [m.group(1) for m in re.finditer(r"^- `([^`]+)`", modes, re.MULTILINE)]
    assert listed == MODE_NAMES, f"the mode list must read {MODE_NAMES}, got {listed}"


def test_every_mode_opens_or_resumes_the_run() -> None:
    text = flat(read(SKILL))
    assert "Every mode starts by opening or resuming the Security Response Run" in text
    assert "There are no `open` or `resume` modes." in text
    assert "[RUN.md](RUN.md)" in text, "SKILL.md must link the run doc"
    runs = flat(section(read(RUN), "Open, resume, or nothing to respond to"))
    assert "At most one run is open at a time." in runs
    assert "resumes the open run" in runs
    assert "opens a run" in runs
    assert "no draft advisories and no open run" in runs.lower()
    assert "nothing to respond to" in runs and "writes nothing" in runs
    opening = next(s for s in runs.split(" 3. ", 1)[1:])
    gate, folder = opening.find("Pass the ignore gate"), opening.find("make the folder")
    assert 0 <= gate < folder, "opening a run passes the ignore gate before it makes the folder"


def test_status_prints_the_board() -> None:
    status = next(line for line in read(SKILL).splitlines() if line.startswith("- `status`"))
    assert "prints the board" in status and "RUN.md" in status, f"status must print the board: {status!r}"


def test_run_folder_path_has_no_config() -> None:
    where = flat(section(read(RUN), "Where the run folder lives"))
    assert "`tmp/security-response/<run>/`" in where
    assert "`<run>` is the date, `YYYY-MM-DD`, with `.2`, `.3` added when that folder is already there" in where
    assert "There is no config key" in where
    assert "no dependency on orchestrate" in where


def test_ignore_gate_writes_nothing_without_a_yes() -> None:
    where = flat(section(read(RUN), "Where the run folder lives"))
    assert "`git check-ignore -q tmp/security-response/`" in where
    assert "Before the first write" in where
    assert "offer to add `tmp/security-response/` to the root `.gitignore`" in where
    assert "write nothing without a yes" in where
    assert "`git clean -x` deletes the folder" in where
    assert "a worktree cannot see it" in where.lower()


def test_the_repository_ignores_its_own_run_folder() -> None:
    assert "tmp/security-response/" in read(ROOT / ".gitignore").splitlines()
    probe = "tmp/security-response/2026-01-01/board.md"
    ignored = subprocess.run(["git", "check-ignore", "-q", probe], cwd=ROOT, check=False)
    assert ignored.returncode == 0, f"git must ignore {probe}"


def test_layout() -> None:
    layout = section(read(RUN), "Layout")
    for entry in ("board.md", "activity.md", "triage/<concept-id>.md", "originals/<GHSA-id>.json"):
        assert re.search(rf"^  {re.escape(entry)} ", layout, re.MULTILINE), f"the layout must list {entry}"
    text = flat(layout)
    assert "append-only" in text
    assert "before any PATCH that rewrites it publicly" in text
    assert "Nothing in the run folder is committed" in text


def test_provisional_concept_ids_fold_into_one_row() -> None:
    ids = flat(section(read(RUN), "Concept ids"))
    assert "each `GHSA:F<n>` gets a provisional concept id from its title" in ids
    assert "Findings with the same id fold into one row" in ids
    assert "`hg89 F2, xmp7 F1`" in ids, "the folded row's Advisory cell must list both advisories"
    assert "final at triage" in ids


def table_rows(text: str) -> str:
    """The text with the padding prettier puts around each table cell taken out."""
    return re.sub(r" *\| *", " | ", text)


def board_doc() -> str:
    """The `## Board` section; its fenced example holds `## Findings` and `## Advisories`, so cut at `## States`."""
    return read(RUN).split("\n## Board\n", 1)[1].split("\n## States\n", 1)[0]


def test_board_format() -> None:
    board = table_rows(board_doc())
    assert "Default branch: main@<sha>, checked <time>" in board
    assert "not checked: <source> unavailable" in board
    waiting, agent = board.find("**Waiting on you:**"), board.find("**Next (agent):**")
    assert 0 <= waiting < agent, "Waiting on you comes first, then Next (agent)"
    findings, advisories = board.find(FINDINGS_COLUMNS), board.find(ADVISORIES_COLUMNS)
    assert agent < findings < advisories, "the findings table, then the advisories table"
    order = flat(board)
    assert (
        "ordered by severity, highest first (`critical`, `high`, `medium`, then anything below), then by advisory"
        in order
    )
    assert "Final rows stay in place" in order


def bullets(text: str) -> dict[str, str]:
    return {m.group(1): m.group(2) for m in re.finditer(r"^- `([^`]+)`: (.+)$", text, re.MULTILINE)}


def test_state_lists() -> None:
    states = section(read(RUN), "States")
    evidence, delivery = subsection(states, "Evidence"), subsection(states, "Delivery")
    advisory = subsection(states, "Advisory state")
    assert "`untriaged | confirmed | rejected | duplicate | below-floor`" in evidence
    assert list(bullets(evidence)) == EVIDENCE
    assert "`open → fix PR open → merged → released`, plus `fixed` and `accepted-risk`" in delivery
    assert list(bullets(delivery)) == DELIVERY
    assert "`draft → published | closed`" in advisory
    assert list(bullets(advisory)) == ADVISORY_STATES


def test_final_states() -> None:
    final = flat(subsection(section(read(RUN), "States"), "Final"))
    row = item(final, "**A row**")
    assert code_values(row) == ["rejected", "duplicate", "released", "fixed", "accepted-risk"], row
    advisory = item(final, "**An advisory**")
    assert code_values(advisory) == ["published", "closed"], advisory
    run = item(final, "**The run**")
    assert "every row and every advisory is final" in run, run
    assert "Final values stay final for the run" in final


def test_status_format_is_retired() -> None:
    assert not (SKILL_DIR / RETIRED).exists(), f"{RETIRED} is retired: the board in RUN.md replaces it"
    tracked = subprocess.run(["git", "ls-files"], cwd=ROOT, capture_output=True, text=True, check=True).stdout
    linking = []
    for name in tracked.splitlines():
        path = ROOT / name
        history = name in ("CHANGELOG.md", "docs/deprecations.yml") or name.startswith(
            "scripts/security-response-contract"
        )
        if history or not path.is_file():
            continue
        try:
            if RETIRED in path.read_text(encoding="utf-8"):
                linking.append(name)
        except UnicodeDecodeError:
            continue
    assert not linking, f"still naming {RETIRED}: {linking}"


def reconcile_doc() -> str:
    return section(read(RUN), "Reconcile")


def test_reconcile_is_step_one_of_every_mode() -> None:
    skill = flat(read(SKILL))
    assert "Reconcile is step one of every mode" in skill
    flow = section(read(SKILL), "Flow")
    assert "2. Reconcile the run against GitHub and git ([RUN.md](RUN.md#reconcile))" in flow
    mode = next(line for line in read(SKILL).splitlines() if line.startswith("- `reconcile`"))
    assert "reconcile only" in mode and "RUN.md#reconcile" in mode, f"reconcile must run reconcile alone: {mode!r}"
    when = flat(reconcile_doc())
    assert "Reconcile is step one of every mode" in when
    assert "The `reconcile` mode runs it alone" in when
    assert "the header's `checked <time>` updates" in when


SOURCES = {
    "Advisory list, state, CVE id": ("advisory API", ["security-advisories?state=draft"]),
    "`fix PR open`": (
        "private fork, or the repository for a `below-floor` row",
        ["gh pr list", "gh pr view", "until publish deletes it", "a `below-floor` row's public PR"],
    ),
    "`merged`": ("`origin/main`", ["git fetch", "git merge-base --is-ancestor <fix SHA> origin/main"]),
    "`released`": ("tags", ["git tag --contains <fix SHA>"]),
    "`fixed` (no code)": ("the API, where it can", ["otherwise the human's report stands"]),
    "Concept ids already recorded": ("the findings ledger", ["read only"]),
}


def table_cells(table: str, columns: int = 3) -> list[list[str]]:
    """The cells of each row of a table of `columns` columns that `table_rows` has evened out."""
    return [line.strip(" |").split(" | ") for line in table.splitlines() if line.count(" | ") == columns + 1]


def test_source_table() -> None:
    sources = table_rows(subsection(reconcile_doc(), "Sources"))
    assert "| Board fact | Source | Check |" in sources
    rows = {fact: (source, check) for fact, source, check in table_cells(sources)}
    for fact, (source, checks) in SOURCES.items():
        assert fact in rows, f"the source table must have a row for {fact}"
        assert rows[fact][0] == source, f"{fact} is checked against {source}, got {rows[fact][0]!r}"
        for check in checks:
            assert check in rows[fact][1], f"{fact}'s check must say {check!r}: {rows[fact][1]!r}"
    assert "`findings_ledger_path`" in sources and "`.security/findings-ledger.md`" in sources


def test_who_wins() -> None:
    wins = flat(subsection(reconcile_doc(), "Who wins"))
    source = item(wins, "**The source wins**")
    for fact in ("advisory state", "fix PR state", "the fix SHA on `main`", "the tag"):
        assert fact in source, f"the source owns {fact}: {source!r}"
    board = item(wins, "**The board wins**")
    for fact in ("Evidence", "fork PR numbers and fix SHAs after the fork is gone", "a CVE request", "accepted-risk"):
        assert fact in board, f"the board owns {fact}: {board!r}"


def test_verified_moves_happen_on_their_own_and_judgements_never() -> None:
    moves = flat(subsection(reconcile_doc(), "Moves"))
    assert "Verified moves happen on their own" in moves
    assert "`fix PR open` → `merged`" in moves and "`merged` → `released`" in moves
    assert "Judgements never happen on their own" in moves


def test_an_unavailable_source_moves_no_row() -> None:
    unavailable = flat(subsection(reconcile_doc(), "An unavailable source"))
    assert "`not checked: <source> unavailable`" in unavailable
    assert "moves no row on that source" in unavailable
    assert "A row is never moved, and an advisory never dropped, on a source the run could not read." in unavailable
    assert "A fork that publish has deleted is not unavailable" in unavailable
    assert "the board is still shown" in unavailable


def test_a_contradicted_final_row_stays_final() -> None:
    final = flat(subsection(reconcile_doc(), "Final rows and advisories"))
    assert "Final rows and advisories are not checked again" in final
    assert "A contradicted final row stays final" in final
    assert "goes to the top of Waiting on you" in final
    assert "is logged in `activity.md`" in final


def test_reconcile_never_deletes_rows() -> None:
    rows = flat(subsection(reconcile_doc(), "Rows are never deleted"))
    assert "Reconcile never deletes a row." in rows
    assert "A new draft advisory joins the open run" in rows and "`untriaged`" in rows
    assert "compared with `originals/<GHSA-id>.json`" in rows
    assert "A missing `F<n>` keeps its row" in rows and "raised in Waiting on you" in rows


def test_a_concept_id_in_the_ledger_enters_untriaged() -> None:
    rows = flat(subsection(reconcile_doc(), "Rows are never deleted"))
    assert "already in the findings ledger gets its row as [Concept ids](#concept-ids) says" in rows
    ids = flat(section(read(RUN), "Concept ids"))
    assert "`untriaged`, with Record `in ledger: <status>`" in ids


def test_each_correction_is_logged() -> None:
    log = flat(subsection(reconcile_doc(), "The log"))
    assert "`reconciled: <old> → <new>, checked <how>`" in log


def test_triage_does_not_write_the_ledger() -> None:
    triage = read(TRIAGE)
    process = section(triage, "Process")
    steps = re.findall(r"^\d+\. (.+)$", process, re.MULTILINE)
    assert not any("ledger" in step.lower() for step in steps), f"no process step may edit the ledger: {steps}"
    rules = flat(section(triage, "Hard rules"))
    assert "Never edit the findings ledger." in rules
    assert "Proposed ledger row" in rules, "the rule must name what triage emits instead"
    assert "only a Security Response Run's `close` applies it" in rules
    outcomes = [m.group(1) for m in re.finditer(r"^   - `([^`]+)`", process, re.MULTILINE)]
    assert outcomes == OUTCOMES, f"triage's outcomes must read {OUTCOMES}, got {outcomes}"


def outcome_line(text: str, field: str) -> str:
    return next(line for line in text.splitlines() if line.startswith(f"- **{field}:**"))


def test_outcome_format_gains_below_floor_and_a_proposed_ledger_row() -> None:
    text = read(OUTCOME_FORMAT)
    outcome = outcome_line(text, "Outcome")
    assert outcome.split(":** ", 1)[1].split(" | ") == OUTCOMES, f"the Outcome line must read {OUTCOMES}: {outcome!r}"
    assert "low" in outcome_line(text, "Severity (after triage)").split(" | "), "a below-floor finding needs `low`"
    assert "`<canonical concept-id>`" in outcome_line(text, "Duplicate of")
    assert "\n### Proposed ledger row\n" in text
    assert "Ledger update" not in text, "`Ledger update` is replaced by `Proposed ledger row`"
    row = flat(subsection(text, "Proposed ledger row"))
    assert "| Concept id | Status | First seen | Advisory | Notes |" in table_rows(row)
    assert "Triage never writes it" in row
    outcomes = flat(subsection(text, "Outcomes"))
    assert "`below-floor`" in item(outcomes, "`below-floor`") and "under the Medium floor" in outcomes
    assert "not `rejected`" in item(outcomes, "`below-floor`")
    accepted = item(outcomes, "`accepted-risk`")
    assert "the Delivery ending `accepted-risk`" in accepted and "a recommendation" in accepted, accepted
    found = flat(subsection(text, "Found in triage"))
    assert "a new finding" in found and "its own concept id" in found


def test_the_shared_outcome_definitions_match_the_evidence_states() -> None:
    """Both skills are User-scope, so neither may link the other's file: the copies are kept equal here."""
    outcomes = bullets(subsection(read(OUTCOME_FORMAT), "Outcomes"))
    evidence = bullets(subsection(section(read(RUN), "States"), "Evidence"))
    for outcome in ("confirmed", "rejected", "below-floor"):
        assert evidence[outcome].startswith(outcomes[outcome]), (
            f"RUN.md's {outcome} must start with OUTCOME-FORMAT.md's definition: "
            f"{outcomes[outcome]!r} vs {evidence[outcome]!r}"
        )

    def first_sentence(text: str) -> str:
        return text.split(". ", 1)[0]

    # Each file then says where it records the canonical id: **Duplicate of**, or the Record.
    assert first_sentence(evidence["duplicate"]) == first_sentence(outcomes["duplicate"]), (
        outcomes["duplicate"],
        evidence["duplicate"],
    )
    for text in (read(RUN), read(OUTCOME_FORMAT)):
        assert "a contract test keeps them the same" in flat(text)


LANDING = "Landing a triage outcome"
OUTCOME_TO_EVIDENCE = {outcome: outcome for outcome in OUTCOMES} | {"accepted-risk": "confirmed"}


def landing() -> str:
    return section(read(RUN), LANDING)


def test_triage_output_is_saved_verbatim() -> None:
    text = flat(landing())
    assert "saved verbatim to `triage/<concept-id>.md`" in text
    assert "under the final concept id: one file per row" in text


def test_outcome_maps_to_evidence_and_severity() -> None:
    mapping = table_rows(subsection(landing(), "Outcome to Evidence"))
    assert "| Outcome | Evidence | Delivery |" in mapping
    rows = {outcome: evidence for outcome, evidence, _ in table_cells(mapping)}
    assert {o for o in rows if o.startswith("`")} == {f"`{outcome}`" for outcome in OUTCOMES}, (
        f"one mapping row per outcome: {list(rows)}"
    )
    for outcome, evidence in OUTCOME_TO_EVIDENCE.items():
        got, evidence = rows.get(f"`{outcome}`"), f"`{evidence}`"
        assert got == evidence, f"Outcome {outcome} must map to Evidence {evidence}, got {got!r}"
    text = flat(landing())
    assert "**Severity (after triage)** becomes the row's Severity, with no `?`" in text
    assert "The concept id becomes final" in text
    assert "Once a row's id is final it is never renamed" in text


def test_a_same_concept_finding_is_kept_as_a_duplicate() -> None:
    dup = flat(subsection(landing(), "Duplicates"))
    assert "kept as a `duplicate` row" in dup
    assert "Record `of <canonical id>`" in dup
    assert "never deleted or folded into the canonical row" in dup


def test_accepted_risk_is_only_a_recommendation() -> None:
    accepted = flat(subsection(landing(), "Accepted risk"))
    assert "only a recommendation" in accepted
    assert "Waiting on you" in accepted and "`record accepted-risk <concept-id>: <reason>`" in accepted
    assert "Delivery stays as it is until the human records it" in accepted


def test_a_finding_found_in_triage_enters_untriaged() -> None:
    found = flat(subsection(landing(), "Found in triage"))
    assert "a new `untriaged` row, with advisory `none yet`" in found
    assert "Record `found in triage of <concept-id>, <date>`" in found
    assert "confirmed at Medium or above" in found
    assert "needs a draft advisory before `fix PR open`" in found


def test_a_standalone_triage_run_is_not_picked_up() -> None:
    text = flat(landing())
    assert "A standalone `security-finding-triage` run is not picked up" in text


def mode_line(mode: str) -> str:
    return next(line for line in read(SKILL).splitlines() if line.startswith(f"- `{mode}`"))


def test_triage_mode_lands_the_outcome() -> None:
    mode = mode_line("triage <target>")
    assert "`security-finding-triage`" in mode, mode
    assert "land its outcome on the board" in mode and "RUN.md#landing-a-triage-outcome" in mode, mode
    fix = mode_line("fix <target>")
    assert "a draft advisory" in fix and "RUN.md#found-in-triage" in fix, fix


RECORD_SET = [
    "merged <fix PR>",
    "released <tag>",
    "fixed <concept-id>: <how>",
    "accepted-risk <concept-id>: <reason>",
    "approve publish|close|cve <GHSA…>",
    "match <GHSA> <concept-id>",
    "ack <concept-id|GHSA>",
]


def record_doc() -> str:
    return section(read(RUN), "Record")


def test_record_is_a_closed_set() -> None:
    doc = record_doc()
    listed = [m.group(1) for m in re.finditer(r"^- `([^`]+)`", subsection(doc, "The set"), re.MULTILINE)]
    assert listed == RECORD_SET, f"the record set must read {RECORD_SET}, got {listed}"
    text = flat(doc)
    assert "Anything else is refused, with the list shown, and records nothing." in text
    mode = mode_line("record <what>")
    assert "not available yet" not in mode, f"record is available now: {mode!r}"
    assert "RUN.md#record" in mode and "closed set" in mode, mode
    assert "a missing argument, or a concept id or GHSA id that is not on the board is refused the same way" in text


def close_doc() -> str:
    return section(read(RUN), "Close and the findings ledger")


def test_close_mode_writes_the_ledger_and_next_recommends_it() -> None:
    mode = mode_line("close")
    assert "not available yet" not in mode, f"close is available now: {mode!r}"
    assert "RUN.md#close-and-the-findings-ledger" in mode, mode
    assert "findings ledger" in mode and "one public pull request" in mode, mode
    nxt = mode_line("next")
    assert "recommends `close`" in nxt and "every row and every advisory is final" in nxt, nxt
    assert "nothing closes on its own" in nxt, nxt


def test_close_rechecks_and_refuses_with_the_list_of_anything_not_final() -> None:
    closable = flat(subsection(close_doc(), "Closable"))
    assert "closable only when every row and every advisory is final" in closable
    assert "`next` then recommends `close`" in closable
    assert "Nothing closes on its own" in closable
    assert "`close` checks again" in closable
    assert "refuses, and lists each row and advisory that is not final" in closable


def test_close_previews_the_exact_lines_and_writes_nothing_without_a_yes() -> None:
    preview = flat(subsection(close_doc(), "Preview"))
    assert "the exact ledger lines" in preview
    assert "Nothing is written without a yes" in preview
    assert "The human may edit the Notes of any line" in preview


def test_the_ledger_path_is_the_callers_or_the_default() -> None:
    path = flat(subsection(close_doc(), "Ledger path"))
    assert "the Caller's `findings_ledger_path`, otherwise `.security/findings-ledger.md`" in path
    assert "the same lookup `security-audit` uses" in path


def test_one_ledger_pr_per_run_with_one_commit_and_never_a_direct_push() -> None:
    pr = flat(subsection(close_doc(), "The ledger PR"))
    assert "One ledger PR per run" in pr
    assert "`chore/security-ledger-<run>`" in pr
    assert "one commit" in pr
    assert "Never a direct push" in pr
    assert "The human merges it" in pr and "the run never merges it" in pr
    assert "no second one is opened" in pr
    whole = flat(close_doc())
    shown, branch = whole.find("the exact ledger lines"), whole.find("`chore/security-ledger-<run>`")
    assert 0 <= shown < branch, "the preview comes before the ledger branch"
    guard = flat(section(read(SKILL), "Guardrails"))
    assert "never pushed to the default branch" in guard


def test_closing_until_the_ledger_pr_is_merged_and_its_lines_are_on_main() -> None:
    closing = flat(subsection(close_doc(), "While closing"))
    assert "`Closing: ledger PR #n`" in closing
    assert "Waiting on you holds only `Merge ledger PR #n`" in closing
    assert "the lines are on `origin/main`" in closing
    assert "Only then is the run `closed`" in closing
    assert "A run never has more than one open ledger PR, and only one is ever merged" in closing
    runs = flat(section(read(RUN), "Open, resume, or nothing to respond to"))
    assert "a run that reads `Closing: ledger PR #n` is still open" in runs
    assert "new draft waiting for the next run" in closing
    assert "does not join the run" in closing
    rows = flat(subsection(reconcile_doc(), "Rows are never deleted"))
    assert "unless the run is closing" in rows, "a draft that appears while closing does not join"
    board = flat(board_doc())
    assert "`Closing: ledger PR #n`" in board and "`Closed <date>, ledger PR #n`" in board


ROW_TO_LINE = {
    "Concept id": ["the row's final concept id"],
    "Status": ["`rejected`", "Evidence is `rejected` or `duplicate`", "`released <tag>`", "`fixed`", "`accepted-risk`"],
    "First seen": ["the Created date of the row's canonical advisory", "the triage date"],
    "Advisory": [
        "the full GHSA id of the row's canonical advisory",
        "`n/a` for a `below-floor` row",
        "and for any row with no advisory (`none yet`)",
    ],
    "Notes": ["Proposed ledger row", "the public parts of the Record"],
}


def test_row_to_line_mapping() -> None:
    mapping = table_rows(subsection(close_doc(), "Row to line"))
    cells = {row[0]: row[1] for row in table_cells(mapping, 2)}
    for column, phrases in ROW_TO_LINE.items():
        assert column in cells, f"Row to line must map {column}"
        for phrase in phrases:
            assert phrase in cells[column], f"{column} must say {phrase!r}: {cells[column]!r}"


def test_notes_carry_only_the_public_parts_of_the_record() -> None:
    notes = flat(subsection(close_doc(), "Notes"))
    for convention in (
        "`fixed in <sha>`",
        "duplicate of `<id>`",
        "`below the Medium floor`",
        "`found in triage of <GHSA>`",
    ):
        assert convention in notes, f"Notes must use {convention}"
    assert "`found in triage of <concept-id>, <date>`" in notes, "the found-in-triage Record maps to its public form"
    assert "never copied" in notes
    for private in ("fork PR numbers", "clone paths", "`in ledger: <status>`"):
        assert private in notes, f"Notes never copies {private}"


def test_the_ledger_is_appended_only_and_its_format_is_unchanged() -> None:
    rules = flat(subsection(close_doc(), "Ledger rules"))
    assert "A `duplicate` of a concept id already in the ledger adds no line" in rules
    assert "`activity.md` records the repeat" in rules
    assert "No concept id gets a second line" in rules
    assert "Append only" in rules
    assert "ordered by first seen, then by advisory (`n/a` last), then by `F<n>`, then by concept id" in rules
    assert "never edits, reorders or removes an existing line" in rules
    assert "The ledger format is unchanged: the same header text and the same five columns" in rules


def test_the_ledger_skeleton_describes_close() -> None:
    """`agent-kit init` copies this skeleton to Consumers, so it must tell the flow `close` runs."""
    text = flat(read(LEDGER_SKELETON))
    assert "updates the row after triage" not in text, "triage never edits the ledger"
    assert "Only a Security Response Run's `close`" in text and "`security-finding-triage` never edits it" in text
    assert "or the maintainer, by hand" in text
    assert "Replace the example row" not in text, "close only appends: the maintainer deletes the example row"
    assert "Delete the example row by hand before your first real line" in text
    statuses = next(line for line in read(LEDGER_SKELETON).splitlines() if line.startswith("Status values"))
    assert code_values(statuses) == ["released <tag>", "fixed", "accepted-risk", "rejected"], statuses
    rows = table_rows(read(LEDGER_SKELETON))
    assert "| Concept id | Status | First seen | Advisory | Notes |" in rows, "the header text and five columns stay"


def test_a_run_with_no_ledger_lines_closes_with_no_pr() -> None:
    no_lines = flat(subsection(close_doc(), "No ledger lines"))
    assert "only no-findings drafts, or only duplicates of concept ids already in the ledger" in no_lines
    assert "goes straight to `closed`" in no_lines and "`Closed <date>, no ledger PR`" in no_lines


def test_a_closed_run_stays_read_only_and_is_the_humans_to_delete() -> None:
    closed = flat(subsection(close_doc(), "Closed"))
    assert "`Closed <date>, ledger PR #n`" in closed
    assert "The folder stays" in closed
    assert "the folder is private and the human's to delete" in closed
    assert "A closed run is read-only" in closed
    assert "the next invocation starts a new run" in closed


def test_merged_and_released_run_reconciles_checks() -> None:
    checks = flat(subsection(record_doc(), "Merged and released"))
    assert "`git merge-base --is-ancestor <fix SHA> origin/main`" in checks
    assert "`git tag --contains <fix SHA>`" in checks
    assert "The report alone moves nothing" in checks
    assert "with the admin bypass where the branch rules ask for it" in checks
    assert "the run never merges one" in checks
    assert "the same checks reconcile runs" in checks
    assert "When both pass, each row whose Record names that fix PR moves `fix PR open` → `merged`" in checks


def test_a_below_floor_row_reaches_released_through_a_public_pr() -> None:
    delivery = flat(subsection(section(read(RUN), "States"), "Delivery"))
    assert "or, for a `below-floor` row, an ordinary public pull request on the repository" in delivery
    assert "A `below-floor` row uses the same values, through its public pull request" in delivery
    moves = flat(subsection(reconcile_doc(), "Moves"))
    assert "`fix PR open` → `merged`, once the fix PR is merged" in moves
    checks = flat(subsection(record_doc(), "Merged and released"))
    assert "a `below-floor` row's public pull request on the repository, by `#<n>` or its URL" in checks
    assert "which a row's Record writes `PR #7`" in checks
    fix = mode_line("fix <target>")
    assert "for a `below-floor` row, an ordinary public pull request on the repository" in fix, fix
    assert "`fix PR open`, with the PR number in its Record" in fix, fix


def test_fixed_and_accepted_risk_are_the_humans_judgement() -> None:
    fixed = flat(subsection(record_doc(), "Fixed"))
    assert "Delivery becomes `fixed`" in fixed and "through `gh api` where there is an endpoint" in fixed
    assert "otherwise the human's report stands" in fixed
    accepted = flat(subsection(record_doc(), "Accepted risk, recorded"))
    assert "Delivery becomes `accepted-risk`" in accepted and "public-safe" in accepted
    landing_item = flat(subsection(landing(), "Accepted risk"))
    assert "[Accepted risk, recorded](#accepted-risk-recorded)" in landing_item


def test_match_joins_a_human_made_draft_to_a_found_in_triage_row() -> None:
    match = flat(subsection(record_doc(), "Match"))
    assert "a draft that names no concept id" in match and "advisory `none yet`" in match
    assert "A draft that names the concept id in its title or body is matched by reconcile on its own" in match
    rows = flat(subsection(reconcile_doc(), "Rows are never deleted"))
    assert "`record match <GHSA> <concept-id>`" in rows


def test_ack_clears_a_contradicted_final_entry() -> None:
    ack = flat(subsection(record_doc(), "Ack"))
    assert "clears the contradicted-final entry from Waiting on you" in ack
    assert "stays final" in ack
    final = flat(subsection(reconcile_doc(), "Final rows and advisories"))
    assert "`record ack <concept-id|GHSA>`" in final


def test_each_record_is_logged_as_a_human_report() -> None:
    log = flat(subsection(record_doc(), "Logging a record"))
    assert "Each `record` is logged in `activity.md` as a human report, with what was verified" in log
    assert "`<time> human: record <what>; verified: <check and result>`" in log
    assert "A form the set accepts is logged even when its check fails or its gate refuses it" in log


TRANSITION_RECORDS = {
    "`fix PR open`": "the fork PR number (`fork PR #2`), or a `below-floor` row's public PR (`PR #7`)",
    "`merged`": "the fix SHA",
    "`released`": "the release tag",
    "`fixed`": "how, in one public-safe line",
    "`duplicate`": "`of <canonical id>`",
    "`accepted-risk`": "one public-safe line on why",
    "`rejected`": "one public-safe line on why, or on what would reopen it",
}


def test_each_transition_leaves_its_record() -> None:
    records = table_rows(subsection(record_doc(), "What each transition records"))
    assert "| Transition | Record |" in records
    rows = dict(table_cells(records, columns=2))
    for transition, record in TRANSITION_RECORDS.items():
        assert transition in rows, f"the records table must have a row for {transition}"
        assert record in rows[transition], f"{transition} records {record!r}, got {rows[transition]!r}"
    assert "in the row's Record" in flat(records)
    fix = mode_line("fix <target>")
    assert "`fix PR open`, with the PR number in its Record" in fix, fix


def advisory_actions() -> str:
    return section(read(RUN), "Advisory actions")


def test_approve_then_the_run_acts_through_gh_api() -> None:
    actions = flat(advisory_actions())
    assert "Only `record approve` lets the run publish, close, or request a CVE" in actions
    assert "[SKILL.md](SKILL.md#advisory-actions)" in actions
    calls = flat(section(read(SKILL), "Advisory actions"))
    for call in (
        "gh api --method PATCH repos/<owner>/<repo>/security-advisories/<GHSA-id> -f state=published",
        "gh api --method PATCH repos/<owner>/<repo>/security-advisories/<GHSA-id> -f state=closed",
        "gh api --method POST repos/<owner>/<repo>/security-advisories/<GHSA-id>/cve",
    ):
        assert f"`{call}`" in calls, f"SKILL.md must name the call {call!r}"
    assert "only after `record approve`" in calls and "RUN.md#advisory-actions" in calls
    assert "(#advisory-actions)" in mode_line("record <what>")


def test_publish_gate() -> None:
    publish = flat(subsection(advisory_actions(), "Publish"))
    assert "Publish is refused while any row under the advisory is not final" in publish
    assert "A duplicate advisory is never published" in publish
    assert "fork PR numbers and fix SHAs are in the Record of every row under it before the publish" in publish
    assert "refuses the publish" in publish


def test_a_duplicate_advisory_is_closed_once_its_canonical_rows_advisory_is_final() -> None:
    close = flat(subsection(advisory_actions(), "Close"))
    assert "A duplicate advisory is closed, not published, once its canonical row's advisory is final" in close
    assert "Close is refused while any row under the advisory is not final" in close


def test_a_folded_row_has_one_canonical_advisory() -> None:
    ids = flat(section(read(RUN), "Concept ids"))
    assert "A folded row has one **canonical advisory**: the earliest created of its advisories" in ids
    assert "then by GHSA id" in ids
    assert "Under each of its other advisories, the folded row counts as a `duplicate` row" in ids
    actions = flat(advisory_actions())
    assert "or a folded row whose canonical advisory is another" in actions
    close = flat(subsection(advisory_actions(), "Close"))
    assert "for a folded row, its canonical advisory must be `published` or `closed`" in close
    notes = flat(subsection(close_doc(), "Notes"))
    assert "the full GHSA id of that concept id's row's canonical advisory" in notes


def test_a_cve_request_needs_a_confirmed_row_and_is_recorded() -> None:
    cve = flat(subsection(advisory_actions(), "CVE request"))
    assert "only after a row under the advisory is `confirmed`" in cve
    assert "`requested <date>`" in cve and "in the advisory's CVE column" in cve
    assert "logged in `activity.md`" in cve


NO_FINDINGS = "No-findings advisories"
# Kind: (what CI's title says, from `.github/security-audit/publish-draft-advisory.sh`; its Advisories-table Next).
KINDS = {
    "`clean run`": ("`clean run (0 Medium+ findings)`", "`you: clean run, read and approve close`"),
    "`format mismatch`": ("`FORMAT MISMATCH`", "`you: read; findings may be hidden`"),
    "`failed run`": ("`failed run: empty report`", "`you: read transcript, approve close`"),
    "`other`": ("anything else with no `F<n>`", "`you: match or close`"),
}
PUBLISH_DRAFT = ROOT / ".github" / "security-audit" / "publish-draft-advisory.sh"


def no_findings() -> str:
    return section(read(RUN), NO_FINDINGS)


def test_a_no_findings_draft_is_one_rows_0_line_never_a_finding_row() -> None:
    text = flat(no_findings())
    assert "A draft with zero parsed `F<n>` is a **no-findings advisory**" in text
    assert "one line in the advisories table, with Rows `0` and its kind" in text
    assert "never a finding row" in text
    board = flat(board_doc())
    assert "`0 (<kind>)` for a no-findings advisory" in board, "the Rows column must show the kind"


def test_no_findings_kinds_come_from_cis_titles() -> None:
    kinds = table_rows(subsection(no_findings(), "Kinds"))
    assert "| Kind | Recognised by | Advisories-table Next |" in kinds
    rows = {kind: (by, nxt) for kind, by, nxt in table_cells(kinds)}
    assert [k for k in rows if k.startswith("`")] == list(KINDS), f"the kinds must read {list(KINDS)}, got {list(rows)}"
    script = read(PUBLISH_DRAFT)
    for kind, (by, nxt) in KINDS.items():
        assert by.strip("`") in rows[kind][0], f"{kind} is recognised by {by!r}, got {rows[kind][0]!r}"
        assert rows[kind][1] == nxt, f"{kind}'s Next must read {nxt}, got {rows[kind][1]!r}"
        if kind != "`other`":
            assert by.strip("`") in script, f"CI's draft title must still say {by}"
    text = flat(subsection(no_findings(), "Kinds"))
    assert (
        "The parsed `F<n>` count, with no row joined to the draft, decides whether a draft is a no-findings advisory"
        in text
    )
    assert "the title only names its kind" in text


def test_waiting_on_you_has_one_item_per_kind_mismatch_and_failed_first() -> None:
    waiting = flat(subsection(no_findings(), "Waiting on you"))
    assert "one numbered item per kind" in waiting
    order = [waiting.find(f"`{kind}`") for kind in ("format mismatch", "failed run", "other", "clean run")]
    assert -1 < order[0] < order[1] < order[2] < order[3], "format mismatch, failed run, other, then clean run"
    assert "before clean runs" in waiting


def test_approve_close_takes_an_explicit_list_with_no_wildcard() -> None:
    close = flat(subsection(no_findings(), "Closing"))
    assert "`record approve close <GHSA…>` takes a list of GHSAs, each named" in close
    assert "There is no wildcard" in close
    assert "refuses any GHSA with non-final rows, and a duplicate whose canonical row is not final" in close
    actions = flat(subsection(advisory_actions(), "Close"))
    assert "a list of full GHSA ids" in actions and "no wildcard" in actions
    calls = flat(section(read(SKILL), "Advisory actions"))
    assert "`record approve close` takes a list of GHSAs, each named, with no wildcard" in calls


def test_a_no_findings_drafts_only_final_state_is_closed() -> None:
    close = flat(subsection(no_findings(), "Closing"))
    assert "Its only final state is `closed`" in close
    assert "never published" in close and "staying a draft is not final" in close
    final = flat(subsection(section(read(RUN), "States"), "Final"))
    assert "A no-findings advisory is final only once `closed`" in final
    publish = flat(subsection(advisory_actions(), "Publish"))
    assert "A no-findings advisory is never published" in publish


def test_a_run_of_only_no_findings_drafts_opens_like_any_other() -> None:
    text = flat(subsection(no_findings(), "A run of only no-findings drafts"))
    assert "opens like any other" in text
    assert "zero rows" in text and "writes no ledger line" in text


def test_a_below_floor_row_keeps_its_advisory_so_the_advisory_can_close() -> None:
    board = flat(board_doc())
    assert "A `below-floor` row keeps the advisory it came from" in board
    assert "`n/a` for a `below-floor` row with no draft" in board
    assert "the findings ledger still writes `n/a` for a `below-floor` row" in board
    actions = flat(advisory_actions())
    assert "An advisory whose every row is `rejected`, `duplicate` or `below-floor` has nothing to publish" in actions
    publish = flat(subsection(advisory_actions(), "Publish"))
    assert "Nor is an advisory whose every row is `rejected`, `duplicate` or `below-floor`" in publish
    assert "A `below-floor` row does not hold the publish of an advisory with other rows" in publish
    found = flat(subsection(landing(), "Found in triage"))
    assert "A found-in-triage row triaged `below-floor` needs no draft: its Advisory becomes `n/a`" in found


if __name__ == "__main__":
    test_argument_hint_and_mode_list()
    test_every_mode_opens_or_resumes_the_run()
    test_status_prints_the_board()
    test_run_folder_path_has_no_config()
    test_ignore_gate_writes_nothing_without_a_yes()
    test_the_repository_ignores_its_own_run_folder()
    test_layout()
    test_provisional_concept_ids_fold_into_one_row()
    test_board_format()
    test_state_lists()
    test_final_states()
    test_status_format_is_retired()
    test_reconcile_is_step_one_of_every_mode()
    test_source_table()
    test_who_wins()
    test_verified_moves_happen_on_their_own_and_judgements_never()
    test_an_unavailable_source_moves_no_row()
    test_a_contradicted_final_row_stays_final()
    test_reconcile_never_deletes_rows()
    test_a_concept_id_in_the_ledger_enters_untriaged()
    test_each_correction_is_logged()
    test_triage_does_not_write_the_ledger()
    test_outcome_format_gains_below_floor_and_a_proposed_ledger_row()
    test_the_shared_outcome_definitions_match_the_evidence_states()
    test_triage_output_is_saved_verbatim()
    test_outcome_maps_to_evidence_and_severity()
    test_a_same_concept_finding_is_kept_as_a_duplicate()
    test_accepted_risk_is_only_a_recommendation()
    test_a_finding_found_in_triage_enters_untriaged()
    test_a_standalone_triage_run_is_not_picked_up()
    test_triage_mode_lands_the_outcome()
    test_record_is_a_closed_set()
    test_close_mode_writes_the_ledger_and_next_recommends_it()
    test_close_rechecks_and_refuses_with_the_list_of_anything_not_final()
    test_close_previews_the_exact_lines_and_writes_nothing_without_a_yes()
    test_the_ledger_path_is_the_callers_or_the_default()
    test_one_ledger_pr_per_run_with_one_commit_and_never_a_direct_push()
    test_row_to_line_mapping()
    test_notes_carry_only_the_public_parts_of_the_record()
    test_the_ledger_is_appended_only_and_its_format_is_unchanged()
    test_closing_until_the_ledger_pr_is_merged_and_its_lines_are_on_main()
    test_the_ledger_skeleton_describes_close()
    test_a_run_with_no_ledger_lines_closes_with_no_pr()
    test_a_closed_run_stays_read_only_and_is_the_humans_to_delete()
    test_merged_and_released_run_reconciles_checks()
    test_a_below_floor_row_reaches_released_through_a_public_pr()
    test_fixed_and_accepted_risk_are_the_humans_judgement()
    test_match_joins_a_human_made_draft_to_a_found_in_triage_row()
    test_ack_clears_a_contradicted_final_entry()
    test_each_record_is_logged_as_a_human_report()
    test_each_transition_leaves_its_record()
    test_approve_then_the_run_acts_through_gh_api()
    test_publish_gate()
    test_a_duplicate_advisory_is_closed_once_its_canonical_rows_advisory_is_final()
    test_a_folded_row_has_one_canonical_advisory()
    test_a_cve_request_needs_a_confirmed_row_and_is_recorded()
    test_a_no_findings_draft_is_one_rows_0_line_never_a_finding_row()
    test_no_findings_kinds_come_from_cis_titles()
    test_waiting_on_you_has_one_item_per_kind_mismatch_and_failed_first()
    test_approve_close_takes_an_explicit_list_with_no_wildcard()
    test_a_no_findings_drafts_only_final_state_is_closed()
    test_a_run_of_only_no_findings_drafts_opens_like_any_other()
    test_a_below_floor_row_keeps_its_advisory_so_the_advisory_can_close()
    print("security-response contract: ok")
