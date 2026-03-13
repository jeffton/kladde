<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { EditorContent, useEditor } from "@tiptap/vue-3";
import type { Editor as TiptapEditor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import TaskList from "@tiptap/extension-task-list";
import TaskItem from "@tiptap/extension-task-item";
import Link from "@tiptap/extension-link";
import CodeBlock from "@tiptap/extension-code-block";
import Strike from "@tiptap/extension-strike";
import Paragraph from "@tiptap/extension-paragraph";
import Table from "@tiptap/extension-table";
import TableRow from "@tiptap/extension-table-row";
import TableHeader from "@tiptap/extension-table-header";
import TableCell from "@tiptap/extension-table-cell";
import { Markdown } from "tiptap-markdown";
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ClipboardCheck,
  CloudCheck,
  CloudOff,
  Copy,
  FileText,
  FolderPlus,
  MoreVertical,
  RefreshCw,
  Share2,
  Trash2,
  X,
} from "lucide-vue-next";
import EditorToolbar from "./EditorToolbar.vue";
import { apiFetch, shareNotePathApi } from "../stores/notesApi";
import type { AppMode, EditorStoreLike, ShareLinksResponse, ShareMode } from "../types";
import { intlLocale, t } from "../i18n";

interface Props {
  store: EditorStoreLike;
  showBack?: boolean;
  mode?: AppMode;
}

const props = withDefaults(defineProps<Props>(), {
  showBack: false,
  mode: "full",
});

const emit = defineEmits<{
  (e: "rename", key: string): void;
  (e: "back"): void;
  (e: "deleted"): void;
  (e: "ui-error", message: string): void;
}>();

const isFullMode = computed(() => props.mode === "full");
const isReadonlyMode = computed(() => props.mode === "share-readonly");

const editableTitle = ref("");
const titleInput = ref<HTMLInputElement | null>(null);
const showPlain = ref(false);
const plainTextarea = ref<HTMLTextAreaElement | null>(null);
const plainWrap = ref<HTMLElement | null>(null);
const wysiwygWrap = ref<HTMLElement | null>(null);
let ignoreEditorChanges = false;

// Preserve empty paragraphs through markdown round-trip.
// ProseMirror's default serializer drops empty paragraphs.
// We serialize them as \u00A0 (nbsp), then strip on save.
const NBSP = "\u00A0";

interface MarkdownSerializerState {
  write: (content: string) => void;
  closeBlock: (node: unknown) => void;
  renderInline: (node: unknown) => void;
}

interface ProseMirrorNodeLike {
  content: { size: number };
}

// Custom paragraph extension that serializes empty paragraphs as nbsp
const PreservingParagraph = Paragraph.extend({
  addStorage() {
    const parentStorage = this.parent?.() || {};
    const parentMarkdown = parentStorage.markdown || {};

    return {
      ...parentStorage,
      markdown: {
        ...parentMarkdown,
        serialize(state: MarkdownSerializerState, node: ProseMirrorNodeLike) {
          if (node.content.size === 0) {
            state.write(NBSP);
            state.closeBlock(node);
            return;
          }
          state.renderInline(node);
          state.closeBlock(node);
        },
      },
    };
  },
});

