<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError, api, isRefreshable } from '../api';
import { useBreakpoint } from '../composables/useBreakpoint';
import { useCurrentUser } from '../composables/useCurrentUser';
import { useToast } from '../composables/useToast';
import AlertBox from '../components/AlertBox.vue';
import BaseButton from '../components/BaseButton.vue';
import BaseModal from '../components/BaseModal.vue';
import EmptyState from '../components/EmptyState.vue';
import FormField from '../components/FormField.vue';
import RoleTag from '../components/RoleTag.vue';
import SkeletonList from '../components/SkeletonList.vue';
import StatusBadge from '../components/StatusBadge.vue';
import type { CommandType, RequirementListItem, UserBrief } from '../types';
import { formatDateTime } from '../utils/format';
import {
  countCodePoints,
  fieldFromServerMessage,
  hasErrors,
  splitLines,
  validateCreateForm,
  type FieldErrors,
} from '../utils/validate';

/**
 * ListView —— 需求列表页。
 *
 * 页面结构（自上而下）：
 *   工具条（范围 / 状态 / 关键词 / 查询 / 新建）→ 反馈区 → 列表或空态
 *
 * 响应式：
 *   - 桌面：工具条一行铺开，搜索框自适应拉伸；
 *   - 移动：搜索框置顶，「筛选」折叠其余条件并显示生效数量，列表项转纵向卡片。
 *
 * 交互反馈：加载=骨架屏；空=解释性空态；失败=内联错误 + Toast；成功=Toast。
 */
const router = useRouter();
const { isMobile } = useBreakpoint();
const { current } = useCurrentUser();
const toast = useToast();

const items = ref<RequirementListItem[]>([]);
const members = ref<UserBrief[]>([]);
const loading = ref(true);
const loadError = ref('');
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

/** 移动端折叠筛选面板；桌面端恒展开 */
const filtersOpen = ref(false);
const showFilters = computed(() => !isMobile.value || filtersOpen.value);

const activeFilterCount = computed(() => {
  let count = 0;
  if (filters.scope !== 'all') count += 1;
  if (filters.state !== '') count += 1;
  if (filters.keyword.trim() !== '') count += 1;
  return count;
});

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    items.value = await api.listRequirements({
      scope: filters.scope,
      state: filters.state || undefined,
      keyword: filters.keyword.trim() || undefined,
    });
  } catch (e) {
    items.value = [];
    loadError.value = e instanceof ApiError ? e.message : '加载失败，请稍后重试';
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  await Promise.all([
    load(),
    api
      .members()
      .then((list) => (members.value = list))
      .catch(() => (members.value = [])),
  ]);
});

function applyFilters(): void {
  if (isMobile.value) filtersOpen.value = false;
  void load();
}

function resetFilters(): void {
  filters.scope = 'all';
  filters.state = '';
  filters.keyword = '';
  void load();
}

function openDetail(id: string): void {
  void router.push({ name: 'detail', params: { id } });
}

/** 列表内可直接完成的动作：仅「开始处理」（无需额外输入） */
function canStartInline(item: RequirementListItem): boolean {
  return item.nextActions.includes('START');
}

/** 需要在详情页完成输入的动作 */
function needsDetail(item: RequirementListItem): boolean {
  const set: CommandType[] = ['EDIT', 'SUBMIT', 'REVIEW_RETURN', 'REVIEW_COMPLETE'];
  return item.nextActions.some((action) => set.includes(action));
}

async function startInline(item: RequirementListItem): Promise<void> {
  busyId.value = item.id;
  try {
    await api.start(item.id, item.rowVersion);
    toast.success(`「${item.title}」已开始处理`);
    await load();
  } catch (e) {
    toast.error(e instanceof ApiError ? e.message : '操作失败，请稍后重试');
    // 版本过期 / 状态冲突：说明页面数据已陈旧，自动刷新
    if (isRefreshable(e)) await load();
  } finally {
    busyId.value = null;
  }
}

// ────────────────── 新建需求 ──────────────────

const createOpen = ref(false);
const creating = ref(false);
const createFormError = ref('');
const createErrors = ref<FieldErrors>({});
const createForm = reactive({
  title: '',
  description: '',
  assigneeId: '',
  criteriaText: '',
});

