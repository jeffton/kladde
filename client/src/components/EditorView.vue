<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Link from '@tiptap/extension-link'
import CodeBlock from '@tiptap/extension-code-block'
import Strike from '@tiptap/extension-strike'
import Paragraph from '@tiptap/extension-paragraph'
import { Markdown } from 'tiptap-markdown'
import {
  AlertTriangle,
  ChevronLeft,
  CloudCheck,
  CloudOff,
  MoreVertical,
  RefreshCw,
  Trash2
} from 'lucide-vue-next'
import EditorToolbar from './EditorToolbar.vue'
import type { NotesStore } from '../stores/notes'

interface Props {
  store: NotesStore
  showBack?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  showBack: false
})

const emit = defineEmits<{
  (e: 'rename', title: string): void
  (e: 'back'): void
  (e: 'deleted'): void
}>()

const editableTitle = ref('')
const error = ref('')
const showPlain = ref(false)
const plainTextarea = ref<HTMLTextAreaElement | null>(null)
let ignoreEditorChanges = false
let updateDebounce: number | null = null

// Preserve empty paragraphs through markdown round-trip.
// ProseMirror's default serializer drops empty paragraphs.
// We serialize them as \u00A0 (nbsp), then strip on save.
const NBSP = '\u00A0'

interface MarkdownSerializerState {
  write: (content: string) => void
  closeBlock: (node: unknown) => void
  renderInline: (node: unknown) => void
}

interface ProseMirrorNodeLike {
  content: { size: number }
}

// Custom paragraph extension that serializes empty paragraphs as nbsp
const PreservingParagraph = Paragraph.extend({
  addStorage() {
    const parentStorage = this.parent?.() || {}
    const parentMarkdown = parentStorage.markdown || {}

    return {
      ...parentStorage,
      markdown: {
        ...parentMarkdown,
        serialize(state: MarkdownSerializerState, node: ProseMirrorNodeLike) {
          if (node.content.size === 0) {
            state.write(NBSP)
            state.closeBlock(node)
            return
          }
          state.renderInline(node)
          state.closeBlock(node)
        },
      },
    }
  },
})

function editorToMd(md: string): string {
  return md
}

function mdToEditor(md: string): string {
  return md
}

const showTooltip = ref(false)
const isTouchLike = ref(false)
const showNoteMenu = ref(false)
const lastSyncTime = ref('')
const noteMenuWrap = ref<HTMLElement | null>(null)

function capitalize(text = '') {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

const locale = navigator.language || 'en'

function startOfWeek(date: Date) {
  const copy = new Date(date)
  copy.setHours(0, 0, 0, 0)
  const day = copy.getDay()
  copy.setDate(copy.getDate() - (day === 0 ? 6 : day - 1))
  return copy
}

function fmtTime(date: Date) {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date)
}

function formatUpdatedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const now = new Date()
  const time = fmtTime(date)
  if (isSameDay(date, now)) return time

  if (date >= startOfWeek(now)) {
    const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(date)
    return `${weekday}, ${time}`
  }

  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}

const statusMeta = computed(() => {
  const syncState = props.store.syncState
  const modifiedRaw = props.store.currentUpdatedAt || props.store.notes.find((n) => n.title === props.store.selectedTitle)?.updatedAt || ''
  const modifiedText = modifiedRaw ? formatUpdatedAt(modifiedRaw) : ''
  const modifiedLine = modifiedText ? `Ændret ${modifiedText}` : ''

  const lines: string[] = []

  if (syncState === 'offline') {
    lines.push('Offline')
    if (modifiedLine) lines.push(modifiedLine)
    lines.push(lastSyncTime.value ? `Sidst synkroniseret ${lastSyncTime.value}` : 'Ændringer gemmes lokalt')
    return { state: 'offline' as const, lines }
  }

  if (syncState === 'syncing') {
    if (modifiedLine) lines.push(modifiedLine)
    lines.push(props.store.syncStatus || 'Synkroniserer ændringer…')
    return { state: 'syncing' as const, lines }
  }

  if (syncState === 'error') {
    if (modifiedLine) lines.push(modifiedLine)
    lines.push(props.store.syncStatus || 'Der opstod en synkroniseringsfejl')
    lines.push(lastSyncTime.value ? `Sidst synkroniseret ${lastSyncTime.value}` : 'Ingen vellykket synkronisering endnu')
    return { state: 'error' as const, lines }
  }

  const syncedAt = lastSyncTime.value ? ` ${lastSyncTime.value}` : ''
  if (modifiedLine) lines.push(modifiedLine)
  lines.push(`Synkroniseret${syncedAt}`)
  return { state: 'synced' as const, lines }
})