// Task item extension without forced focus on checkbox toggle.
// The upstream extension calls chain().focus() on change, which triggers
// virtual keyboard popup on touch devices when editor is currently blurred.
const FocusSafeTaskItem = TaskItem.extend({
  addNodeView() {
    return ({ node, HTMLAttributes, getPos, editor }) => {
      const listItem = document.createElement("li");
      const checkboxWrapper = document.createElement("label");
      const checkboxStyler = document.createElement("span");
      const checkbox = document.createElement("input");
      const content = document.createElement("div");

      const updateA11Y = () => {
        checkbox.ariaLabel =
          this.options.a11y?.checkboxLabel?.(node, checkbox.checked) ||
          `Task item checkbox for ${node.textContent || "empty task item"}`;
      };

      updateA11Y();

      checkboxWrapper.contentEditable = "false";
      checkbox.type = "checkbox";
      checkbox.addEventListener("mousedown", (event) => event.preventDefault());
      checkbox.addEventListener("change", (event) => {
        if (!editor.isEditable && !this.options.onReadOnlyChecked) {
          checkbox.checked = !checkbox.checked;
          return;
        }

        const { checked } = event.target as HTMLInputElement;

        if (editor.isEditable && typeof getPos === "function") {
          editor
            .chain()
            .command(({ tr }) => {
              const position = getPos();

              if (typeof position !== "number") {
                return false;
              }

              const currentNode = tr.doc.nodeAt(position);

              tr.setNodeMarkup(position, undefined, {
                ...currentNode?.attrs,
                checked,
              });

              return true;
            })
            .run();
        }

        if (!editor.isEditable && this.options.onReadOnlyChecked) {
          if (!this.options.onReadOnlyChecked(node, checked)) {
            checkbox.checked = !checkbox.checked;
          }
        }
      });

      Object.entries(this.options.HTMLAttributes).forEach(([key, value]) => {
        listItem.setAttribute(key, value);
      });

      listItem.dataset.checked = String(node.attrs.checked);
      checkbox.checked = Boolean(node.attrs.checked);

      checkboxWrapper.append(checkbox, checkboxStyler);
      listItem.append(checkboxWrapper, content);

      Object.entries(HTMLAttributes).forEach(([key, value]) => {
        listItem.setAttribute(key, value);
      });

      return {
        dom: listItem,
        contentDOM: content,
        update: (updatedNode) => {
          if (updatedNode.type !== this.type) {
            return false;
          }

          listItem.dataset.checked = String(updatedNode.attrs.checked);
          checkbox.checked = Boolean(updatedNode.attrs.checked);
          updateA11Y();

          return true;
        },
      };
    };
  },
});

const showTooltip = ref(false);
const isTouchLike = ref(false);
const showNoteMenu = ref(false);
const showShareDialog = ref(false);
const shareLinks = ref<ShareLinksResponse>({
  view: { enabled: false },
  edit: { enabled: false },
});
const shareBusyMode = ref<ShareMode | "">("");
const shareCopyMode = ref<ShareMode | "">("");
const menuCopyFeedback = ref<"markdown" | "path" | "">("");
const shareLoading = ref(false);
const lastSyncTime = ref("");
const noteMenuWrap = ref<HTMLElement | null>(null);
const availableCollections = computed(() => props.store.collections);
const selectedCollection = computed(() => props.store.selectedCollection || "");
let shouldBlurAfterTaskCheckboxTap = false;
let menuCopyFeedbackTimeout: ReturnType<typeof setTimeout> | null = null;

function isSameDay(a: Date, b: Date) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

const locale = intlLocale;

function isTouchDevice(): boolean {
  if (typeof window === "undefined" || typeof navigator === "undefined") return false;

  return (
    navigator.maxTouchPoints > 0 || window.matchMedia("(hover: none), (pointer: coarse)").matches
  );
}

const touchDevice = isTouchDevice();

function isTaskCheckboxTarget(target: EventTarget | null): target is HTMLInputElement {
  if (!(target instanceof HTMLInputElement)) return false;
  if (target.type !== "checkbox") return false;
  return Boolean(target.closest("ul[data-type='taskList'] li input[type='checkbox']"));
}

function handleTaskCheckboxPointerStart(event: Event): boolean {
  if (!touchDevice) return false;
  if (!isTaskCheckboxTarget(event.target)) {
    shouldBlurAfterTaskCheckboxTap = false;
    return false;
  }

  shouldBlurAfterTaskCheckboxTap = !editor.value?.isFocused;
  event.preventDefault();
  return true;
}

function handleTaskCheckboxClick(event: Event): boolean {
  if (!touchDevice) return false;
  if (!isTaskCheckboxTarget(event.target)) return false;

  if (shouldBlurAfterTaskCheckboxTap) {
    requestAnimationFrame(() => {
      editor.value?.commands.blur();
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body) active.blur();
    });
  }

  shouldBlurAfterTaskCheckboxTap = false;
  return false;
}

function selectionTouchesListItems(tiptap: TiptapEditor): boolean {
  const { selection, doc } = tiptap.state;

  const inListItemAt = ($pos: typeof selection.$from): boolean => {
    for (let depth = $pos.depth; depth >= 0; depth--) {
      const node = $pos.node(depth);
      if (node.type.name === "taskItem" || node.type.name === "listItem") return true;
    }
    return false;
  };

  if (inListItemAt(selection.$from) || inListItemAt(selection.$to)) return true;
  if (selection.empty) return false;

  let hasListItems = false;
  doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.type.name !== "taskItem" && node.type.name !== "listItem") return;
    hasListItems = true;
    return false;
  });

  return hasListItems;
}