/** 负责人候选排除自己（后端硬约束：负责人 ≠ 提出者），从源头避免无效提交 */
const availableAssignees = computed(() =>
  members.value.filter((member) => member.id !== current.value?.id),
);

const criteriaLines = computed(() => splitLines(createForm.criteriaText));

function openCreate(): void {
  createForm.title = '';
  createForm.description = '';
  createForm.criteriaText = '';
  createForm.assigneeId = availableAssignees.value[0]?.id ?? '';
  createErrors.value = {};
  createFormError.value = '';
  createOpen.value = true;
}

function closeCreate(): void {
  if (!creating.value) createOpen.value = false;
}

function clearFieldError(field: string): void {
  if (createErrors.value[field]) {
    createErrors.value = { ...createErrors.value, [field]: undefined };
  }
}

async function submitCreate(): Promise<void> {
  createFormError.value = '';
  createErrors.value = validateCreateForm(createForm);

  if (createForm.assigneeId !== '' && createForm.assigneeId === current.value?.id) {
    createErrors.value = { ...createErrors.value, assigneeId: '负责人不能与提出者相同' };
  }
  if (hasErrors(createErrors.value)) return;

  creating.value = true;
  try {
    const created = await api.create({
      title: createForm.title.trim(),
      description: createForm.description.trim(),
      assigneeId: createForm.assigneeId,
      criteria: criteriaLines.value,
    });
    createOpen.value = false;
    toast.success('需求已创建（初始状态：待处理）');
    await load();
    void router.push({ name: 'detail', params: { id: created.id } });
  } catch (e) {
    const message = e instanceof ApiError ? e.message : '创建失败，请稍后重试';
    const field = fieldFromServerMessage(message);
    if (field) createErrors.value = { ...createErrors.value, [field]: message };
    else createFormError.value = message;
  } finally {
    creating.value = false;
  }
}
</script>

