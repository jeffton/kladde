import { expect, test, type Route } from "@playwright/test";
import { loginIfNeeded } from "./helpers/editor-list-helpers";

test.describe("Mobile note opening on poor network", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("opens the editor immediately while the note fetch is still pending", async ({ page }) => {
    await loginIfNeeded(page);
    await expect(page.locator(".create-fab")).toBeVisible();

    const title = `mobile-bad-net-${Date.now()}`;

    await page.locator(".create-fab").click();
    await expect(page.locator(".note-title-input")).toBeVisible();
    await page.locator(".note-title-input").fill(title);
    await page.locator(".note-title-input").press("Enter");

    await expect(page.locator(".mobile-title-back")).toBeVisible();
    await expect(page.locator(".note-title-input")).toHaveValue(title);

    await page.locator(".mobile-title-back").click();
    const noteItem = page.locator(".note-item").filter({ hasText: title }).first();
    await expect(noteItem).toBeVisible();

    const notePath = `**/client-api/notes/${encodeURIComponent(title)}*`;
    let releaseFetch: () => void = () => {};
    const releaseFetchPromise = new Promise<void>((resolve) => {
      releaseFetch = () => {
        resolve();
      };
    });

    const routeHandler = async (route: Route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }

      await releaseFetchPromise;
      await route.continue().catch(() => undefined);
    };

    await page.route(notePath, routeHandler);

    await noteItem.click();

    await expect(page).toHaveURL(new RegExp(`/note/${title}$`));
    await expect(page.locator(".mobile-title-back")).toBeVisible({ timeout: 1000 });
    await expect(page.locator(".note-title-input")).toHaveValue(title, { timeout: 1000 });

    releaseFetch();
    await page.unroute(notePath, routeHandler);
  });
});
