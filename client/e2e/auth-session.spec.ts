import { expect, test } from "@playwright/test";
import { loginIfNeeded } from "./helpers/editor-list-helpers";

test.describe("Session handling on API failures", () => {
  test("401 from client API logs user out to login screen", async ({ page }) => {
    await loginIfNeeded(page);
    await expect(page.locator(".create-fab")).toBeVisible();

    await page.route("**/client-api/notes*", async (route) => {
      await route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "unauthorized" }),
      });
    });

    await page.reload();

    await expect(page.locator(".login-form")).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: "screenshots/playwright-401-logs-out.png", fullPage: true });
  });

  test("server errors keep user logged in", async ({ page }) => {
    await loginIfNeeded(page);
    await expect(page.locator(".create-fab")).toBeVisible();

    await page.route("**/client-api/notes*", async (route) => {
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "boom" }),
      });
    });

    await page.reload();

    await expect(page.locator(".create-fab")).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".login-form")).not.toBeVisible();
    await page.screenshot({
      path: "screenshots/playwright-500-stays-logged-in.png",
      fullPage: true,
    });
  });
});
