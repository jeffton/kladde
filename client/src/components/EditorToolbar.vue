<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import {
  Bold,
  Code,
  FileCode,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link,
  List,
  ListOrdered,
  ListTodo,
  Ellipsis,
  Minus,
  Quote
} from 'lucide-vue-next'
import type { Editor } from '@tiptap/vue-3'

interface Props {
  editor: Editor | null
  isPlain?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  editor: null,
  isPlain: false
})

const emit = defineEmits<{
  (e: 'toggle-plain'): void
  (e: 'apply-link'): void
  (e: 'plain-action', action: string): void
}>()

const isMobile = ref(window.matchMedia('(max-width: 900px)').matches)
const showMobileMore = ref(false)
let media: MediaQueryList | null = null
let mediaListener: ((event: MediaQueryListEvent) => void) | null = null

function run(action: string, richAction?: () => void) {
  if (props.isPlain) {
    emit('plain-action', action)
    return
  }
  richAction?.()
}

function isDisabled() {
  return !props.editor && !props.isPlain
}

function toggleMore() {
  showMobileMore.value = !showMobileMore.value
}

onMounted(() => {
  media = window.matchMedia('(max-width: 900px)')
  mediaListener = (event: MediaQueryListEvent) => {
    isMobile.value = event.matches
    if (!event.matches) showMobileMore.value = false
  }
  media.addEventListener('change', mediaListener)
})

onUnmounted(() => {
  if (media && mediaListener) media.removeEventListener('change', mediaListener)
})
</script>

<template>
  <div class="editor-toolbar" aria-label="Editor toolbar">
    <div class="toolbar-row">
      <button title="Overskrift 1" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('heading', { level: 1 }) }" @click="run('h1', () => editor?.chain().focus().toggleHeading({ level: 1 }).run())"><Heading1 :size="18" /></button>
      <button title="Overskrift 2" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('heading', { level: 2 }) }" @click="run('h2', () => editor?.chain().focus().toggleHeading({ level: 2 }).run())"><Heading2 :size="18" /></button>
      <button title="Overskrift 3" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('heading', { level: 3 }) }" @click="run('h3', () => editor?.chain().focus().toggleHeading({ level: 3 }).run())"><Heading3 :size="18" /></button>

      <span class="toolbar-divider" aria-hidden="true"></span>

      <button title="Punktliste" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('bulletList') }" @click="run('bullet', () => editor?.chain().focus().toggleBulletList().run())"><List :size="18" /></button>

      <button title="Nummereret liste" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('orderedList') }" @click="run('ordered', () => editor?.chain().focus().toggleOrderedList().run())"><ListOrdered :size="18" /></button>

      <button title="Opgaveliste" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('taskList') }" @click="run('task', () => editor?.chain().focus().toggleTaskList().run())"><ListTodo :size="18" /></button>

      <span class="toolbar-divider" aria-hidden="true"></span>

      <button v-if="isMobile" class="toolbar-more" :title="showMobileMore ? 'Skjul flere værktøjer' : 'Vis flere værktøjer'" :aria-expanded="showMobileMore" @click="toggleMore"><Ellipsis :size="20" /></button>

      <button v-if="!isMobile" class="mode-toggle" title="Skift mellem markdown og WYSIWYG" :class="{ active: isPlain }" @click="emit('toggle-plain')">
        <FileText :size="18" />
      </button>
    </div>

    <div v-if="!isMobile || showMobileMore" class="toolbar-row toolbar-row-secondary">
      <button title="Fed" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('bold') }" @click="run('bold', () => editor?.chain().focus().toggleBold().run())"><Bold :size="18" /></button>

      <button title="Kursiv" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('italic') }" @click="run('italic', () => editor?.chain().focus().toggleItalic().run())"><Italic :size="18" /></button>

      <button title="Link" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('link') }" @click="run('link', () => emit('apply-link'))"><Link :size="18" /></button>

      <button title="Inline kode" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('code') }" @click="run('code', () => editor?.chain().focus().toggleCode().run())"><Code :size="18" /></button>

      <button title="Kodeblok" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('codeBlock') }" @click="run('codeBlock', () => editor?.chain().focus().toggleCodeBlock().run())"><FileCode :size="18" /></button>

      <button title="Citat" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('blockquote') }" @click="run('blockquote', () => editor?.chain().focus().toggleBlockquote().run())"><Quote :size="18" /></button>

      <button title="Horisontal linje" :disabled="isDisabled()" @click="run('hr', () => editor?.chain().focus().setHorizontalRule().run())"><Minus :size="18" /></button>

      <button v-if="isMobile" class="mode-toggle" title="Skift mellem markdown og WYSIWYG" :class="{ active: isPlain }" @click="emit('toggle-plain')">
        <FileText :size="18" />
      </button>
    </div>
  </div>
</template>
