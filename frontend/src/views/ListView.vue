<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError, api, isRefreshable } from '../api';
import type { CommandType, RequirementListItem, UserBrief } from '../types';

const router = useRouter();

const items = ref<RequirementListItem[]>([]);
const members = ref<UserBrief[]>([]);
const loading = ref(false);
const error = ref('');
const notice = ref('');
const busyId = ref<string | null>(null);

const filters = reactive({
  scope: 'all' as 'all' | 'proposed' | 'assigned',
  state: '' as '' | 'PENDING' | 'IN_PROGRESS' | 'IN_REVIEW' | 'COMPLETED',
  keyword: '',
});

const stateOptions = [
  { value: '', label: '全部状态' },
  { value: 'PENDING', label: '待处理' },
  { value: 'IN_PROGRESS', label: '进行中' },
  { value: 'IN_REVIEW', label: '待验收' },
  { value: 'COMPLETED', label: '已完成' },
];

const scopeOptions = [
  { value: 'all', label: '全部' },
  { value: 'proposed', label: '我提出的' },
  { value: 'assigned', label: '我负责的' },
] as const;

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    items.value = await api.listRequirements({
      scope: filters.scope,
      state: filters.state || undefined,
      keyword: filters.keyword.trim() || undefined,
    });
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await load();
  try {
    members.value = await api.members();
  } catch {
    members.value = [];
  }
});

function roleTag(role: string): string {
  if (role === 'PROPOSER') return '提出者';
  if (role === 'ASSIGNEE') return '负责人';
  return '—';
}

function fmtDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

/** 列表内可直接完成的动作：仅「开始处理」（无需额外输入） */
function canStartInline(item: RequirementListItem): boolean {
  return item.nextActions.includes('START');
}

async function startInline(item: RequirementListItem): Promise<void> {
  busyId.value = item.id;
  error.value = '';
  notice.value = '';
  try {
    await api.start(item.id, item.rowVersion);
    notice.value = `「${item.title}」已开始处理`;
    await load();
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '操作失败';
    if (isRefreshable(e)) await load();
  } finally {
    busyId.value = null;
  }
}

/** 需要在详情页完成输入的动作 */
function needsDetail(item: RequirementListItem): boolean {
  const set: CommandType[] = ['EDIT', 'SUBMIT', 'REVIEW_RETURN', 'REVIEW_COMPLETE'];
  return item.nextActions.some((a) => set.includes(a));
}

function openDetail(id: string): void {
  void router.push({ name: 'detail', params: { id } });
}

// ────────────────── 新建需求 ──────────────────

const createOpen = ref(false);
const creating = ref(false);
const createError = ref('');
const createForm = reactive({
  title: '',
  description: '',
  assigneeId: '',
  criteriaText: '',
});

function openCreate(): void {
  createForm.title = '';
  createForm.description = '';
  createForm.assigneeId = members.value[0]?.id ?? '';
  createForm.criteriaText = '';
  createError.value = '';
  createOpen.value = true;
}

function closeCreate(): void {
  if (!creating.value) createOpen.value = false;
}

