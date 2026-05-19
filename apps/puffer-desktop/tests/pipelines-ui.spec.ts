import { expect, test } from "@playwright/test";
import { FakeDaemon } from "./support/fakeDaemon";

test("starter workflow uses the connected workspace as working directory", async ({ page }) => {
  const daemon = new FakeDaemon({ workspaceRoot: "/tmp/puffer-workspace" });
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Pipelines" }).click();

  await expect(page.getByRole("button", { name: /agent-review-pipeline/ })).toBeVisible();
  await expect(page.getByLabel("Working directory")).toHaveValue("/tmp/puffer-workspace");
  await expect(page.getByLabel("Working directory")).not.toHaveValue("/Users/shou/corbina");
});

test("local workflow draft survives main tab switches", async ({ page }) => {
  const daemon = new FakeDaemon({ workspaceRoot: "/tmp/puffer-workspace" });
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Pipelines" }).click();
  await daemon.waitForRequest("workflow_list");
  const pipelineName = page.locator(".pf-editor-config").getByLabel("Name");
  await pipelineName.fill("Navigation-safe draft");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Pipelines" }).click();

  await expect(page.locator(".pf-editor-config").getByLabel("Name")).toHaveValue("Navigation-safe draft");
});

test("local workflow draft survives failed refresh", async ({ page }) => {
  const daemon = new FakeDaemon({ workspaceRoot: "/tmp/puffer-workspace" });
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Pipelines" }).click();
  await daemon.waitForRequest("workflow_list");
  const pipelineName = page.locator(".pf-editor-config").getByLabel("Name");
  await pipelineName.fill("Refresh-safe draft");

  const workflowRequests = daemon.requests.filter((request) => request.method === "workflow_list").length;
  daemon.failNext("workflow_list", "workflow list unavailable");
  await page.locator(".pf-pipe-top-right").getByRole("button", { name: "Refresh" }).click();

  await expect.poll(() =>
    daemon.requests.filter((request) => request.method === "workflow_list").length
  ).toBe(workflowRequests + 1);
  await expect(page.locator(".pf-editor-config").getByLabel("Name")).toHaveValue("Refresh-safe draft");
});

test("provider switch preserves customized agent fields", async ({ page }) => {
  const daemon = new FakeDaemon({ workspaceRoot: "/tmp/puffer-workspace" });
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Pipelines" }).click();
  await daemon.waitForRequest("workflow_list");

  const inspector = page.locator(".pf-editor-inspector");
  await inspector.getByLabel("Agent name").fill("Custom implementer");
  await inspector.getByLabel("Model").fill("custom-model");
  await inspector.getByLabel("Tools").fill("custom-tool, bash");
  await inspector.getByRole("button", { name: "Claude Code" }).click();

  await expect(inspector.getByLabel("Agent name")).toHaveValue("Custom implementer");
  await expect(inspector.getByLabel("Model")).toHaveValue("custom-model");
  await expect(inspector.getByLabel("Tools")).toHaveValue("custom-tool, bash");
});

test("trigger type switch preserves prior trigger fields", async ({ page }) => {
  const daemon = new FakeDaemon({ workspaceRoot: "/tmp/puffer-workspace" });
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Pipelines" }).click();
  await daemon.waitForRequest("workflow_list");

  const config = page.locator(".pf-editor-config");
  await config.getByLabel("Source topic").fill("custom.topic.created");
  await config.getByLabel("Pattern").fill("ship|review");
  const triggerType = config.getByRole("group", { name: "Trigger type" });
  await triggerType.getByRole("button", { name: "Cron" }).click();
  const cronInput = config.locator('label:has-text("Cron") input');
  await cronInput.fill("15 9 * * 1-5");
  await triggerType.getByRole("button", { name: "Subscription" }).click();

  await expect(config.getByLabel("Source topic")).toHaveValue("custom.topic.created");
  await expect(config.getByLabel("Pattern")).toHaveValue("ship|review");

  await triggerType.getByRole("button", { name: "Cron" }).click();
  await expect(cronInput).toHaveValue("15 9 * * 1-5");
});

