import path from "node:path";

export function selectCase(run, caseId) {
  const selected = (run.cases ?? []).find((item) => item.caseId === caseId);
  if (!selected) {
    throw new Error(`Case not found: ${caseId}`);
  }
  return selected;
}

export function buildReplayTemplate(testCase, options = {}) {
  const relativeCoverageImport = options.coverageImport ?? "../../../fuzz/playwright/pufferCoverage";
  const fakeDaemonImport = options.fakeDaemonImport ?? "./support/fakeDaemon";
  const daemonOptions = buildReplayDaemonOptions(testCase);
  const replayMetadata = buildReplayMetadata(testCase, daemonOptions);
  const lines = [
    "import { expect, test } from \"@playwright/test\";",
    `import { FakeDaemon } from "${fakeDaemonImport}";`,
    `import { appendTraceEvent, collectPufferUiState, createTraceId, installRuntimeOracle, writeTraceJsonl } from "${relativeCoverageImport}";`,
    "",
    `const replayMetadata = ${JSON.stringify(replayMetadata, null, 2)} as const;`,
    "",
    `test("fuzz replay ${testCase.caseId}", async ({ page }, testInfo) => {`,
    `  const daemon = new FakeDaemon(${JSON.stringify(daemonOptions, null, 2)});`,
    "  const replayTurnRegistry = installUniqueReplayTurnIds(daemon);",
    "  const traceId = createTraceId(\"puffer-fuzz\");",
    "  const trace = [];",
    "  installRuntimeOracle(page, trace, traceId);",
    "  await daemon.install(page);",
    "  await daemon.open(page);",
    "  let activeReplaySessionId = \"session-browser\";",
    "  let activeReplayTurnId: string | null = null;",
    "  let activeReplayEventTurnId: string | null = null;",
    "  let createdReplaySessionCount = 0;",
    "  let replayTurnSequence = 0;",
    "  let socketCountBeforeDisconnect = 0;",
    "  let requestIndexBefore = 0;",
    "  await page.locator(\"body\").waitFor({ state: \"visible\", timeout: 10_000 });",
    "  appendTraceEvent(trace, { type: \"state\", traceId, step: 0, state: await collectPufferUiState(page, { viewport: \"desktop\", browserOrShell: \"chromium\", fakeDaemon: true }) });",
    "  const initialBrowserState = await collectBrowserReplayState(page);",
    ""
  ];

  let step = 1;
  for (const action of testCase.steps ?? []) {
    if (action.phase === "assert") continue;
    lines.push(`  // Step ${step}: ${action.action}${action.params ? ` ${JSON.stringify(action.params)}` : ""}`);
    lines.push("  {");
    for (const command of commandsForAction(action)) {
      lines.push(`    ${command}`);
    }
    lines.push("  }");
    lines.push(`  appendTraceEvent(trace, { type: "action", traceId, step: ${step}, action: ${JSON.stringify(action)}, state: await collectPufferUiState(page, { viewport: "desktop", browserOrShell: "chromium", fakeDaemon: true }) });`);
    lines.push("");
    step += 1;
  }

  lines.push("  expect(page.isClosed()).toBe(false);");
  lines.push("  const finalBrowserState = await collectBrowserReplayState(page);");
  lines.push("  await assertReplayInvariants(page, daemon, trace, traceId, replayMetadata, initialBrowserState, finalBrowserState, activeReplaySessionId);");
  lines.push("  const tracePath = testInfo.outputPath(`${traceId}.jsonl`);");
  lines.push("  writeTraceJsonl(tracePath, trace);");
  lines.push("});");
  lines.push("");
  lines.push(...replayHelperLines());
  return lines.join("\n");
}

export function formatReplayMarkdown(testCase, outputPath) {
  const lines = [
    "# Puffer Fuzz Replay Scaffold",
    "",
    `Case: ${testCase.caseId}`,
    `Seed: ${testCase.seedId}`,
    `Suggested spec path: ${outputPath}`,
    "",
    "## Steps",
    ""
  ];
  for (const step of testCase.steps ?? []) {
    lines.push(`- ${step.phase}: ${step.action} ${step.params ? JSON.stringify(step.params) : ""}`.trim());
  }
  lines.push("", "## Notes", "");
  lines.push("- The scaffold includes concrete FakeDaemon reconnect handling, trace capture, and baseline browser invariants.");
  lines.push("- Unsupported generated actions fail fast so false replay passes do not inflate coverage.");
  lines.push("- Run the spec three times before filing a confirmed bug, then shrink the sequence to the smallest stable reproducer.");
  return `${lines.join("\n")}\n`;
}

function buildReplayMetadata(testCase, daemonOptions = {}) {
  const coverage = testCase.coverage ?? [];
  const steps = testCase.steps ?? [];
  return {
    caseId: testCase.caseId,
    seedId: testCase.seedId,
    coverage,
    initialSessionCount: Array.isArray(daemonOptions.sessions) ? daemonOptions.sessions.length : 1,
    typedUrls: steps
      .filter((step) => step.action === "type-url" && step.params?.url)
      .map((step) => String(step.params.url)),
    typedMessages: steps
      .filter((step) => step.action === "type-composer" && step.params?.text)
      .map((step) => String(step.params.text)),
    staleUrls: steps
      .filter((step) => step.action === "emit-state-for-old-tab" && step.params?.url)
      .map((step) => String(step.params.url)),
    hasDroppedResponse: coverage.includes("async:dropped-response") ||
      steps.some((step) => step.action === "hold-next-browser-response"),
    hasInjectedFailure: steps.some((step) => step.action?.startsWith("fail-next-")),
    hasReconnect: coverage.includes("async:reconnect") ||
      steps.some((step) => step.action === "disconnect-reconnect"),
    hasDuplicateSubmit: coverage.includes("async:duplicate-submit")
  };
}

