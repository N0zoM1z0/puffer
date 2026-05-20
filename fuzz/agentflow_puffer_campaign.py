"""AgentFlow campaign for Puffer UI/UX fuzz bug hunting.

Run from the Puffer repo root after exporting the Infer-backed Claude
environment:

  export INFER_API_KEY="<redacted>"
  export ANTHROPIC_BASE_URL="https://api-infer.agentsey.ai"
  export ANTHROPIC_AUTH_TOKEN="$INFER_API_KEY"
  export ANTHROPIC_API_KEY=""
  export ANTHROPIC_MODEL="claude-opus-4-6"
  agentflow run fuzz/agentflow_puffer_campaign.py --output summary

The graph intentionally does not commit, push, or patch product code. Workers
may create temporary replay specs and must clean them before finishing.
"""

from agentflow import Graph, claude, fanout, merge, shell


REPO_ROOT = "/dsk/hdd/home/llmft/Riema/puffer"
ISSUE_PATH = "/tmp/puffer_issue.md"
MODEL = "claude-opus-4-6"

# Keep ANTHROPIC_API_KEY explicitly empty for the Infer Claude gateway. The
# base URL and auth token are inherited from the launching shell so secrets do
# not appear in this pipeline file.
CLAUDE_ENV = {
    "ANTHROPIC_API_KEY": "",
    "ANTHROPIC_MODEL": MODEL,
}

AREAS = [
    {
        "name": "chat-turn-lifecycle",
        "seed": "chat-turn-race",
        "iterations": 36,
        "steps": 20,
        "replay_limit": 3,
        "priority": "P0/P1",
        "focus": (
            "chat/session/new agent/turn/reload core loop: send, stop, streaming, "
            "permission, question, session switch, transcript reload, stale events, "
            "one request per intent, and draft preservation"
        ),
    },
    {
        "name": "workspace-session-switching",
        "seed": "workspace-session-race",
        "iterations": 32,
        "steps": 18,
        "replay_limit": 3,
        "priority": "P1",
        "focus": (
            "workspace board, project grouping, search/filter, session selection, "
            "active-agent sidebar, pin state, reconnect, and stale refresh"
        ),
    },
    {
        "name": "provider-auth-model",
        "seed": "provider-auth-model-race",
        "iterations": 32,
        "steps": 18,
        "replay_limit": 3,
        "priority": "P1",
        "focus": (
            "provider auth import/refresh, default model save, new-agent provider "
            "selection, provider/model mismatch, stale model list responses"
        ),
    },
    {
        "name": "modal-focus-keyboard",
        "seed": "modal-focus-race",
        "iterations": 40,
        "steps": 3,
        "replay_limit": 3,
        "priority": "P1",
        "focus": (
            "New agent, Create Project, and Switch workspace modal initial focus, "
            "Tab containment, keyboard-only navigation, and modal recovery"
        ),
    },
    {
        "name": "files-terminal",
        "seed": "files-terminal-race",
        "iterations": 24,
        "steps": 16,
        "replay_limit": 2,
        "priority": "P1/P2",
        "focus": (
            "Files and Terminal secondary workflows: dirty draft preservation, save "
            "failure/reload races, pty focus/close/input routing, stale daemon events"
        ),
    },
    {
        "name": "browser-tabs-input",
        "seed": "browser-tab-race",
        "iterations": 24,
        "steps": 16,
        "replay_limit": 2,
        "priority": "P1/P2",
        "focus": (
            "Browser pane secondary workflows: tab open/close/focus, address input, "
            "navigation failures, stale frames, page keyboard input, and tab recovery"
        ),
    },
    {
        "name": "settings-mcp-permissions",
        "seed": "settings-mcp-permission-race",
        "iterations": 20,
        "steps": 14,
        "replay_limit": 2,
        "priority": "P2",
        "focus": (
            "Settings MCP and permission editors: add/update/remove/test, save races, "
            "stale refresh, validation, and draft preservation"
        ),
    },
    {
        "name": "pipelines-drafts",
        "seed": "pipelines-draft-race",
        "iterations": 20,
        "steps": 14,
        "replay_limit": 2,
        "priority": "P2",
        "focus": (
            "Pipeline editor drafts and graph state: tab switching, refresh, provider "
            "changes, trigger edits, required-field validation, and cycle handling"
        ),
    },
]


