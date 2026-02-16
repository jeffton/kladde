<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Link from '@tiptap/extension-link'
import CodeBlock from '@tiptap/extension-code-block'
import Placeholder from '@tiptap/extension-placeholder'
import Strike from '@tiptap/extension-strike'
import { Markdown } from 'tiptap-markdown'
import EditorToolbar from './EditorToolbar.vue'

const props = defineProps({
  store: { type: Object, required: true },
  isMobile: { type: Boolean, default: false },
  mobileView: { type: String, default: 'editor' }
})

const emit = defineEmits(['rename', 'back'])

const editableTitle = ref('')
const error = ref('')
const showPlain = ref(false)
let ignoreEditorChanges = false
let updateDebounce = null

const saveLabel = computed(() => (props.store.dirty ? 'Ikke gemt' : 'Gemt'))

const editor = useEditor({
  extensions: [
    StarterKit.configure({ strike: false, codeBlock: false }),
    Strike,
    CodeBlock,
    TaskList,
    TaskItem.configure({ nested: true }),
    Link.configure({
      autolink: true,
      openOnClick: true,
      linkOnPaste: true,
      HTMLAttributes: {
        rel: 'noopener noreferrer nofollow',
        target: '_blank'
      }
    }),
    Placeholder.configure({ placeholder: 'Skriv din note her…' }),
    Markdown.configure({
      html: false,
      transformCopiedText: true,
      transformPastedText: true
    })
  ],
  content: props.store.currentContent || '',
  contentType: 'markdown',
  onUpdate: ({ editor: tiptapEditor }) => {
    if (ignoreEditorChanges) return
    const markdown = tiptapEditor.storage.markdown.getMarkdown()

    clearTimeout(updateDebounce)
    updateDebounce = setTimeout(() => {
      if (markdown !== props.store.currentContent) {
        props.store.setCurrentContent(markdown).catch((err) => {
          error.value = err?.message || 'Kunne ikke gemme lokalt'
        })
      }
    }, 300)
  }
})

function setEditorMarkdown(markdown = '') {
  if (!editor.value) return
  ignoreEditorChanges = true
  editor.value.commands.setContent(markdown || '', false, { contentType: 'markdown' })
  ignoreEditorChanges = false
}

function syncEditorFromStore() {
  if (!editor.value || showPlain.value) return
  const current = editor.value.storage.markdown.getMarkdown()
  if (current === props.store.currentContent) return
  setEditorMarkdown(props.store.currentContent)
}

function applyLink() {
  if (!editor.value) return
  const previousUrl = editor.value.getAttributes('link').href
  const href = window.prompt('Indsæt link (https://...)', previousUrl || '')

  if (href === null) return
  if (href === '') {
    editor.value.chain().focus().unsetLink().run()
    return
  }

  editor.value.chain().focus().setLink({ href }).run()
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
    error.value = e.message
    editableTitle.value = props.store.selectedTitle
  }
}

watch(showPlain, (isPlain) => {
  if (isPlain) return
  syncEditorFromStore()
})

watch(
  () => props.store.currentContent,
  () => {
    syncEditorFromStore()
  }
)

watch(
  () => props.store.selectedTitle,
  (title) => {
    editableTitle.value = title || ''
  },
  { immediate: true }
)

onUnmounted(() => {
  if (updateDebounce) clearTimeout(updateDebounce)
  if (editor.value) editor.value.destroy()
})
</script>

<template>
  <main class="editor-area">
    <div class="note-title-wrap" v-if="store.selectedTitle">
      <input
        v-model="editableTitle"
        class="note-title-input"
        type="text"
        spellcheck="false"
        @blur="commitTitleChange"
        @keydown.enter.prevent="$event.target.blur()" />
    </div>

    <EditorToolbar
      :editor="editor"
      :is-plain="showPlain"
      :is-mobile="isMobile"
      :mobile-view="mobileView"
      :online="store.online"
      :save-label="saveLabel"
      :sync-status="store.syncStatus"
      @toggle-plain="showPlain = !showPlain"
      @apply-link="applyLink"
      @back="emit('back')" />

    <p v-if="error" class="error">{{ error }}</p>
    <section v-if="showPlain" class="plain-wrap">
      <textarea :value="store.currentContent" @input="store.setCurrentContent($event.target.value)"></textarea>
    </section>
    <section v-else class="wysiwyg-wrap">
      <EditorContent v-if="editor" :editor="editor" class="tiptap-root" />
    </section>
  </main>
</template>