function commandsForAction(step) {
  const params = step.params ?? {};
  switch (step.action) {
    case "open-workspace":
      return [
        "await ensureWorkspaceOpen(page);"
      ];
    case "open-settings-providers":
      return [
        "await ensureProvidersOpen(page);"
      ];
    case "type-search":
      return [
        "await ensureWorkspaceOpen(page);",
        `await page.getByLabel("Search workspace").fill(${JSON.stringify(params.text ?? "browser")}, { timeout: 5_000 });`
      ];
    case "clear-search":
      return [
        "await ensureWorkspaceOpen(page);",
        "await page.getByRole(\"button\", { name: \"Clear search\" }).click({ timeout: 1_000 }).catch(async () => {",
        "  await page.getByLabel(\"Search workspace\").fill(\"\", { timeout: 5_000 });",
        "});"
      ];
    case "open-agent-card":
      return [
        "await closeReplayModalIfOpen(page);",
        "requestIndexBefore = daemon.requests.length;",
        `await clickReplaySession(page, ${JSON.stringify(params.session ?? "session-browser")}, "open workspace/session card");`,
        `activeReplaySessionId = ${JSON.stringify(params.session ?? "session-browser")};`,
        "activeReplayTurnId = null;",
        "activeReplayEventTurnId = null;",
        "await waitForNewDaemonRequest(daemon, \"load_session_detail\", requestIndexBefore, (request) => request.params.sessionId === activeReplaySessionId);"
      ];
    case "pin-agent":
      return [
        "await closeReplayModalIfOpen(page);",
        "daemon.delayResponse(\"set_desktop_pin\", () => true, 250);",
        `const agentRow = page.locator(".pf-sidebar-agent-row").filter({ hasText: ${JSON.stringify(sessionDisplayName(params.session ?? "session-browser"))} }).first();`,
        "await expect(agentRow).toBeVisible({ timeout: 5_000 });",
        "requestIndexBefore = daemon.requests.length;",
        "await agentRow.getByRole(\"button\", { name: /Pin agent|Unpin agent/ }).evaluate((button) => {",
        "  (button as HTMLButtonElement).click();",
        "  (button as HTMLButtonElement).click();",
        "});",
        "await waitForNewDaemonRequest(daemon, \"set_desktop_pin\", requestIndexBefore);",
        "await page.waitForTimeout(50);",
        "expect(daemon.requests.slice(requestIndexBefore).filter((request) => request.method === \"set_desktop_pin\")).toHaveLength(1);"
      ];
    case "open-connect-project":
      return [
        "await ensureWorkspaceOpen(page);",
        "await page.getByRole(\"button\", { name: \"Create Project\" }).click({ timeout: 5_000 });",
        "await expect(page.getByRole(\"dialog\", { name: \"Create Project\" })).toBeVisible({ timeout: 5_000 });"
      ];
    case "open-workspace-picker":
      return [
        "await ensureWorkspaceOpen(page);",
        "await page.getByRole(\"button\", { name: \"Switch workspace\" }).click({ timeout: 5_000 });",
        "await expect(page.getByRole(\"dialog\", { name: \"Switch workspace\" })).toBeVisible({ timeout: 5_000 });"
      ];
    case "assert-modal-initial-focus":
      return [
        `await assertDialogOwnsFocus(page, ${JSON.stringify(params.name ?? "dialog")});`
      ];
    case "assert-modal-focus-trap":
      return [
        `await assertDialogTrapsTabFocus(page, ${JSON.stringify(params.name ?? "dialog")}, ${Number(params.tabs ?? 12)});`
      ];
    case "emit-grouped-session-refresh":
      return [
        "requestIndexBefore = daemon.requests.length;",
        "daemon.emit(\"workspace:sessions:changed\", { reason: \"fuzz-grouped-refresh\", at: Date.now() });",
        "await waitForNewDaemonRequest(daemon, \"list_grouped_sessions\", requestIndexBefore, () => true, 3_000).catch(() => undefined);"
      ];
    case "emit-active-agent-change":
      return [
        "daemon.setSessionTimeline(activeReplaySessionId, [{ kind: \"assistant_message\", id: `fuzz-${Date.now()}`, text: `Fuzz update for ${activeReplaySessionId}`, createdAtMs: Date.now() }]);",
        "requestIndexBefore = daemon.requests.length;",
        "daemon.emit(\"workspace:sessions:changed\", { reason: \"fuzz-active-agent-change\", sessionId: activeReplaySessionId, at: Date.now() });",
        "await waitForNewDaemonRequest(daemon, \"list_grouped_sessions\", requestIndexBefore, () => true, 3_000).catch(() => undefined);"
      ];
    case "open-agent-detail":
      return [
        "await clickFirstVisible(page, [",
        "  () => page.locator(\".pf-sidebar-agents-list\").getByRole(\"button\", { name: /^Browser regression\\b/ }),",
        "  () => page.getByRole(\"button\", { name: /Browser regression/ }).first()",
        "], \"open Browser regression agent\");"
      ];
    case "open-browser-pane":
      return [
        "await clickFirstVisible(page, [",
        "  () => page.locator(\".pf-agent-tabs\").getByRole(\"button\", { name: \"Browser\", exact: true }),",
        "  () => page.getByRole(\"button\", { name: \"Browser\", exact: true })",
        "], \"open Browser panel\");",
        "await waitForDaemonRequest(daemon, \"browser_open\");"
      ];
    case "type-composer":
      return [
        `await page.locator(".pf-composer textarea").fill(${JSON.stringify(params.text ?? "test prompt")}, { timeout: 5_000 });`
      ];
    case "send-prompt":
      return [
        "await expect(page.getByRole(\"button\", { name: \"Send\", exact: true })).toBeEnabled({ timeout: 5_000 });",
        "requestIndexBefore = daemon.requests.length;",
        "await page.getByRole(\"button\", { name: \"Send\", exact: true }).click({ timeout: 5_000 });",
        "const turnRequest = await waitForNewDaemonRequest(daemon, \"run_agent_turn\", requestIndexBefore);",
        "replayTurnSequence += 1;",
        "activeReplayTurnId = replayTurnRegistry.latestForSession(String(turnRequest.params.sessionId ?? activeReplaySessionId));",
        "if (!activeReplayTurnId) throw new Error(\"Fake daemon did not record a replay turn id\");",
        "activeReplayEventTurnId = activeReplayTurnId;"
      ];
    case "rapid-send-prompt":
      return [
        "await expect(page.getByRole(\"button\", { name: \"Send\", exact: true })).toBeEnabled({ timeout: 5_000 });",
        "requestIndexBefore = daemon.requests.length;",
        "await page.getByRole(\"button\", { name: \"Send\", exact: true }).evaluate((button) => {",
        "  (button as HTMLButtonElement).click();",
        "  (button as HTMLButtonElement).click();",
        "});",
        "const turnRequest = await waitForNewDaemonRequest(daemon, \"run_agent_turn\", requestIndexBefore);",
        "replayTurnSequence += 1;",
        "activeReplayTurnId = replayTurnRegistry.latestForSession(String(turnRequest.params.sessionId ?? activeReplaySessionId));",
        "if (!activeReplayTurnId) throw new Error(\"Fake daemon did not record a replay turn id\");",
        "activeReplayEventTurnId = activeReplayTurnId;"
      ];
    case "stop-turn":
      return [
        "requestIndexBefore = daemon.requests.length;",
        "await page.getByRole(\"button\", { name: \"Stop turn\" }).click({ timeout: 5_000 });",
        "await waitForNewDaemonRequest(daemon, \"cancel_turn\", requestIndexBefore);"
      ];
    case "complete-turn":
      return [
        "if (!activeReplayTurnId) throw new Error(\"Invalid replay state: complete-turn requires an active turn id\");",
        "daemon.emit(`session:${activeReplaySessionId}:event`, { type: \"turn-complete\", turnId: activeReplayEventTurnId ?? activeReplayTurnId, assistantText: \"Fuzz completed turn\" });",
        "await expect(page.getByRole(\"button\", { name: \"Send\", exact: true })).toBeVisible({ timeout: 5_000 });",
        "replayTurnRegistry.clear(activeReplayTurnId);",
        "activeReplayTurnId = null;",
        "activeReplayEventTurnId = null;"
      ];
    case "settle-canceled-turn":
      return [
        "if (!activeReplayTurnId) throw new Error(\"Invalid replay state: settle-canceled-turn requires an active turn id\");",
        "daemon.emit(`session:${activeReplaySessionId}:event`, { type: \"turn-error\", turnId: activeReplayTurnId, error: \"Canceled by fuzz\" });",
        "await expect(page.getByRole(\"button\", { name: \"Send\", exact: true })).toBeVisible({ timeout: 5_000 });",
        "replayTurnRegistry.clear(activeReplayTurnId);",
        "activeReplayTurnId = null;",
        "activeReplayEventTurnId = null;"
      ];
    case "switch-session":
      return [
        "requestIndexBefore = daemon.requests.length;",
        `await clickReplaySession(page, ${JSON.stringify(params.session ?? "session-browser")}, "switch session ${params.session ?? "session-browser"}");`,
        `activeReplaySessionId = ${JSON.stringify(params.session ?? "session-browser")};`,
        "activeReplayTurnId = null;",
        "activeReplayEventTurnId = null;",
        "await waitForNewDaemonRequest(daemon, \"load_session_detail\", requestIndexBefore, (request) => request.params.sessionId === activeReplaySessionId);"
      ];
    case "emit-old-session-stream":
      return [
        `daemon.emit(\`session:\${staleReplaySessionId(activeReplaySessionId)}:event\`, { type: "turn-complete", turnId: "turn-stale-fuzz", assistantText: ${JSON.stringify(params.delta ?? "late token")} });`
      ];
    case "emit-permission":
      return [
        "if (!activeReplayTurnId) throw new Error(\"Invalid replay state: emit-permission requires an active turn id\");",
        "activeReplayEventTurnId = activeReplayTurnId;",
        `daemon.emit(\`session:\${activeReplaySessionId}:event\`, { type: "permission-request", turnId: activeReplayEventTurnId, requestId: ${JSON.stringify(`request-${step.id}`)}, toolId: ${JSON.stringify(params.tool ?? "bash")}, summary: "Fuzz permission request", reason: "Fuzz permission reason" });`,
        "await expect(page.getByText(\"Approval needed\")).toBeVisible({ timeout: 5_000 });"
      ];
    case "answer-permission":
      return [
        "requestIndexBefore = daemon.requests.length;",
        `await page.getByRole("button", { name: ${JSON.stringify(permissionButtonName(params.answer))} }).click({ timeout: 5_000 });`,
        "await waitForNewDaemonRequest(daemon, \"resolve_permission\", requestIndexBefore);"
      ];
    case "emit-question":
      return [
        "if (!activeReplayTurnId) throw new Error(\"Invalid replay state: emit-question requires an active turn id\");",
        "activeReplayEventTurnId = activeReplayTurnId;",
        `daemon.emit(\`session:\${activeReplaySessionId}:event\`, { type: "user-question-request", turnId: activeReplayEventTurnId, requestId: ${JSON.stringify(`request-${step.id}`)}, questions: [{ header: "Fuzz", question: "Which path should I use?", options: [{ label: "src", description: "Use src." }, { label: "tests", description: "Use tests." }] }] });`,
        "await expect(page.getByText(\"Which path should I use?\")).toBeVisible({ timeout: 5_000 });"
      ];
    case "answer-question":
      return [
        `await page.getByPlaceholder("Type another answer").fill(${JSON.stringify(params.answer ?? "custom answer")}, { timeout: 5_000 }).catch(async () => { await page.locator("textarea").last().fill(${JSON.stringify(params.answer ?? "custom answer")}, { timeout: 5_000 }); });`,
        "requestIndexBefore = daemon.requests.length;",
        "await page.getByRole(\"button\", { name: \"Send answer\" }).click({ timeout: 5_000 });",
        "await waitForNewDaemonRequest(daemon, \"resolve_user_question\", requestIndexBefore);"
      ];
    case "change-model":
      return [
        `await changeReplayModel(page, daemon, ${JSON.stringify(params.model ?? "codex/test-model")});`
      ];
    case "delayed-transcript-refresh":
      return [
        "daemon.delayResponse(\"load_session_detail\", () => true, 350);"
      ];
    case "import-credential":
      return [
        "await ensureProvidersOpen(page);",
        `const providerId = normalizeReplayProviderId(${JSON.stringify(params.provider ?? "codex")});`,
        "requestIndexBefore = daemon.requests.length;",
        "await providerCard(page, providerId).locator(\"button.import\").first().click({ timeout: 5_000 });",
        "await waitForNewDaemonRequest(daemon, \"import_external_credential\", requestIndexBefore, (request) => requestProviderMatches(request, providerId));"
      ];
    case "refresh-credential":
      return [
        "await ensureProvidersOpen(page);",
        `const providerId = normalizeReplayProviderId(${JSON.stringify(params.provider ?? "codex")});`,
        "requestIndexBefore = daemon.requests.length;",
        "if (providerId === \"anthropic\") {",
        "  const card = providerCard(page, providerId);",
        "  await card.getByLabel(\"API key for Anthropic\").fill(`sk-fuzz-${Date.now()}`, { timeout: 5_000 });",
        "  await card.getByRole(\"button\", { name: /Connect|Update key/ }).click({ timeout: 5_000 });",
        "  await waitForNewDaemonRequest(daemon, \"login_with_api_key\", requestIndexBefore, (request) => requestProviderMatches(request, providerId));",
        "} else {",
        "  await providerCard(page, providerId).getByRole(\"button\", { name: /Connect with OAuth|Reconnect with OAuth/ }).click({ timeout: 5_000 });",
        "  await waitForNewDaemonRequest(daemon, \"login_with_oauth\", requestIndexBefore, (request) => requestProviderMatches(request, providerId));",
        "}"
      ];
    case "save-default-model":
      return [
        "await ensureProvidersOpen(page);",
        `await saveReplayDefaultModel(page, daemon, ${JSON.stringify(params.provider ?? "codex")}, ${JSON.stringify(params.model ?? "test-model")});`
      ];
    case "open-new-agent":
      return [
        "await ensureWorkspaceOpen(page);",
        "await clickFirstVisible(page, [",
        "  () => page.getByRole(\"button\", { name: \"New agent in puffer\" }),",
        "  () => page.getByRole(\"button\", { name: \"New agent in default workspace\" }),",
        "  () => page.locator(\".pf-pw-project\").first().getByRole(\"button\", { name: \"New agent\" })",
        "], \"open New agent modal\");",
        "await expect(page.getByRole(\"dialog\", { name: \"New agent\" })).toBeVisible({ timeout: 5_000 });"
      ];
    case "switch-new-agent-provider":
      return [
        `await page.getByRole("dialog", { name: "New agent" }).getByRole("radio", { name: ${providerLabelRegex(params.provider ?? "codex")} }).click({ timeout: 5_000 });`
      ];
    case "submit-new-agent":
      return [
        "daemon.delayResponse(\"create_session\", () => true, 250);",
        "requestIndexBefore = daemon.requests.length;",
        "await page.getByRole(\"dialog\", { name: \"New agent\" }).getByRole(\"button\", { name: \"Start agent\" }).evaluate((button) => {",
        "  (button as HTMLButtonElement).click();",
        "  (button as HTMLButtonElement).click();",
        "});",
        "await waitForNewDaemonRequest(daemon, \"create_session\", requestIndexBefore);",
        "await page.waitForTimeout(50);",
        "expect(daemon.requests.slice(requestIndexBefore).filter((request) => request.method === \"create_session\")).toHaveLength(1);",
        "createdReplaySessionCount += 1;",
        "activeReplaySessionId = `session-created-${replayMetadata.initialSessionCount + createdReplaySessionCount}`;",
        "activeReplayTurnId = null;",
        "activeReplayEventTurnId = null;",
        "await expect(page.locator(\".pf-composer textarea\")).toBeVisible({ timeout: 5_000 });"
      ];
    case "emit-auth-list-refresh":
      return [
        "await ensureProvidersOpen(page);",
        `daemon.setAuthStatuses(replayAuthStatuses(${JSON.stringify(params.authState ?? "multi-provider")}));`,
        "requestIndexBefore = daemon.requests.length;",
        "await clickFirstVisible(page, [",
        "  () => page.locator(\".login-page .refresh-btn\"),",
        "  () => page.locator(\".pf-settings-pane\").getByRole(\"button\", { name: \"Refresh\" }).first()",
        "], \"refresh provider/auth list\");",
        "await waitForNewDaemonRequest(daemon, \"load_settings_snapshot\", requestIndexBefore);"
      ];
    case "delayed-model-list":
      return [
        "daemon.delayResponse(\"list_provider_models\", () => true, 350);"
      ];
    case "type-url":
      return [
        `await page.locator(".pf-browser-address").fill(${JSON.stringify(params.url ?? "about:blank")}, { timeout: 5_000 });`
      ];
    case "press-address-enter":
      return [
        "await page.locator(\".pf-browser-address\").press(\"Enter\", { timeout: 5_000 });",
        "await waitForDaemonRequest(daemon, \"browser_navigate\");"
      ];
    case "click-new-tab":
      return [
        "await page.locator(\".pf-browser-tab-add\").click({ timeout: 5_000 });",
        "await waitForDaemonRequest(daemon, \"browser_agent\", (request) => request.params.action === \"open\");"
      ];
    case "close-active-tab":
      return [
        "await page.locator(\".pf-browser-tab\").filter({ hasText: /./ }).first().getByRole(\"button\").click({ timeout: 5_000 });",
        "await waitForDaemonRequest(daemon, \"browser_agent\", (request) => request.params.action === \"close\");"
      ];
    case "reload":
      return [
        "await page.locator(\"button[title='Reload']\").click({ timeout: 5_000 });",
        "await waitForDaemonRequest(daemon, \"browser_reload\");"
      ];
    case "history":
      return [
        `await page.locator("button[title='${params.direction === "forward" ? "Forward" : "Back"}']").click({ timeout: 5_000 });`,
        "await waitForDaemonRequest(daemon, \"browser_history\");"
      ];
    case "switch-tab":
      return [
        `await page.locator(".pf-browser-tab").nth(${Number(params.tabIndex ?? 0)}).click({ timeout: 5_000 });`
      ];
    case "type-page-input":
      return [
        "await page.locator(\".pf-browser-canvas, canvas\").first().click({ position: { x: 20, y: 20 } }).catch(() => undefined);",
        `await page.keyboard.type(${JSON.stringify(params.text ?? "")});`,
        "await waitForDaemonRequest(daemon, \"browser_input\");"
      ];
    case "special-key":
      return [
        "await page.locator(\".pf-browser-canvas, canvas\").first().click({ position: { x: 20, y: 20 } }).catch(() => undefined);",
        `await page.keyboard.press(${JSON.stringify(params.key ?? "Enter")});`,
        "await waitForDaemonRequest(daemon, \"browser_input\");"
      ];
    case "emit-state-for-old-tab":
      return [
        `daemon.emit("browser:session-browser:browser:tab-1:state", ${JSON.stringify({ url: params.url ?? "https://stale.example.test", title: "Stale page", loading: params.loading === true, width: 960, height: 720 })});`
      ];
    case "emit-empty-tab-list":
      return [
        "daemon.emit(\"browser:session-browser:tabs\", { activeTabId: null, tabs: [] });"
      ];
    case "emit-frame-burst":
      return [
        "for (const frame of " + JSON.stringify(params.frames ?? []) + ") {",
        "  daemon.emit(\"browser:session-browser:browser:tab-1:frame\", { frameId: `frame-${frame.width}-${frame.height}`, mimeType: \"image/png\", encoding: \"base64\", data: \"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lzTnGQAAAABJRU5ErkJggg==\", width: frame.width, height: frame.height });",
        "}"
      ];
    case "fail-next-browser-command":
      return [
        "daemon.failNext(\"browser_agent\", \"fuzz injected browser failure\");"
      ];
    case "hold-next-browser-response":
      return [
        "daemon.delayResponse(\"browser_navigate\", () => true, 60_000);"
      ];
    case "disconnect-reconnect":
      return [
        "socketCountBeforeDisconnect = getFakeDaemonSocketCount(daemon);",
        "await disconnectFakeDaemonSockets(daemon);",
        "appendTraceEvent(trace, { type: \"daemon\", traceId, step: -1, event: \"forced-disconnect\" });",
        "await waitForFakeDaemonSocketCount(daemon, 0, 3_000);",
        "await expect(page.locator(\"body\")).toContainText(/Disconnected|not connected|closed|reconnecting/i, { timeout: 3_000 }).catch(() => undefined);",
        "if (socketCountBeforeDisconnect > 0) {",
        "  await reconnectFakeDaemonIfNeeded(page, daemon, 5_000).catch(() => undefined);",
        "}"
      ];
    case "resize-narrow":
    case "resize-desktop":
      return [
        `await page.setViewportSize({ width: ${Number(params.width ?? 800)}, height: ${Number(params.height ?? 720)} });`
      ];
    default:
      return [
        `throw new Error("Unsupported replay action: ${String(step.action).replaceAll("\"", "\\\"")}");`
      ];
  }
}

