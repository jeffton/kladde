<script setup>
defineProps({
  editor: { type: Object, default: null },
  isMobile: { type: Boolean, default: false },
  mobileView: { type: String, default: 'editor' },
  online: { type: Boolean, default: true },
  saveLabel: { type: String, required: true },
  syncStatus: { type: String, default: '' },
  isPlain: { type: Boolean, default: false }
})

const emit = defineEmits(['toggle-plain', 'back', 'apply-link'])
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
    <button :disabled="!editor || isPlain" :class="{ active: editor?.isActive('bold') }" @click="editor?.chain().focus().toggleBold().run()"><strong>B</strong></button>
    <button :disabled="!editor || isPlain" :class="{ active: editor?.isActive('italic') }" @click="editor?.chain().focus().toggleItalic().run()"><em>I</em></button>
    <button :disabled="!editor || isPlain" :class="{ active: editor?.isActive('strike') }" @click="editor?.chain().focus().toggleStrike().run()"><s>S</s></button>
    <button :disabled="!editor || isPlain" :class="{ active: editor?.isActive('heading', { level: 1 }) }" @click="editor?.chain().focus().toggleHeading({ level: 1 }).run()">H1</button>
    <button :disabled="!editor || isPlain" :class="{ active: editor?.isActive('heading', { level: 2 }) }" @click="editor?.chain().focus().toggleHeading({ level: 2 }).run()">H2</button>
    <button :disabled="!editor || isPlain" :class="{ active: editor?.isActive('heading', { level: 3 }) }" @click="editor?.chain().focus().toggleHeading({ level: 3 }).run()">H3</button>
    <button :disabled="!editor || isPlain" :class="{ active: editor?.isActive('bulletList') }" @click="editor?.chain().focus().toggleBulletList().run()">• Liste</button>
    <button :disabled="!editor || isPlain" :class="{ active: editor?.isActive('orderedList') }" @click="editor?.chain().focus().toggleOrderedList().run()">1. Liste</button>
    <button :disabled="!editor || isPlain" :class="{ active: editor?.isActive('taskList') }" @click="editor?.chain().focus().toggleTaskList().run()">☑ Todo</button>
    <button :disabled="!editor || isPlain" :class="{ active: editor?.isActive('link') }" @click="emit('apply-link')">Link</button>
    <button :disabled="!editor || isPlain" :class="{ active: editor?.isActive('code') }" @click="editor?.chain().focus().toggleCode().run()">&lt;/&gt;</button>
    <button :disabled="!editor || isPlain" :class="{ active: editor?.isActive('codeBlock') }" @click="editor?.chain().focus().toggleCodeBlock().run()">Kodeblok</button>
    <button :disabled="!editor || isPlain" :class="{ active: editor?.isActive('blockquote') }" @click="editor?.chain().focus().toggleBlockquote().run()">Quote</button>
    <button :disabled="!editor || isPlain" @click="editor?.chain().focus().setHorizontalRule().run()">—</button>

    <button class="mode-toggle" :class="{ active: isPlain }" @click="emit('toggle-plain')">
      {{ isPlain ? 'WYSIWYG' : 'Plain markdown' }}
    </button>
  </div>
</template>
