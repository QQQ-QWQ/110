import { createRouter, createWebHistory, type RouteLocationNormalized } from 'vue-router';
import { api } from './api';

/**
 * 登录态缓存在模块作用域：首次导航时探一次 /auth/me，
 * 之后由登录/登出动作显式刷新，避免每次跳转都打一次接口。
 */
let authed: boolean | null = null;

export function setAuthed(value: boolean): void {
  authed = value;
}

export function isAuthed(): boolean {
  return authed === true;
}

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/login',
      name: 'login',
      component: () => import('./views/LoginView.vue'),
      meta: { public: true },
    },
    {
      path: '/',
      name: 'list',
      component: () => import('./views/ListView.vue'),
    },
    {
      path: '/requirements/:id',
      name: 'detail',
      component: () => import('./views/DetailView.vue'),
      props: true,
    },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.beforeEach(async (to: RouteLocationNormalized) => {
  if (authed === null) {
    try {
      await api.me();
      authed = true;
    } catch {
      authed = false;
    }
  }

  if (to.meta.public) {
    if (authed && to.name === 'login') return { name: 'list' };
    return true;
  }

  if (!authed) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  return true;
});

export default router;
