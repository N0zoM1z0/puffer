import { expect, test } from "@playwright/test";
import { FakeDaemon } from "./support/fakeDaemon";

test("default model cannot be saved before provider models load", async ({ page }) => {
  const daemon = new FakeDaemon();
  daemon.delayResponse(
    "list_provider_models",
    (request) => request.params.providerId === "anthropic",
    160
  );
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Providers" }).click();

  const pane = page.locator(".pf-settings-pane");
  const providerSelect = pane.getByLabel("Provider");
  const modelSelect = pane.getByLabel("Model");
  const saveButton = pane.getByRole("button", { name: "Save default" });

  await providerSelect.selectOption("anthropic");
  await expect(modelSelect).toBeDisabled();
  await expect(saveButton).toBeDisabled();

  await expect(modelSelect).toBeEnabled();
  await expect(modelSelect).toHaveValue("test-model");
  await expect(saveButton).toBeEnabled();

  await saveButton.click();
  const update = await daemon.waitForRequest("update_config");
  expect(update.params).toMatchObject({
    defaultProvider: "anthropic",
    defaultModel: "test-model"
  });
});

test("default model controls are locked while saving", async ({ page }) => {
  const daemon = new FakeDaemon();
  daemon.delayResponse("update_config", () => true, 3_000);
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Providers" }).click();

  const pane = page.locator(".pf-settings-pane");
  const providerSelect = pane.getByLabel("Provider");
  const modelSelect = pane.getByLabel("Model");
  await providerSelect.selectOption("anthropic");
  await expect(modelSelect).toBeEnabled();

  await pane.getByRole("button", { name: "Save default" }).click();
  await daemon.waitForRequest("update_config");

  await expect(providerSelect).toBeDisabled({ timeout: 250 });
  await expect(modelSelect).toBeDisabled({ timeout: 250 });
});

test("advertised settings shortcut opens settings", async ({ page }) => {
  const daemon = new FakeDaemon();
  await daemon.install(page);
  await daemon.open(page);

  await expect(page.getByRole("button", { name: "Connect project" })).toBeVisible();
  await page.keyboard.press("Control+,");

  await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
  await page.getByRole("button", { name: "Shortcuts" }).click();
  await expect(page.getByText("Cmd/Ctrl + ,")).toBeVisible();
  await expect(page.getByText("Open settings")).toBeVisible();
});

test("provider API key connect requires a non-empty key", async ({ page }) => {
  const daemon = new FakeDaemon();
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Providers" }).click();

  const input = page.getByLabel("API key for Anthropic");
  const connect = page
    .locator(".provider-card")
    .filter({ hasText: "Anthropic" })
    .getByRole("button", { name: "Connect" });

  await expect(connect).toBeDisabled();
  await input.fill("   ");
  await expect(connect).toBeDisabled();
  await input.press("Enter");
  await page.waitForTimeout(50);
  expect(
    daemon.requests.filter((request) => request.method === "login_with_api_key")
  ).toHaveLength(0);

  await input.fill("  sk-test  ");
  await expect(connect).toBeEnabled();
  await connect.click();

  const request = await daemon.waitForRequest("login_with_api_key");
  expect(request.params).toMatchObject({
    providerId: "anthropic",
    apiKey: "sk-test"
  });
});

test("provider auth controls are disabled while another auth action is pending", async ({ page }) => {
  const daemon = new FakeDaemon();
  daemon.delayResponse("login_with_api_key", () => true, 220);
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Providers" }).click();

  const anthropicCard = page.locator(".provider-card").filter({ hasText: "Anthropic" });
  const codexCard = page.locator(".provider-card").filter({ hasText: "Codex" });
  await anthropicCard.getByLabel("API key for Anthropic").fill("sk-test");
  await anthropicCard.getByRole("button", { name: "Connect" }).click();
  await daemon.waitForRequest("login_with_api_key");

  await expect(anthropicCard.getByLabel("API key for Anthropic")).toBeDisabled();
  await expect(anthropicCard.getByRole("button", { name: "Connect" })).toBeDisabled();
  await expect(codexCard.getByRole("button", { name: "Connect with OAuth" })).toBeDisabled();
});


