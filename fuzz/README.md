# Puffer Interaction Fuzz Framework

This directory contains a first-pass framework for coverage-guided UI/UX bug
hunting in the Puffer desktop app. It is intentionally independent from the
existing Playwright specs so agents can use it to choose high-value interaction
scopes before turning a confirmed failure into a deterministic regression test.

## Goal

The framework tracks product-relevant interaction coverage, not generic line
coverage. The dimensions are:

- Route coverage: which screens and modals were exercised.
- Control-action coverage: which buttons, inputs, tabs, and forms were acted on.
- State-action coverage: which product states were combined with actions.
- Async ordering coverage: which delayed, stale, duplicate, reconnect, or push
  events were combined with actions.
- Invariant coverage: which safety properties were checked after the sequence.

## Quick Start

List available coverage dimensions and seeds:

```sh
node fuzz/bin/puffer-fuzz.mjs list
```

Generate a prioritized plan:

```sh
node fuzz/bin/puffer-fuzz.mjs plan --profile core --out /tmp/puffer_fuzz_plan.md
```

Generate deterministic fuzz cases for one area:

```sh
node fuzz/bin/puffer-fuzz.mjs run \
  --seed chat-turn-race \
  --iterations 12 \
  --steps 18 \
  --rng-seed day2-core-chat \
  --profile core \
  --out /tmp/puffer_fuzz_chat.json
```

Generate a readable report:

```sh
node fuzz/bin/puffer-fuzz.mjs report \
  --input /tmp/puffer_fuzz_chat.json \
  --out /tmp/puffer_fuzz_chat.md
```

Generate a task prompt for an agent:

```sh
node fuzz/bin/puffer-fuzz.mjs agent-task \
  --seed chat-turn-race \
  --out /tmp/puffer_fuzz_agent_task.md
```

Validate the framework metadata against the manifest, adapter map, and current
fake daemon method names:

```sh
node fuzz/bin/puffer-fuzz.mjs validate
```

Run a one-command smoke check that validates metadata and writes a small run
plus report to `/tmp`:

```sh
node fuzz/bin/puffer-fuzz.mjs smoke --profile core
```

Generate a Playwright replay scaffold for one generated case:

```sh
node fuzz/bin/puffer-fuzz.mjs replay \
  --input /tmp/puffer_fuzz_chat.json \
  --case-id chat-turn-race-0001 \
  --out apps/puffer-desktop/tests/chat-replay.spec.ts
```

The replay command derives import paths from `--out`, so scaffolds can be
generated either inside the Playwright test tree or under `/tmp` for inspection.
Specs generated inside `apps/puffer-desktop/tests/` can be run directly with:

```sh
cd apps/puffer-desktop
npx playwright test tests/chat-replay.spec.ts --reporter=line
```

## Recommended Workflow

1. Start with `--profile core` unless the task explicitly targets a secondary pane.
2. Pick a seed from `fuzz/seeds/` that matches the target area.
3. Generate 8-20 cases with a named `--rng-seed`.
4. Read the report and choose cases that include `async:late-*`,
   `async:stale-*`, `async:duplicate-submit`, or `async:reconnect`.
5. Replay the chosen case against `apps/puffer-desktop/tests/support/fakeDaemon.ts`.
6. If it reproduces a product bug, shrink the sequence to the smallest stable
   reproducer.
7. Archive the finding under `bugs/`.
8. Fix the product bug.
9. Add a deterministic Playwright regression and a concise component spec.
10. Re-run the fuzz report and mark the covered tags as validated.

## Ready Metrics

For day-to-day use, treat the app as ready only when:

- P0/P1 open interaction bugs are zero.
- Core route coverage is at least 95%.
- Core control-action coverage is at least 90%.
- High-priority state-action coverage is at least 85%.
- High-priority async ordering coverage is at least 80%.
- Every fixed finding has a deterministic regression test.
- Several consecutive fuzz batches produce no new P0/P1 findings.
- Fake daemon coverage is followed by a real daemon smoke pass for auth, chat,
  Browser, terminal, and CLI/GUI connection paths.

## Files

- `manifests/puffer-ui.json`: coverage target model.
- `seeds/*.json`: weighted fuzz grammars for product areas.
- `adapters/playwright-actions.json`: generated-action support map.
- `coverage-ledger.json`: validated coverage and fixed finding ledger.
- `bin/puffer-fuzz.mjs`: CLI entrypoint.
- `lib/*.mjs`: deterministic generator, coverage summarizer, and formatters.
- `playwright/pufferCoverage.ts`: reusable state, element, and trace helpers for Playwright replays.
- `agent_guide.md`: instructions for agents using this framework.
- `playwright_adapter.md`: mapping from generated actions to current Playwright
  fake daemon helpers.

## Current Limitation

This version generates and scores interaction cases, validates that generated
metadata is replayable, documents the Playwright mapping, and emits executable
replay scaffolds for mapped core chat/session actions and mapped Browser
actions. It does not yet execute the fuzz run JSON directly or shrink failing
traces by itself. Generated cases should still be replayed and shrunk by an
agent before becoming stable product regressions.
