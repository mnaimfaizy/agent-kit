"""Contract test: no agent can end its run waiting on background work (#92).

A scheduled audit called the Agent tool, which started a background subagent,
then ended its turn with "Waiting for the agents to complete." The run ended,
no report was written, and the audit failed with "Empty report". Agent and the
scheduling tools need no permission, so leaving them out of --allowedTools does
not stop a headless run from calling them.

Every agent step therefore:
- sets CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1, which removes the
  `run_in_background` parameter from the Bash and subagent tools, so a subagent
  can only run in the foreground (review keeps its parallel subagents);
- denies the scheduling, messaging and background tools a CI run never needs.
The planner, the Review responder and the auditor do one task in one session,
so they deny Agent too.
"""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = ROOT / ".github" / "workflows"
AGENT_STEPS = {
    "agent-plan-reusable.yml": "Run planner (Claude Code)",
    "agent-implement-reusable.yml": "Run implementer (Claude Code)",
    "agent-review-reusable.yml": "Run code review (Claude Code)",
    "agent-review-response-reusable.yml": "Run review responder (Claude Code)",
    "security-audit-reusable.yml": "Run security audit (Claude Code)",
}
SINGLE_SESSION = {"agent-plan-reusable.yml", "agent-review-response-reusable.yml", "security-audit-reusable.yml"}
# Tools that need no permission and can leave a run waiting or reach outside it,
# plus Workflow and Monitor, which start background work the variable may not cover.
NEVER_IN_CI = (
    "ScheduleWakeup",
    "CronCreate",
    "RemoteTrigger",
    "SendMessage",
    "Workflow",
    "Monitor",
    "PushNotification",
)
AUDIT_PROMPT = ROOT / ".github" / "security-audit" / "prompt.md"


def _step(data: str, name: str) -> str:
    marker = f"- name: {name}\n"
    start = data.index(marker)
    rest = data[start + len(marker) :]
    next_step = rest.find("\n      - ")
    return rest if next_step < 0 else rest[:next_step]


def _agent(workflow: str) -> str:
    return _step((WORKFLOWS / workflow).read_text(encoding="utf-8"), AGENT_STEPS[workflow])


def _denied(agent: str) -> list[str]:
    return agent.split('--disallowedTools "')[1].split('"')[0].split(",")


def test_every_agent_step_disables_background_tasks() -> None:
    for workflow in AGENT_STEPS:
        agent = _agent(workflow)
        assert "\n        env:\n" in agent, f"{workflow}: the agent step needs an env block"
        assert '          CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1"\n' in agent, (
            f"{workflow}: set CLAUDE_CODE_DISABLE_BACKGROUND_TASKS so no subagent or command runs in the background"
        )


def test_every_agent_denies_the_scheduling_tools() -> None:
    for workflow in AGENT_STEPS:
        denied = _denied(_agent(workflow))
        for tool in NEVER_IN_CI:
            assert tool in denied, f"{workflow}: deny {tool}"


def test_single_session_agents_deny_subagents() -> None:
    for workflow in SINGLE_SESSION:
        denied = _denied(_agent(workflow))
        # `Agent` is the documented name; a bare name removes the tool entirely.
        assert "Agent" in denied, f"{workflow}: deny Agent"


def test_the_audit_prompt_says_it_must_finish_in_one_turn() -> None:
    prompt = AUDIT_PROMPT.read_text(encoding="utf-8")
    assert "Finish the whole audit in this one turn" in prompt
    assert "no background agents" in prompt


if __name__ == "__main__":
    test_every_agent_step_disables_background_tasks()
    test_every_agent_denies_the_scheduling_tools()
    test_single_session_agents_deny_subagents()
    test_the_audit_prompt_says_it_must_finish_in_one_turn()
    print("agent background-work contract: ok")