test("permissions settings save tool policies through the daemon", async ({ page }) => {
  const daemon = new FakeDaemon();
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Permissions" }).click();
  await expect(page.getByText("Stored at")).toBeVisible();

  await page.getByRole("button", { name: "Add rule" }).click();
  const row = page.locator(".pf-perm-row").last();
  await row.locator("input").fill("browser_open");
  await row.locator("select").selectOption("deny");
  await page.getByRole("button", { name: "Save" }).click();

  const request = await daemon.waitForRequest("save_permissions");
  expect(request.params.tools).toMatchObject({
    bash: "ask",
    browser_open: "deny"
  });
});

test("permissions settings block duplicate tool rules before saving", async ({ page }) => {
  const daemon = new FakeDaemon();
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Permissions" }).click();
  await expect(page.getByText("Stored at")).toBeVisible();

  await page.getByRole("button", { name: "Add rule" }).click();
  const row = page.locator(".pf-perm-row").last();
  await row.locator("input").fill("bash");
  await row.locator("select").selectOption("deny");

  await expect(page.getByText("Duplicate tool rule: bash")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(daemon.requests.filter((request) => request.method === "save_permissions")).toHaveLength(0);
});

test("permissions settings keep edits after a late list response", async ({ page }) => {
  const daemon = new FakeDaemon();
  daemon.delayResponse("list_permissions", () => true, 220);
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Permissions" }).click();

  const addRule = page.getByRole("button", { name: "Add rule" });
  await expect(addRule).toBeDisabled();
  await expect(page.getByText("Loading permissions...")).toBeVisible();
  await expect(page.getByText("Stored at")).toBeVisible();

  await addRule.click();
  const row = page.locator(".pf-perm-row").last();
  await row.locator("input").fill("browser_open");
  await row.locator("select").selectOption("deny");

  await expect(row.locator("input")).toHaveValue("browser_open");
  await expect(row.locator("select")).toHaveValue("deny");

  await page.getByRole("button", { name: "Save" }).click();
  const request = await daemon.waitForRequest("save_permissions");
  expect(request.params.tools).toMatchObject({
    bash: "ask",
    browser_open: "deny"
  });
});

test("permissions settings lock rule edits while saving", async ({ page }) => {
  const daemon = new FakeDaemon();
  daemon.delayResponse("save_permissions", () => true, 220);
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Permissions" }).click();
  await expect(page.getByText("Stored at")).toBeVisible();

  await page.getByRole("button", { name: "Add rule" }).click();
  const row = page.locator(".pf-perm-row").last();
  await row.locator("input").fill("browser_open");
  await row.locator("select").selectOption("deny");
  await page.getByRole("button", { name: "Save" }).click();
  await daemon.waitForRequest("save_permissions");

  await expect(page.getByRole("button", { name: "Add rule" })).toBeDisabled();
  await expect(row.locator("input")).toBeDisabled();
  await expect(row.locator("select")).toBeDisabled();
  await expect(row.getByRole("button", { name: "Remove rule" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Saving…" })).toBeDisabled();

  await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
  await expect(row.locator("input")).toHaveValue("browser_open");
  await expect(row.locator("select")).toHaveValue("deny");
});

test("settings panes follow refreshed workspace state", async ({ page }) => {
  const daemon = new FakeDaemon();
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Providers" }).click();
  await expect(page.locator(".pf-settings-pane").getByLabel("Provider")).toHaveValue("codex");

  await page.getByRole("button", { name: "Permissions" }).click();
  await expect(page.getByText("Stored at")).toContainText("/tmp/puffer/.puffer/permissions.json");
  const permissionRequestsBefore = daemon.requests.filter(
    (request) => request.method === "list_permissions"
  ).length;

  daemon.setWorkspaceRoot("/tmp/puffer-next");
  daemon.setSettingsConfig({
    defaultProvider: "anthropic",
    defaultModel: "test-model"
  });
  daemon.setPermissions({ browser_open: "deny" });

  await page.getByRole("button", { name: "General" }).click();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.locator(".pf-settings-row").filter({ hasText: "Workspace root" })).toContainText(
    "/tmp/puffer-next"
  );

  await page.getByRole("button", { name: "Providers" }).click();
  await expect(page.locator(".pf-settings-pane").getByLabel("Provider")).toHaveValue("anthropic");

  await page.getByRole("button", { name: "Permissions" }).click();
  await expect.poll(() =>
    daemon.requests.filter((request) => request.method === "list_permissions").length
  ).toBe(permissionRequestsBefore + 1);
  await expect(page.getByText("Stored at")).toContainText(
    "/tmp/puffer-next/.puffer/permissions.json"
  );
  const refreshedRow = page.locator(".pf-perm-row").last();
  await expect(refreshedRow.locator("input")).toHaveValue("browser_open");
  await expect(refreshedRow.locator("select")).toHaveValue("deny");
});

test("remember last session persists and restores agent detail", async ({ page }) => {
  const daemon = new FakeDaemon();
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Settings" }).click();
  const remember = page
    .locator(".pf-settings-row")
    .filter({ hasText: "Remember last session" })
    .locator("input");
  await remember.check();
  await expect(remember).toBeChecked();

  await page.getByRole("button", { name: "Workspace" }).click();
  await page
    .locator(".pf-sidebar-agents-list")
    .getByRole("button", { name: /^Browser regression\b/ })
    .click();
  await expect(page.getByRole("button", { name: "Back" })).toBeVisible();

  await page.reload();
  await expect(page.getByRole("button", { name: "Back" })).toBeVisible();
  await expect(page.locator(".pf-agent-detail .primary-title")).toContainText("Browser regression");
});

test("MCP settings add server through the daemon", async ({ page }) => {
  const daemon = new FakeDaemon();
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "MCP Servers" }).click();
  await expect(page.locator(".pf-mcp-card .title").filter({ hasText: "Playwright" })).toBeVisible();

  await page.getByLabel("ID").fill("github");
  await page.getByLabel("Name").fill("GitHub");
  await page.getByLabel("Command").fill("npx");
  await page.getByLabel("Arguments").fill("@modelcontextprotocol/server-github");
  await page.getByLabel("Description").fill("GitHub issue and PR tools");
  await page.getByRole("button", { name: "Add server" }).click();

  const request = await daemon.waitForRequest("add_mcp_server");
  expect(request.params).toMatchObject({
    id: "github",
    displayName: "GitHub",
    description: "GitHub issue and PR tools",
    transport: "stdio",
    target: "npx @modelcontextprotocol/server-github",
    scope: "local"
  });
  await expect(page.getByText("Added github")).toBeVisible();
});

test("MCP settings block duplicate server IDs before saving", async ({ page }) => {
  const daemon = new FakeDaemon();
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "MCP Servers" }).click();
  await expect(page.locator(".pf-mcp-card .title").filter({ hasText: "Playwright" })).toBeVisible();

  await page.getByLabel("ID").fill("playwright");
  await page.getByLabel("Command").fill("npx");

  await expect(page.getByText("MCP server ID already exists: playwright")).toBeVisible();
  await expect(page.getByRole("button", { name: "Add server" })).toBeDisabled();
  expect(daemon.requests.filter((request) => request.method === "add_mcp_server")).toHaveLength(0);
});