PLANNER_PROMPT = f"""\
You are planning a Puffer UI/UX fuzz campaign using AgentFlow.

Repo: {REPO_ROOT}
Issue/task file: {ISSUE_PATH}

Read:
- {ISSUE_PATH}
- fuzz/README.md
- fuzz/agent_guide.md
- fuzz/playwright_adapter.md
- fuzz/manifests/puffer-ui.json
- fuzz/coverage-ledger.json
- existing bugs/ summaries relevant to UI/UX interaction findings

Then produce a concise campaign plan for the worker shards:
- priority order
- known already-confirmed findings to avoid duplicating unless used as a harness sanity check
- coverage gaps workers should target
- false-positive rules
- report format requirements

Do not modify files. Do not run product fixes. The output should be directly useful
to the worker shards and reducers.
"""


SHARD_PROMPT = """\
You are a Puffer UI/UX fuzz shard running inside an AgentFlow campaign.

Repo: /dsk/hdd/home/llmft/Riema/puffer
Task file: /tmp/puffer_issue.md
Area: {{ item.name }}
Seed: {{ item.seed }}
Priority target: {{ item.priority }}
Focus: {{ item.focus }}
Iterations: {{ item.iterations }}
Steps: {{ item.steps }}
Replay limit: {{ item.replay_limit }}

Campaign plan from planner:
{{ nodes.plan.output }}

Rules:
- Do not patch product code.
- Do not commit or push.
- Use fake daemon unless a real-daemon confirmation is explicitly practical and safe.
- Count only real user-visible UI/UX bugs triggered by click, type, keyboard,
  resize, reconnect, stale daemon event, or response ordering.
- Reject fixture-only, environment-only, dependency-only, and tooling-only failures.
- Temporary replay specs are allowed only under `apps/puffer-desktop/tests/*tmp*.spec.ts`;
  remove every temporary spec before finishing.
- Never search outside the repo to clean temporary specs. Use only:
  `find apps/puffer-desktop/tests -maxdepth 1 -name '*tmp*.spec.ts' -delete`
- Leave generated `/tmp/puffer-agentflow-{{ item.name }}-*` JSON/Markdown artifacts for review.
- If a generated replay reveals an already-known bug, classify it as duplicate
  and keep hunting for distinct triggerable issues.
- Do not read the full `/tmp/puffer-agentflow-{{ item.name }}.md` report unless
  a selected top-case artifact is missing. Full reports are intentionally too
  large for stable shard execution.
- Only inspect `/tmp/puffer-agentflow-{{ item.name }}-top.md` and at most
  {{ item.replay_limit }} selected case IDs.
- Do not create `*.replay.spec.ts` files in the test tree during this campaign.

Required workflow:
1. Read `fuzz/README.md`, `fuzz/agent_guide.md`, `fuzz/playwright_adapter.md`,
   and `fuzz/prompt.txt`.
2. Run `node fuzz/bin/puffer-fuzz.mjs validate`.
3. Run:
   `node fuzz/bin/puffer-fuzz.mjs run --seed {{ item.seed }} --iterations {{ item.iterations }} --steps {{ item.steps }} --rng-seed agentflow-{{ item.name }} --out /tmp/puffer-agentflow-{{ item.name }}.json`
4. Run:
   `node fuzz/bin/puffer-fuzz.mjs report --input /tmp/puffer-agentflow-{{ item.name }}.json --out /tmp/puffer-agentflow-{{ item.name }}.md`
5. Run:
   `node fuzz/bin/puffer-fuzz.mjs top-cases --input /tmp/puffer-agentflow-{{ item.name }}.json --limit {{ item.replay_limit }} --out /tmp/puffer-agentflow-{{ item.name }}-top.json --report-out /tmp/puffer-agentflow-{{ item.name }}-top.md`
6. Read only `/tmp/puffer-agentflow-{{ item.name }}-top.md` and use only the listed case IDs.
7. Generate temporary Playwright replay specs with:
   `node fuzz/bin/puffer-fuzz.mjs replay --input /tmp/puffer-agentflow-{{ item.name }}.json --case-id <case-id> --out apps/puffer-desktop/tests/<case-id>.tmp.spec.ts`
8. Run selected specs one at a time with a hard timeout:
   `cd apps/puffer-desktop && timeout 120s npx playwright test tests/<case-id>.tmp.spec.ts --workers=1 --reporter=list`
9. Rerun any failure at least 2 more times with the same timeout to check stability.
10. Shrink mentally only. Do not create extra exploratory specs unless a replay
    failure is stable and the original spec is too broad to describe.
11. Remove temporary specs before finishing with:
    `find apps/puffer-desktop/tests -maxdepth 1 -name '*tmp*.spec.ts' -delete`

For each accepted finding, write a detailed entry with:
- Title
- Severity estimate: P0/P1/P2
- Area/component
- Seed and replay case ID
- Trigger steps
- Expected behavior
- Actual behavior
- User impact
- Why this is product bug, not fixture/environment/tooling
- Stability: exact rerun count and result
- Relevant source files/components likely involved
- Suggested regression test target
- Error-context/screenshot/trace paths if generated

Final shard output must include:
- commands run
- replay cases tested
- accepted findings
- duplicates/rejected false positives and why
- remaining coverage gaps for this area
"""


