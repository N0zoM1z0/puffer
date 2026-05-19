import { expect, test } from "@playwright/test";
import { FakeDaemon } from "./support/fakeDaemon";

const baseTime = Date.now();

test("Terminal pane restores PTYs when switching sessions", async ({ page }) => {
  const daemon = new FakeDaemon({
    sessions: [
      {
        sessionId: "session-alpha",
        displayName: "Alpha terminal",
        title: "Alpha terminal",
        cwd: "/tmp/puffer-alpha",
        folderPath: "/tmp/puffer-alpha",
        updatedAtMs: baseTime,
        createdAtMs: baseTime - 60_000,
        timeline: []
      },
      {
        sessionId: "session-beta",
        displayName: "Beta terminal",
        title: "Beta terminal",
        cwd: "/tmp/puffer-beta",
        folderPath: "/tmp/puffer-beta",
        updatedAtMs: baseTime - 1_000,
        createdAtMs: baseTime - 120_000,
        timeline: []
      }
    ]
  });
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: /Alpha terminal/ }).first().click();
  await page.locator(".pf-agent-tabs").getByRole("button", { name: "Terminal", exact: true }).click();

  await daemon.waitForRequest("pty_open", (request) =>
    request.params.sessionId === "session-alpha" &&
    request.params.cwd === "/tmp/puffer-alpha"
  );
  await expect(page.getByRole("tab", { name: /Terminal 1/ })).toBeVisible();

  await page.getByRole("button", { name: /Beta terminal/ }).first().click();

  await daemon.waitForRequest("pty_list", (request) =>
    request.params.sessionId === "session-beta"
  );
  await daemon.waitForRequest("pty_open", (request) =>
    request.params.sessionId === "session-beta" &&
    request.params.cwd === "/tmp/puffer-beta"
  );
});

test("Terminal input keeps global find shortcuts while focused", async ({ page }) => {
  const daemon = new FakeDaemon();
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: /Browser regression/ }).first().click();
  await page.locator(".pf-agent-tabs").getByRole("button", { name: "Terminal", exact: true }).click();
  await daemon.waitForRequest("pty_open");

  const terminalHost = page.locator(".pf-terminal-host");
  await expect(terminalHost).toBeVisible();
  await terminalHost.click();
  await page.keyboard.press("Control+F");

  await expect(page.getByRole("search", { name: "Find in agent view" })).toHaveCount(0);
});

test("Terminal ignores stale focus responses before attaching input", async ({ page }) => {
  const daemon = new FakeDaemon();
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: /Browser regression/ }).first().click();
  await page.locator(".pf-agent-tabs").getByRole("button", { name: "Terminal", exact: true }).click();
  await daemon.waitForRequest("pty_open", (request) => request.params.sessionId === "session-browser");
  await expect(page.getByRole("tab", { name: /Terminal 1/ })).toBeVisible();

  await page.getByRole("button", { name: "New terminal" }).click();
  await daemon.waitForRequest("pty_open", (request) => request.params.sessionId === "session-browser");
  await expect(page.getByRole("tab", { name: /Terminal 2/ })).toBeVisible();

  daemon.delayResponse("pty_focus", (request) => request.params.ptyId === "pty-1", 180);
  await page.getByRole("tab", { name: /Terminal 1/ }).click();
  await daemon.waitForRequest("pty_focus", (request) => request.params.ptyId === "pty-1");
  await page.getByRole("tab", { name: /Terminal 2/ }).click();
  await daemon.waitForRequest("pty_focus", (request) => request.params.ptyId === "pty-2");
  await expect(page.getByRole("tab", { name: /Terminal 2/ })).toHaveAttribute("aria-selected", "true");

  await page.waitForTimeout(230);
  await page.locator(".pf-terminal-host").click();
  await page.keyboard.type("x");

  const write = await daemon.waitForRequest("pty_write");
  expect(write.params.ptyId).toBe("pty-2");
});

test("Terminal decodes UTF-8 PTY output", async ({ page }) => {
  const daemon = new FakeDaemon();
  await daemon.install(page);
  await daemon.open(page);

  await page.getByRole("button", { name: /Browser regression/ }).first().click();
  await page.locator(".pf-agent-tabs").getByRole("button", { name: "Terminal", exact: true }).click();
  await daemon.waitForRequest("pty_open", (request) => request.params.sessionId === "session-browser");
  await daemon.waitForRequest("pty_replay");

  daemon.emit("pty:pty-1:data", {
    data: Buffer.from("构建完成\n", "utf8").toString("base64"),
    seq: 1
  });

  await expect(page.locator(".pf-terminal-host")).toContainText("构建完成");
});