function adjustListItemIndent(tiptap: TiptapEditor, outdent: boolean): boolean {
  if (outdent) {
    if (tiptap.chain().focus().liftListItem("taskItem").run()) return true;
    return tiptap.chain().focus().liftListItem("listItem").run();
  }

  if (tiptap.chain().focus().sinkListItem("taskItem").run()) return true;
  return tiptap.chain().focus().sinkListItem("listItem").run();
}

function syncEditorSelectionFromDom(tiptap: TiptapEditor) {
  const domSelection = window.getSelection();
  if (!domSelection?.anchorNode || !domSelection.focusNode) return;

  const root = tiptap.view.dom as HTMLElement;
  if (!root.contains(domSelection.anchorNode) || !root.contains(domSelection.focusNode)) return;

  try {
    const anchor = tiptap.view.posAtDOM(domSelection.anchorNode, domSelection.anchorOffset);
    const head = tiptap.view.posAtDOM(domSelection.focusNode, domSelection.focusOffset);
    tiptap.commands.setTextSelection({
      from: Math.min(anchor, head),
      to: Math.max(anchor, head),
    });
  } catch {
    // Ignore unresolvable DOM selection nodes.
  }
}

function handleGlobalTabKeyDown(event: KeyboardEvent) {
  if (event.key !== "Tab") return;
  if (!editor.value) return;

  const root = editor.value.view.dom as HTMLElement;
  const active = document.activeElement as HTMLElement | null;
  const inEditor = active === root || (active != null && root.contains(active));
  if (!inEditor) return;

  syncEditorSelectionFromDom(editor.value);
  if (!selectionTouchesListItems(editor.value)) return;

  event.preventDefault();
  adjustListItemIndent(editor.value, event.shiftKey);
}

function firstDayOfWeek(): number {
  try {
    const localeInfo = new Intl.Locale(locale) as Intl.Locale & {
      weekInfo?: { firstDay?: number };
    };
    const first = localeInfo.weekInfo?.firstDay;
    if (typeof first === "number") {
      // Intl.Locale uses 1..7 (Mon..Sun). Date.getDay uses 0..6 (Sun..Sat).
      return first % 7;
    }
  } catch {
    // Fallback below
  }

  return locale.toLowerCase().startsWith("en-us") ? 0 : 1;
}

function startOfWeek(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  const day = copy.getDay();
  const weekStartsOn = firstDayOfWeek();
  const diff = (day - weekStartsOn + 7) % 7;
  copy.setDate(copy.getDate() - diff);
  return copy;
}

function fmtTime(date: Date) {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatUpdatedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  const time = fmtTime(date);
  if (isSameDay(date, now)) return time;

  if (date >= startOfWeek(now)) {
    const weekday = new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date);
    return `${weekday}, ${time}`;
  }

  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

const statusMeta = computed(() => {
  const syncState = props.store.syncState;
  const modifiedRaw =
    props.store.currentUpdatedAt ||
    props.store.notes.find((n) => n.key === props.store.selectedKey)?.updatedAt ||
    "";
  const modifiedText = modifiedRaw ? formatUpdatedAt(modifiedRaw) : "";
  const modifiedLine = modifiedText ? `${t("modified")} ${modifiedText}` : "";

  const lines: string[] = [];

  if (isReadonlyMode.value) {
    if (modifiedLine) lines.push(modifiedLine);
    lines.push(t("shareReadonly"));
    return { state: "synced" as const, lines };
  }

  if (syncState === "offline") {
    lines.push(t("offline"));
    if (modifiedLine) lines.push(modifiedLine);
    lines.push(
      lastSyncTime.value ? `${t("synced")} ${lastSyncTime.value}` : t("changesSavedLocally"),
    );
    return { state: "offline" as const, lines };
  }

  if (syncState === "syncing") {
    if (modifiedLine) lines.push(modifiedLine);
    lines.push(props.store.syncStatus || t("syncingChanges"));
    return { state: "syncing" as const, lines };
  }

  if (syncState === "error") {
    if (modifiedLine) lines.push(modifiedLine);
    lines.push(props.store.syncStatus || t("syncError"));
    lines.push(
      lastSyncTime.value ? `${t("synced")} ${lastSyncTime.value}` : t("noSuccessfulSyncYet"),
    );
    return { state: "error" as const, lines };
  }

  const syncedAt = lastSyncTime.value ? ` ${lastSyncTime.value}` : "";
  if (modifiedLine) lines.push(modifiedLine);
  lines.push(`${t("synced")}${syncedAt}`);
  return { state: "synced" as const, lines };
});