function buildReplayDaemonOptions(testCase) {
  const needsExtraSessions = (testCase.steps ?? []).some((step) => step.action === "switch-session");
  const needsCoreHarness = ["chat-turn-race", "workspace-session-race", "provider-auth-model-race", "modal-focus-race"].includes(testCase.seedId);
  if (!needsExtraSessions && !needsCoreHarness) {
    return {};
  }
  const now = Date.now();
  return {
    sessions: [
      replaySession("session-browser", "Browser regression", "Browser seed transcript", now),
      replaySession("session-second", "Second session", "Second seed transcript", now - 1_000),
      replaySession("session-third", "Third session", "Third seed transcript", now - 2_000)
    ],
    providerModels: replayProviderModels(),
    externalCredentials: [
      {
        providerId: "codex",
        source: "codex",
        kind: "oauth",
        description: "Codex CLI OAuth credential",
        sourcePath: "/tmp/home/.codex/auth.json"
      },
      {
        providerId: "anthropic",
        source: "claude",
        kind: "api_key",
        description: "Claude CLI API key credential",
        sourcePath: "/tmp/home/.claude.json"
      }
    ]
  };
}

function replayProviderModels() {
  return {
    codex: [
      replayModel("test-model", "Test model", "codex", "openai-responses", true),
      replayModel("gpt-5.5", "GPT-5.5", "codex", "openai-responses", false)
    ],
    openai: [
      replayModel("test-model", "Test model", "openai", "openai-responses", true),
      replayModel("gpt-5.5", "GPT-5.5", "openai", "openai-responses", false)
    ],
    anthropic: [
      replayModel("test-model", "Test model", "anthropic", "anthropic-messages", true),
      replayModel("claude-sonnet-4-5", "Claude Sonnet 4.5", "anthropic", "anthropic-messages", false)
    ]
  };
}

