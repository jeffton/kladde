import { expect, test } from "@playwright/test";

test("note menu uses available viewport height before collections scroll", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(".login-input").nth(0).fill("admin");
  await page.locator(".login-input").nth(1).fill("testpass123");
  await page.locator(".login-button").click();
  await expect(page.locator(".create-fab")).toBeVisible();

  await page.evaluate(async () => {
    for (let index = 1; index <= 12; index += 1) {
      const response = await fetch("/client-api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: `Menu layout ${index}`,
          collection: `Collection ${String(index).padStart(2, "0")}`,
          content: "",
        }),
      });

      if (!response.ok) throw new Error(`Could not create fixture note: ${response.status}`);
    }
  });

  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".note-item").first().click();
  await page.locator(".note-menu-button").click();

  const dropdown = page.locator(".note-menu-dropdown");
  const collections = page.locator(".note-menu-collections");
  await expect(dropdown).toBeVisible();

  const spaciousLayout = await collections.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(spaciousLayout.clientHeight).toBeGreaterThan(220);
  expect(spaciousLayout.scrollHeight).toBe(spaciousLayout.clientHeight);

  await page.setViewportSize({ width: 1280, height: 720 });

  await expect
    .poll(async () =>
      collections.evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true);

  const constrainedLayout = await dropdown.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      bottom: bounds.bottom,
      viewportHeight: window.innerHeight,
      outerScrolls: element.scrollHeight > element.clientHeight,
    };
  });
  const constrainedCollectionsHeight = await collections.evaluate(
    (element) => element.clientHeight,
  );

  expect(constrainedLayout.bottom).toBeLessThanOrEqual(constrainedLayout.viewportHeight - 11);
  expect(constrainedLayout.outerScrolls).toBe(false);
  expect(constrainedCollectionsHeight).toBeGreaterThan(220);

  await page.screenshot({ path: "screenshots/playwright-note-menu-layout.png", fullPage: true });
});
