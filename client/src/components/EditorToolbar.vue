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
  List,
  ListOrdered,
  ListTodo,
  ChevronDown,
  Indent,
  Outdent,
  Quote
} from 'lucide-vue-next'
import type { Editor } from '@tiptap/vue-3'
import { Fragment } from '@tiptap/pm/model'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { t } from '../i18n'

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

function convertListSelection(target: 'bullet' | 'ordered' | 'task'): boolean {
  if (!props.editor) return false

  const editor = props.editor
  const { state } = editor
  const { schema, selection } = state

  const bulletList = schema.nodes.bulletList
  const orderedList = schema.nodes.orderedList
  const taskList = schema.nodes.taskList
  const listItem = schema.nodes.listItem
  const taskItem = schema.nodes.taskItem

  if (!bulletList || !orderedList || !taskList || !listItem || !taskItem) return false

  const isListNodeName = (name: string) => name === 'bulletList' || name === 'orderedList' || name === 'taskList'

  const outerListBounds = ($pos: typeof selection.$from) => {
    for (let depth = 1; depth <= $pos.depth; depth++) {
      const node = $pos.node(depth)
      if (!isListNodeName(node.type.name)) continue
      const start = $pos.before(depth)
      return { from: start, to: start + node.nodeSize }
    }
    return null
  }

  let from = selection.from
  let to = selection.to

  const fromBounds = outerListBounds(selection.$from)
  const toBounds = outerListBounds(selection.$to)

  if (fromBounds) from = Math.min(from, fromBounds.from)
  if (toBounds) from = Math.min(from, toBounds.from)
  if (fromBounds) to = Math.max(to, fromBounds.to)
  if (toBounds) to = Math.max(to, toBounds.to)

  const listRoots: Array<{ pos: number; nodeSize: number; node: ProseMirrorNode }> = []
  const addRootAt = (pos: number) => {
    const node = state.doc.nodeAt(pos)
    if (!node || !isListNodeName(node.type.name)) return
    if (listRoots.some((root) => root.pos === pos)) return
    listRoots.push({ pos, nodeSize: node.nodeSize, node })
  }

  if (fromBounds) addRootAt(fromBounds.from)
  if (toBounds) addRootAt(toBounds.from)

  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!isListNodeName(node.type.name)) return
    if (listRoots.some((root) => root.pos === pos)) return

    const insideExistingRoot = listRoots.some((root) => pos > root.pos && pos < root.pos + root.nodeSize)
    if (insideExistingRoot) return

    listRoots.push({ pos, nodeSize: node.nodeSize, node })
  })

  if (listRoots.length === 0) return false

  const targetNodeName = target === 'bullet' ? 'bulletList' : target === 'ordered' ? 'orderedList' : 'taskList'

  const unwrapListRoot = (root: ProseMirrorNode): Fragment => {
    const unwrapped: ProseMirrorNode[] = []

    root.forEach((item) => {
      item.forEach((child) => {
        unwrapped.push(child)
      })
    })

    return Fragment.fromArray(unwrapped)
  }

  const convertNode = (node: ProseMirrorNode): ProseMirrorNode => {
    const childNodes: ProseMirrorNode[] = []
    node.forEach((child) => {
      childNodes.push(convertNode(child))
    })
    const nextContent = Fragment.fromArray(childNodes)

    const nodeName = node.type.name

    if (target === 'bullet') {
      if (nodeName === 'taskList' || nodeName === 'orderedList') return bulletList.create(node.attrs, nextContent)
      if (nodeName === 'taskItem') return listItem.create(null, nextContent)
      return node.copy(nextContent)
    }

    if (target === 'ordered') {
      if (nodeName === 'taskList' || nodeName === 'bulletList') return orderedList.create(node.attrs, nextContent)
      if (nodeName === 'taskItem') return listItem.create(null, nextContent)
      return node.copy(nextContent)
    }

    if (nodeName === 'bulletList' || nodeName === 'orderedList') return taskList.create(node.attrs, nextContent)
    if (nodeName === 'listItem') return taskItem.create({ checked: false }, nextContent)

    return node.copy(nextContent)
  }

  let tr = state.tr
  listRoots
    .sort((a, b) => b.pos - a.pos)
    .forEach((root) => {
      const mappedPos = tr.mapping.map(root.pos)
      const currentRoot = tr.doc.nodeAt(mappedPos)
      if (!currentRoot) return

      if (currentRoot.type.name === targetNodeName) {
        tr = tr.replaceWith(mappedPos, mappedPos + currentRoot.nodeSize, unwrapListRoot(currentRoot))
        return
      }

      const converted = convertNode(currentRoot)
      tr = tr.replaceWith(mappedPos, mappedPos + currentRoot.nodeSize, converted)
    })

  if (!tr.docChanged) return false
  editor.view.dispatch(tr)
  return true
}

