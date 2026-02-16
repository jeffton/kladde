<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { Editor, rootCtx, defaultValueCtx, commandsCtx, editorViewCtx, prosePluginsCtx } from '@milkdown/core'
import {
  commonmark,
  createCodeBlockCommand,
  insertHrCommand,
  toggleEmphasisCommand,
  toggleInlineCodeCommand,
  toggleLinkCommand,
  toggleStrongCommand,
  wrapInBlockquoteCommand,
  wrapInBulletListCommand,
  wrapInHeadingCommand,
  wrapInOrderedListCommand,
} from '@milkdown/preset-commonmark'
import { gfm, toggleStrikethroughCommand } from '@milkdown/preset-gfm'
import { nord } from '@milkdown/theme-nord'
import { listener, listenerCtx } from '@milkdown/plugin-listener'
import { Plugin } from '@milkdown/prose/state'
import { useNotesStore } from './stores/notes'

const store = useNotesStore()
const editorEl = ref(null)
const milkdownEditor = ref(null)
const showPlain = ref(false)
const newTitle = ref('')
const error = ref('')
const isMobile = ref(window.matchMedia('(max-width: 900px)').matches)
const mobileView = ref('editor') // 'list' | 'editor'
let ignoreEditorChanges = false
let autosaveTimer = null
let syncTimer = null
let lastRenderedMarkdown = null
let suppressHistoryPush = false
let media = null
let mediaListener = null
let popStateHandler = null

const online = () => store.setOnline(true)
const offline = () => store.setOnline(false)

const sortedNotes = computed(() => store.sortedNotes)
const appShellClasses = computed(() => ({
  'mobile-list-view': isMobile.value && mobileView.value === 'list',
  'mobile-editor-view': isMobile.value && mobileView.value === 'editor',
}))

const saveLabel = computed(() => (store.dirty ? 'Ikke gemt' : 'Gemt'))

function currentPathForState() {
  if (isMobile.value && mobileView.value === 'list') return '/'
  if (!store.selectedTitle) return '/'
  return `/note/${encodeURIComponent(store.selectedTitle)}`
}

function pushCurrentHistory() {
  if (suppressHistoryPush) return
  const nextPath = currentPathForState()
  if (window.location.pathname !== nextPath) {
    history.pushState({ title: store.selectedTitle, view: mobileView.value }, '', nextPath)
  }
}

async function runCommand(command, payload) {
  if (!milkdownEditor.value) return

  milkdownEditor.value.action((ctx) => {
    ctx.get(commandsCtx).call(command.key, payload)
  })
}

function applyLink() {
  const href = window.prompt('Indsæt link (https://...)')
  if (!href) return
  runCommand(toggleLinkCommand, { href })
}

function insertTodoItem() {
  if (!milkdownEditor.value) return

  milkdownEditor.value.action((ctx) => {
    const view = ctx.get(editorViewCtx)
    const { state, dispatch } = view
    dispatch(state.tr.insertText('- [ ] '))
    view.focus()
  })
}

function createTaskTogglePlugin() {
  return new Plugin({
    props: {
      handleDOMEvents: {
        click(view, event) {
          const target = event.target
          if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return false

          const taskItem = target.closest('li[data-item-type="task"]')
          if (!taskItem) return false

          event.preventDefault()

          const pos = view.posAtDOM(taskItem, 0)
          const $pos = view.state.doc.resolve(pos)

          let nodePos = null
          let node = null

          for (let depth = $pos.depth; depth >= 0; depth--) {
            const candidate = $pos.node(depth)
            if (candidate.type.name === 'list_item' && candidate.attrs.checked != null) {
              nodePos = $pos.before(depth)
              node = candidate
              break
            }
          }

          if (nodePos == null || !node) return false

          view.dispatch(
            view.state.tr.setNodeMarkup(nodePos, undefined, {
              ...node.attrs,
              checked: !Boolean(node.attrs.checked),
            })
          )
          return true
        },
      },
    },
  })
}

async function destroyEditor() {
  if (!milkdownEditor.value) return
  await milkdownEditor.value.destroy()
  milkdownEditor.value = null
}

async function createEditor(content = '') {
  await destroyEditor()
  await nextTick()
  if (!editorEl.value) return

  ignoreEditorChanges = true

  milkdownEditor.value = await Editor.make()
    .config((ctx) => {
      ctx.set(rootCtx, editorEl.value)
      ctx.set(defaultValueCtx, content || '')
      ctx.update(prosePluginsCtx, (plugins) => [...plugins, createTaskTogglePlugin()])
      ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
        if (ignoreEditorChanges) return
        if (markdown !== store.currentContent) store.setCurrentContent(markdown)
      })
    })
    .use(commonmark)
    .use(gfm)
    .use(listener)
    .use(nord)
    .create()

  lastRenderedMarkdown = content || ''

  setTimeout(() => {
    ignoreEditorChanges = false
  }, 0)
}

async function load() {
  try {
    await store.initialize()
    await applyRouteFromLocation(true)
    if (!showPlain.value) await createEditor(store.currentContent)
  } catch (e) {
    error.value = e.message
  }
}

async function selectNote(title, fromRoute = false) {
  try {
    await store.selectNote(title)
    if (isMobile.value) mobileView.value = 'editor'
    if (!showPlain.value) await createEditor(store.currentContent)
    error.value = ''
    if (!fromRoute) pushCurrentHistory()
  } catch (e) {
    error.value = e.message
  }
}

async function createNote() {
  if (!newTitle.value.trim()) return
  try {
    await store.createNote(newTitle.value.trim())
    newTitle.value = ''
    if (isMobile.value) mobileView.value = 'editor'
    if (!showPlain.value) await createEditor(store.currentContent)
    error.value = ''
    pushCurrentHistory()
  } catch (e) {
    error.value = e.message
  }
}

