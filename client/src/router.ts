import { createRouter, createWebHistory } from 'vue-router'
import type { RouteRecordRaw } from 'vue-router'

const EmptyView = { template: '<div />' }

const routes: RouteRecordRaw[] = [
  { path: '/', name: 'list', component: EmptyView },
  { path: '/note/:key', name: 'note', component: EmptyView },
  { path: '/share/:token', name: 'share', component: EmptyView }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

export default router
