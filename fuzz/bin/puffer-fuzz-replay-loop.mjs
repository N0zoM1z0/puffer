#!/usr/bin/env node
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const desktopRoot = path.join(repoRoot, "apps", "puffer-desktop");
const defaultSeeds = [
  "chat-turn-race",
  "workspace-session-race",
  "provider-auth-model-race",
  "modal-focus-race",
  "browser-tab-race",
  "files-terminal-race",
  "settings-mcp-permission-race",
  "pipelines-draft-race"
];

const seedDefaults = {
  "chat-turn-race": { iterations: 12, steps: 20 },
  "workspace-session-race": { iterations: 12, steps: 18 },
  "provider-auth-model-race": { iterations: 12, steps: 18 },
  "modal-focus-race": { iterations: 12, steps: 3 },
  "browser-tab-race": { iterations: 10, steps: 16 },
  "files-terminal-race": { iterations: 8, steps: 16 },
  "settings-mcp-permission-race": { iterations: 8, steps: 14 },
  "pipelines-draft-race": { iterations: 8, steps: 14 }
};

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      args._.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seeds = String(args.seeds ?? process.env.PUFFER_REPLAY_SEEDS ?? defaultSeeds.join(","))
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const topLimit = Number(args.limit ?? process.env.PUFFER_REPLAY_LIMIT ?? 1);
  const attempts = Number(args.attempts ?? process.env.PUFFER_REPLAY_ATTEMPTS ?? 1);
  const timeoutSeconds = Number(args.timeout ?? process.env.PUFFER_REPLAY_TIMEOUT_SECONDS ?? 120);
  const out = path.resolve(String(args.out ?? "/tmp/puffer_bounded_replay_report.md"));
  const jsonOut = path.resolve(String(args["json-out"] ?? "/tmp/puffer_bounded_replay_report.json"));
  const tmpDir = path.resolve(String(args["tmp-dir"] ?? "/tmp/puffer-bounded-replay"));
  const rngNamespace = String(args["rng-seed"] ?? process.env.PUFFER_REPLAY_RNG_SEED ?? "bounded-replay");

  await mkdir(tmpDir, { recursive: true });
  await cleanTempSpecs();

  const startedAt = new Date().toISOString();
  const results = [];
  for (const seed of seeds) {
    const defaults = seedDefaults[seed] ?? { iterations: 8, steps: 12 };
    const runPath = path.join(tmpDir, `${seed}.json`);
    const reportPath = path.join(tmpDir, `${seed}.md`);
    const topPath = path.join(tmpDir, `${seed}-top.json`);
    const topReportPath = path.join(tmpDir, `${seed}-top.md`);
    const rngSeed = `${rngNamespace}-${seed}`;

    await runCommand("node", [
      "fuzz/bin/puffer-fuzz.mjs",
      "run",
      "--seed",
      seed,
      "--iterations",
      String(defaults.iterations),
      "--steps",
      String(defaults.steps),
      "--rng-seed",
      rngSeed,
      "--out",
      runPath
    ], { cwd: repoRoot, timeoutSeconds: 60 });

    await runCommand("node", [
      "fuzz/bin/puffer-fuzz.mjs",
      "report",
      "--input",
      runPath,
      "--out",
      reportPath
    ], { cwd: repoRoot, timeoutSeconds: 60, quiet: true });

    await runCommand("node", [
      "fuzz/bin/puffer-fuzz.mjs",
      "top-cases",
      "--input",
      runPath,
      "--limit",
      String(topLimit),
      "--out",
      topPath,
      "--report-out",
      topReportPath
    ], { cwd: repoRoot, timeoutSeconds: 60, quiet: true });

    const top = JSON.parse(await readFile(topPath, "utf8"));
    for (const item of top.cases ?? []) {
      const specName = `${item.caseId}.bounded.tmp.spec.ts`;
      const specPath = path.join(repoRoot, "apps", "puffer-desktop", "tests", specName);
      const replay = {
        seed,
        caseId: item.caseId,
        score: item.score,
        coverage: item.coverage,
        steps: item.steps?.map((step) => step.action) ?? [],
        specPath,
        attempts: []
      };

      await runCommand("node", [
        "fuzz/bin/puffer-fuzz.mjs",
        "replay",
        "--input",
        runPath,
        "--case-id",
        item.caseId,
        "--out",
        specPath
      ], { cwd: repoRoot, timeoutSeconds: 60, quiet: true });

      for (let attempt = 1; attempt <= attempts; attempt += 1) {
        const logPath = path.join(tmpDir, `${item.caseId}-attempt-${attempt}.log`);
        const result = await runCommand("timeout", [
          `${timeoutSeconds}s`,
          "npx",
          "playwright",
          "test",
          `tests/${specName}`,
          "--workers=1",
          "--reporter=list"
        ], {
          cwd: desktopRoot,
          timeoutSeconds: timeoutSeconds + 20,
          env: { ...process.env, CODEX_CI: "1" },
          allowFailure: true
        });
        await writeFile(logPath, result.output);
        replay.attempts.push({
          attempt,
          status: result.exitCode === 0 ? "passed" : result.exitCode === 124 ? "timeout" : "failed",
          exitCode: result.exitCode,
          logPath,
          excerpt: excerptFailure(result.output)
        });
      }
      results.push(replay);
      await rm(specPath, { force: true });
    }
  }

  await cleanTempSpecs();
  const finishedAt = new Date().toISOString();
  const summary = summarize(results);
  const payload = {
    version: 1,
    startedAt,
    finishedAt,
    seeds,
    topLimit,
    attempts,
    timeoutSeconds,
    summary,
    results
  };
  await writeFile(jsonOut, `${JSON.stringify(payload, null, 2)}\n`);
  await writeFile(out, formatMarkdown(payload));
  process.stdout.write(`Report: ${out}\nJSON: ${jsonOut}\n`);
  process.stdout.write(`Passed: ${summary.passed}, Failed: ${summary.failed}, Timeout: ${summary.timeout}\n`);
  if ((summary.failed > 0 || summary.timeout > 0) && args["fail-on-finding"]) process.exitCode = 2;
}

