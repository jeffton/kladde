<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
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
      <button title="Overskrift 1" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('heading', { level: 1 }) }" @click="run('h1', () => editor?.chain().focus().toggleHeading({ level: 1 }).run())"><span class="text-icon">H1</span></button>
      <button title="Overskrift 2" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('heading', { level: 2 }) }" @click="run('h2', () => editor?.chain().focus().toggleHeading({ level: 2 }).run())"><span class="text-icon">H2</span></button>
      <button title="Overskrift 3" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('heading', { level: 3 }) }" @click="run('h3', () => editor?.chain().focus().toggleHeading({ level: 3 }).run())"><span class="text-icon">H3</span></button>

      <span class="toolbar-divider" aria-hidden="true"></span>

      <button title="Punktliste" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('bulletList') }" @click="run('bullet', () => editor?.chain().focus().toggleBulletList().run())">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="5" cy="7" r="1.4" />
          <circle cx="5" cy="12" r="1.4" />
          <circle cx="5" cy="17" r="1.4" />
          <path d="M9 7h10M9 12h10M9 17h10" />
        </svg>
      </button>

      <button title="Nummereret liste" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('orderedList') }" @click="run('ordered', () => editor?.chain().focus().toggleOrderedList().run())">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M10 7h10M10 12h10M10 17h10" />
          <path d="M4 7h1v3" />
          <path d="M3.8 12h1.6" />
          <path d="M4 15h2l-2 2h2" />
        </svg>
      </button>

      <button title="Opgaveliste" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('taskList') }" @click="run('task', () => editor?.chain().focus().toggleTaskList().run())">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="4" width="5" height="5" rx="1" />
          <rect x="3" y="15" width="5" height="5" rx="1" />
          <path d="M11 7h10M11 18h10" />
          <path d="m4.4 17.5 1.2 1.2 2.4-2.6" />
        </svg>
      </button>

      <span class="toolbar-divider" aria-hidden="true"></span>

      <button v-if="isMobile" class="toolbar-more" :title="showMobileMore ? 'Skjul flere værktøjer' : 'Vis flere værktøjer'" :aria-expanded="showMobileMore" @click="toggleMore">⋯</button>

      <button class="mode-toggle" title="Skift mellem markdown og WYSIWYG" :class="{ active: isPlain }" @click="emit('toggle-plain')">
        <span class="text-icon">{{ isPlain ? 'Aa' : 'MD' }}</span>
      </button>
    </div>

    <div v-if="!isMobile || showMobileMore" class="toolbar-row toolbar-row-secondary">
      <button title="Fed" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('bold') }" @click="run('bold', () => editor?.chain().focus().toggleBold().run())">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M8 5h5a3 3 0 1 1 0 6H8z" />
          <path d="M8 11h6a4 4 0 1 1 0 8H8z" />
        </svg>
      </button>

      <button title="Kursiv" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('italic') }" @click="run('italic', () => editor?.chain().focus().toggleItalic().run())">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M14 5h5" />
          <path d="M5 19h5" />
          <path d="M14 5 10 19" />
        </svg>
      </button>

      <button title="Link" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('link') }" @click="run('link', () => emit('apply-link'))">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M10 13.5 8 15.5a3.5 3.5 0 1 1-5-5l2.5-2.5a3.5 3.5 0 0 1 5 0" />
          <path d="M14 10.5 16 8.5a3.5 3.5 0 1 1 5 5L18.5 16a3.5 3.5 0 0 1-5 0" />
          <path d="m9 15 6-6" />
        </svg>
      </button>

      <button title="Inline kode" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('code') }" @click="run('code', () => editor?.chain().focus().toggleCode().run())">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m8 8-4 4 4 4" />
          <path d="m16 8 4 4-4 4" />
        </svg>
      </button>

      <button title="Kodeblok" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('codeBlock') }" @click="run('codeBlock', () => editor?.chain().focus().toggleCodeBlock().run())">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <path d="M3 9h18" />
          <path d="m10 12-2 2 2 2" />
          <path d="m14 12 2 2-2 2" />
        </svg>
      </button>

      <button title="Citat" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('blockquote') }" @click="run('blockquote', () => editor?.chain().focus().toggleBlockquote().run())">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M8 9H5v4h3v4H4v-4a4 4 0 0 1 4-4z" />
          <path d="M18 9h-3v4h3v4h-4v-4a4 4 0 0 1 4-4z" />
        </svg>
      </button>

      <button title="Horisontal linje" :disabled="isDisabled()" @click="run('hr', () => editor?.chain().focus().setHorizontalRule().run())">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4 12h16" />
        </svg>
      </button>
    </div>
  </div>
</template>
