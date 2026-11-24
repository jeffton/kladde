<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import { EditorContent, useEditor } from "@tiptap/vue-3";
import { generateHTML } from "@tiptap/core";
import type { Editor as TiptapEditor } from "@tiptap/core";
import {
  TriangleExclamationPoint,
  Check,
  ChevronLeft,
  ClipboardCheck,
  CloudCheck,
  CodeXml,
  CloudOff,
  Copy,
  FileText,
  FolderPlus,
  MoreVertical,
  RefreshCw,
  Share2,
  Trash2,
  X,
} from "@lucide/vue";
import EditorToolbar from "./EditorToolbar.vue";
import { apiFetch, shareNotePathApi } from "../stores/notesApi";
import type { AppMode, EditorStoreLike, ShareLinksResponse, ShareMode } from "../types";
import { t } from "../i18n";
import { useEditorStatus } from "../composables/useEditorStatus";
import { useMarkdownSource } from "../composables/useMarkdownSource";
import { createEditorExtensions, serializeClipboardText } from "./editorExtensions";
import { readableMarkdown } from "../markdown-source";

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
const plainWrap = ref<HTMLElement | null>(null);
const wysiwygWrap = ref<HTMLElement | null>(null);
let ignoreEditorChanges = false;

function reportSaveError(err: unknown) {
  emit("ui-error", (err as Error)?.message || t("couldNotSaveLocally"));
}

const { plainInput, plainTextarea, applyPlainAction, onPlainInput } = useMarkdownSource(
  (value) => props.store.setCurrentContent(value),
  reportSaveError,
  () => isReadonlyMode.value,
);

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
const menuCopyFeedback = ref<"markdown" | "html" | "path" | "">("");
const shareLoading = ref(false);
const noteMenuWrap = ref<HTMLElement | null>(null);
const availableCollections = computed(() => props.store.collections);
const selectedCollection = computed(() => props.store.selectedCollection || "");
let shouldBlurAfterTaskCheckboxTap = false;
let menuCopyFeedbackTimeout: ReturnType<typeof setTimeout> | null = null;

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

const { statusMeta, statusAriaLabel } = useEditorStatus(
  () => props.store,
  () => isReadonlyMode.value,
);

const editor = useEditor({
  extensions: createEditorExtensions(),
  editorProps: {
    clipboardTextSerializer: serializeClipboardText,
    handleDOMEvents: {
      pointerdown: (_view, event) => handleTaskCheckboxPointerStart(event),
      touchstart: (_view, event) => handleTaskCheckboxPointerStart(event),
      mousedown: (_view, event) => handleTaskCheckboxPointerStart(event),
      click: (_view, event) => handleTaskCheckboxClick(event),
    },
  },
  editable: !isReadonlyMode.value,
  content: props.store.currentContent || "",
  contentType: "markdown",
  onUpdate: ({ editor: tiptapEditor }) => {
    if (ignoreEditorChanges) return;

    const nextMarkdown = readableMarkdown(tiptapEditor.getMarkdown(), tiptapEditor.markdown!);
    if (nextMarkdown === props.store.currentContent) return;

    void props.store.setCurrentContent(nextMarkdown).catch(reportSaveError);
  },
});

const markdownSource = computed(() => {
  const source = props.store.currentContent || "";
  const manager = editor.value?.markdown;
  if (!manager || (showPlain.value && source === plainInput.value)) return source;
  return readableMarkdown(source, manager);
});

function setEditorMarkdown(markdown = "") {
  if (!editor.value) return;

  const wasFocused = editor.value.isFocused;
  const previousSelection = {
    from: editor.value.state.selection.from,
    to: editor.value.state.selection.to,
  };

  ignoreEditorChanges = true;
  editor.value.commands.setContent(markdown || "", {
    contentType: "markdown",
    emitUpdate: false,
  });

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
  const current = readableMarkdown(editor.value.getMarkdown(), editor.value.markdown!);
  if (current === markdownSource.value) return;
  setEditorMarkdown(props.store.currentContent);
}

function onTitleInput(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.value.includes("/")) {
    const cursor = input.selectionStart ?? input.value.length;
    const nextCursor = input.value.slice(0, cursor).replaceAll("/", "").length;
    input.value = input.value.replaceAll("/", "");
    input.setSelectionRange(nextCursor, nextCursor);
  }
  editableTitle.value = input.value;
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

function setMenuCopyFeedback(type: "markdown" | "html" | "path") {
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
    await navigator.clipboard.writeText(markdownSource.value);
    setMenuCopyFeedback("markdown");
    showNoteMenu.value = false;
  } catch {
    emit("ui-error", t("couldNotCopy"));
  }
}

async function copyCurrentAsHtml() {
  if (!isFullMode.value || !editor.value) return;

  const markdown = props.store.currentContent || "";
  // The editor always includes the Markdown extension.
  const document = editor.value.markdown!.parse(markdown);
  const html = generateHTML(document, editor.value.extensionManager.extensions);

  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/html": new Blob([html], { type: "text/html" }),
        "text/plain": new Blob([markdownSource.value], { type: "text/plain" }),
      }),
    ]);
    setMenuCopyFeedback("html");
    showNoteMenu.value = false;
  } catch {
    emit("ui-error", t("couldNotCopy"));
  }
}

async function copyCurrentPath() {
  if (!isFullMode.value || !props.store.selectedTitle) return;

  const notePath = selectedCollection.value
    ? `${selectedCollection.value}/${props.store.selectedTitle}.md`
    : `${props.store.selectedTitle}.md`;

  try {
    await navigator.clipboard.writeText(`"${notePath}"`);
    setMenuCopyFeedback("path");
    showNoteMenu.value = false;
  } catch {
    emit("ui-error", t("couldNotCopy"));
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
  plainInput.value = null;
  if (isPlain) {
    nextTick(() => plainTextarea.value?.focus());
    return;
  }
  syncEditorFromStore();
});

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
    plainInput.value = null;
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
        :value="editableTitle"
        class="note-title-input"
        type="text"
        spellcheck="false"
        :readonly="!isFullMode"
        @beforeinput="if ($event.data === '/') $event.preventDefault();"
        @input="onTitleInput"
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
          <TriangleExclamationPoint v-else :size="18" />
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

          <button class="note-menu-item" role="menuitem" @click="copyCurrentAsHtml">
            <span class="note-menu-leading" aria-hidden="true">
              <ClipboardCheck v-if="menuCopyFeedback === 'html'" :size="16" />
              <CodeXml v-else :size="16" />
            </span>
            <span class="note-menu-label">{{ t("copyAsHtml") }}</span>
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
        :value="markdownSource"
        :readonly="isReadonlyMode"
        @input="onPlainInput"
      ></textarea>
    </section>
    <section v-else ref="wysiwygWrap" class="wysiwyg-wrap">
      <EditorContent v-if="editor" :editor="editor || null" class="tiptap-root" />
    </section>
  </main>
</template>
