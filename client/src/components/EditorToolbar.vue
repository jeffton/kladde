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
import { TextSelection } from '@tiptap/pm/state'
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
let lastListSelectionText: string | null = null

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

  const findNearestListRoot = ($pos: typeof selection.$from): number | null => {
    for (let depth = $pos.depth; depth >= 1; depth--) {
      const node = $pos.node(depth)
      if (!isListNodeName(node.type.name)) continue
      return $pos.before(depth)
    }
    return null
  }

  const listRoots: number[] = []
  const addListRoot = (pos: number | null) => {
    if (typeof pos !== 'number') return
    const node = state.doc.nodeAt(pos)
    if (!node || !isListNodeName(node.type.name)) return
    if (listRoots.includes(pos)) return
    listRoots.push(pos)
  }

  addListRoot(findNearestListRoot(selection.$from))
  addListRoot(findNearestListRoot(selection.$to))

  if (!selection.empty && listRoots.length === 0) {
    state.doc.nodesBetween(selection.from, selection.to, (node, pos) => {
      if (!isListNodeName(node.type.name)) return
      if (listRoots.includes(pos)) return
      listRoots.push(pos)
    })
  }

  if (listRoots.length === 0) return false

  const targetNodeName = target === 'bullet' ? 'bulletList' : target === 'ordered' ? 'orderedList' : 'taskList'
  const targetListType = target === 'bullet' ? bulletList : target === 'ordered' ? orderedList : taskList

  const convertSelectedItem = (item: ProseMirrorNode): ProseMirrorNode => {
    if (target === 'task') {
      if (item.type.name === 'taskItem') return item
      return taskItem.create({ checked: false }, item.content)
    }

    if (item.type.name === 'listItem') return item
    return listItem.create(null, item.content)
  }

  const findFirstTextPosition = (doc: typeof state.doc, from: number, to: number): number | null => {
    let found: number | null = null

    doc.nodesBetween(from, to, (node, pos) => {
      if (found != null) return false
      if (!node.isText || !node.text?.length) return
      found = pos + 1
      return false
    })

    return found
  }

  let tr = state.tr
  const collapsed = selection.empty
  let preferredSelectionPos: number | null = null

  listRoots
    .sort((a, b) => b - a)
    .forEach((rootPos) => {
      const mappedRootPos = tr.mapping.map(rootPos)
      const currentRoot = tr.doc.nodeAt(mappedRootPos)
      if (!currentRoot || !isListNodeName(currentRoot.type.name)) return

      const mappedFrom = tr.mapping.map(selection.from)
      const mappedTo = tr.mapping.map(selection.to)

      const replacementNodes: ProseMirrorNode[] = []
      let bufferedMode: 'unchanged' | 'converted' | null = null
      let bufferedItems: ProseMirrorNode[] = []
      let hasSelectedItems = false

      const flushBufferedItems = () => {
        if (!bufferedMode || bufferedItems.length === 0) return

        const content = Fragment.fromArray(bufferedItems)
        if (bufferedMode === 'unchanged') {
          replacementNodes.push(currentRoot.type.create(currentRoot.attrs, content))
        } else {
          replacementNodes.push(targetListType.create(currentRoot.attrs, content))
        }

        bufferedMode = null
        bufferedItems = []
      }

      currentRoot.forEach((item, offset) => {
        const itemFrom = mappedRootPos + 1 + offset
        const itemTo = itemFrom + item.nodeSize

        const isSelected = collapsed
          ? mappedFrom >= itemFrom && mappedFrom <= itemTo
          : itemTo > mappedFrom && itemFrom < mappedTo

        if (!isSelected) {
          if (bufferedMode !== 'unchanged') {
            flushBufferedItems()
            bufferedMode = 'unchanged'
          }
          bufferedItems.push(item)
          return
        }

        hasSelectedItems = true

        if (currentRoot.type.name === targetNodeName) {
          flushBufferedItems()
          item.forEach((child) => {
            replacementNodes.push(child)
          })
          return
        }

        if (bufferedMode !== 'converted') {
          flushBufferedItems()
          bufferedMode = 'converted'
        }

        bufferedItems.push(convertSelectedItem(item))
      })

      flushBufferedItems()

      if (!hasSelectedItems) return

      const shouldSetPreferred = collapsed
        && preferredSelectionPos == null
        && mappedFrom >= mappedRootPos
        && mappedFrom <= mappedRootPos + currentRoot.nodeSize

      const replacementFragment = Fragment.fromArray(replacementNodes)

      tr = tr.replaceWith(
        mappedRootPos,
        mappedRootPos + currentRoot.nodeSize,
        replacementFragment
      )

      if (shouldSetPreferred) {
        const insertedTo = mappedRootPos + replacementFragment.size
        preferredSelectionPos = findFirstTextPosition(tr.doc, mappedRootPos, insertedTo) ?? (mappedRootPos + 1)
      }
    })

  if (!tr.docChanged) return false

  const docMax = Math.max(1, tr.doc.content.size)
  const clamp = (pos: number) => Math.min(Math.max(pos, 1), docMax)

  if (preferredSelectionPos != null) {
    const resolved = tr.doc.resolve(clamp(preferredSelectionPos))
    const nextSelection = TextSelection.findFrom(resolved, 1, true) || TextSelection.near(resolved, 1)
    tr = tr.setSelection(nextSelection)
  } else {
    const mappedAnchor = clamp(tr.mapping.map(selection.anchor, 1))
    const mappedHead = clamp(tr.mapping.map(selection.head, 1))

    try {
      tr = tr.setSelection(TextSelection.create(tr.doc, mappedAnchor, mappedHead))
    } catch {
      tr = tr.setSelection(TextSelection.near(tr.doc.resolve(mappedAnchor), -1))
    }
  }

  editor.view.dispatch(tr)
  return true
}