test("MCP settings lock the add form while a server is saving", async ({ page }) => {
  const daemon = new FakeDaemon();
  daemon.delayResponse("add_mcp_server", () => true, 220);
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "MCP Servers" }).click();
  await expect(page.locator(".pf-mcp-card .title").filter({ hasText: "Playwright" })).toBeVisible();

  await page.getByLabel("ID").fill("github");
  await page.getByLabel("Name").fill("GitHub");
  await page.getByLabel("Command").fill("npx");
  await page.getByLabel("Arguments").fill("@modelcontextprotocol/server-github");
  await page.getByLabel("Description").fill("GitHub issue and PR tools");
  await page.getByRole("button", { name: "Add server" }).click();
  await daemon.waitForRequest("add_mcp_server");

  await expect(page.getByLabel("ID")).toBeDisabled();
  await expect(page.getByLabel("Name")).toBeDisabled();
  await expect(page.getByLabel("Transport")).toBeDisabled();
  await expect(page.getByLabel("Scope")).toBeDisabled();
  await expect(page.getByLabel("Command")).toBeDisabled();
  await expect(page.getByLabel("Arguments")).toBeDisabled();
  await expect(page.getByLabel("Description")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Adding…" })).toBeDisabled();

  await expect(page.getByText("Added github")).toBeVisible();
});