test("wiring prevents dependencies that would create cycles", async ({ page }) => {
  const daemon = new FakeDaemon({ workspaceRoot: "/tmp/puffer-workspace" });
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Pipelines" }).click();
  await daemon.waitForRequest("workflow_list");

  const wiring = page.locator(".pf-editor-wiring");
  const pufferDependency = wiring.locator(".pf-wire-row").filter({ hasText: "Puffer shipper" }).locator("input");
  await expect(pufferDependency).toBeDisabled();
  await expect(pufferDependency).not.toBeChecked();
});

test("required pipeline and agent fields show validation when cleared", async ({ page }) => {
  const daemon = new FakeDaemon({ workspaceRoot: "/tmp/puffer-workspace" });
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Pipelines" }).click();
  await daemon.waitForRequest("workflow_list");

  const config = page.locator(".pf-editor-config");
  await config.getByLabel("Name").fill("");
  await config.getByLabel("Slug").fill("");
  await config.getByLabel("Working directory").fill("");
  await config.getByLabel("Source topic").fill("");
  await config.getByLabel("Pattern").fill("");

  await expect(config.getByText("Pipeline name is required.")).toBeVisible();
  await expect(config.getByText("Pipeline slug is required.")).toBeVisible();
  await expect(config.getByText("Working directory is required.")).toBeVisible();
  await expect(config.getByText("Source topic is required.")).toBeVisible();
  await expect(config.getByText("Pattern is required.")).toBeVisible();

  const inspector = page.locator(".pf-editor-inspector");
  await inspector.getByLabel("Agent name").fill("");
  await inspector.getByLabel("Model").fill("");
  await inspector.getByLabel("Tools").fill("");
  await inspector.getByLabel("Prompt").fill("");

  await expect(inspector.getByText("Agent name is required.")).toBeVisible();
  await expect(inspector.getByText("Model is required.")).toBeVisible();
  await expect(inspector.getByText("At least one tool is required.")).toBeVisible();
  await expect(inspector.getByText("Prompt is required.")).toBeVisible();

  const triggerType = config.getByRole("group", { name: "Trigger type" });
  await triggerType.getByRole("button", { name: "Cron" }).click();
  const cronInput = config.locator('label:has-text("Cron") input');
  await cronInput.fill("");

  await expect(config.getByText("Cron is required.")).toBeVisible();
});

test("tools field preserves invalid and quoted input while validating", async ({ page }) => {
  const daemon = new FakeDaemon({ workspaceRoot: "/tmp/puffer-workspace" });
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Pipelines" }).click();
  await daemon.waitForRequest("workflow_list");

  const inspector = page.locator(".pf-editor-inspector");
  const tools = inspector.getByLabel("Tools");

  await tools.fill("read,,bash");
  await expect(tools).toHaveValue("read,,bash");
  await expect(inspector.getByText("Tool entries cannot be empty.")).toBeVisible();

  await tools.fill('"read,edit", bash');
  await expect(tools).toHaveValue('"read,edit", bash');
  await expect(inspector.getByText("Tool entries cannot be empty.")).toBeHidden();

  await inspector.getByRole("button", { name: "Claude Code" }).click();
  await expect(tools).toHaveValue('"read,edit", bash');
});

