<script setup>
const props = defineProps({
  editor: { type: Object, default: null },
  isMobile: { type: Boolean, default: false },
  mobileView: { type: String, default: 'editor' },
  online: { type: Boolean, default: true },
  saveLabel: { type: String, required: true },
  syncStatus: { type: String, default: '' },
  isPlain: { type: Boolean, default: false }
})

const emit = defineEmits(['toggle-plain', 'back', 'apply-link', 'plain-action'])

function run(action, richAction) {
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
  <header class="toolbar">
    <div class="toolbar-left">
      <button v-if="isMobile && mobileView === 'editor'" class="back-button" @click="emit('back')">← Tilbage</button>
      <div class="status">
        <span :class="online ? 'online' : 'offline'">{{ online ? 'Online' : 'Offline' }}</span>
        <span>{{ saveLabel }}</span>
        <span>{{ syncStatus }}</span>
      </div>
    </div>
  </header>

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