async function cleanTempSpecs() {
  await runCommand("find", [
    "apps/puffer-desktop/tests",
    "-maxdepth",
    "1",
    "(",
    "-name",
    "*.bounded.tmp.spec.ts",
    "-o",
    "-name",
    "*tmp*.spec.ts",
    "-o",
    "-name",
    "*race.replay.spec.ts",
    ")",
    "-delete"
  ], { cwd: repoRoot, timeoutSeconds: 30, quiet: true, allowFailure: true });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, Number(options.timeoutSeconds ?? 120) * 1000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (!options.quiet) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
      if (!options.quiet) process.stderr.write(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      settled = true;
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      settled = true;
      const result = { exitCode: exitCode ?? 1, output };
      if (result.exitCode !== 0 && !options.allowFailure) {
        const error = new Error(`${command} ${args.join(" ")} exited ${result.exitCode}`);
        error.result = result;
        reject(error);
        return;
      }
      resolve(result);
    });
  });
}

function excerptFailure(output) {
  const cleaned = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const lines = cleaned.split(/\r?\n/);
  const interesting = lines.filter((line) => /Error|Timeout|expect|failed|passed|✘|✓|locator|Timed out/i.test(line));
  return interesting.slice(-20).join("\n").slice(0, 4000);
}

function summarize(results) {
  let passed = 0;
  let failed = 0;
  let timeout = 0;
  for (const item of results) {
    const last = item.attempts.at(-1);
    if (!last) continue;
    if (last.status === "passed") passed += 1;
    else if (last.status === "timeout") timeout += 1;
    else failed += 1;
  }
  return { total: results.length, passed, failed, timeout };
}

function formatMarkdown(payload) {
  const lines = [
    "# Puffer Bounded UI/UX Replay Report",
    "",
    `Started: ${payload.startedAt}`,
    `Finished: ${payload.finishedAt}`,
    `Seeds: ${payload.seeds.join(", ")}`,
    `Top cases per seed: ${payload.topLimit}`,
    `Attempts per case: ${payload.attempts}`,
    `Timeout per attempt: ${payload.timeoutSeconds}s`,
    "",
    "## Summary",
    "",
    `- Total replay cases: ${payload.summary.total}`,
    `- Passed: ${payload.summary.passed}`,
    `- Failed: ${payload.summary.failed}`,
    `- Timed out: ${payload.summary.timeout}`,
    "",
    "## Replay Positions",
    ""
  ];
  for (const item of payload.results) {
    const last = item.attempts.at(-1) ?? { status: "not-run", exitCode: null, logPath: "" };
    lines.push(`### ${item.caseId}`);
    lines.push("");
    lines.push(`- Seed: ${item.seed}`);
    lines.push(`- Status: ${last.status}`);
    lines.push(`- Exit code: ${last.exitCode}`);
    lines.push(`- Replay score: ${item.score}`);
    lines.push(`- Spec path: ${relativeRepoPath(item.specPath)}`);
    lines.push(`- Log path: ${last.logPath}`);
    lines.push(`- Coverage: ${item.coverage.join(", ")}`);
    lines.push(`- Steps: ${item.steps.join(" -> ")}`);
    if (last.excerpt) {
      lines.push("", "```text", last.excerpt, "```");
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

function relativeRepoPath(filePath) {
  return path.relative(repoRoot, filePath).replaceAll(path.sep, "/");
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
