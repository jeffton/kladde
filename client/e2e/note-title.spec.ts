import { expect, test } from "@playwright/test";

test("note title blocks typed and pasted slashes and persists the filename title", async ({
  page,
  context,
}) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.locator(".login-input").nth(0).fill("admin");
  await page.locator(".login-input").nth(1).fill("testpass123");
  await page.locator(".login-button").click();
  await page.locator(".create-fab").click();

  const title = page.locator(".note-title-input");
  await expect(title).toBeVisible();
  await title.fill("Plan");
  await title.press("End");
  await title.press("/");
  await expect(title).toHaveValue("Plan");

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("/idéer/"));
  await title.press("ControlOrMeta+V");
  await expect(title).toHaveValue("Planidéer");

  // Input-event sanitation also covers insertion methods that bypass beforeinput.
  await title.fill("/Plan/idéer/");
  await expect(title).toHaveValue("Planidéer");
  await title.press("Enter");
  // A new note can be created under its final title without a rename request.
  await expect
    .poll(async () => {
      const response = await page.request.get(
        `/client-api/notes/${encodeURIComponent("Planidéer")}`,
      );
      return response.status();
    })
    .toBe(200);

  await page.reload();
  await page.locator(".note-item").filter({ hasText: "Planidéer" }).click();
  await expect(title).toHaveValue("Planidéer");
});
