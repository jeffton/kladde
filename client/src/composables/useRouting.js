import { ref } from 'vue'

export function useRouting({ store, selectNote }) {
  const isMobile = ref(window.matchMedia('(max-width: 900px)').matches)
  const mobileView = ref('editor') // 'list' | 'editor'
  const suppressHistoryPush = ref(false)

  function currentPathForState() {
    if (isMobile.value && mobileView.value === 'list') return '/'
    if (!store.selectedTitle) return '/'
    return `/note/${encodeURIComponent(store.selectedTitle)}`
  }

  function pushCurrentHistory() {
    if (suppressHistoryPush.value) return
    const nextPath = currentPathForState()
    if (window.location.pathname !== nextPath) {
      history.pushState({ title: store.selectedTitle, view: mobileView.value }, '', nextPath)
    }
  }

  async function applyRouteFromLocation(replace = false) {
    const path = window.location.pathname

    if (path.startsWith('/note/')) {
      const title = decodeURIComponent(path.replace('/note/', ''))
      if (title) {
        suppressHistoryPush.value = true
        try {
          await selectNote(title, true)
        } finally {
          suppressHistoryPush.value = false
        }
        mobileView.value = 'editor'
        if (replace) history.replaceState({ title: store.selectedTitle, view: 'editor' }, '', window.location.pathname)
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

  function replaceWithTitle(title) {
    const nextPath = `/note/${encodeURIComponent(title)}`
    history.replaceState({ title, view: mobileView.value }, '', nextPath)
  }

  function goBackToList() {
    mobileView.value = 'list'
    pushCurrentHistory()
  }

  return {
    isMobile,
    mobileView,
    suppressHistoryPush,
    pushCurrentHistory,
    applyRouteFromLocation,
    replaceWithTitle,
    goBackToList
  }
}