const statusAriaLabel = computed(() => statusMeta.value.lines.join(', '))

const editor = useEditor({
  extensions: [
    StarterKit.configure({ strike: false, codeBlock: false, paragraph: false }),
    PreservingParagraph,
    Strike,
    CodeBlock,
    TaskList,
    TaskItem.configure({ nested: true }),
    Link.configure({
      autolink: true,
      openOnClick: true,
      linkOnPaste: true,
      HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' }
    }),
    Markdown.configure({ html: false, transformCopiedText: true, transformPastedText: true })
  ],
  editorProps: {
    clipboardTextSerializer: (slice) => {
      const defaultText = slice.content.textBetween(0, slice.content.size, '\n\n')
      return defaultText.replace(new RegExp(NBSP, 'g'), '')
    }
  },
  content: mdToEditor(props.store.currentContent || ''),
  onUpdate: ({ editor: tiptapEditor }) => {
    if (ignoreEditorChanges) return
    const nextMarkdown = editorToMd(tiptapEditor.storage.markdown.getMarkdown())
    const titleAtSchedule = props.store.selectedTitle

    if (updateDebounce) window.clearTimeout(updateDebounce)
    updateDebounce = window.setTimeout(() => {
      if (props.store.selectedTitle !== titleAtSchedule) return
      if (nextMarkdown !== props.store.currentContent) {
        void props.store.setCurrentContent(nextMarkdown).catch((err: unknown) => {
          error.value = (err as Error)?.message || 'Kunne ikke gemme lokalt'
        })
      }
    }, 300)
  }
})

function setEditorMarkdown(markdown = '') {
  if (!editor.value) return
  ignoreEditorChanges = true
  editor.value.commands.setContent(mdToEditor(markdown || ''), false)
  ignoreEditorChanges = false
}

function syncEditorFromStore() {
  if (!editor.value || showPlain.value) return
  const current = editorToMd(editor.value.storage.markdown.getMarkdown())
  if (current === props.store.currentContent) return
  setEditorMarkdown(props.store.currentContent)
}

async function updatePlainText(nextValue: string, selectionStart: number, selectionEnd: number) {
  const textarea = plainTextarea.value
  if (!textarea) return

  textarea.value = nextValue
  await props.store.setCurrentContent(nextValue)

  await nextTick()
  if (plainTextarea.value) {
    plainTextarea.value.focus()
    plainTextarea.value.setSelectionRange(selectionStart, selectionEnd)
  }
}

function wrapSelection(prefix: string, suffix = prefix, placeholder = '') {
  const textarea = plainTextarea.value
  if (!textarea) return

  const { value } = textarea
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const selected = value.slice(start, end)
  const middle = selected || placeholder
  const replacement = `${prefix}${middle}${suffix}`
  const nextValue = value.slice(0, start) + replacement + value.slice(end)

  const selectFrom = start + prefix.length
  const selectTo = start + prefix.length + middle.length
  void updatePlainText(nextValue, selectFrom, selectTo)
}

function prefixLines(prefix: string) {
  const textarea = plainTextarea.value
  if (!textarea) return

  const { value } = textarea
  const start = textarea.selectionStart
  const end = textarea.selectionEnd

  const blockStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const blockEndIndex = value.indexOf('\n', end)
  const blockEnd = blockEndIndex === -1 ? value.length : blockEndIndex

  const block = value.slice(blockStart, blockEnd)
  const lines = block.split('\n')
  const prefixed = lines.map((line) => `${prefix}${line}`).join('\n')
  const nextValue = value.slice(0, blockStart) + prefixed + value.slice(blockEnd)

  const shiftAtStart = start - blockStart >= 0 ? prefix.length : 0
  const addedChars = prefix.length * lines.length

  void updatePlainText(nextValue, start + shiftAtStart, end + addedChars)
}