function replayModel(id, displayName, provider, api, isDefault) {
  return {
    id,
    displayName,
    provider,
    api,
    contextWindow: 128000,
    maxOutputTokens: 4096,
    supportsReasoning: true,
    supportsTools: true,
    supportsVision: false,
    thinkingOptions: [
      { id: "low", label: "Low", description: "Low reasoning.", isDefault: true },
      { id: "high", label: "High", description: "High reasoning.", isDefault: false }
    ],
    defaultThinkingOptionId: "low",
    isDefault
  };
}

function replaySession(sessionId, displayName, text, updatedAtMs) {
  return {
    sessionId,
    displayName,
    title: displayName,
    cwd: "/tmp/puffer",
    folderPath: "/tmp/puffer",
    updatedAtMs,
    createdAtMs: updatedAtMs - 60_000,
    eventCount: 1,
    providerId: "codex",
    modelId: "test-model",
    timeline: [{ kind: "assistant_message", id: `${sessionId}-seed`, text, createdAtMs: updatedAtMs - 30_000 }]
  };
}

function sessionNameRegex(sessionId) {
  if (sessionId === "session-second") return "/^Second session\\b/";
  if (sessionId === "session-third") return "/^Third session\\b/";
  return "/^Browser regression\\b/";
}

function sessionDisplayName(sessionId) {
  if (sessionId === "session-second") return "Second session";
  if (sessionId === "session-third") return "Third session";
  return "Browser regression";
}

