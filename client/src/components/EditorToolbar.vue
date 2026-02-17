<script setup lang="ts">
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
</script>

<template>
  <div class="editor-toolbar" aria-label="Editor toolbar">
    <button :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('bold') }" @click="run('bold', () => editor?.chain().focus().toggleBold().run())"><strong>B</strong></button>
    <button :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('italic') }" @click="run('italic', () => editor?.chain().focus().toggleItalic().run())"><em>I</em></button>
    <button :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('strike') }" @click="run('strike', () => editor?.chain().focus().toggleStrike().run())"><s>S</s></button>
    <button :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('heading', { level: 1 }) }" @click="run('h1', () => editor?.chain().focus().toggleHeading({ level: 1 }).run())">H1</button>
    <button :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('heading', { level: 2 }) }" @click="run('h2', () => editor?.chain().focus().toggleHeading({ level: 2 }).run())">H2</button>
    <button :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('heading', { level: 3 }) }" @click="run('h3', () => editor?.chain().focus().toggleHeading({ level: 3 }).run())">H3</button>
    <button :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('bulletList') }" @click="run('bullet', () => editor?.chain().focus().toggleBulletList().run())">• Liste</button>
    <button :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('orderedList') }" @click="run('ordered', () => editor?.chain().focus().toggleOrderedList().run())">1. Liste</button>
    <button :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('taskList') }" @click="run('task', () => editor?.chain().focus().toggleTaskList().run())">☑ Todo</button>
    <button :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('link') }" @click="run('link', () => emit('apply-link'))">Link</button>
    <button :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('code') }" @click="run('code', () => editor?.chain().focus().toggleCode().run())">&lt;/&gt;</button>
    <button :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('codeBlock') }" @click="run('codeBlock', () => editor?.chain().focus().toggleCodeBlock().run())">Kodeblok</button>
    <button :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('blockquote') }" @click="run('blockquote', () => editor?.chain().focus().toggleBlockquote().run())">Quote</button>
    <button :disabled="isDisabled()" @click="run('hr', () => editor?.chain().focus().setHorizontalRule().run())">—</button>

    <button class="mode-toggle" :class="{ active: isPlain }" @click="emit('toggle-plain')">
      {{ isPlain ? 'WYSIWYG' : 'Plain markdown' }}
    </button>
  </div>
</template>