<template>
  <main id="main-content" class="page">
    <div class="card">
      <div class="toolbar">
        <div class="toolbar-filters">
          <div class="grow">
            <input
              v-model="filters.keyword"
              class="input"
              type="search"
              placeholder="按标题关键词搜索…"
              aria-label="按标题关键词搜索"
              @keyup.enter="applyFilters"
            />
          </div>

          <BaseButton v-if="isMobile" @click="filtersOpen = !filtersOpen">
            筛选{{ activeFilterCount > 0 ? ` · ${activeFilterCount}` : '' }}
          </BaseButton>

          <template v-if="showFilters">
            <div class="seg" role="group" aria-label="按归属范围筛选">
              <button
                v-for="option in scopeOptions"
                :key="option.value"
                type="button"
                :class="{ active: filters.scope === option.value }"
                :aria-pressed="filters.scope === option.value"
                @click="((filters.scope = option.value), applyFilters())"
              >
                {{ option.label }}
              </button>
            </div>

            <select
              v-model="filters.state"
              class="select"
              style="width: 130px"
              aria-label="按状态筛选"
              @change="applyFilters"
            >
              <option v-for="option in stateOptions" :key="option.value" :value="option.value">
                {{ option.label }}
              </option>
            </select>

            <BaseButton :loading="loading" @click="applyFilters">查询</BaseButton>
            <BaseButton v-if="activeFilterCount > 0" variant="ghost" @click="resetFilters">
              重置
            </BaseButton>
          </template>
        </div>

        <BaseButton variant="primary" @click="openCreate">新建需求</BaseButton>
      </div>

      <AlertBox v-if="loadError" kind="error" style="margin: 14px 20px 0">
        {{ loadError }}
        <BaseButton size="sm" style="margin-left: 8px" @click="load">重试</BaseButton>
      </AlertBox>

      <SkeletonList v-if="loading" :rows="3" />

      <EmptyState
        v-else-if="items.length === 0 && !loadError"
        title="没有符合条件的需求"
        :desc="
          activeFilterCount > 0
            ? '试试放宽筛选条件，或清空关键词后重新查询。'
            : '仅显示与你相关（你提出或你负责）的需求。'
        "
      >
        <BaseButton v-if="activeFilterCount > 0" @click="resetFilters">重置筛选</BaseButton>
        <BaseButton v-else variant="primary" @click="openCreate">新建第一条需求</BaseButton>
      </EmptyState>

      <div v-else-if="items.length > 0">
        <div class="faint small" style="padding: 12px 20px 0">共 {{ items.length }} 条需求</div>
        <div
          v-for="item in items"
          :key="item.id"
          class="list-item"
          style="border-top: 1px solid var(--c-border)"
        >
          <div class="list-item-main">
            <div class="list-item-title">
              <button class="list-item-link" type="button" @click="openDetail(item.id)">
                {{ item.title }}
              </button>
              <StatusBadge :state="item.state" :label="item.stateLabel" />
              <RoleTag :role="item.myRole" />
            </div>
            <div class="list-item-meta">
              <span>提出者：{{ item.proposer.name }}</span>
              <span>负责人：{{ item.assignee.name }}</span>
              <span>验收条件 {{ item.criteriaCount }} 条</span>
              <span v-if="item.latestSubmissionNo">最新提交 V{{ item.latestSubmissionNo }}</span>
              <span>更新于 {{ formatDateTime(item.updatedAt) }}</span>
            </div>
          </div>

          <div class="list-item-actions">
            <BaseButton
              v-if="canStartInline(item)"
              size="sm"
              variant="primary"
              :loading="busyId === item.id"
              @click="startInline(item)"
            >
              {{ busyId === item.id ? '处理中…' : '开始处理' }}
            </BaseButton>
            <BaseButton v-if="needsDetail(item)" size="sm" @click="openDetail(item.id)">
              去处理
            </BaseButton>
            <BaseButton size="sm" variant="ghost" @click="openDetail(item.id)">详情</BaseButton>
          </div>
        </div>
      </div>
    </div>

    <!-- 新建需求 -->
    <BaseModal v-model="createOpen" title="新建需求" :closable="!creating">
      <AlertBox v-if="createFormError" kind="error" class="mb-2">{{ createFormError }}</AlertBox>

      <FormField
        label="标题"
        required
        for-id="create-title"
        :error="createErrors.title"
        :counter="`${countCodePoints(createForm.title)} / 200`"
      >
        <input
          id="create-title"
          v-model="createForm.title"
          class="input"
          maxlength="200"
          placeholder="一句话说明需求"
          @input="clearFieldError('title')"
        />
      </FormField>

      <FormField
        label="问题与内容说明"
        required
        for-id="create-description"
        :error="createErrors.description"
        hint="描述背景、要解决的问题与期望结果。"
      >
        <textarea
          id="create-description"
          v-model="createForm.description"
          class="textarea"
          placeholder="例如：目前需求靠口头传达，交付标准不明确，改动后难以确认是否完成。"
          @input="clearFieldError('description')"
        />
      </FormField>

      <FormField
        label="负责人"
        required
        for-id="create-assignee"
        :error="createErrors.assigneeId"
        hint="负责人不能与提出者相同；开始处理后正文与验收条件将被冻结。"
      >
        <select
          id="create-assignee"
          v-model="createForm.assigneeId"
          class="select"
          @change="clearFieldError('assigneeId')"
        >
          <option value="" disabled>请选择负责人</option>
          <option v-for="member in availableAssignees" :key="member.id" :value="member.id">
            {{ member.name }}（{{ member.account }}）
          </option>
        </select>
      </FormField>

      <FormField
        label="验收条件"
        required
        for-id="create-criteria"
        :error="createErrors.criteriaText"
        hint="每行一条，1~50 条；每条不超过 500 字符。"
        :counter="`${criteriaLines.length} / 50 条`"
        :counter-over="criteriaLines.length > 50"
      >
        <textarea
          id="create-criteria"
          v-model="createForm.criteriaText"
          class="textarea"
          placeholder="每行一条，例如：&#10;接口在 200ms 内返回&#10;失败场景有明确错误提示"
          @input="clearFieldError('criteriaText')"
        />
      </FormField>

      <template #footer>
        <BaseButton :disabled="creating" @click="closeCreate">取消</BaseButton>
        <BaseButton variant="primary" :loading="creating" @click="submitCreate">
          {{ creating ? '创建中…' : '创建' }}
        </BaseButton>
      </template>
    </BaseModal>
  </main>
</template>
