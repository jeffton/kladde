import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { registerSW } from 'virtual:pwa-register'
import App from './App.vue'
import './style.css'
import '@milkdown/theme-nord/style.css'

registerSW({ immediate: true })

const app = createApp(App)
app.use(createPinia())
app.mount('#app')
