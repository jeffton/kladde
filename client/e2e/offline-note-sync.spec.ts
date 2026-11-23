import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { PendingOp } from "../src/types";
import { loginIfNeeded } from "./helpers/editor-list-helpers";

function readQueue(page: Page): Promise<PendingOp[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("kladde-db:admin");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const rows = await new Promise<(PendingOp & { id: number })[]>((resolve, reject) => {
        const request = database.transaction("ops").objectStore("ops").getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return rows.map(({ id: _id, ...op }) => op);
    } finally {
      database.close();
    }
  });
}

test("queues multiple offline operations and syncs them after an offline reload", async ({
  page,
  context,
}) => {
  await loginIfNeeded(page);
  const suffix = randomUUID();
  const titles = ["star", "delete", "rename"].map((action) => `Offline ${action} ${suffix}`);
  for (const title of titles) {
    const response = await page.request.post("/client-api/notes", {
      data: { title, content: `Body of ${title}` },
    });
    expect(response.ok()).toBe(true);
  }

  const [starred, deleted, renamed] = titles;
  const newTitle = `${renamed} updated`;
  const note = (title: string, tab = page) =>
    tab.locator(".note-item").filter({ has: tab.getByText(title, { exact: true }) });
  const serverNote = (title: string) =>
    page.request.get(`/client-api/notes/${encodeURIComponent(title)}`);

  await page.reload();
  await expect(note(renamed)).toBeVisible();
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
  const secondTab = await context.newPage();
  await secondTab.goto("/");
  await expect(note(renamed, secondTab)).toBeVisible();
  await context.setOffline(true);
  await note(starred).locator(".pin").click();
  const starOp = { type: "star", key: starred, starred: true };
  await expect.poll(() => readQueue(page)).toEqual([starOp]);

  await note(deleted).click();
  await page.locator(".note-menu-button").click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.locator(".note-menu-delete").click();
  await expect(page.locator(".error-overlay")).toBeHidden();
  await expect(note(deleted)).toHaveCount(0);
  const deleteOp = { type: "delete", key: deleted };
  await expect.poll(() => readQueue(page)).toEqual([starOp, deleteOp]);

  await note(renamed, secondTab).click();
  const titleInput = secondTab.locator(".note-title-input");
  await titleInput.fill(newTitle);
  await titleInput.press("Enter");
  const renameOp = { type: "rename", oldKey: renamed, newKey: newTitle };
  await expect.poll(() => readQueue(page)).toEqual([starOp, deleteOp, renameOp]);

  await page.reload();
  await expect(note(newTitle)).toBeVisible();
  await expect(note(deleted)).toHaveCount(0);
  await expect.poll(() => readQueue(page)).toEqual([starOp, deleteOp, renameOp]);

  const mutations: string[] = [];
  context.on("request", (request) => {
    const method = request.method();
    if (request.url().includes("/client-api/notes/") && (method === "PUT" || method === "DELETE")) {
      mutations.push(method);
    }
  });
  await context.setOffline(false);
  await expect.poll(() => readQueue(page)).toEqual([]);
  expect(mutations).toEqual(["PUT", "DELETE", "PUT"]);
  expect((await serverNote(deleted)).status()).toBe(404);
  expect((await serverNote(renamed)).status()).toBe(404);
  expect(await (await serverNote(newTitle)).json()).toMatchObject({
    content: `Body of ${renamed}`,
  });
  expect(await (await serverNote(starred)).json()).toMatchObject({
    starred: true,
    content: `Body of ${starred}`,
  });
});
