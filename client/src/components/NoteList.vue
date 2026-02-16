<script setup>
defineProps({
  notes: { type: Array, required: true },
  selectedTitle: { type: String, default: '' },
  pinned: { type: Object, required: true }
})

const emit = defineEmits(['create', 'select', 'toggle-pin'])

function capitalize(text = '') {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

function isSameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

function startOfWeek(date) {
  const copy = new Date(date)
  copy.setHours(0, 0, 0, 0)
  const day = copy.getDay()
  const diff = day === 0 ? 6 : day - 1 // Mandag = ugestart
  copy.setDate(copy.getDate() - diff)
  return copy
}

function formatUpdatedAt(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const now = new Date()
  const time = new Intl.DateTimeFormat('da-DK', {
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)

  if (isSameDay(date, now)) {
    return time
  }

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (isSameDay(date, yesterday)) {
    return `I går, ${time}`
  }

  if (date >= startOfWeek(now)) {
    const weekday = capitalize(
      new Intl.DateTimeFormat('da-DK', { weekday: 'long' }).format(date)
    )
    return `${weekday}, ${time}`
  }

  return new Intl.DateTimeFormat('da-DK', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(date)
}
</script>

<template>
  <aside class="sidebar">
    <h1>Noteapp</h1>
    <div class="create-row">
      <button class="create-button" @click="emit('create')" aria-label="Opret ny note">+</button>
    </div>

    <div class="list">
      <button
        v-for="note in notes"
        :key="note.title"
        class="note-item"
        :class="{ active: note.title === selectedTitle }"
        @click="emit('select', note.title)">
        <div>
          <strong>{{ note.title }}</strong>
          <small>{{ formatUpdatedAt(note.updatedAt) }}</small>
        </div>
        <span
          class="pin"
          :aria-label="pinned.has(note.title) ? 'Fjern stjerne' : 'Stjernemarkér note'"
          @click.stop="emit('toggle-pin', note.title)">{{ pinned.has(note.title) ? '★' : '☆' }}</span>
      </button>
    </div>
  </aside>
</template>