function goBackToList() {
  mobileView.value = 'list'
  pushCurrentHistory()
}

function togglePin(title) {
  store.togglePin(title)
}

async function applyRouteFromLocation(replace = false) {
  const path = window.location.pathname

  if (path.startsWith('/note/')) {
    const title = decodeURIComponent(path.replace('/note/', ''))
    if (title) {
      suppressHistoryPush = true
      try {
        await selectNote(title, true)
      } finally {
        suppressHistoryPush = false
      }
      mobileView.value = 'editor'
      if (replace) history.replaceState({ title, view: 'editor' }, '', window.location.pathname)
      return
    }
  }

  if (isMobile.value) {
    mobileView.value = 'list'
  } else {
    mobileView.value = 'editor'
  }

  if (replace) history.replaceState({ title: store.selectedTitle, view: mobileView.value }, '', '/')
}

watch(showPlain, async (isPlain) => {
  if (!isPlain) {
    await createEditor(store.currentContent)
  } else {
    await destroyEditor()
  }
})

onMounted(async () => {
  await load()

  media = window.matchMedia('(max-width: 900px)')
  mediaListener = (event) => {
    isMobile.value = event.matches
    if (event.matches && !store.selectedTitle) mobileView.value = 'list'
    if (!event.matches) mobileView.value = 'editor'
  }

  media.addEventListener('change', mediaListener)

  popStateHandler = async () => {
    await applyRouteFromLocation()
  }

  window.addEventListener('popstate', popStateHandler)
  window.addEventListener('online', online)
  window.addEventListener('offline', offline)

  autosaveTimer = setInterval(async () => {
    if (!store.dirty) return
    try {
      await store.saveCurrent()
      error.value = ''
    } catch {
      // keep quiet, status already indicates failure
    }
  }, 2500)

  syncTimer = setInterval(async () => {
    if (!store.online) return
    try {
      await store.syncWithServer()
      if (!showPlain.value && !store.dirty && store.currentContent !== lastRenderedMarkdown) {
        await createEditor(store.currentContent)
      }
      error.value = ''
    } catch {
      // ignore transient sync errors
    }
  }, 15000)
})

onUnmounted(async () => {
  if (media && mediaListener) media.removeEventListener('change', mediaListener)
  if (popStateHandler) window.removeEventListener('popstate', popStateHandler)
  window.removeEventListener('online', online)
  window.removeEventListener('offline', offline)
  clearInterval(autosaveTimer)
  clearInterval(syncTimer)
  await destroyEditor()
})
</script>

<template>
  <div class="app-shell" :class="appShellClasses">
    <aside class="sidebar">
      <h1>Noteapp</h1>
      <div class="create-row">
        <input v-model="newTitle" placeholder="Ny note titel" @keyup.enter="createNote" />
        <button @click="createNote">Opret</button>
      </div>

      <div class="list">
        <button
          v-for="note in sortedNotes"
          :key="note.title"
          class="note-item"
          :class="{ active: note.title === store.selectedTitle }"
          @click="selectNote(note.title)">
          <div>
            <strong>{{ note.title }}</strong>
            <small>{{ new Date(note.updatedAt).toLocaleString() }}</small>
          </div>
          <span class="pin" @click.stop="togglePin(note.title)">{{ store.pinned.has(note.title) ? '📌' : '📍' }}</span>
        </button>
      </div>
    </aside>

    <main class="editor-area">
      <header class="toolbar">
        <div class="toolbar-left">
          <button v-if="isMobile && mobileView === 'editor'" class="back-button" @click="goBackToList">← Tilbage</button>
          <div class="status">
            <span :class="store.online ? 'online' : 'offline'">{{ store.online ? 'Online' : 'Offline' }}</span>
            <span>{{ saveLabel }}</span>
            <span>{{ store.syncStatus }}</span>
          </div>
        </div>
        <div class="actions">
          <button @click="showPlain = !showPlain">{{ showPlain ? 'WYSIWYG visning' : 'Plain markdown' }}</button>
        </div>
      </header>

      <div v-if="!showPlain" class="editor-toolbar" aria-label="Editor toolbar">
        <button @click="runCommand(toggleStrongCommand)"><strong>B</strong></button>
        <button @click="runCommand(toggleEmphasisCommand)"><em>I</em></button>
        <button @click="runCommand(toggleStrikethroughCommand)"><s>S</s></button>
        <button @click="runCommand(wrapInHeadingCommand, 1)">H1</button>
        <button @click="runCommand(wrapInHeadingCommand, 2)">H2</button>
        <button @click="runCommand(wrapInHeadingCommand, 3)">H3</button>
        <button @click="runCommand(wrapInBulletListCommand)">• Liste</button>
        <button @click="runCommand(wrapInOrderedListCommand)">1. Liste</button>
        <button @click="insertTodoItem">☑ Todo</button>
        <button @click="applyLink">Link</button>
        <button @click="runCommand(toggleInlineCodeCommand)">&lt;/&gt;</button>
        <button @click="runCommand(createCodeBlockCommand)">Kodeblok</button>
        <button @click="runCommand(wrapInBlockquoteCommand)">Quote</button>
        <button @click="runCommand(insertHrCommand)">—</button>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
      <section v-if="showPlain" class="plain-wrap">
        <textarea :value="store.currentContent" @input="store.setCurrentContent($event.target.value)"></textarea>
      </section>
      <section v-else class="wysiwyg-wrap"><div ref="editorEl" class="milkdown-root"></div></section>
    </main>
  </div>
</template>
