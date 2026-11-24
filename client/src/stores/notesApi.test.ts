import { describe, expect, test, vi } from "vite-plus/test";
import {
  apiFetch,
  notePathApi,
  renameNotePathApi,
  shareNotePathApi,
  sharedNotePathApi,
  starNotePathApi,
} from "./notesApi";

test("a non-JSON 401 still expires the session", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 401 }));
  try {
    await expect(apiFetch("/client-api/notes")).rejects.toThrow("UNAUTHORIZED");
  } finally {
    fetch.mockRestore();
  }
});

describe("notes api path helpers", () => {
  test("encodes titles and omits empty collections", () => {
    expect(notePathApi("hello world")).toBe("/client-api/notes/hello%20world");
    expect(renameNotePathApi("hello world")).toBe("/client-api/notes/hello%20world/rename");
    expect(starNotePathApi("hello world")).toBe("/client-api/notes/hello%20world/star");
  });

  test("adds collection and mode query parameters in a stable order", () => {
    expect(shareNotePathApi("plan", "work", "edit")).toBe(
      "/client-api/notes/plan/share?collection=work&mode=edit",
    );
    expect(shareNotePathApi("plan", " work ")).toBe("/client-api/notes/plan/share?collection=work");
  });

  test("encodes share tokens in shared note urls", () => {
    expect(sharedNotePathApi("token/with spaces")).toBe(
      "/client-api/share/token%2Fwith%20spaces/note",
    );
  });
});
