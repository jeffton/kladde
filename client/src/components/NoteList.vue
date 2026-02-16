<script setup>
defineProps({
  notes: { type: Array, required: true },
  selectedTitle: { type: String, default: '' },
  pinned: { type: Object, required: true }
})

const emit = defineEmits(['create', 'select', 'toggle-pin'])
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
          <small>{{ new Date(note.updatedAt).toLocaleString() }}</small>
        </div>
        <span class="pin" @click.stop="emit('toggle-pin', note.title)">{{ pinned.has(note.title) ? '📌' : '📍' }}</span>
      </button>
    </div>
  </aside>
</template>
