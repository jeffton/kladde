import { expect, type Locator, type Page } from "@playwright/test";

export const isMac = process.platform === "darwin";

export type ListKind = "task" | "bullet" | "ordered";

export type ListEntry = {
  text: string;
  kind: ListKind;
  depth: number;
};

export async function loginIfNeeded(page: Page) {
  await page.goto("/", { waitUntil: "networkidle" });
  const loginVisible = await page
    .locator(".login-form")
    .isVisible()
    .catch(() => false);
  if (!loginVisible) return;

  await page.locator(".login-input").nth(0).fill("admin");
  await page.locator(".login-input").nth(1).fill("testpass123");
  await page.locator(".login-button").click();
}

export async function createNote(page: Page, titlePrefix: string) {
  await page.locator(".create-fab").click();
  await page.locator(".note-title-input").fill(`${titlePrefix}-${Date.now()}`);
  await page.locator(".note-title-input").press("Enter");
}

export function editor(page: Page): Locator {
  return page.locator(".tiptap-root .ProseMirror");
}

export function topToolbar(page: Page): Locator {
  return page.locator(".editor-toolbar .toolbar-row").first().locator("button");
}

export function secondaryToolbar(page: Page): Locator {
  return page.locator(".editor-toolbar .toolbar-row-secondary").first().locator("button");
}

export async function clickListButton(page: Page, kind: ListKind) {
  const bar = topToolbar(page);
  const index = kind === "bullet" ? 3 : kind === "ordered" ? 4 : 5;
  await bar.nth(index).click();
}

export async function selectAll(page: Page) {
  await page.keyboard.press(isMac ? "Meta+A" : "Control+A");
}

export async function typeBaseLines(page: Page) {
  const ed = editor(page);
  await ed.click();
  await selectAll(page);
  await page.keyboard.press("Backspace");
  await page.keyboard.type("alpha");
  await page.keyboard.press("Enter");
  await page.keyboard.type("beta");
  await page.keyboard.press("Enter");
  await page.keyboard.type("gamma");
}

export async function listEntries(page: Page): Promise<ListEntry[]> {
  const entries = await editor(page).evaluate((root) => {
    const values: Array<{ text: string; kind: "task" | "bullet" | "ordered"; depth: number }> = [];
    const listItems = Array.from(root.querySelectorAll("li"));

    for (const li of listItems) {
      const list = li.parentElement;
      if (!list || (list.tagName !== "UL" && list.tagName !== "OL")) continue;

      const kind =
        list.tagName === "OL"
          ? "ordered"
          : list.getAttribute("data-type") === "taskList"
            ? "task"
            : "bullet";

      const text =
        kind === "task"
          ? (li.querySelector(":scope > div > p")?.textContent || "").trim()
          : (li.querySelector(":scope > p")?.textContent || "").trim();

      if (!text) continue;

      let depth = 1;
      let parent: HTMLElement | null = list.parentElement;
      while (parent) {
        if (parent.tagName === "UL" || parent.tagName === "OL") depth += 1;
        parent = parent.parentElement;
      }

      values.push({ text, kind, depth });
    }

    return values;
  });

  return entries.sort((a, b) => a.text.localeCompare(b.text));
}

export function expectEntry(
  entries: ListEntry[],
  expected: { text: string; kind: ListKind; depth: number },
) {
  expect(
    entries.some(
      (entry) =>
        entry.kind === expected.kind &&
        entry.depth === expected.depth &&
        entry.text.includes(expected.text),
    ),
  ).toBeTruthy();
}

export async function expectEditorHasFocus(page: Page) {
  const focused = await editor(page).evaluate((root) => {
    const active = document.activeElement;
    return active === root || (active instanceof Node && root.contains(active));
  });

  expect(focused).toBeTruthy();
}