const statusAriaLabel = computed(() => statusMeta.value.lines.join(", "));

const editor = useEditor({
  extensions: [
    StarterKit.configure({ strike: false, codeBlock: false, paragraph: false }),
    PreservingParagraph,
    Strike,
    CodeBlock,
    TaskList,
    FocusSafeTaskItem.configure({ nested: true }),
    Table.configure({ resizable: false }),
    TableRow,
    TableHeader,
    TableCell,
    Link.configure({
      autolink: true,
      openOnClick: true,
      linkOnPaste: true,
      HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank" },
    }),
    Markdown.configure({ html: false, transformCopiedText: true, transformPastedText: true }),
  ],
  editorProps: {
    clipboardTextSerializer: (slice) => {
      const defaultText = slice.content.textBetween(0, slice.content.size, "\n\n");
      return defaultText.replace(new RegExp(NBSP, "g"), "");
    },
    handleDOMEvents: {
      pointerdown: (_view, event) => handleTaskCheckboxPointerStart(event),
      touchstart: (_view, event) => handleTaskCheckboxPointerStart(event),
      mousedown: (_view, event) => handleTaskCheckboxPointerStart(event),
      click: (_view, event) => handleTaskCheckboxClick(event),
    },
  },
  editable: !isReadonlyMode.value,
  content: props.store.currentContent || "",
  onUpdate: ({ editor: tiptapEditor }) => {
    if (ignoreEditorChanges) return;

    const nextMarkdown = tiptapEditor.storage.markdown.getMarkdown();
    if (nextMarkdown === props.store.currentContent) return;

    void props.store.setCurrentContent(nextMarkdown).catch((err: unknown) => {
      emit("ui-error", (err as Error)?.message || t("couldNotSaveLocally"));
    });
  },
});

function setEditorMarkdown(markdown = "") {
  if (!editor.value) return;

  const wasFocused = editor.value.isFocused;
  const previousSelection = {
    from: editor.value.state.selection.from,
    to: editor.value.state.selection.to,
  };

  ignoreEditorChanges = true;
  editor.value.commands.setContent(markdown || "", false);

  const docMax = Math.max(1, editor.value.state.doc.content.size);
  const from = Math.min(Math.max(previousSelection.from, 1), docMax);
  const to = Math.min(Math.max(previousSelection.to, 1), docMax);

  editor.value.commands.setTextSelection({ from: Math.min(from, to), to: Math.max(from, to) });
  if (wasFocused) {
    editor.value.commands.focus();
  }
  ignoreEditorChanges = false;
}

function syncEditorFromStore() {
  if (!editor.value || showPlain.value) return;
  const current = editor.value.storage.markdown.getMarkdown();
  if (current === props.store.currentContent) return;
  setEditorMarkdown(props.store.currentContent);
}

