# Agent Guide: Coverage-Guided UI/UX Bug Hunting

Use this guide when an agent is asked to find Puffer desktop interaction bugs.

## Operating Rules

- Use generated cases as a guide, not as proof.
- A finding counts only if it is reproducible by user interaction or daemon
  response ordering.
- Do not count fixture-only, environment-only, or cosmetic-only issues.
- Prefer fake daemon for race construction.
- Re-check high-value failures with real daemon when the path exists there.
- Convert confirmed failures into deterministic Playwright specs.

## Agent Loop

1. Run `node fuzz/bin/puffer-fuzz.mjs plan --profile core`.
2. Run `node fuzz/bin/puffer-fuzz.mjs validate` before using a changed seed.
3. Run `node fuzz/bin/puffer-fuzz.mjs smoke --profile core` when checking a fresh checkout or modified seed set.
4. Run `node fuzz/bin/puffer-fuzz.mjs frontier --profile core` and pick one high-risk uncovered target.
5. Pick one seed with high priority and low recent validated coverage.
6. Run the seed with 8-20 iterations and 12-20 steps.
7. Read the report and choose a case with high async coverage.
8. Generate a replay scaffold with `node fuzz/bin/puffer-fuzz.mjs replay --input <run.json> --case-id <id> --out apps/puffer-desktop/tests/<name>.spec.ts`.
9. Replay it against the existing Playwright fake daemon harness with `npx playwright test tests/<name>.spec.ts --reporter=line`.
10. Shrink the case.
11. Decide whether it is a product bug.
12. Archive under `bugs/` if confirmed.
13. Fix and add regression coverage.
14. Update or add a concise component spec.

## Product Bug Threshold

Accept the issue if it blocks or corrupts:

- launch, onboarding, auth, provider/model selection, or new-agent creation
- prompt send, stop, permission answer, question answer, or transcript display
- Browser open, navigation, input, tab close, frame rendering, or chat Browser
  tool usage
- terminal input, close, focus, or pty routing
- file draft preservation, save, reload, or stale restore
- settings save, credential import, MCP add/update/remove/test, or permissions
  save

Reject the issue if it is only:

- fake daemon fixture mismatch
- missing local dependency
- screenshot-only polish that does not block interaction
- expected disabled state with clear recovery

## How To Read Generated Cases

Each generated case has:

- `caseId`: stable id for the generated sequence.
- `rngSeed`: deterministic seed to reproduce generation.
- `steps`: setup, fuzz actions, and invariant assertions.
- `coverage`: tags for the route/control/state/async/invariant matrix.

Action kinds:

- `ui`: click, focus, selection, or visible control operation.
- `keyboard`: typing or key dispatch.
- `daemon`: fake daemon delay/failure/reconnect setup.
- `daemon-event`: fake daemon push event.
- `assertion`: invariant that must hold after replay.

## Shrinking Rule

When a case fails, remove steps until the failure disappears, then restore the
last removed step. The final regression should normally be 4-10 steps:

1. Open the relevant screen.
2. Put the UI in the target state.
3. Trigger the stale/late/duplicate/reconnect condition.
4. Perform the user action that exposes the bug.
5. Assert the blocked or corrupted behavior.

## Useful Commands

```sh
node fuzz/bin/puffer-fuzz.mjs validate
node fuzz/bin/puffer-fuzz.mjs smoke --profile core
node fuzz/bin/puffer-fuzz.mjs frontier --profile core --out /tmp/puffer-frontier.md
node fuzz/bin/puffer-fuzz.mjs gate --out /tmp/puffer-ready.md
node fuzz/bin/puffer-fuzz.mjs run --seed chat-turn-race --iterations 12 --steps 18 --profile core --out /tmp/chat.json
node fuzz/bin/puffer-fuzz.mjs report --input /tmp/chat.json --out /tmp/chat.md
node fuzz/bin/puffer-fuzz.mjs replay --input /tmp/chat.json --case-id chat-turn-race-0001 --out apps/puffer-desktop/tests/chat-replay.spec.ts
node fuzz/bin/puffer-fuzz.mjs agent-task --seed chat-turn-race --out /tmp/chat-agent.md
```

Use secondary seeds such as `browser-tab-race` only after the core chat,
session, new-agent, turn lifecycle, reload, permission, and question paths have
acceptable coverage for the current pass.