function unprefixLines(prefix: string) {
  const textarea = plainTextarea.value
  if (!textarea) return

  const { value } = textarea
  const start = textarea.selectionStart
  const end = textarea.selectionEnd

  const blockStart = value.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const blockEndIndex = value.indexOf('\n', end)
  const blockEnd = blockEndIndex === -1 ? value.length : blockEndIndex

  const block = value.slice(blockStart, blockEnd)
  const lines = block.split('\n')

  let removedBeforeStart = 0
  let removedBeforeEnd = 0

  const unprefixed = lines.map((line, index) => {
    const hadPrefix = line.startsWith(prefix)
    if (!hadPrefix) return line

    if (index === 0) removedBeforeStart = prefix.length
    removedBeforeEnd += prefix.length
    return line.slice(prefix.length)
  }).join('\n')

  const nextValue = value.slice(0, blockStart) + unprefixed + value.slice(blockEnd)
  const nextStart = Math.max(blockStart, start - removedBeforeStart)
  const nextEnd = Math.max(nextStart, end - removedBeforeEnd)

  void updatePlainText(nextValue, nextStart, nextEnd)
}

function insertHr() {
  const textarea = plainTextarea.value
  if (!textarea) return

  const { value } = textarea
  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const before = value.slice(0, start)
  const after = value.slice(end)

  const pre = before.length && !before.endsWith('\n') ? '\n' : ''
  const post = after.length && !after.startsWith('\n') ? '\n' : ''
  const insert = `${pre}---${post}`

  const nextValue = before + insert + after
  const cursor = before.length + insert.length
  void updatePlainText(nextValue, cursor, cursor)
}

function applyPlainLink() {
  const textarea = plainTextarea.value
  if (!textarea) return

  const start = textarea.selectionStart
  const end = textarea.selectionEnd
  const selected = textarea.value.slice(start, end) || 'text'
  const href = window.prompt('Indsæt link (https://...)', 'https://')
  if (href === null) return

  const replacement = `[${selected}](${href || 'url'})`
  const nextValue = textarea.value.slice(0, start) + replacement + textarea.value.slice(end)
  const textStart = start + 1
  const textEnd = textStart + selected.length
  void updatePlainText(nextValue, textStart, textEnd)
}

function applyPlainAction(action: string) {
  switch (action) {
    case 'bold': wrapSelection('**'); break
    case 'italic': wrapSelection('*'); break
    case 'strike': wrapSelection('~~'); break
    case 'h1': prefixLines('# '); break
    case 'h2': prefixLines('## '); break
    case 'h3': prefixLines('### '); break
    case 'bullet': prefixLines('- '); break
    case 'ordered': prefixLines('1. '); break
    case 'task': prefixLines('- [ ] '); break
    case 'link': applyPlainLink(); break
    case 'code': wrapSelection('`'); break
    case 'codeBlock': wrapSelection('```\n', '\n```'); break
    case 'blockquote': prefixLines('> '); break
    case 'indent': prefixLines('  '); break
    case 'outdent': unprefixLines('  '); break
    case 'hr': insertHr(); break
  }
}

async function commitTitleChange() {
  if (!props.store.selectedTitle) return
  const next = editableTitle.value.trim()

  if (!next) {
    editableTitle.value = props.store.selectedTitle
    return
  }

  try {
    const renamedTitle = await props.store.renameCurrent(next)
    editableTitle.value = renamedTitle
    error.value = ''
    emit('rename', renamedTitle)
  } catch (e) {
    error.value = (e as Error).message
    editableTitle.value = props.store.selectedTitle
  }
}

function toggleNoteMenu() {
  showNoteMenu.value = !showNoteMenu.value
}

async function deleteCurrentNote() {
  if (!props.store.selectedTitle) return
  const confirmed = window.confirm('Er du sikker?')
  if (!confirmed) return

  try {
    await props.store.deleteCurrent()
    showNoteMenu.value = false
    error.value = ''
    emit('deleted')
  } catch (e) {
    error.value = (e as Error).message
  }
}

function handleStatusClick() {
  if (!isTouchLike.value) return
  showTooltip.value = !showTooltip.value
}

function handleStatusHover() {
  if (isTouchLike.value) return
  showTooltip.value = true
}

function handleStatusFocus() {
  if (isTouchLike.value) return
  showTooltip.value = true
}

