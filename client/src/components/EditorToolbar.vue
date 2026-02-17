<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import type { Editor } from '@tiptap/vue-3'

interface Props {
  editor: Editor | null
  showBack?: boolean
  online?: boolean
  saveLabel: string
  syncStatus?: string
  isPlain?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  editor: null,
  showBack: false,
  online: true,
  syncStatus: '',
  isPlain: false
})

const emit = defineEmits<{
  (e: 'toggle-plain'): void
  (e: 'back'): void
  (e: 'apply-link'): void
  (e: 'plain-action', action: string): void
}>()

const showTooltip = ref(false)
const isTouchLike = ref(false)

const statusMeta = computed(() => {
  const sync = (props.syncStatus || '').toLowerCase()
  const dirty = (props.saveLabel || '').toLowerCase().includes('ikke gemt')

  if (!props.online) {
    return {
      state: 'offline',
      label: 'Offline',
      detail: props.syncStatus || 'Offline — ændringer gemmes lokalt'
    }
  }

  if (sync.includes('synkroniserer')) {
    return {
      state: 'syncing',
      label: 'Synkroniserer',
      detail: props.syncStatus || 'Synkroniserer ændringer…'
    }
  }

  if (sync.includes('sync-fejl')) {
    return {
      state: 'error',
      label: 'Sync-fejl',
      detail: props.syncStatus || 'Der opstod en synkroniseringsfejl'
    }
  }

  if (dirty) {
    return {
      state: 'dirty',
      label: 'Ikke gemt',
      detail: 'Lokale ændringer venter på synk'
    }
  }

  return {
    state: 'synced',
    label: 'Synkroniseret',
    detail: props.syncStatus || 'Alle ændringer er synkroniseret'
  }
})

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

function handleStatusClick() {
  if (!isTouchLike.value) return
  showTooltip.value = !showTooltip.value
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
  if (!isTouchLike.value) return
  const target = event.target as HTMLElement | null
  if (target?.closest('.status-indicator-wrap')) return
  showTooltip.value = false
}

onMounted(() => {
  updateInputMode()
  window.addEventListener('resize', updateInputMode)
  window.addEventListener('pointerdown', onGlobalPointerDown)
})

onUnmounted(() => {
  window.removeEventListener('resize', updateInputMode)
  window.removeEventListener('pointerdown', onGlobalPointerDown)
})
</script>

<template>
  <header class="toolbar">
    <div class="toolbar-left">
      <button v-if="showBack" class="back-button" @click="emit('back')" aria-label="Tilbage">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M14.7 5.3a1 1 0 0 1 0 1.4L10.41 11H20a1 1 0 1 1 0 2h-9.59l4.3 4.3a1 1 0 0 1-1.42 1.4l-6-6a1 1 0 0 1 0-1.4l6-6a1 1 0 0 1 1.41 0Z" fill="currentColor" />
        </svg>
      </button>

      <div class="status-indicator-wrap">
        <button
          class="status-indicator"
          :class="`state-${statusMeta.state}`"
          :aria-label="`${statusMeta.label}: ${statusMeta.detail}`"
          @mouseenter="showTooltip = true"
          @mouseleave="closeTooltip"
          @focus="showTooltip = true"
          @blur="closeTooltip"
          @click="handleStatusClick">
          <svg v-if="statusMeta.state === 'synced'" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 17.6a4.5 4.5 0 0 0-1.8-8.62 6 6 0 0 0-11.74 1.2A4 4 0 0 0 7 18h12a1 1 0 0 0 1-1v.6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            <path d="m9.2 13 2.1 2.1 4-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>

          <svg v-else-if="statusMeta.state === 'syncing'" class="spin" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 12a8 8 0 0 0-13.66-5.66" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            <path d="M6.2 3.8v3.7h3.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            <path d="M4 12a8 8 0 0 0 13.66 5.66" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
            <path d="M17.8 20.2v-3.7h-3.7" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
          </svg>

          <svg v-else-if="statusMeta.state === 'dirty'" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="5" fill="currentColor" />
          </svg>

          <svg v-else-if="statusMeta.state === 'offline'" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M20 17.6a4.5 4.5 0 0 0-1.8-8.62 6 6 0 0 0-11.74 1.2A4 4 0 0 0 7 18h12a1 1 0 0 0 1-1v.6Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
            <path d="m8 8 8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          </svg>

          <svg v-else viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 4 3.8 18.2c-.34.6.1 1.3.8 1.3h14.8c.7 0 1.14-.7.8-1.3L12 4Z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" />
            <path d="M12 9v5" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
            <circle cx="12" cy="16.8" r="1" fill="currentColor" />
          </svg>
        </button>

        <div v-if="showTooltip" class="status-tooltip" role="status">
          <strong>{{ statusMeta.label }}</strong>
          <span>{{ statusMeta.detail }}</span>
        </div>
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