async function updatePlainText(nextValue: string, selectionStart: number, selectionEnd: number) {
  const textarea = plainTextarea.value;
  if (!textarea) return;

  textarea.value = nextValue;
  await props.store.setCurrentContent(nextValue);

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

function applyPlainAction(action: string) {
  switch (action) {
    case "bold":
      wrapSelection("**");
      break;
    case "italic":
      wrapSelection("*");
      break;
    case "strike":
      wrapSelection("~~");
      break;
    case "h1":
      prefixLines("# ");
      break;
    case "h2":
      prefixLines("## ");
      break;
    case "h3":
      prefixLines("### ");
      break;
    case "bullet":
      prefixLines("- ");
      break;
    case "ordered":
      prefixLines("1. ");
      break;
    case "task":
      prefixLines("- [ ] ");
      break;
    case "link":
      applyPlainLink();
      break;
    case "code":
      wrapSelection("`");
      break;
    case "codeBlock":
      wrapSelection("```\n", "\n```");
      break;
    case "blockquote":
      prefixLines("> ");
      break;
    case "indent":
      prefixLines("  ");
      break;
    case "outdent":
      unprefixLines("  ");
      break;
    case "hr":
      insertHr();
      break;
  }
}

function onPlainInput(event: Event) {
  if (isReadonlyMode.value) return;

  const value = (event.target as HTMLTextAreaElement).value;
  void props.store.setCurrentContent(value).catch((err: unknown) => {
    emit("ui-error", (err as Error)?.message || t("couldNotSaveLocally"));
  });
}

async function commitTitleChange() {
  if (!isFullMode.value || !props.store.selectedKey) return;
  const next = editableTitle.value.trim();

  if (!next) {
    editableTitle.value = props.store.selectedTitle;
    return;
  }

  try {
    const renamedKey = await props.store.renameCurrent(next);
    editableTitle.value = props.store.selectedTitle;
    emit("rename", renamedKey);
  } catch (e) {
    emit("ui-error", (e as Error).message || t("genericError"));
    editableTitle.value = props.store.selectedTitle;
  }
}

function toggleNoteMenu() {
  if (!isFullMode.value) return;
  showNoteMenu.value = !showNoteMenu.value;
}

function isValidCollectionName(value: string): boolean {
  if (!value) return false;
  if (value.includes("/") || value.includes("\\") || value.includes("..")) return false;
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 32 || code === 127) return false;
  }
  return true;
}

async function moveCurrentToCollection(collection: string) {
  if (!isFullMode.value || !props.store.selectedKey) return;

  const targetCollection = selectedCollection.value === collection ? "" : collection;

  try {
    const renamedKey = await props.store.moveCurrentToCollection(targetCollection);
    showNoteMenu.value = false;
    emit("rename", renamedKey);
  } catch (e) {
    emit("ui-error", (e as Error).message || t("genericError"));
  }
}

async function createCollectionAndMove() {
  if (!isFullMode.value || !props.store.selectedKey) return;

  const candidate = window.prompt(t("newCollectionPrompt"));
  if (candidate === null) return;

  const nextCollection = candidate.trim();
  if (!isValidCollectionName(nextCollection)) {
    emit("ui-error", t("invalidCollectionName"));
    return;
  }

  await moveCurrentToCollection(nextCollection);
}

async function loadShareLinks() {
  if (!isFullMode.value || !props.store.selectedTitle) return;
  shareLoading.value = true;

  try {
    const response = await apiFetch(
      shareNotePathApi(props.store.selectedTitle, props.store.selectedCollection),
    );
    shareLinks.value = (await response.json()) as ShareLinksResponse;
  } catch (err) {
    emit("ui-error", (err as Error).message || t("genericError"));
  } finally {
    shareLoading.value = false;
  }
}

function openShareDialog() {
  if (!isFullMode.value) return;
  showNoteMenu.value = false;
  showShareDialog.value = true;
  shareCopyMode.value = "";
  void loadShareLinks();
}

function closeShareDialog() {
  showShareDialog.value = false;
  shareBusyMode.value = "";
  shareCopyMode.value = "";
}

async function toggleShareLink(mode: ShareMode) {
  if (!isFullMode.value || !props.store.selectedTitle) return;
  if (shareBusyMode.value) return;

  shareBusyMode.value = mode;
  shareCopyMode.value = "";

  try {
    const link = shareLinks.value[mode];
    const response = link.enabled
      ? await apiFetch(
          shareNotePathApi(props.store.selectedTitle, props.store.selectedCollection, mode),
          {
            method: "DELETE",
          },
        )
      : await apiFetch(
          shareNotePathApi(props.store.selectedTitle, props.store.selectedCollection),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode }),
          },
        );

    shareLinks.value = (await response.json()) as ShareLinksResponse;
  } catch (err) {
    emit("ui-error", (err as Error).message || t("genericError"));
  } finally {
    shareBusyMode.value = "";
  }
}

async function copyShareLink(mode: ShareMode) {
  const url = shareLinks.value[mode].url;
  if (!url) return;

  try {
    await navigator.clipboard.writeText(url);
    shareCopyMode.value = mode;
  } catch {
    emit("ui-error", t("couldNotCopyLink"));
  }
}