function captureSelectionParagraphText(): string | null {
  if (!props.editor || !props.editor.state.selection.empty) return null

  const domSelection = window.getSelection()
  const anchorNode = domSelection?.anchorNode
  if (!anchorNode) return null

  const anchorElement = anchorNode.nodeType === Node.ELEMENT_NODE
    ? (anchorNode as Element)
    : anchorNode.parentElement

  const paragraph = anchorElement?.closest('p')
  const text = paragraph?.textContent?.trim() || ''
  return text || null
}

function restoreSelectionParagraphText(text: string | null) {
  if (!props.editor || !text) return

  const root = props.editor.view.dom as HTMLElement
  const target = Array.from(root.querySelectorAll('p')).find((node) => (node.textContent || '').trim() === text)
  if (!target) return

  const targetNode = target.firstChild || target
  const offset = targetNode.nodeType === Node.TEXT_NODE ? (targetNode.textContent?.length || 0) : 0
  const targetPos = props.editor.view.posAtDOM(targetNode, offset)

  try {
    const tr = props.editor.state.tr.setSelection(TextSelection.create(props.editor.state.doc, targetPos))
    props.editor.view.dispatch(tr)
  } catch {
    const fallback = TextSelection.near(props.editor.state.doc.resolve(Math.max(1, targetPos)), 1)
    props.editor.view.dispatch(props.editor.state.tr.setSelection(fallback))
  }
}

function applyRichListType(target: 'bullet' | 'ordered' | 'task') {
  if (!props.editor) return

  const selectionText = captureSelectionParagraphText() || lastListSelectionText
  if (selectionText) restoreSelectionParagraphText(selectionText)

  props.editor.chain().focus().run()

  const changed = convertListSelection(target)
  if (changed) {
    lastListSelectionText = selectionText
    restoreSelectionParagraphText(selectionText)
    return
  }

  if (target === 'bullet') props.editor.chain().focus().toggleBulletList().run()
  if (target === 'ordered') props.editor.chain().focus().toggleOrderedList().run()
  if (target === 'task') props.editor.chain().focus().toggleTaskList().run()

  lastListSelectionText = selectionText
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

      <button :title="t('bulletList')" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('bulletList') }" @pointerdown.prevent @mousedown.prevent @click="run('bullet', () => applyRichListType('bullet'))"><List :size="18" /></button>

      <button :title="t('orderedList')" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('orderedList') }" @pointerdown.prevent @mousedown.prevent @click="run('ordered', () => applyRichListType('ordered'))"><ListOrdered :size="18" /></button>

      <button :title="t('taskList')" :disabled="isDisabled()" :class="{ active: !isPlain && editor?.isActive('taskList') }" @pointerdown.prevent @mousedown.prevent @click="run('task', () => applyRichListType('task'))"><ListTodo :size="18" /></button>

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
