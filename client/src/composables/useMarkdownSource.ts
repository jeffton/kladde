import { nextTick, ref } from "vue";
import { t } from "../i18n";

export function useMarkdownSource(
  saveContent: (value: string) => Promise<unknown>,
  onSaveError: (error: unknown) => void,
  isReadonly: () => boolean,
) {
  const plainInput = ref<string | null>(null);
  const plainTextarea = ref<HTMLTextAreaElement | null>(null);

  async function updatePlainText(nextValue: string, selectionStart: number, selectionEnd: number) {
    const textarea = plainTextarea.value;
    if (!textarea) return;

    textarea.value = nextValue;
    plainInput.value = nextValue;
    await saveContent(nextValue);

    await nextTick();
    if (plainTextarea.value) {
      plainTextarea.value.focus();
      plainTextarea.value.setSelectionRange(selectionStart, selectionEnd);
    }
  }

  function wrapSelection(prefix: string, suffix = prefix, placeholder = "") {
    const textarea = plainTextarea.value;
    if (!textarea) return;

    const { value } = textarea;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = value.slice(start, end);
    const middle = selected || placeholder;
    const replacement = `${prefix}${middle}${suffix}`;
    const nextValue = value.slice(0, start) + replacement + value.slice(end);

    const selectFrom = start + prefix.length;
    const selectTo = start + prefix.length + middle.length;
    void updatePlainText(nextValue, selectFrom, selectTo);
  }

  function prefixLines(prefix: string) {
    const textarea = plainTextarea.value;
    if (!textarea) return;

    const { value } = textarea;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    const blockStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const blockEndIndex = value.indexOf("\n", end);
    const blockEnd = blockEndIndex === -1 ? value.length : blockEndIndex;

    const block = value.slice(blockStart, blockEnd);
    const lines = block.split("\n");
    const prefixed = lines.map((line) => `${prefix}${line}`).join("\n");
    const nextValue = value.slice(0, blockStart) + prefixed + value.slice(blockEnd);

    const shiftAtStart = start - blockStart >= 0 ? prefix.length : 0;
    const addedChars = prefix.length * lines.length;

    void updatePlainText(nextValue, start + shiftAtStart, end + addedChars);
  }

  function unprefixLines(prefix: string) {
    const textarea = plainTextarea.value;
    if (!textarea) return;

    const { value } = textarea;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;

    const blockStart = value.lastIndexOf("\n", Math.max(0, start - 1)) + 1;
    const blockEndIndex = value.indexOf("\n", end);
    const blockEnd = blockEndIndex === -1 ? value.length : blockEndIndex;

    const block = value.slice(blockStart, blockEnd);
    const lines = block.split("\n");

    let removedBeforeStart = 0;
    let removedBeforeEnd = 0;

    const unprefixed = lines
      .map((line, index) => {
        const hadPrefix = line.startsWith(prefix);
        if (!hadPrefix) return line;

        if (index === 0) removedBeforeStart = prefix.length;
        removedBeforeEnd += prefix.length;
        return line.slice(prefix.length);
      })
      .join("\n");

    const nextValue = value.slice(0, blockStart) + unprefixed + value.slice(blockEnd);
    const nextStart = Math.max(blockStart, start - removedBeforeStart);
    const nextEnd = Math.max(nextStart, end - removedBeforeEnd);

    void updatePlainText(nextValue, nextStart, nextEnd);
  }

  function insertHr() {
    const textarea = plainTextarea.value;
    if (!textarea) return;

    const { value } = textarea;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const before = value.slice(0, start);
    const after = value.slice(end);

    const pre = before.length && !before.endsWith("\n") ? "\n" : "";
    const post = after.length && !after.startsWith("\n") ? "\n" : "";
    const insert = `${pre}---${post}`;

    const nextValue = before + insert + after;
    const cursor = before.length + insert.length;
    void updatePlainText(nextValue, cursor, cursor);
  }

  function applyPlainLink() {
    const textarea = plainTextarea.value;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.slice(start, end) || t("linkTextPlaceholder");
    const href = window.prompt(t("insertLinkPrompt"), "https://");
    if (href === null) return;

    const replacement = `[${selected}](${href || t("linkUrlFallback")})`;
    const nextValue = textarea.value.slice(0, start) + replacement + textarea.value.slice(end);
    const textStart = start + 1;
    const textEnd = textStart + selected.length;
    void updatePlainText(nextValue, textStart, textEnd);
  }

  const actions: ReadonlyMap<string, () => void> = new Map([
    ["bold", () => wrapSelection("**")],
    ["italic", () => wrapSelection("*")],
    ["strike", () => wrapSelection("~~")],
    ["h1", () => prefixLines("# ")],
    ["h2", () => prefixLines("## ")],
    ["h3", () => prefixLines("### ")],
    ["bullet", () => prefixLines("- ")],
    ["ordered", () => prefixLines("1. ")],
    ["task", () => prefixLines("- [ ] ")],
    ["link", applyPlainLink],
    ["code", () => wrapSelection("`")],
    ["codeBlock", () => wrapSelection("```\n", "\n```")],
    ["blockquote", () => prefixLines("> ")],
    ["indent", () => prefixLines("  ")],
    ["outdent", () => unprefixLines("  ")],
    ["hr", insertHr],
  ]);

  function applyPlainAction(action: string) {
    actions.get(action)?.();
  }

  function onPlainInput(event: Event) {
    if (isReadonly()) return;

    const value = (event.target as HTMLTextAreaElement).value;
    plainInput.value = value;
    void saveContent(value).catch(onSaveError);
  }

  return { plainInput, plainTextarea, applyPlainAction, onPlainInput };
}
