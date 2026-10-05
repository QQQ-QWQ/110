<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, api } from '../api';
import { setAuthed } from '../router';

const route = useRoute();
const router = useRouter();

const form = reactive({ account: '', password: '' });
const loading = ref(false);
const error = ref('');

/** 演示账号：种子数据预置，便于考核评审快速验证三种角色视角 */
const demoAccounts = [
  { account: 'alice', label: 'Alice（提出者视角）' },
  { account: 'bob', label: 'Bob（负责人视角）' },
  { account: 'carol', label: 'Carol（第三方视角）' },
];
const demoPassword = 'Passw0rd!';

function fill(account: string): void {
  form.account = account;
  form.password = demoPassword;
}

async function submit(): Promise<void> {
  error.value = '';
  if (!form.account.trim() || !form.password) {
    error.value = '请输入账号与密码';
    return;
  }

  loading.value = true;
  try {
    await api.login(form.account.trim(), form.password);
    setAuthed(true);
    const redirect = typeof route.query.redirect === 'string' ? route.query.redirect : '/';
    await router.push(redirect);
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '登录失败，请稍后重试';
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="page page-narrow" style="padding-top: 64px">
    <div class="card">
      <div class="card-body">
        <h1 style="font-size: 20px; margin-bottom: 6px">需求与验收协作台</h1>
        <p class="muted small mb-2">
          小团队需求流转与验收留痕平台。请使用团队账号登录。
        </p>

        <div v-if="error" class="alert alert-error">{{ error }}</div>

        <form @submit.prevent="submit">
          <div class="field">
            <label for="account">账号</label>
            <input
              id="account"
              v-model="form.account"
              class="input"
              type="text"
              autocomplete="username"
              placeholder="请输入账号"
            />
          </div>

          <div class="field">
            <label for="password">密码</label>
            <input
              id="password"
              v-model="form.password"
              class="input"
              type="password"
              autocomplete="current-password"
              placeholder="请输入密码"
            />
          </div>

          <button class="btn btn-primary" type="submit" :disabled="loading" style="width: 100%; height: 38px">
            <span v-if="loading" class="spinner" />
            <span>{{ loading ? '登录中…' : '登录' }}</span>
          </button>
        </form>

        <div class="mt-2">
          <div class="faint small mb-1">演示账号（点击填入，密码 {{ demoPassword }}）</div>
          <div class="row">
            <button
              v-for="d in demoAccounts"
              :key="d.account"
              class="btn btn-sm"
              type="button"
              @click="fill(d.account)"
            >
              {{ d.label }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>
