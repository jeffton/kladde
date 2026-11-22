import { expect, test } from "@playwright/test";
import { editor, loginIfNeeded } from "./helpers/editor-list-helpers";

test("shows and copies readable Markdown without altering a note on open", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await loginIfNeeded(page);
  const title = `Markdown entities ${Date.now()}`;
  const original = "- [ ] a &gt; b &amp; c &lt; d\n\nLiteral: `&gt;` and &amp;gt;";
  const readable = "- [ ] a > b & c < d\n\nLiteral: `&gt;` and &amp;gt;";
  const created = await page.evaluate(
    async ({ title, content }) => {
      const response = await fetch("/client-api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content, collection: "" }),
      });
      return response.ok;
    },
    { title, content: original },
  );
  expect(created).toBe(true);

  await page.reload();
  await page.getByText(title, { exact: true }).click();
  await expect(editor(page).locator("li")).toHaveText("a > b & c < d");
  const toggle = page.getByTitle("Toggle between markdown and WYSIWYG");
  await toggle.click();
  const source = page.locator(".plain-wrap textarea");
  await expect(source).toHaveValue(readable);
  await page.locator(".note-menu-button").click();
  await page.getByRole("menuitem", { name: "Copy as Markdown" }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(readable);

  await toggle.click();
  await expect(editor(page).locator("li")).toHaveText("a > b & c < d");
  await expect(editor(page).locator("code")).toHaveText("&gt;");

  const saved = await page.evaluate(async (title) => {
    const response = await fetch(`/client-api/notes/${encodeURIComponent(title)}`);
    return (await response.json()).content;
  }, title);
  expect(saved).toBe(original);

  await editor(page).locator("li p").click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(" > e");
  await expect(editor(page).locator("li")).toHaveText("a > b & c < d > e");
  await toggle.click();
  await expect(source).toHaveValue(readable.replace("d\n", "d > e\n"));
  await toggle.click();
  await expect(editor(page).locator("li")).toHaveText("a > b & c < d > e");
});
