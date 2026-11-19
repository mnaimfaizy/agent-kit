"""Contract test: the Security Response Run, as `security-response` and its run doc define it.

The skill is prose, so this pins the sentences a run relies on (where the run
folder lives, the ignore gate, the layout, the board, the state lists and what
is final, the modes, reconcile: its sources, who wins, and the rules that it
never deletes a row, keeps a contradicted final row final and moves nothing on
an unavailable source), not what they mean. What a sentence means is for review.
It also keeps the retired status-format file gone, with nothing linking to it.
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


def test_board_format() -> None:
    # The board's fenced example holds `## Findings` and `## Advisories`, so cut at the next real section.
    board = table_rows(read(RUN).split("\n## Board\n", 1)[1].split("\n## States\n", 1)[0])
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
        if name == "CHANGELOG.md" or name.startswith("scripts/security-response-contract") or not path.is_file():
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
    "`fix PR open`": ("private fork", ["gh pr list", "gh pr view", "until publish deletes it"]),
    "`merged`": ("`origin/main`", ["git fetch", "git merge-base --is-ancestor <fix SHA> origin/main"]),
    "`released`": ("tags", ["git tag --contains <fix SHA>"]),
    "`fixed` (no code)": ("the API, where it can", ["otherwise the human's report stands"]),
    "Concept ids already recorded": ("the findings ledger", ["read only"]),
}


def table_cells(table: str) -> list[list[str]]:
    """The cells of each row of a three-column table that `table_rows` has evened out."""
    return [line.strip(" |").split(" | ") for line in table.splitlines() if line.count(" | ") == 4]


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
    for fact in ("advisory state", "fork PR state", "the fix SHA on `main`", "the tag"):
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
    assert "fingerprint-safe" not in triage, "the step that updated the ledger's fingerprint-safe fields is gone"
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


LANDING = "Landing a triage outcome"
OUTCOME_TO_EVIDENCE = {
    "`confirmed`": "`confirmed`",
    "`rejected`": "`rejected`",
    "`below-floor`": "`below-floor`",
    "`duplicate`": "`duplicate`",
    "`accepted-risk`": "`confirmed`",
}


def landing() -> str:
    return section(read(RUN), LANDING)


def test_triage_output_is_saved_verbatim() -> None:
    text = flat(landing())
    assert "saved verbatim to `triage/<concept-id>.md`" in text
    assert "under the final concept id" in text


def test_outcome_maps_to_evidence_and_severity() -> None:
    mapping = table_rows(subsection(landing(), "Outcome to Evidence"))
    assert "| Outcome | Evidence | Delivery |" in mapping
    rows = {outcome: evidence for outcome, evidence, _ in table_cells(mapping)}
    for outcome, evidence in OUTCOME_TO_EVIDENCE.items():
        got = rows.get(outcome)
        assert got == evidence, f"Outcome {outcome} must map to Evidence {evidence}, got {got!r}"
    text = flat(landing())
    assert "**Severity (after triage)** becomes the row's Severity, with no `?`" in text
    assert "The concept id becomes final" in text


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
    assert "Record `found in triage of <concept id>, <date>`" in found
    assert "confirmed at Medium or above" in found
    assert "needs a draft advisory before `fix PR open`" in found


def test_a_standalone_triage_run_is_not_picked_up() -> None:
    text = flat(landing())
    assert "A standalone `security-finding-triage` run is not picked up" in text


def test_triage_mode_lands_the_outcome() -> None:
    mode = next(line for line in read(SKILL).splitlines() if line.startswith("- `triage <target>`"))
    assert "`security-finding-triage`" in mode, mode
    assert "land its outcome on the board" in mode and "RUN.md#landing-a-triage-outcome" in mode, mode
    fix = next(line for line in read(SKILL).splitlines() if line.startswith("- `fix <target>`"))
    assert "a draft advisory" in fix and "RUN.md#found-in-triage" in fix, fix


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
    test_triage_output_is_saved_verbatim()
    test_outcome_maps_to_evidence_and_severity()
    test_a_same_concept_finding_is_kept_as_a_duplicate()
    test_accepted_risk_is_only_a_recommendation()
    test_a_finding_found_in_triage_enters_untriaged()
    test_a_standalone_triage_run_is_not_picked_up()
    test_triage_mode_lands_the_outcome()
    print("security-response contract: ok")
