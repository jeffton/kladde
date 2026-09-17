import { expect, test } from "@playwright/test";
import { loginIfNeeded } from "./helpers/editor-list-helpers";

test("copies the current note as semantic HTML with a Markdown fallback", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://127.0.0.1:8080",
  });
  await loginIfNeeded(page);

  const title = `Copy as HTML ${Date.now()}`;
  const markdown = "# Heading\n\nParagraph with **bold** and [a link](https://example.com).";
  const created = await page.evaluate(
    async ({ title, markdown }) => {
      const response = await fetch("/client-api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content: markdown, collection: "" }),
      });
      return response.ok;
    },
    { title, markdown },
  );
  expect(created).toBe(true);

  await page.reload();
  await page.getByText(title, { exact: true }).click();
  await page.locator(".note-menu-button").click();
  await page.getByRole("menuitem", { name: "Copy as HTML" }).click();

  const clipboard = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    const [htmlBlob, plainBlob] = await Promise.all([
      item.getType("text/html"),
      item.getType("text/plain"),
    ]);
    const [html, plain] = await Promise.all([htmlBlob.text(), plainBlob.text()]);
    return { types: item.types, html, plain };
  });

  expect(clipboard.types).toEqual(expect.arrayContaining(["text/html", "text/plain"]));
  expect(clipboard.html).toContain("<h1>Heading</h1>");
  expect(clipboard.html).toContain("<strong>bold</strong>");
  expect(clipboard.html).toContain('href="https://example.com/"');
  expect(clipboard.html).not.toContain("style=");
  expect(clipboard.plain).toBe(markdown);
});