function providerLabelRegex(providerId) {
  if (providerId === "anthropic" || providerId === "claude") return "/Anthropic/i";
  return "/Codex|OpenAI/i";
}

function permissionButtonName(answer) {
  return answer === "deny" ? "Deny" : "Allow once";
}

export function defaultReplaySpecPath(testCase) {
  return path.join("apps", "puffer-desktop", "tests", `${testCase.seedId}.replay.spec.ts`);
}

function replayHelperLines() {
  return [
    "type BrowserReplayState = {",
    "  addressValue: string;",
    "  activeTabText: string;",
    "  activeTabCount: number;",
    "  tabCount: number;",
    "  statusText: string;",
    "  errorText: string;",
    "  loadingText: string;",
    "};",
    "",
    "async function clickFirstVisible(page, candidates, label: string): Promise<void> {",
    "  const errors: string[] = [];",
    "  for (const candidate of candidates) {",
    "    const locator = candidate();",
    "    try {",
    "      await locator.click({ timeout: 5_000 });",
    "      return;",
    "    } catch (error) {",
    "      errors.push(String(error));",
    "    }",
    "  }",
    "  throw new Error(`${label} failed. Tried ${candidates.length} locator(s). Last error: ${errors.at(-1) ?? \"none\"}`);",
    "}",
    "",
    "async function closeReplayModalIfOpen(page): Promise<void> {",
    "  const dialogs = page.getByRole(\"dialog\");",
    "  if ((await dialogs.count().catch(() => 0)) === 0) return;",
    "  await page.keyboard.press(\"Escape\").catch(() => undefined);",
    "  await expect(dialogs.first()).toBeHidden({ timeout: 1_000 }).catch(() => undefined);",
    "}",
    "",
    "async function ensureWorkspaceOpen(page): Promise<void> {",
    "  await closeReplayModalIfOpen(page);",
    "  if ((await page.getByLabel(\"Search workspace\").count().catch(() => 0)) > 0) return;",
    "  if ((await page.getByRole(\"button\", { name: \"Back\" }).count().catch(() => 0)) > 0) {",
    "    await page.getByRole(\"button\", { name: \"Back\" }).click({ timeout: 5_000 });",
    "    await expect(page.getByLabel(\"Search workspace\")).toBeVisible({ timeout: 5_000 });",
    "    return;",
    "  }",
    "  await clickFirstVisible(page, [",
    "    () => page.getByRole(\"button\", { name: \"Project\", exact: true }),",
    "    () => page.locator(\".pf-sidebar-item\").filter({ hasText: \"Project\" })",
    "  ], \"open Project workspace\");",
    "  await expect(page.getByLabel(\"Search workspace\")).toBeVisible({ timeout: 5_000 });",
    "}",
    "",
    "async function ensureProvidersOpen(page): Promise<void> {",
    "  await closeReplayModalIfOpen(page);",
    "  await clickFirstVisible(page, [",
    "    () => page.getByRole(\"button\", { name: \"Settings\", exact: true }),",
    "    () => page.locator(\".pf-sidebar-item\").filter({ hasText: \"Settings\" })",
    "  ], \"open Settings\");",
    "  await clickFirstVisible(page, [",
    "    () => page.getByRole(\"button\", { name: \"Providers\", exact: true }),",
    "    () => page.getByRole(\"tab\", { name: \"Providers\", exact: true }),",
    "    () => page.locator(\".pf-settings-nav-item\").filter({ hasText: \"Providers\" })",
    "  ], \"open Providers settings\");",
    "  await expect(page.locator(\".pf-settings-pane\")).toContainText(\"Providers\", { timeout: 5_000 });",
    "}",
    "",
    "async function clickReplaySession(page, sessionId: string, label: string): Promise<void> {",
    "  const name = replaySessionRegex(sessionId);",
    "  if ((await page.getByRole(\"button\", { name }).count().catch(() => 0)) === 0 &&",
    "      (await page.getByRole(\"button\", { name: \"Back\" }).count().catch(() => 0)) > 0) {",
    "    await page.getByRole(\"button\", { name: \"Back\" }).click({ timeout: 5_000 });",
    "    await expect(page.getByLabel(\"Search workspace\")).toBeVisible({ timeout: 5_000 });",
    "  }",
    "  await clickFirstVisible(page, [",
    "    () => page.locator(\".pf-sidebar-agents-list\").getByRole(\"button\", { name }).first(),",
    "    () => page.getByRole(\"region\", { name: \"Session history\" }).getByRole(\"button\", { name }).first(),",
    "    () => page.getByRole(\"button\", { name }).first()",
    "  ], label);",
    "}",
    "",
    "async function assertDialogOwnsFocus(page, dialogName: string): Promise<void> {",
    "  const dialog = page.getByRole(\"dialog\", { name: dialogName });",
    "  await expect(dialog).toBeVisible({ timeout: 5_000 });",
    "  const activeSummary = await page.evaluate(() => {",
    "    const active = document.activeElement as HTMLElement | null;",
    "    return {",
    "      tag: active?.tagName ?? \"none\",",
    "      text: (active?.innerText || active?.textContent || active?.getAttribute(\"aria-label\") || active?.getAttribute(\"title\") || \"\").trim().slice(0, 120)",
    "    };",
    "  });",
    "  const focusInside = await dialog.evaluate((node) => node.contains(document.activeElement));",
    "  expect(focusInside, `${dialogName} should receive focus when opened; active=${JSON.stringify(activeSummary)}`).toBe(true);",
    "}",
    "",
    "async function assertDialogTrapsTabFocus(page, dialogName: string, tabs: number): Promise<void> {",
    "  const dialog = page.getByRole(\"dialog\", { name: dialogName });",
    "  await expect(dialog).toBeVisible({ timeout: 5_000 });",
    "  const focusable = dialog.locator(\"button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])\").first();",
    "  await expect(focusable).toBeVisible({ timeout: 5_000 });",
    "  await focusable.focus();",
    "  for (let index = 0; index < tabs; index += 1) {",
    "    await page.keyboard.press(index % 5 === 4 ? \"Shift+Tab\" : \"Tab\");",
    "    const focusInside = await dialog.evaluate((node) => node.contains(document.activeElement));",
    "    const activeSummary = await page.evaluate(() => {",
    "      const active = document.activeElement as HTMLElement | null;",
    "      return {",
    "        tag: active?.tagName ?? \"none\",",
    "        text: (active?.innerText || active?.textContent || active?.getAttribute(\"aria-label\") || active?.getAttribute(\"title\") || \"\").trim().slice(0, 120)",
    "      };",
    "    });",
    "    expect(focusInside, `${dialogName} focus escaped after Tab ${index + 1}; active=${JSON.stringify(activeSummary)}`).toBe(true);",
    "  }",
    "}",
    "",
    "function replaySessionRegex(sessionId: string): RegExp {",
    "  if (sessionId === \"session-second\") return /^Second session\\b/;",
    "  if (sessionId === \"session-third\") return /^Third session\\b/;",
    "  return /^Browser regression\\b/;",
    "}",
    "",
    "function replaySessionDisplayName(sessionId: string): string {",
    "  if (sessionId === \"session-second\") return \"Second session\";",
    "  if (sessionId === \"session-third\") return \"Third session\";",
    "  if (sessionId.startsWith(\"session-created-\")) return \"New Session\";",
    "  return \"Browser regression\";",
    "}",
    "",
    "function normalizeReplayProviderId(providerId: string): string {",
    "  const normalized = String(providerId || \"codex\").trim().toLowerCase();",
    "  if (normalized === \"openai\") return \"codex\";",
    "  if (normalized === \"claude\") return \"anthropic\";",
    "  return normalized || \"codex\";",
    "}",
    "",
    "function canonicalReplayProviderId(providerId: string): string {",
    "  const normalized = String(providerId || \"\").trim().toLowerCase();",
    "  if (normalized === \"codex\" || normalized === \"openai\") return \"openai\";",
    "  if (normalized === \"claude\" || normalized === \"anthropic\") return \"anthropic\";",
    "  return normalized;",
    "}",
    "",
    "function providerIdsMatch(left: string, right: string): boolean {",
    "  return canonicalReplayProviderId(left) === canonicalReplayProviderId(right);",
    "}",
    "",
    "function providerDisplayName(providerId: string): string {",
    "  return providerIdsMatch(providerId, \"anthropic\") ? \"Anthropic\" : \"Codex\";",
    "}",
    "",
    "function providerCard(page, providerId: string) {",
    "  return page.locator(\".provider-card\").filter({ hasText: providerDisplayName(providerId) }).first();",
    "}",
    "",
    "function requestProviderMatches(request, providerId: string): boolean {",
    "  return providerIdsMatch(String(request.params.providerId ?? request.params.defaultProvider ?? \"\"), providerId);",
    "}",
    "",
    "function replayAuthStatuses(authState: string) {",
    "  if (authState === \"one-provider\") {",
    "    return [{ providerId: \"codex\", kind: \"oauth\", email: \"tester@example.com\", expiresAtMs: null, scopes: [], planType: \"test\", organizationName: null }];",
    "  }",
    "  return [",
    "    { providerId: \"codex\", kind: \"oauth\", email: \"tester@example.com\", expiresAtMs: null, scopes: [], planType: \"test\", organizationName: null },",
    "    { providerId: \"anthropic\", kind: \"api_key\", email: null, expiresAtMs: null, scopes: [], planType: null, organizationName: null }",
    "  ];",
    "}",
    "",
    "async function changeReplayModel(page, daemon, modelSpec: string): Promise<void> {",
    "  const slash = modelSpec.indexOf(\"/\");",
    "  const providerId = normalizeReplayProviderId(slash > 0 ? modelSpec.slice(0, slash) : \"codex\");",
    "  const modelId = slash > 0 ? modelSpec.slice(slash + 1) : modelSpec;",
    "  const picker = page.locator(\".pf-composer .picker\").first();",
    "  await expect(picker.locator(\".trigger\")).toBeEnabled({ timeout: 5_000 });",
    "  let startIndex = daemon.requests.length;",
    "  await picker.locator(\".trigger\").click({ timeout: 5_000 });",
    "  await waitForNewDaemonRequest(daemon, \"list_provider_models\", startIndex, () => true, 3_000).catch(() => undefined);",
    "  const providerButton = picker.locator(\".providers\").getByRole(\"button\", { name: providerDisplayName(providerId) });",
    "  if ((await providerButton.count().catch(() => 0)) > 0) {",
    "    startIndex = daemon.requests.length;",
    "    await providerButton.click({ timeout: 5_000 });",
    "    await waitForNewDaemonRequest(daemon, \"list_provider_models\", startIndex, (request) => requestProviderMatches(request, providerId), 3_000).catch(() => undefined);",
    "  }",
    "  const target = picker.locator(\".row\").filter({ hasText: modelId }).first();",
    "  if ((await target.count().catch(() => 0)) > 0) {",
    "    await target.click({ timeout: 5_000 });",
    "  } else {",
    "    await picker.locator(\".row\").first().click({ timeout: 5_000 });",
    "  }",
    "  await expect(picker.locator(\".menu\")).toHaveCount(0, { timeout: 5_000 });",
    "}",
    "",
    "async function saveReplayDefaultModel(page, daemon, provider: string, model: string): Promise<void> {",
    "  const providerId = normalizeReplayProviderId(provider);",
    "  const pane = page.locator(\".pf-settings-pane\");",
    "  const providerSelect = pane.getByLabel(\"Provider\");",
    "  let startIndex = daemon.requests.length;",
    "  await providerSelect.selectOption(providerId).catch(async () => {",
    "    await providerSelect.selectOption(canonicalReplayProviderId(providerId));",
    "  });",
    "  await waitForNewDaemonRequest(daemon, \"list_provider_models\", startIndex, (request) => requestProviderMatches(request, providerId), 3_000).catch(() => undefined);",
    "  const modelSelect = pane.getByLabel(\"Model\");",
    "  await expect(modelSelect).toBeEnabled({ timeout: 5_000 });",
    "  await selectReplayModelOption(modelSelect, model);",
    "  startIndex = daemon.requests.length;",
    "  await pane.getByRole(\"button\", { name: \"Save default\" }).click({ timeout: 5_000 });",
    "  await waitForNewDaemonRequest(daemon, \"update_config\", startIndex, (request) => requestProviderMatches(request, providerId));",
    "}",
    "",
    "async function selectReplayModelOption(modelSelect, preferredModel: string): Promise<void> {",
    "  const values = await modelSelect.locator(\"option\").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).filter(Boolean));",
    "  const value = values.includes(preferredModel) ? preferredModel : values[0];",
    "  if (!value) throw new Error(\"No selectable model option is available\");",
    "  await modelSelect.selectOption(value);",
    "}",
    "",
    "function installUniqueReplayTurnIds(daemon) {",
    "  const unsafe = daemon as any;",
    "  const originalDispatch = typeof unsafe.dispatch === \"function\" ? unsafe.dispatch.bind(daemon) : null;",
    "  const activeTurnIds = new Set<string>();",
    "  const latestBySession = new Map<string, string>();",
    "  let counter = 0;",
    "  if (originalDispatch) {",
    "    unsafe.dispatch = (request) => {",
    "      if (request.method === \"run_agent_turn\") {",
    "        const sessionId = String(request.params?.sessionId ?? \"session-browser\");",
    "        const turnId = `turn-${sessionId}-${++counter}`;",
    "        activeTurnIds.add(turnId);",
    "        latestBySession.set(sessionId, turnId);",
    "        return { turnId };",
    "      }",
    "      if (request.method === \"cancel_turn\") {",
    "        const turnId = String(request.params?.turnId ?? \"\");",
    "        if (activeTurnIds.has(turnId)) return { ok: true };",
    "      }",
    "      return originalDispatch(request);",
    "    };",
    "  }",
    "  return {",
    "    latestForSession(sessionId: string): string | null {",
    "      return latestBySession.get(sessionId) ?? null;",
    "    },",
    "    clear(turnId: string | null): void {",
    "      if (turnId) activeTurnIds.delete(turnId);",
    "    }",
    "  };",
    "}",
    "",
    "async function waitForDaemonRequest(daemon, method: string, predicate = () => true, timeoutMs = 5_000) {",
    "  let timer: ReturnType<typeof setTimeout> | null = null;",
    "  try {",
    "    return await Promise.race([",
    "      daemon.waitForRequest(method, predicate),",
    "      new Promise((_, reject) => {",
    "        timer = setTimeout(() => reject(new Error(`Timed out waiting for daemon request ${method}`)), timeoutMs);",
    "      })",
    "    ]);",
    "  } finally {",
    "    if (timer) clearTimeout(timer);",
    "  }",
    "}",
    "",
    "async function waitForNewDaemonRequest(daemon, method: string, startIndex: number, predicate = () => true, timeoutMs = 5_000) {",
    "  return waitForDaemonRequest(daemon, method, (request) => {",
    "    const index = daemon.requests.indexOf(request);",
    "    return index >= startIndex && predicate(request);",
    "  }, timeoutMs);",
    "}",
    "",
    "function getFakeDaemonSocketCount(daemon): number {",
    "  if (typeof daemon.socketCount === \"function\") return daemon.socketCount();",
    "  const sockets = (daemon as any).sockets;",
    "  if (sockets && typeof sockets.size === \"number\") return sockets.size;",
    "  return 0;",
    "}",
    "",
    "async function disconnectFakeDaemonSockets(daemon): Promise<void> {",
    "  if (typeof daemon.disconnectAllSockets === \"function\") {",
    "    await daemon.disconnectAllSockets();",
    "    return;",
    "  }",
    "  const sockets = [...(((daemon as any).sockets ?? []) as Iterable<{ close: (options?: { code?: number; reason?: string }) => Promise<void> }>)];",
    "  await Promise.all(sockets.map((socket) => socket.close({ code: 1011, reason: \"fuzz forced reconnect\" }).catch(() => undefined)));",
    "}",
    "",
    "async function waitForFakeDaemonSocketCount(daemon, count: number, timeoutMs = 5_000): Promise<void> {",
    "  if (typeof daemon.waitForSocketCount === \"function\") {",
    "    await daemon.waitForSocketCount(count, timeoutMs);",
    "    return;",
    "  }",
    "  const deadline = Date.now() + timeoutMs;",
    "  while (getFakeDaemonSocketCount(daemon) !== count) {",
    "    if (Date.now() >= deadline) {",
    "      throw new Error(`Timed out waiting for ${count} fake daemon socket(s); saw ${getFakeDaemonSocketCount(daemon)}.`);",
    "    }",
    "    await new Promise((resolve) => setTimeout(resolve, 25));",
    "  }",
    "}",
    "",
    "async function reconnectFakeDaemonIfNeeded(page, daemon, timeoutMs = 5_000): Promise<void> {",
    "  if (getFakeDaemonSocketCount(daemon) > 0) return;",
    "  const reconnect = page.getByRole(\"button\", { name: \"Reconnect\", exact: true });",
    "  await reconnect.click({ timeout: 1_000 }).catch(() => undefined);",
    "  await waitForFakeDaemonSocketCount(daemon, 1, timeoutMs);",
    "}",
    "",
    "function staleReplaySessionId(activeSessionId: string): string {",
    "  return activeSessionId === \"session-browser\" ? \"session-second\" : \"session-browser\";",
    "}",
    "",
    "async function collectBrowserReplayState(page): Promise<BrowserReplayState> {",
    "  const activeTab = page.locator(\".pf-browser-tab[aria-selected='true'], .pf-browser-tab[data-active='true'], .pf-browser-tab.active\");",
    "  const loadingText = await page.locator(\"body\").innerText({ timeout: 1_000 }).catch(() => \"\");",
    "  return {",
    "    addressValue: await page.locator(\".pf-browser-address\").first().inputValue({ timeout: 500 }).catch(() => \"\"),",
    "    activeTabText: await activeTab.first().innerText({ timeout: 500 }).catch(() => \"\"),",
    "    activeTabCount: await activeTab.count().catch(() => 0),",
    "    tabCount: await page.locator(\".pf-browser-tab\").count().catch(() => 0),",
    "    statusText: await page.locator(\".pf-browser-status\").first().innerText({ timeout: 500 }).catch(() => \"\"),",
    "    errorText: await page.locator(\".pf-browser-error\").allInnerTexts().then((items) => items.join(\"\\n\")).catch(() => \"\"),",
    "    loadingText",
    "  };",
    "}",
    "",
    "async function assertReplayInvariants(page, daemon, trace, traceId, metadata, initialBrowserState: BrowserReplayState, finalBrowserState: BrowserReplayState, activeSessionId: string): Promise<void> {",
    "  appendTraceEvent(trace, { type: \"state\", traceId, step: 9_999, state: await collectPufferUiState(page, { viewport: \"desktop\", browserOrShell: \"chromium\", fakeDaemon: true }), initialBrowserState, finalBrowserState });",
    "  expect(page.isClosed()).toBe(false);",
    "  await expect(page.locator(\"body\")).toBeVisible();",
    "  const runtimeErrors = trace.filter((event) => event.type === \"pageerror\" || (event.type === \"console\" && /TypeError|ReferenceError|Unhandled|Cannot read|Cannot set/i.test(String(event.text ?? \"\"))));",
    "  expect(runtimeErrors, JSON.stringify(runtimeErrors.slice(0, 3))).toHaveLength(0);",
    "",
    "  if (metadata.coverage.includes(\"invariant:active-tab-stable\") || metadata.coverage.includes(\"async:stale-tab-event\")) {",
    "    const state = await collectBrowserReplayState(page);",
    "    if (state.tabCount > 0) expect(state.activeTabCount, \"browser should keep one reachable active tab when tabs exist\").toBeGreaterThan(0);",
    "    for (const staleUrl of metadata.staleUrls) {",
    "      expect(state.addressValue, `stale tab URL leaked into active address: ${staleUrl}`).not.toBe(staleUrl);",
    "    }",
    "  }",
    "",
    "  if (metadata.coverage.includes(\"invariant:no-permanent-loading\") && !metadata.hasDroppedResponse) {",
    "    await expect.poll(async () => {",
    "      const state = await collectBrowserReplayState(page);",
    "      return /loading|connecting|pending/i.test(`${state.statusText} ${state.loadingText}`);",
    "    }, { timeout: 3_000 }).toBe(false);",
    "  }",
    "",
    "  if (metadata.coverage.includes(\"invariant:draft-preserved-on-failure\") && metadata.hasInjectedFailure && metadata.typedUrls.length > 0) {",
    "    const state = await collectBrowserReplayState(page);",
    "    const lastTypedUrl = metadata.typedUrls[metadata.typedUrls.length - 1];",
    "    expect(`${state.addressValue} ${state.errorText}`, \"typed browser URL should remain recoverable after injected failure\").toContain(lastTypedUrl);",
    "  }",
    "",
    "  if (metadata.coverage.includes(\"invariant:active-session-stable\") || metadata.coverage.includes(\"async:stale-session-event\")) {",
    "    if ((await page.locator(\".pf-agent-detail\").count().catch(() => 0)) > 0) {",
    "      await expect(page.locator(\".pf-agent-detail\")).toContainText(replaySessionDisplayName(activeSessionId), { timeout: 3_000 });",
    "    }",
    "  }",
    "",
    "  if (metadata.coverage.includes(\"invariant:no-cross-provider-model\")) {",
    "    const badProviderModel = daemon.requests.find((request) => providerModelLooksCrossed(request));",
    "    expect(badProviderModel, `provider/model crossed in request: ${JSON.stringify(badProviderModel)}`).toBeUndefined();",
    "  }",
    "",
    "  if (metadata.hasDuplicateSubmit) {",
    "    const maxDuplicateNavigates = maxDuplicateRequestCount(daemon.requests, \"browser_navigate\", (params) => String(params.url ?? \"\"));",
    "    const maxDuplicateTurns = maxDuplicateRequestCount(daemon.requests, \"run_agent_turn\", (params) => String(params.message ?? \"\"));",
    "    expect(maxDuplicateNavigates, \"one browser navigate request per unique URL intent\").toBeLessThanOrEqual(1);",
    "    expect(maxDuplicateTurns, \"one chat turn request per unique prompt intent\").toBeLessThanOrEqual(1);",
    "  }",
    "}",
    "",
    "function maxDuplicateRequestCount(requests, method: string, keyForParams: (params) => string): number {",
    "  const counts = new Map<string, number>();",
    "  for (const request of requests) {",
    "    if (request.method !== method) continue;",
    "    const key = keyForParams(request.params);",
    "    if (!key) continue;",
    "    counts.set(key, (counts.get(key) ?? 0) + 1);",
    "  }",
    "  return Math.max(0, ...counts.values());",
    "}",
    "",
    "function providerModelLooksCrossed(request): boolean {",
    "  const params = request.params ?? {};",
    "  const provider = canonicalReplayProviderId(String(params.providerId ?? params.defaultProvider ?? \"\"));",
    "  const model = String(params.modelId ?? params.defaultModel ?? \"\").toLowerCase();",
    "  if (!provider || !model) return false;",
    "  if (provider === \"anthropic\") return /gpt|codex|openai/.test(model);",
    "  if (provider === \"openai\") return /claude|anthropic/.test(model);",
    "  return false;",
    "}",
    ""
  ];
}