function setMenuCopyFeedback(type: "markdown" | "path") {
  menuCopyFeedback.value = type;
  if (menuCopyFeedbackTimeout) clearTimeout(menuCopyFeedbackTimeout);
  menuCopyFeedbackTimeout = setTimeout(() => {
    menuCopyFeedback.value = "";
    menuCopyFeedbackTimeout = null;
  }, 1500);
}

async function copyCurrentAsMarkdown() {
  if (!isFullMode.value) return;

  try {
    await navigator.clipboard.writeText(props.store.currentContent || "");
    setMenuCopyFeedback("markdown");
    showNoteMenu.value = false;
  } catch {
    emit("ui-error", t("couldNotCopyLink"));
  }
}

async function copyCurrentPath() {
  if (!isFullMode.value || !props.store.selectedTitle) return;

  const notePath = selectedCollection.value
    ? `${selectedCollection.value}/${props.store.selectedTitle}`
    : props.store.selectedTitle;

  try {
    await navigator.clipboard.writeText(`"${notePath}"`);
    setMenuCopyFeedback("path");
    showNoteMenu.value = false;
  } catch {
    emit("ui-error", t("couldNotCopyLink"));
  }
}

async function deleteCurrentNote() {
  if (!isFullMode.value || !props.store.selectedKey) return;
  const confirmed = window.confirm(t("confirmDelete"));
  if (!confirmed) return;

  try {
    await props.store.deleteCurrent();
    showNoteMenu.value = false;
    emit("deleted");
  } catch (e) {
    emit("ui-error", (e as Error).message || t("genericError"));
  }
}

function handleStatusClick() {
  if (!isTouchLike.value) return;
  showTooltip.value = !showTooltip.value;
}

function handleStatusHover() {
  if (isTouchLike.value) return;
  showTooltip.value = true;
}

function handleStatusFocus() {
  if (isTouchLike.value) return;
  showTooltip.value = true;
}

function closeTooltip() {
  if (isTouchLike.value) return;
  showTooltip.value = false;
}

function updateInputMode() {
  isTouchLike.value = window.matchMedia("(hover: none), (pointer: coarse)").matches;
  if (!isTouchLike.value) showTooltip.value = false;
}

function onGlobalPointerDown(event: Event) {
  const target = event.target as HTMLElement | null;

  if (showNoteMenu.value && noteMenuWrap.value && target && !noteMenuWrap.value.contains(target)) {
    showNoteMenu.value = false;
  }

  if (!isTouchLike.value) return;
  if (target?.closest(".status-indicator-wrap")) return;
  showTooltip.value = false;
}

function resetEditorScrollPosition() {
  const reset = (el?: HTMLElement | null) => {
    if (!el) return;
    el.scrollTop = 0;
  };

  reset(plainWrap.value);
  reset(plainTextarea.value);
  reset(wysiwygWrap.value);
  reset(wysiwygWrap.value?.querySelector<HTMLElement>(".tiptap-root"));
  reset(wysiwygWrap.value?.querySelector<HTMLElement>(".ProseMirror"));
}

watch(
  () => props.mode,
  (mode) => {
    editor.value?.setEditable(mode !== "share-readonly");
  },
  { immediate: true },
);

watch(showPlain, (isPlain) => {
  if (isPlain) {
    nextTick(() => plainTextarea.value?.focus());
    return;
  }
  syncEditorFromStore();
});

watch(
  () => props.store.syncState,
  (syncState, previousState) => {
    const enteredSynced = syncState === "synced" && previousState !== "synced";
    if (!enteredSynced) return;

    lastSyncTime.value = new Date().toLocaleTimeString(locale, {
      hour: "2-digit",
      minute: "2-digit",
    });
  },
  { immediate: true },
);

function fallbackTitleFromKey(key: string): string {
  if (!key) return "";
  const slashIndex = key.indexOf("/");
  if (slashIndex === -1) return key;
  return key.slice(slashIndex + 1);
}

