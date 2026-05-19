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
