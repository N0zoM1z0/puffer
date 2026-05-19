import { expect, test } from "@playwright/test";
import { FakeDaemon } from "./support/fakeDaemon";

const baseTime = Date.now();

test("workspace search filters projects and agents", async ({ page }) => {
  const daemon = new FakeDaemon({
    sessions: [
      {
        sessionId: "session-alpha",
        displayName: "Alpha planner",
        title: "Alpha planner",
        cwd: "/tmp/puffer-alpha",
        folderPath: "/tmp/puffer-alpha",
        updatedAtMs: baseTime,
        createdAtMs: baseTime - 60_000,
        eventCount: 2
      },
      {
        sessionId: "session-beta",
        displayName: "Beta browser audit",
        title: "Beta browser audit",
        cwd: "/tmp/puffer-beta",
        folderPath: "/tmp/puffer-beta",
        updatedAtMs: baseTime - 1_000,
        createdAtMs: baseTime - 120_000,
        eventCount: 4
      }
    ]
  });
  await daemon.install(page);
  await daemon.open(page);

  const workspace = page.locator(".pf-pw-list");
  await expect(workspace.getByText("puffer-alpha")).toBeVisible();
  await expect(workspace.getByText("puffer-beta")).toBeVisible();

  await page.getByLabel("Search workspace").fill("beta browser");
  await expect(workspace.getByText("Beta browser audit")).toBeVisible();
  await expect(workspace.getByText("puffer-beta")).toBeVisible();
  await expect(workspace.getByText("Alpha planner")).toHaveCount(0);
  await expect(workspace.getByText("puffer-alpha")).toHaveCount(0);

  await page.getByLabel("Search workspace").fill("missing session");
  await expect(workspace.getByText("No workspace results")).toBeVisible();
  await page.getByRole("button", { name: "Clear search" }).click();
  await expect(workspace.getByText("Alpha planner")).toBeVisible();
  await expect(workspace.getByText("Beta browser audit")).toBeVisible();
});

test("workspace search includes sessions beyond the first six in a project", async ({
  page
}) => {
  const daemon = new FakeDaemon({
    sessions: Array.from({ length: 7 }, (_, index) => {
      const ordinal = index + 1;
      const title = ordinal === 7 ? "Seventh hidden audit" : `Workspace audit ${ordinal}`;
      return {
        sessionId: `session-workspace-${ordinal}`,
        displayName: title,
        title,
        cwd: "/tmp/puffer-many",
        folderPath: "/tmp/puffer-many",
        updatedAtMs: baseTime - index * 1_000,
        createdAtMs: baseTime - 60_000 - index * 1_000,
        eventCount: ordinal
      };
    })
  });
  await daemon.install(page);
  await daemon.open(page);

  const workspace = page.locator(".pf-pw-list");
  await page.getByLabel("Search workspace").fill("seventh hidden");
  await expect(
    workspace.getByRole("button", { name: /^Seventh hidden audit\b/ })
  ).toBeVisible();
  await expect(workspace.getByText("puffer-many")).toBeVisible();
  await expect(workspace.getByText("Workspace audit 1")).toHaveCount(0);
});

test("workspace board renders daemon session activity states", async ({ page }) => {
  const daemon = new FakeDaemon({
    sessions: [
      {
        sessionId: "session-running",
        displayName: "Running checkout fix",
        title: "Running checkout fix",
        cwd: "/tmp/puffer-active",
        folderPath: "/tmp/puffer-active",
        updatedAtMs: baseTime,
        createdAtMs: baseTime - 60_000,
        eventCount: 3,
        activityStatus: "running"
      },
      {
        sessionId: "session-awaiting",
        displayName: "Awaiting deploy approval",
        title: "Awaiting deploy approval",
        cwd: "/tmp/puffer-active",
        folderPath: "/tmp/puffer-active",
        updatedAtMs: baseTime - 1_000,
        createdAtMs: baseTime - 120_000,
        eventCount: 5,
        activityStatus: "awaiting"
      },
      {
        sessionId: "session-idle",
        displayName: "Idle docs followup",
        title: "Idle docs followup",
        cwd: "/tmp/puffer-active",
        folderPath: "/tmp/puffer-active",
        updatedAtMs: baseTime - 2_000,
        createdAtMs: baseTime - 180_000,
        eventCount: 2,
        activityStatus: "idle"
      }
    ]
  });
  await daemon.install(page);
  await daemon.open(page);

  const project = page.locator(".pf-pw-project").filter({ hasText: "puffer-active" });
  await expect(project).toContainText("2 active");

  await expect(
    page.locator(".pf-sidebar-agent-row").filter({ hasText: "Running checkout fix" })
  ).toContainText("running");
  await expect(
    page.locator(".pf-sidebar-agent-row").filter({ hasText: "Awaiting deploy approval" })
  ).toContainText("awaiting");

  await project.getByRole("button", { name: "Details" }).click();
  const runningColumn = page.locator(".pf-fpb-col").filter({ hasText: "Running" });
  await expect(runningColumn.getByText("Running checkout fix")).toBeVisible();
  await expect(runningColumn.getByText("Awaiting deploy approval")).toBeVisible();

  const queuedColumn = page.locator(".pf-fpb-col").filter({ hasText: "Queued" });
  await expect(queuedColumn.getByText("Idle docs followup")).toBeVisible();
});