watch(
  () => props.store.currentContent,
  () => syncEditorFromStore(),
);
watch(
  () => props.store.selectedKey,
  () => {
    if (!(document.activeElement === titleInput.value && editableTitle.value.trim() !== "")) {
      editableTitle.value =
        props.store.selectedTitle || fallbackTitleFromKey(props.store.selectedKey);
    }
    showNoteMenu.value = false;
    showShareDialog.value = false;
    syncEditorFromStore();
    nextTick(() => resetEditorScrollPosition());
  },
  { immediate: true },
);

watch(
  () => props.store.selectedTitle,
  (title) => {
    if (!props.store.selectedKey) {
      editableTitle.value = "";
      return;
    }
    if (!title) return;
    if (document.activeElement === titleInput.value) return;
    editableTitle.value = title;
  },
);

onMounted(() => {
  updateInputMode();
  window.addEventListener("resize", updateInputMode);
  window.addEventListener("pointerdown", onGlobalPointerDown);
  window.addEventListener("keydown", handleGlobalTabKeyDown, true);
});

onUnmounted(() => {
  window.removeEventListener("resize", updateInputMode);
  window.removeEventListener("pointerdown", onGlobalPointerDown);
  window.removeEventListener("keydown", handleGlobalTabKeyDown, true);
  if (menuCopyFeedbackTimeout) clearTimeout(menuCopyFeedbackTimeout);
  editor.value?.destroy();
});
</script>