function applyRichListType(target: 'bullet' | 'ordered' | 'task') {
  if (!props.editor) return

  const changed = convertListSelection(target)
  if (changed) return

  if (target === 'bullet') props.editor.chain().focus().toggleBulletList().run()
  if (target === 'ordered') props.editor.chain().focus().toggleOrderedList().run()
  if (target === 'task') props.editor.chain().focus().toggleTaskList().run()
}

function indentRich() {
  if (!props.editor) return

  if (props.editor.isActive('taskItem')) {
    props.editor.chain().focus().sinkListItem('taskItem').run()
    return
  }

  props.editor.chain().focus().sinkListItem('listItem').run()
}

function outdentRich() {
  if (!props.editor) return

  if (props.editor.isActive('taskItem')) {
    props.editor.chain().focus().liftListItem('taskItem').run()
    return
  }

  props.editor.chain().focus().liftListItem('listItem').run()
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
  <div class="editor-toolbar" :aria-label="t('editorToolbar')">
    <div class="toolbar-row">
      <button :title="t('heading1')" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('heading', { level: 1 }) }" @click="run('h1', () => editor?.chain().focus().toggleHeading({ level: 1 }).run())"><Heading1 :size="18" /></button>
      <button :title="t('heading2')" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('heading', { level: 2 }) }" @click="run('h2', () => editor?.chain().focus().toggleHeading({ level: 2 }).run())"><Heading2 :size="18" /></button>
      <button :title="t('heading3')" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('heading', { level: 3 }) }" @click="run('h3', () => editor?.chain().focus().toggleHeading({ level: 3 }).run())"><Heading3 :size="18" /></button>

      <button :title="t('bulletList')" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('bulletList') }" @click="run('bullet', () => applyRichListType('bullet'))"><List :size="18" /></button>

      <button :title="t('orderedList')" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('orderedList') }" @click="run('ordered', () => applyRichListType('ordered'))"><ListOrdered :size="18" /></button>

      <button :title="t('taskList')" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('taskList') }" @click="run('task', () => applyRichListType('task'))"><ListTodo :size="18" /></button>

      <button v-if="isMobile" class="toolbar-more" :class="{ expanded: showMobileMore }" :title="showMobileMore ? t('hideMoreTools') : t('showMoreTools')" :aria-expanded="showMobileMore" @click="toggleMore"><ChevronDown :size="20" /></button>
    </div>

    <div
      class="toolbar-row toolbar-row-secondary"
      :class="{ collapsed: isMobile && !showMobileMore }"
      :aria-hidden="isMobile && !showMobileMore">
      <button :title="t('indent')" :disabled="isDisabled()" @click="run('indent', indentRich)"><Indent :size="18" /></button>

      <button :title="t('outdent')" :disabled="isDisabled()" @click="run('outdent', outdentRich)"><Outdent :size="18" /></button>

      <button :title="t('bold')" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('bold') }" @click="run('bold', () => editor?.chain().focus().toggleBold().run())"><Bold :size="18" /></button>

      <button :title="t('italic')" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('italic') }" @click="run('italic', () => editor?.chain().focus().toggleItalic().run())"><Italic :size="18" /></button>

      <button :title="t('quote')" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('blockquote') }" @click="run('blockquote', () => editor?.chain().focus().toggleBlockquote().run())"><Quote :size="18" /></button>

      <button :title="t('inlineCode')" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('code') }" @click="run('code', () => editor?.chain().focus().toggleCode().run())"><Code :size="18" /></button>

      <button :title="t('codeBlock')" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('codeBlock') }" @click="run('codeBlock', () => editor?.chain().focus().toggleCodeBlock().run())"><FileCode :size="18" /></button>

      <button v-if="!isMobile" class="mode-toggle" :title="t('toggleMarkdownWysiwyg')" :class="{ active: isPlain }" @click="emit('toggle-plain')">
        <FileText :size="18" />
      </button>
    </div>
  </div>
</template>