async function submitCreate(): Promise<void> {
  createError.value = '';
  const criteria = createForm.criteriaText
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (!createForm.title.trim()) {
    createError.value = '请填写标题';
    return;
  }
  if (!createForm.description.trim()) {
    createError.value = '请填写问题与内容说明';
    return;
  }
  if (!createForm.assigneeId) {
    createError.value = '请指定负责人';
    return;
  }
  if (criteria.length === 0) {
    createError.value = '至少需要一条可核对的验收条件（每行一条）';
    return;
  }

  creating.value = true;
  try {
    const created = await api.create({
      title: createForm.title.trim(),
      description: createForm.description.trim(),
      assigneeId: createForm.assigneeId,
      criteria,
    });
    createOpen.value = false;
    notice.value = '需求已创建（初始状态：待处理）';
    await load();
    void router.push({ name: 'detail', params: { id: created.id } });
  } catch (e) {
    createError.value = e instanceof ApiError ? e.message : '创建失败';
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <main class="page">
    <div class="card">
      <div class="toolbar">
        <div class="seg">
          <button
            v-for="s in scopeOptions"
            :key="s.value"
            type="button"
            :class="{ active: filters.scope === s.value }"
            @click="((filters.scope = s.value), load())"
          >
            {{ s.label }}
          </button>
        </div>

        <select
          v-model="filters.state"
          class="select"
          style="width: 130px"
          @change="load()"
        >
          <option v-for="o in stateOptions" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>

        <div class="grow" style="flex: 1; min-width: 180px">
          <input
            v-model="filters.keyword"
            class="input"
            type="search"
            placeholder="按标题搜索…"
            @keyup.enter="load()"
          />
        </div>

        <button class="btn" type="button" :disabled="loading" @click="load()">查询</button>
        <button class="btn btn-primary" type="button" @click="openCreate">新建需求</button>
      </div>

      <div v-if="error || notice" style="padding: 14px 18px 0">
        <div v-if="error" class="alert alert-error" style="margin-bottom: 0">{{ error }}</div>
        <div v-else-if="notice" class="alert alert-info" style="margin-bottom: 0">{{ notice }}</div>
      </div>

      <div v-if="loading" class="empty">加载中…</div>

      <div v-else-if="items.length === 0" class="empty">
        没有符合条件的需求。<br />
        <span class="small">仅显示与你相关（你提出或你负责）的需求。</span>
      </div>

      <div v-else>
        <div v-for="item in items" :key="item.id" class="list-item">
          <div class="list-item-main">
            <div class="list-item-title">
              <a href="#" @click.prevent="openDetail(item.id)">{{ item.title }}</a>
              <span class="badge" :class="item.state">{{ item.stateLabel }}</span>
              <span v-if="item.myRole !== 'IRRELEVANT'" class="tag" :class="`role-${item.myRole}`">
                {{ roleTag(item.myRole) }}
              </span>
            </div>
            <div class="list-item-meta">
              <span>提出者：{{ item.proposer.name }}</span>
              <span>负责人：{{ item.assignee.name }}</span>
              <span>验收条件 {{ item.criteriaCount }} 条</span>
              <span v-if="item.latestSubmissionNo">最新提交 V{{ item.latestSubmissionNo }}</span>
              <span>更新于 {{ fmtDate(item.updatedAt) }}</span>
            </div>
          </div>

          <div class="list-item-actions">
            <button
              v-if="canStartInline(item)"
              class="btn btn-sm btn-primary"
              type="button"
              :disabled="busyId === item.id"
              @click="startInline(item)"
            >
              {{ busyId === item.id ? '处理中…' : '开始处理' }}
            </button>
            <button
              v-if="needsDetail(item)"
              class="btn btn-sm"
              type="button"
              @click="openDetail(item.id)"
            >
              去处理
            </button>
            <button class="btn btn-sm btn-ghost" type="button" @click="openDetail(item.id)">
              详情
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- 新建需求 -->
    <div v-if="createOpen" class="overlay" @click.self="closeCreate">
      <div class="modal">
        <div class="modal-head">
          <h3>新建需求</h3>
          <button class="icon-btn" type="button" @click="closeCreate">×</button>
        </div>

        <div class="modal-body">
          <div v-if="createError" class="alert alert-error">{{ createError }}</div>

          <div class="field">
            <label>标题</label>
            <input v-model="createForm.title" class="input" maxlength="200" placeholder="一句话说明需求" />
          </div>

          <div class="field">
            <label>问题与内容说明</label>
            <textarea
              v-model="createForm.description"
              class="textarea"
              placeholder="描述背景、问题与期望结果"
            />
          </div>

          <div class="field">
            <label>负责人</label>
            <select v-model="createForm.assigneeId" class="select">
              <option value="" disabled>请选择负责人</option>
              <option v-for="m in members" :key="m.id" :value="m.id">
                {{ m.name }}（{{ m.account }}）
              </option>
            </select>
            <div class="hint">负责人不能与提出者相同；开始处理后正文与验收条件将冻结。</div>
          </div>

          <div class="field" style="margin-bottom: 0">
            <label>验收条件</label>
            <textarea
              v-model="createForm.criteriaText"
              class="textarea"
              placeholder="每行一条，例如：&#10;接口在 200ms 内返回&#10;失败场景有明确错误提示"
            />
            <div class="hint">每行一条，1~50 条；每条 ≤500 字符。</div>
          </div>
        </div>

        <div class="modal-foot">
          <button class="btn" type="button" :disabled="creating" @click="closeCreate">取消</button>
          <button class="btn btn-primary" type="button" :disabled="creating" @click="submitCreate">
            <span v-if="creating" class="spinner" />
            <span>{{ creating ? '创建中…' : '创建' }}</span>
          </button>
        </div>
      </div>
    </div>
  </main>
</template>