test("refresh preserves the selected workflow node when it still exists", async ({ page }) => {
  const workflows = [
    {
      schema: "puffer.workflow.v1",
      slug: "first-flow",
      enabled: true,
      trigger: { type: "subscription", source_topic: "first.topic", pattern: "*" },
      pipeline: {
        name: "First flow",
        working_dir: "/tmp/puffer-workspace",
        concurrency: 1,
        nodes: [
          {
            id: "first-implement",
            type: "codex",
            agent: "First implementer",
            model: "gpt-5",
            tools: ["read"],
            prompt: "Implement first."
          }
        ]
      }
    },
    {
      schema: "puffer.workflow.v1",
      slug: "second-flow",
      enabled: true,
      trigger: { type: "subscription", source_topic: "second.topic", pattern: "*" },
      pipeline: {
        name: "Second flow",
        working_dir: "/tmp/puffer-workspace",
        concurrency: 1,
        nodes: [
          {
            id: "second-implement",
            type: "codex",
            agent: "Second implementer",
            model: "gpt-5",
            tools: ["read"],
            prompt: "Implement second."
          },
          {
            id: "second-review",
            type: "claude",
            agent: "Second reviewer",
            model: "claude-sonnet-4-5",
            tools: ["read"],
            depends_on: ["second-implement"],
            prompt: "Review second."
          }
        ]
      }
    }
  ];
  const daemon = new FakeDaemon({ workspaceRoot: "/tmp/puffer-workspace", workflows });
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Pipelines" }).click();
  await daemon.waitForRequest("workflow_list");
  await page.getByRole("button", { name: /second-flow/ }).click();
  await page.locator(".pf-pipe-graph").getByRole("button", { name: /Second reviewer/ }).click();
  await expect(page.locator(".pf-editor-inspector").getByLabel("Agent name")).toHaveValue("Second reviewer");

  const workflowRequests = daemon.requests.filter((request) => request.method === "workflow_list").length;
  await page.locator(".pf-pipe-top-right").getByRole("button", { name: "Refresh" }).click();
  await expect.poll(() =>
    daemon.requests.filter((request) => request.method === "workflow_list").length
  ).toBe(workflowRequests + 1);

  await expect(page.locator(".pf-editor-inspector").getByLabel("Agent name")).toHaveValue("Second reviewer");
});

test("removing a node with dependents requires confirmation", async ({ page }) => {
  const daemon = new FakeDaemon({ workspaceRoot: "/tmp/puffer-workspace" });
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Pipelines" }).click();
  await daemon.waitForRequest("workflow_list");

  const inspector = page.locator(".pf-editor-inspector");
  await expect(inspector.getByLabel("Agent name")).toHaveValue("Codex implementer");
  await inspector.getByRole("button", { name: "Remove" }).click();

  await expect(inspector.getByRole("alert")).toContainText("Removing this node will drop downstream wiring.");
  await expect(inspector.getByRole("alert")).toContainText("Claude reviewer");
  await expect(inspector.getByLabel("Agent name")).toHaveValue("Codex implementer");

  await inspector.getByRole("button", { name: "Cancel" }).click();
  await expect(inspector.getByRole("alert")).toHaveCount(0);
  await expect(inspector.getByLabel("Agent name")).toHaveValue("Codex implementer");

  await inspector.getByRole("button", { name: "Remove" }).click();
  await inspector.getByRole("button", { name: "Remove anyway" }).click();
  await expect(inspector.getByLabel("Agent name")).toHaveValue("Claude reviewer");
  await expect(page.locator(".pf-pipe-graph").getByRole("button", { name: /Codex implementer/ })).toHaveCount(0);
});

test("edited workflow can be exported as JSON", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (value: string) => {
          (window as typeof window & { __copiedWorkflowJson?: string }).__copiedWorkflowJson = value;
          return Promise.resolve();
        }
      }
    });
  });
  const daemon = new FakeDaemon({ workspaceRoot: "/tmp/puffer-workspace" });
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: "Pipelines" }).click();
  await daemon.waitForRequest("workflow_list");
  await page.locator(".pf-editor-config").getByLabel("Name").fill("Exported workflow");
  await page.getByRole("button", { name: "Copy JSON" }).click();

  const copied = await page.evaluate(() => (window as typeof window & { __copiedWorkflowJson?: string }).__copiedWorkflowJson ?? "");
  const exported = JSON.parse(copied);
  expect(exported.pipeline.name).toBe("Exported workflow");
  expect(exported.pipeline.nodes).toHaveLength(3);
  await expect(page.getByText("Workflow JSON copied to clipboard.")).toBeVisible();
});