test("project memory edit control is disabled until file editing is wired", async ({ page }) => {
  const daemon = new FakeDaemon();
  await daemon.install(page);
  await daemon.open(page);

  await page.locator(".pf-pw-project").getByRole("button", { name: "Details" }).click();
  await page.getByRole("button", { name: /Memory/ }).click();

  const memoryDetail = page.locator(".pf-pmem-detail");
  await expect(memoryDetail.getByRole("button", { name: "Edit" })).toBeDisabled();
  await expect(page.locator(".pf-pmem-list-head")).toContainText("Memory previews");
  await expect(memoryDetail.locator(".path")).not.toContainText(".puffer/memory");
});

test("workspace ignores stale grouped session refresh responses", async ({ page }) => {
  const daemon = new FakeDaemon({
    sessions: [
      {
        sessionId: "session-old",
        displayName: "Old workspace session",
        title: "Old workspace session",
        cwd: "/tmp/puffer-old",
        folderPath: "/tmp/puffer-old",
        updatedAtMs: baseTime,
        createdAtMs: baseTime - 60_000
      }
    ]
  });
  daemon.delayResponse("list_grouped_sessions", () => true, 220);
  await daemon.install(page);
  await daemon.open(page);
  await daemon.waitForRequest("list_grouped_sessions");
  const existingRequests = new Set(daemon.requests);

  daemon.setSessions([
    {
      sessionId: "session-new",
      displayName: "New workspace session",
      title: "New workspace session",
      cwd: "/tmp/puffer-new",
      folderPath: "/tmp/puffer-new",
      updatedAtMs: baseTime + 1_000,
      createdAtMs: baseTime - 30_000
    }
  ]);
  daemon.emit("workspace:sessions:changed", { sessionId: "session-new", reason: "created" });

  await daemon.waitForRequest(
    "list_grouped_sessions",
    (request) => !existingRequests.has(request)
  );
  const workspace = page.locator(".pf-pw-list");
  await expect(workspace.getByRole("button", { name: /^New workspace session\b/ })).toBeVisible();
  await page.waitForTimeout(260);
  await expect(workspace.getByRole("button", { name: /^New workspace session\b/ })).toBeVisible();
  await expect(workspace.getByText("Old workspace session")).toHaveCount(0);
});

test("agent pin keeps the latest user intent when an older response arrives late", async ({ page }) => {
  const daemon = new FakeDaemon({
    sessions: [
      {
        sessionId: "session-pin-race",
        displayName: "Pin race session",
        title: "Pin race session",
        cwd: "/tmp/puffer-pin",
        folderPath: "/tmp/puffer-pin",
        updatedAtMs: baseTime,
        createdAtMs: baseTime - 60_000
      }
    ]
  });
  daemon.delayResponse(
    "set_desktop_pin",
    (request) => request.params.id === "session-pin-race" && request.params.pinned === true,
    220
  );
  await daemon.install(page);
  await daemon.open(page);

  const row = page.locator(".pf-sidebar-agent-row").filter({ hasText: "Pin race session" });
  await row.getByRole("button", { name: "Pin agent" }).click();
  await expect(row).toHaveAttribute("data-pinned", "true");
  await row.getByRole("button", { name: "Unpin agent" }).click();
  await expect(row).toHaveAttribute("data-pinned", "false");

  await page.waitForTimeout(260);
  await expect(row).toHaveAttribute("data-pinned", "false");
});