test("MCP settings manage existing workspace servers", async ({ page }) => {
  const daemon = new FakeDaemon({
    mcpServers: [
      {
        id: "playwright",
        displayName: "Playwright",
        description: "Browser automation",
        transport: "stdio",
        endpoint: "",
        target: "npx @playwright/mcp",
        sourceKind: "builtin",
        sourcePath: null
      },
      {
        id: "github",
        displayName: "GitHub",
        description: "GitHub issue tools",
        transport: "stdio",
        endpoint: "",
        target: "npx @modelcontextprotocol/server-github",
        sourceKind: "local",
        sourcePath: "/tmp/puffer/.puffer/resources/mcp_servers/github.yaml"
      }
    ]
  });
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "MCP Servers" }).click();

  const builtinCard = page.locator(".pf-mcp-card").filter({ hasText: "Playwright" });
  await expect(builtinCard.getByRole("button", { name: "Edit" })).toBeDisabled();
  await expect(builtinCard.getByRole("button", { name: "Remove" })).toBeDisabled();

  const githubCard = page.locator(".pf-mcp-card").filter({ hasText: "GitHub" });
  await githubCard.getByRole("button", { name: "Test" }).click();
  await expect(page.getByText("Validated github")).toBeVisible();
  expect((await daemon.waitForRequest("test_mcp_server")).params).toMatchObject({ id: "github" });

  await githubCard.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Name").fill("GitHub MCP");
  await page.getByLabel("Description").fill("GitHub PR and issue tools");
  await page.getByRole("button", { name: "Update server" }).click();

  const update = await daemon.waitForRequest("update_mcp_server");
  expect(update.params).toMatchObject({
    originalId: "github",
    id: "github",
    displayName: "GitHub MCP",
    description: "GitHub PR and issue tools"
  });
  await expect(page.getByText("Updated github")).toBeVisible();
  await expect(page.locator(".pf-mcp-card .title").filter({ hasText: "GitHub MCP" })).toBeVisible();

  await page
    .locator(".pf-mcp-card")
    .filter({ hasText: "GitHub MCP" })
    .getByRole("button", { name: "Remove" })
    .click();
  expect((await daemon.waitForRequest("remove_mcp_server")).params).toMatchObject({ id: "github" });
  await expect(page.getByText("Removed github")).toBeVisible();
  await expect(page.locator(".pf-mcp-card .title").filter({ hasText: "GitHub MCP" })).toHaveCount(0);
});

test("MCP settings ignore stale server loads after workspace refresh", async ({ page }) => {
  const daemon = new FakeDaemon();
  daemon.delayResponse("list_mcp_servers", () => true, 260);
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "MCP Servers" }).click();
  await daemon.waitForRequest("list_mcp_servers");
  await expect(page.getByText("Loading MCP servers…")).toBeVisible();

  daemon.setWorkspaceRoot("/tmp/puffer-next");
  daemon.setMcpServers([]);
  await page.getByRole("button", { name: "General" }).click();
  await page.getByRole("button", { name: "Refresh" }).click();
  await expect(page.locator(".pf-settings-row").filter({ hasText: "Workspace root" })).toContainText(
    "/tmp/puffer-next"
  );

  await page.getByRole("button", { name: "MCP Servers" }).click();
  await expect.poll(() =>
    daemon.requests.filter((request) => request.method === "list_mcp_servers").length
  ).toBe(2);
  await expect(page.getByText("No MCP servers configured.")).toBeVisible();
  await page.waitForTimeout(320);
  await expect(page.getByText("No MCP servers configured.")).toBeVisible();
  await expect(page.locator(".pf-mcp-card .title").filter({ hasText: "Playwright" })).toHaveCount(0);
});

test("MCP settings do not reload-loop when no servers are configured", async ({ page }) => {
  const daemon = new FakeDaemon({ mcpServers: [] });
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "MCP Servers" }).click();
  await daemon.waitForRequest("list_mcp_servers");

  await expect(page.getByText("No MCP servers configured.")).toBeVisible();
  await page.waitForTimeout(300);
  expect(daemon.requests.filter((request) => request.method === "list_mcp_servers")).toHaveLength(1);
});