<template>
  <main class="editor-area">
    <div class="note-title-wrap" v-if="store.selectedKey">
      <button
        v-if="showBack"
        class="mobile-title-back"
        @click="emit('back')"
        :aria-label="t('back')"
      >
        <ChevronLeft :size="20" />
      </button>
      <input
        ref="titleInput"
        v-model="editableTitle"
        class="note-title-input"
        type="text"
        spellcheck="false"
        :readonly="!isFullMode"
        @blur="commitTitleChange"
        @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
      />

      <div class="status-indicator-wrap">
        <button
          class="status-indicator"
          :class="`state-${statusMeta.state}`"
          :aria-label="statusAriaLabel"
          :aria-describedby="showTooltip ? 'sync-tooltip' : undefined"
          @mouseenter="handleStatusHover"
          @mouseleave="closeTooltip"
          @focus="handleStatusFocus"
          @blur="closeTooltip"
          @click="handleStatusClick"
        >
          <CloudCheck v-if="statusMeta.state === 'synced'" :size="18" />
          <RefreshCw v-else-if="statusMeta.state === 'syncing'" :size="18" class="spin" />
          <CloudOff v-else-if="statusMeta.state === 'offline'" :size="18" />
          <AlertTriangle v-else :size="18" />
        </button>

        <div v-if="showTooltip" id="sync-tooltip" class="status-tooltip" role="tooltip">
          <span v-for="(line, i) in statusMeta.lines" :key="i">{{ line }}</span>
        </div>
      </div>

      <div v-if="isFullMode" ref="noteMenuWrap" class="note-menu-wrap">
        <button
          class="note-menu-button"
          :aria-label="t('more')"
          :aria-expanded="showNoteMenu"
          @click="toggleNoteMenu"
        >
          <MoreVertical :size="20" />
        </button>
        <div v-if="showNoteMenu" class="note-menu-dropdown" role="menu">
          <div class="note-menu-collections" role="group" :aria-label="t('collections')">
            <button
              v-for="collection in availableCollections"
              :key="collection"
              class="note-menu-item"
              role="menuitemradio"
              :aria-checked="selectedCollection === collection"
              @click="moveCurrentToCollection(collection)"
            >
              <span class="note-menu-leading" aria-hidden="true">
                <Check :size="16" :class="{ 'is-hidden': selectedCollection !== collection }" />
              </span>
              <span class="note-menu-label">{{ collection }}</span>
            </button>
          </div>

          <button class="note-menu-item" role="menuitem" @click="createCollectionAndMove">
            <span class="note-menu-leading" aria-hidden="true">
              <FolderPlus :size="16" />
            </span>
            <span class="note-menu-label">{{ t("newCollection") }}</span>
          </button>

          <button class="note-menu-item" role="menuitem" @click="copyCurrentAsMarkdown">
            <span class="note-menu-leading" aria-hidden="true">
              <ClipboardCheck v-if="menuCopyFeedback === 'markdown'" :size="16" />
              <FileText v-else :size="16" />
            </span>
            <span class="note-menu-label">{{ t("copyAsMarkdown") }}</span>
          </button>

          <button class="note-menu-item" role="menuitem" @click="copyCurrentPath">
            <span class="note-menu-leading" aria-hidden="true">
              <ClipboardCheck v-if="menuCopyFeedback === 'path'" :size="16" />
              <Copy v-else :size="16" />
            </span>
            <span class="note-menu-label">{{ t("copyPath") }}</span>
          </button>

          <button class="note-menu-item" role="menuitem" @click="openShareDialog">
            <span class="note-menu-leading" aria-hidden="true">
              <Share2 :size="16" />
            </span>
            <span class="note-menu-label">{{ t("shareNote") }}</span>
          </button>

          <button class="note-menu-delete" role="menuitem" @click="deleteCurrentNote">
            <span class="note-menu-leading" aria-hidden="true">
              <Trash2 :size="16" />
            </span>
            <span class="note-menu-label">{{ t("deleteNote") }}</span>
          </button>
        </div>
      </div>
    </div>

    <Teleport v-if="isFullMode" to="body">
      <div v-if="showShareDialog" class="share-dialog-backdrop" @click.self="closeShareDialog">
        <div class="share-dialog" role="dialog" aria-modal="true" :aria-label="t('shareNote')">
          <h2 class="share-dialog-title">{{ t("shareNote") }}</h2>
          <button
            class="icon-button share-dialog-close"
            type="button"
            :aria-label="t('close')"
            @click="closeShareDialog"
          >
            <X :size="20" />
          </button>

          <div class="share-link-row">
            <div class="share-link-info">
              <div class="share-link-label-row">
                <span class="share-link-label">{{ t("shareReadonly") }}</span>
              </div>
              <div class="share-link-url">{{ shareLinks.view.url || t("shareOff") }}</div>
            </div>
            <div class="share-link-actions">
              <button
                class="share-toggle share-link-toggle"
                role="switch"
                :aria-checked="shareLinks.view.enabled"
                :disabled="shareBusyMode === 'view' || shareLoading"
                @click="toggleShareLink('view')"
              >
                <span class="share-toggle-track"><span class="share-toggle-thumb" /></span>
              </button>
              <button
                class="icon-button share-link-copy"
                :disabled="!shareLinks.view.url"
                :aria-label="t('copyLink')"
                @click="copyShareLink('view')"
              >
                <ClipboardCheck v-if="shareCopyMode === 'view'" :size="18" />
                <Copy v-else :size="18" />
              </button>
            </div>
          </div>

          <div class="share-link-row">
            <div class="share-link-info">
              <div class="share-link-label-row">
                <span class="share-link-label">{{ t("shareCollaborative") }}</span>
              </div>
              <div class="share-link-url">{{ shareLinks.edit.url || t("shareOff") }}</div>
            </div>
            <div class="share-link-actions">
              <button
                class="share-toggle share-link-toggle"
                role="switch"
                :aria-checked="shareLinks.edit.enabled"
                :disabled="shareBusyMode === 'edit' || shareLoading"
                @click="toggleShareLink('edit')"
              >
                <span class="share-toggle-track"><span class="share-toggle-thumb" /></span>
              </button>
              <button
                class="icon-button share-link-copy"
                :disabled="!shareLinks.edit.url"
                :aria-label="t('copyLink')"
                @click="copyShareLink('edit')"
              >
                <ClipboardCheck v-if="shareCopyMode === 'edit'" :size="18" />
                <Copy v-else :size="18" />
              </button>
            </div>
          </div>
        </div>
      </div>
    </Teleport>

    <EditorToolbar
      :editor="editor || null"
      :is-plain="showPlain"
      :readonly="isReadonlyMode"
      @toggle-plain="showPlain = !showPlain"
      @plain-action="applyPlainAction"
    />

    <section v-if="showPlain" ref="plainWrap" class="plain-wrap">
      <textarea
        ref="plainTextarea"
        :value="store.currentContent"
        :readonly="isReadonlyMode"
        @input="onPlainInput"
      ></textarea>
    </section>
    <section v-else ref="wysiwygWrap" class="wysiwyg-wrap">
      <EditorContent v-if="editor" :editor="editor || null" class="tiptap-root" />
    </section>
  </main>
</template>