MERGE_PROMPT = """\
Merge these Puffer UI/UX fuzz shard results into a detailed maintainer handoff.

Planner:
{{ nodes.plan.output }}

Shard outputs:
{% for shard in fanouts.fuzz_shard.nodes %}
## {{ shard.name }} / {{ shard.seed }} / {{ shard.status }}
{{ shard.output or "(no output)" }}

{% endfor %}

Requirements:
- Deduplicate by root cause and trigger path.
- Keep independently triggerable variants when they affect different core flows.
- Separate confirmed product bugs from duplicates, false positives, and environment issues.
- Preserve detailed finding descriptions so engineers can locate and fix them.
- Include a coverage summary by route/control/state/async/invariant where available.
- Include next recommended seeds/areas.
- Write the final report to `/tmp/puffer_agentflow_fuzz_report.md`.
- Do not modify product code.
"""


with Graph(
    "puffer-uiux-agentflow-fuzz",
    description="AgentFlow campaign for Puffer UI/UX interaction fuzzing with Playwright feedback signals.",
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
            "timeout_seconds": 1500,
        }
    },
) as dag:
    preflight = shell(
        task_id="preflight",
        script=(
            "set -euo pipefail\n"
            "test -n \"${ANTHROPIC_AUTH_TOKEN:-}\"\n"
            "test \"${ANTHROPIC_BASE_URL:-}\" = \"https://api-infer.agentsey.ai\"\n"
            "find apps/puffer-desktop/tests -maxdepth 1 \\( -name '*tmp*.spec.ts' -o -name '*race.replay.spec.ts' \\) -delete\n"
            "node fuzz/bin/puffer-fuzz.mjs validate\n"
            "node fuzz/bin/puffer-fuzz.mjs frontier --out /tmp/puffer-agentflow-frontier.md\n"
            "node fuzz/bin/puffer-fuzz.mjs plan --profile core --out /tmp/puffer-agentflow-plan.md\n"
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
            timeout_seconds=1500,
        ),
        AREAS,
    )

    merge_findings = merge(
        claude(
            task_id="merge_findings",
            prompt=MERGE_PROMPT,
            tools="read_write",
            timeout_seconds=900,
        ),
        fuzz_shard,
        size=len(AREAS),
    )

    preflight >> plan
    plan >> fuzz_shard
    fuzz_shard >> merge_findings


if __name__ == "__main__":
    print(dag.to_json())
