<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError, api } from '../api';
import { setAuthed } from '../router';
import AlertBox from '../components/AlertBox.vue';
import BaseButton from '../components/BaseButton.vue';
import FormField from '../components/FormField.vue';

/**
 * LoginView —— 登录页。
 *
 * 交互要点：
 *  - 字段级内联校验（失焦 / 提交时触发），而不是一个笼统的「请输入账号密码」；
 *  - 登录中按钮进入 loading 且禁用，防止重复提交；
 *  - 演示账号一键填入，供评审快速切换三种角色视角；
 *  - 登录失败展示后端语义化文案，不清空已输入的账号。
 */
const route = useRoute();
const router = useRouter();

const form = reactive({ account: '', password: '' });
const loading = ref(false);
const error = ref('');
const fieldErrors = reactive<{ account?: string; password?: string }>({});

const demoAccounts = [
  { account: 'alice', label: 'Alice · 提出者' },
  { account: 'bob', label: 'Bob · 负责人' },
  { account: 'carol', label: 'Carol · 无关成员' },
];
const demoPassword = 'Passw0rd!';

function clearErrors(): void {
  error.value = '';
  fieldErrors.account = undefined;
  fieldErrors.password = undefined;
}

function fill(account: string): void {
  form.account = account;
  form.password = demoPassword;
  clearErrors();
}

function validate(): boolean {
  fieldErrors.account = form.account.trim().length > 0 ? undefined : '请输入账号';
  fieldErrors.password = form.password.length > 0 ? undefined : '请输入密码';
  return fieldErrors.account === undefined && fieldErrors.password === undefined;
}

async function submit(): Promise<void> {
  clearErrors();
  if (!validate()) return;

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
  <main id="main-content" class="page page-narrow" style="padding-top: 56px">
    <div class="card">
      <div class="card-body">
        <h1 style="font-size: 20px; margin-bottom: 6px">需求与验收协作台</h1>
        <p class="muted small mb-2">
          小团队需求流转与验收留痕平台。提出者写清验收条件，负责人提交成果，逐项核对后确认完成。
        </p>

        <AlertBox v-if="error" kind="error" class="mb-2">{{ error }}</AlertBox>

        <form novalidate @submit.prevent="submit">
          <FormField label="账号" required for-id="account" :error="fieldErrors.account">
            <input
              id="account"
              v-model="form.account"
              class="input"
              type="text"
              autocomplete="username"
              placeholder="请输入账号"
              :aria-invalid="fieldErrors.account ? 'true' : undefined"
              @input="fieldErrors.account = undefined"
            />
          </FormField>

          <FormField label="密码" required for-id="password" :error="fieldErrors.password">
            <input
              id="password"
              v-model="form.password"
              class="input"
              type="password"
              autocomplete="current-password"
              placeholder="请输入密码"
              :aria-invalid="fieldErrors.password ? 'true' : undefined"
              @input="fieldErrors.password = undefined"
            />
          </FormField>

          <BaseButton
            class="mt-1"
            variant="primary"
            size="lg"
            block
            type="submit"
            :loading="loading"
          >
            {{ loading ? '登录中…' : '登录' }}
          </BaseButton>
        </form>

        <div class="mt-2">
          <div class="faint small mb-1">演示账号（点击填入，密码 {{ demoPassword }}）</div>
          <div class="row">
            <BaseButton
              v-for="demo in demoAccounts"
              :key="demo.account"
              size="sm"
              @click="fill(demo.account)"
            >
              {{ demo.label }}
            </BaseButton>
          </div>
        </div>
      </div>
    </div>
  </main>
</template>
