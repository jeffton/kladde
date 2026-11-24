import { expect, it, vi } from "vite-plus/test";
import { useMarkdownSource } from "./useMarkdownSource";

it("reports rejected Markdown saves from typing and the toolbar and keeps the edit available", async () => {
  const typingError = new Error("Typing save failed");
  const toolbarError = new Error("Toolbar save failed");
  const saveContent = vi
    .fn<(value: string) => Promise<void>>()
    .mockRejectedValueOnce(typingError)
    .mockRejectedValueOnce(toolbarError);
  const onSaveError = vi.fn();
  const source = useMarkdownSource(saveContent, onSaveError, () => false);
  const textarea = {
    value: "draft",
    selectionStart: 0,
    selectionEnd: 5,
    focus: vi.fn(),
    setSelectionRange: vi.fn(),
  };
  source.plainTextarea.value = textarea as unknown as HTMLTextAreaElement;

  const input = new Event("input");
  Object.defineProperty(input, "target", { value: textarea });
  source.onPlainInput(input);
  await vi.waitFor(() => expect(onSaveError).toHaveBeenNthCalledWith(1, typingError));

  source.applyPlainAction("bold");
  await vi.waitFor(() => expect(onSaveError).toHaveBeenNthCalledWith(2, toolbarError));
  expect(saveContent.mock.calls).toEqual([["draft"], ["**draft**"]]);
  expect(textarea.value).toBe("**draft**");
  expect(source.plainInput.value).toBe("**draft**");
  expect(textarea.setSelectionRange).toHaveBeenCalledWith(2, 7);
});
