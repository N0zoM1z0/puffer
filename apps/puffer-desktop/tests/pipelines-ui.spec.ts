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
