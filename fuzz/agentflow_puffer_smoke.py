"""Small AgentFlow smoke for the Puffer UI/UX fuzz campaign.

This runs the same planner + shard pattern as `agentflow_puffer_campaign.py`,
but only targets the already-proven `modal-focus-race` seed. Use it to verify
Claude/Infer auth, AgentFlow templating, Playwright replay generation, and
report handoff before launching the full campaign.
"""

from agentflow import Graph, claude, fanout, merge, shell


REPO_ROOT = "/dsk/hdd/home/llmft/Riema/puffer"
ISSUE_PATH = "/tmp/puffer_issue.md"
MODEL = "claude-opus-4-6"
CLAUDE_ENV = {
    "ANTHROPIC_API_KEY": "",
    "ANTHROPIC_MODEL": MODEL,
}

PLANNER_PROMPT = f"""\
You are planning a one-shard smoke test for the Puffer UI/UX AgentFlow fuzz campaign.

Repo: {REPO_ROOT}
Issue/task file: {ISSUE_PATH}

Read:
- {ISSUE_PATH}
- fuzz/README.md
- fuzz/agent_guide.md
- fuzz/playwright_adapter.md
- fuzz/manifests/puffer-ui.json
- fuzz/coverage-ledger.json

Produce a concise plan for the modal-focus-keyboard smoke shard. Mention known
modal focus findings as a harness sanity check, and explain how to classify
duplicates versus distinct findings. Do not modify files.
"""

SHARD_PROMPT = """\
You are a Puffer UI/UX fuzz shard running inside an AgentFlow smoke campaign.

Repo: /dsk/hdd/home/llmft/Riema/puffer
Area: {{ item.name }}
Seed: {{ item.seed }}
Priority target: {{ item.priority }}
Focus: {{ item.focus }}
Iterations: {{ item.iterations }}
Steps: {{ item.steps }}

Plan:
{{ nodes.plan.output }}

Rules:
- Do not patch product code.
- Do not commit or push.
- Use fake daemon.
- Count only real user-visible UI/UX bugs.
- Remove every `apps/puffer-desktop/tests/*tmp*.spec.ts` file you create.
- Never search outside the repo to clean temporary specs. Use only:
  `find apps/puffer-desktop/tests -maxdepth 1 -name '*tmp*.spec.ts' -delete`
- Leave `/tmp/puffer-agentflow-{{ item.name }}.json` and `.md` artifacts.

Workflow:
1. Run `node fuzz/bin/puffer-fuzz.mjs validate`.
2. Run `node fuzz/bin/puffer-fuzz.mjs run --seed {{ item.seed }} --iterations {{ item.iterations }} --steps {{ item.steps }} --rng-seed agentflow-{{ item.name }} --out /tmp/puffer-agentflow-{{ item.name }}.json`.
3. Run `node fuzz/bin/puffer-fuzz.mjs report --input /tmp/puffer-agentflow-{{ item.name }}.json --out /tmp/puffer-agentflow-{{ item.name }}.md`.
4. Generate replay specs for cases that cover New agent, Create Project, and Switch workspace modal focus/trap.
5. Run the specs with Playwright and rerun failures at least twice.
6. Write detailed findings or duplicate classifications in your final output.
7. Remove temporary specs before finishing with:
   `find apps/puffer-desktop/tests -maxdepth 1 -name '*tmp*.spec.ts' -delete`
"""

MERGE_PROMPT = """\
Merge the smoke shard result into `/tmp/puffer_agentflow_smoke_report.md`.

Planner:
{{ nodes.plan.output }}

Shard outputs:
{% for shard in fanouts.fuzz_shard.nodes %}
## {{ shard.name }} / {{ shard.seed }} / {{ shard.status }}
{{ shard.output or "(no output)" }}
{% endfor %}

Requirements:
- Say whether AgentFlow + Claude + fuzz + Playwright replay worked.
- List confirmed findings and duplicates.
- Preserve detailed finding descriptions.
- Write the final report to `/tmp/puffer_agentflow_smoke_report.md`.
"""


SMOKE_AREA = [
    {
        "name": "modal-focus-keyboard-smoke",
        "seed": "modal-focus-race",
        "iterations": 12,
        "steps": 3,
        "priority": "P1",
        "focus": (
            "Smoke-test AgentFlow plus fuzz replay on New agent, Create Project, "
            "and Switch workspace modal focus/keyboard behavior"
        ),
    }
]


with Graph(
    "puffer-uiux-agentflow-smoke",
    description="Single-shard smoke test for the Puffer UI/UX AgentFlow fuzz campaign.",
    working_dir=REPO_ROOT,
    concurrency=2,
    fail_fast=False,
    node_defaults={
        "capture": "final",
        "retries": 0,
    },
    agent_defaults={
        "claude": {
            "model": MODEL,
            "env": CLAUDE_ENV,
            "timeout_seconds": 2400,
        }
    },
) as dag:
    preflight = shell(
        task_id="preflight",
        script=(
            "set -euo pipefail\n"
            "test -n \"${ANTHROPIC_AUTH_TOKEN:-}\"\n"
            "test \"${ANTHROPIC_BASE_URL:-}\" = \"https://api-infer.agentsey.ai\"\n"
            "node fuzz/bin/puffer-fuzz.mjs validate\n"
            "echo PREFLIGHT_OK\n"
        ),
        timeout_seconds=120,
        success_criteria=[{"kind": "output_contains", "value": "PREFLIGHT_OK"}],
    )

    plan = claude(
        task_id="plan",
        prompt=PLANNER_PROMPT,
        tools="read_only",
        timeout_seconds=900,
    )

    fuzz_shard = fanout(
        claude(
            task_id="fuzz_shard",
            prompt=SHARD_PROMPT,
            tools="read_write",
            timeout_seconds=2400,
        ),
        SMOKE_AREA,
    )

    merge_findings = merge(
        claude(
            task_id="merge_findings",
            prompt=MERGE_PROMPT.replace(
                "/tmp/puffer_agentflow_fuzz_report.md",
                "/tmp/puffer_agentflow_smoke_report.md",
            ),
            tools="read_write",
            timeout_seconds=900,
        ),
        fuzz_shard,
        size=1,
    )

    preflight >> plan
    plan >> fuzz_shard
    fuzz_shard >> merge_findings


if __name__ == "__main__":
    print(dag.to_json())