function closeTooltip() {
  if (isTouchLike.value) return
  showTooltip.value = false
}

function updateInputMode() {
  isTouchLike.value = window.matchMedia('(hover: none), (pointer: coarse)').matches
  if (!isTouchLike.value) showTooltip.value = false
}

function onGlobalPointerDown(event: Event) {
  const target = event.target as HTMLElement | null

  if (showNoteMenu.value && noteMenuWrap.value && target && !noteMenuWrap.value.contains(target)) {
    showNoteMenu.value = false
  }

  if (!isTouchLike.value) return
  if (target?.closest('.status-indicator-wrap')) return
  showTooltip.value = false
}

watch(showPlain, (isPlain) => {
  if (isPlain) {
    nextTick(() => plainTextarea.value?.focus())
    return
  }
  syncEditorFromStore()
})

watch(
  () => props.store.syncState,
  (syncState, previousState) => {
    const enteredSynced = syncState === 'synced' && previousState !== 'synced'
    if (!enteredSynced) return

    lastSyncTime.value = new Date().toLocaleTimeString(navigator.language, {
      hour: '2-digit',
      minute: '2-digit'
    })
  },
  { immediate: true }
)

watch(() => props.store.currentContent, () => syncEditorFromStore())
watch(() => props.store.selectedTitle, (title) => {
  if (updateDebounce) {
    window.clearTimeout(updateDebounce)
    updateDebounce = null
  }
  editableTitle.value = title || ''
  showNoteMenu.value = false
}, { immediate: true })

onMounted(() => {
  updateInputMode()
  window.addEventListener('resize', updateInputMode)
  window.addEventListener('pointerdown', onGlobalPointerDown)
})

onUnmounted(() => {
  if (updateDebounce) window.clearTimeout(updateDebounce)
  window.removeEventListener('resize', updateInputMode)
  window.removeEventListener('pointerdown', onGlobalPointerDown)
  editor.value?.destroy()
})
</script>

<template>
  <main class="editor-area">
    <div class="note-title-wrap" v-if="store.selectedTitle">
      <button v-if="showBack" class="mobile-title-back" @click="emit('back')" aria-label="Tilbage">
        <ChevronLeft :size="20" />
      </button>
      <input
        v-model="editableTitle"
        class="note-title-input"
        type="text"
        spellcheck="false"
        @blur="commitTitleChange"
        @keydown.enter.prevent="($event.target as HTMLInputElement).blur()" />

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
          @click="handleStatusClick">
          <CloudCheck v-if="statusMeta.state === 'synced'" :size="18" />
          <RefreshCw v-else-if="statusMeta.state === 'syncing'" :size="18" class="spin" />
          <CloudOff v-else-if="statusMeta.state === 'offline'" :size="18" />
          <AlertTriangle v-else :size="18" />
        </button>

        <div v-if="showTooltip" id="sync-tooltip" class="status-tooltip" role="tooltip">
          <span v-for="(line, i) in statusMeta.lines" :key="i">{{ line }}</span>
        </div>
      </div>

      <div ref="noteMenuWrap" class="note-menu-wrap">
        <button class="note-menu-button" aria-label="Mere" :aria-expanded="showNoteMenu" @click="toggleNoteMenu">
          <MoreVertical :size="20" />
        </button>
        <div v-if="showNoteMenu" class="note-menu-dropdown" role="menu">
          <button class="note-menu-delete" role="menuitem" @click="deleteCurrentNote">
            <Trash2 :size="18" />
            <span>Slet note</span>
          </button>
        </div>
      </div>
    </div>

    <EditorToolbar
      :editor="editor || null"
      :is-plain="showPlain"
      @toggle-plain="showPlain = !showPlain"
      @plain-action="applyPlainAction" />

    <p v-if="error" class="error">{{ error }}</p>
    <section v-if="showPlain" class="plain-wrap">
      <textarea
        ref="plainTextarea"
        :value="store.currentContent"
        @input="store.setCurrentContent(($event.target as HTMLTextAreaElement).value)"></textarea>
    </section>
    <section v-else class="wysiwyg-wrap">
      <EditorContent v-if="editor" :editor="editor || null" class="tiptap-root" />
    </section>
  </main>
</template>
