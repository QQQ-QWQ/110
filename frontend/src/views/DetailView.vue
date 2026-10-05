<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError, api, isRefreshable } from '../api';
import { useAsyncAction } from '../composables/useAsyncAction';
import { useToast } from '../composables/useToast';
import AlertBox from '../components/AlertBox.vue';
import BaseButton from '../components/BaseButton.vue';
import BaseModal from '../components/BaseModal.vue';
import CriteriaList from '../components/CriteriaList.vue';
import EventTimeline from '../components/EventTimeline.vue';
import FormField from '../components/FormField.vue';
import NextStepCard from '../components/NextStepCard.vue';
import ReviewPanel from '../components/ReviewPanel.vue';
import RoleTag from '../components/RoleTag.vue';
import SkeletonList from '../components/SkeletonList.vue';
import StatusBadge from '../components/StatusBadge.vue';
import SubmissionCard from '../components/SubmissionCard.vue';
import { COMMAND_LABEL } from '../types';
import type { CommandType, RequirementDetail, ReviewPayload } from '../types';
import { formatDateTime } from '../utils/format';
import {
  countCodePoints,
  fieldFromServerMessage,
  splitLines,
  validateArtifacts,
  validateCriteria,
  validateDescription,
  validateNote,
  validateTitle,
  type FieldErrors,
} from '../utils/validate';

/**
 * DetailView —— 需求详情页。
 *
 * 页面结构（自上而下）：
 *   返回 → 头部（标题/状态/角色 + 元信息 + 动作区 + 下一步引导）
 *        → 问题与内容说明 → 验收条件 → 提交与验收记录 → 操作留痕
 *
 * 三类弹窗复用同一套基座：编辑（仅待处理）、提交成果（仅进行中）、逐项验收（仅待验收）。
 * 所有失败都会**保留用户已输入内容**并给出可读文案，绝不清空表单。
 */
const props = defineProps<{ id: string }>();
const router = useRouter();
const toast = useToast();
const { busy, error, lastError, run } = useAsyncAction();

const detail = ref<RequirementDetail | null>(null);
const loading = ref(true);
const loadError = ref('');

async function load(): Promise<void> {
  loading.value = true;
  loadError.value = '';
  try {
    detail.value = await api.detail(props.id);
  } catch (e) {
    detail.value = null;
    loadError.value = e instanceof ApiError ? e.message : '加载失败，请稍后重试';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => props.id, load);

const can = (command: CommandType): boolean => detail.value?.nextActions.includes(command) ?? false;

/** criterionId → "1. 条件文本"，用于把验收结果还原成可读条目 */
const criterionText = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {};
  for (const c of detail.value?.criteria ?? []) map[c.id] = `${c.seq}. ${c.text}`;
  return map;
});

/** 失败后的统一收尾：版本/状态冲突说明数据已陈旧，自动刷新拿最新 rowVersion */
async function settleFailure(inline?: (message: string) => void): Promise<void> {
  const message = error.value;
  if (inline) inline(message);
  else toast.error(message);
  if (isRefreshable(lastError.value)) await load();
}

// ────────────────── 开始处理 ──────────────────

async function doStart(): Promise<void> {
  const current = detail.value;
  if (!current) return;
  const ok = await run(() => api.start(current.id, current.rowVersion));
  if (ok) {
    toast.success('已开始处理，验收条件已冻结');
    await load();
    return;
  }
  await settleFailure();
}

// ────────────────── 编辑 ──────────────────

const editOpen = ref(false);
const editFormError = ref('');
const editErrors = ref<FieldErrors>({});
const editForm = reactive({ title: '', description: '', criteriaText: '' });

function openEdit(): void {
  const current = detail.value;
  if (!current) return;
  editForm.title = current.title;
  editForm.description = current.description;
  editForm.criteriaText = current.criteria.map((c) => c.text).join('\n');
  editErrors.value = {};
  editFormError.value = '';
  editOpen.value = true;
}

async function saveEdit(): Promise<void> {
  const current = detail.value;
  if (!current) return;
  editFormError.value = '';

  const titleError = validateTitle(editForm.title);
  const descriptionError = validateDescription(editForm.description);
  const criteriaError = validateCriteria(splitLines(editForm.criteriaText));
  editErrors.value = {
    title: titleError ?? undefined,
    description: descriptionError ?? undefined,
    criteriaText: criteriaError ?? undefined,
  };
  if (titleError || descriptionError || criteriaError) return;

  const ok = await run(() =>
    api.edit(
      current.id,
      {
        title: editForm.title.trim(),
        description: editForm.description.trim(),
        criteria: splitLines(editForm.criteriaText),
      },
      current.rowVersion,
    ),
  );
  if (ok) {
    editOpen.value = false;
    toast.success('需求已更新');
    await load();
    return;
  }
  await settleFailure((message) => {
    const field = fieldFromServerMessage(message);
    if (field) editErrors.value = { ...editErrors.value, [field]: message };
    else editFormError.value = message;
  });
}

// ────────────────── 提交成果 ──────────────────

const submitOpen = ref(false);
const submitFormError = ref('');
const submitErrors = ref<FieldErrors>({});
const submitForm = reactive({ note: '', artifactsText: '' });

function openSubmit(): void {
  submitForm.note = '';
  submitForm.artifactsText = '';
  submitErrors.value = {};
  submitFormError.value = '';
  submitOpen.value = true;
}

async function doSubmit(): Promise<void> {
  const current = detail.value;
  if (!current) return;
  submitFormError.value = '';

  const artifacts = splitLines(submitForm.artifactsText);
  const artifactsError = validateArtifacts(artifacts);
  const noteError = validateNote(submitForm.note);
  submitErrors.value = { artifactsText: artifactsError ?? undefined, note: noteError ?? undefined };
  if (artifactsError || noteError) return;

  const ok = await run(() =>
    api.submit(current.id, { artifacts, note: submitForm.note.trim() }, current.rowVersion),
  );
  if (ok) {
    submitOpen.value = false;
    toast.success('成果已提交，等待提出者验收');
    await load();
    return;
  }
  await settleFailure((message) => {
    const field = fieldFromServerMessage(message);
    if (field) submitErrors.value = { ...submitErrors.value, [field]: message };
    else submitFormError.value = message;
  });
}

// ────────────────── 逐项验收 ──────────────────

const reviewOpen = ref(false);
const reviewServerError = ref('');

function openReview(): void {
  reviewServerError.value = '';
  reviewOpen.value = true;
}

async function doReview(payload: ReviewPayload): Promise<void> {
  const current = detail.value?.currentSubmission;
  if (!detail.value || !current) {
    reviewServerError.value = '当前没有可验收的提交';
    return;
  }
  reviewServerError.value = '';

  const ok = await run(() => api.review(current.id, payload, detail.value!.rowVersion));
  if (ok) {
    reviewOpen.value = false;
    toast.success(payload.action === 'RETURN' ? '已退回，负责人可重新提交' : '已确认完成');
    await load();
    return;
  }
  reviewServerError.value = error.value;
  if (isRefreshable(lastError.value)) await load();
}
</script>

<template>
  <main id="main-content" class="page">
    <div class="mb-1">
      <BaseButton size="sm" variant="ghost" @click="router.push({ name: 'list' })">
        ← 返回列表
      </BaseButton>
    </div>

    <div v-if="loading" class="card">
      <SkeletonList :rows="4" />
    </div>

    <div v-else-if="!detail" class="card">
      <div class="empty">
        <div class="empty-title">{{ loadError || '需求不存在或你无权访问' }}</div>
        <div class="empty-desc">与需求无关的账号访问会被拒绝，且不会暴露该需求是否存在。</div>
        <div class="mt-2">
          <BaseButton size="sm" @click="load">重试</BaseButton>
          <BaseButton size="sm" variant="ghost" @click="router.push({ name: 'list' })">
            返回列表
          </BaseButton>
        </div>
      </div>
    </div>

    <template v-else>
      <!-- 头部：标题 / 状态 / 角色 / 元信息 / 动作 / 下一步 -->
      <section class="card">
        <div class="detail-head">
          <div class="list-item-title" style="margin-bottom: 0">
            <h1 class="detail-title">{{ detail.title }}</h1>
            <StatusBadge :state="detail.state" :label="detail.stateLabel" />
            <RoleTag :role="detail.myRole" />
          </div>

          <div class="meta-grid">
            <div class="meta-item">
              <div class="k">提出者</div>
              <div class="v">{{ detail.proposer.name }}（{{ detail.proposer.account }}）</div>
            </div>
            <div class="meta-item">
              <div class="k">负责人</div>
              <div class="v">{{ detail.assignee.name }}（{{ detail.assignee.account }}）</div>
            </div>
            <div class="meta-item">
              <div class="k">版本号（row_version）</div>
              <div class="v mono">{{ detail.rowVersion }}</div>
            </div>
            <div class="meta-item">
              <div class="k">最近更新</div>
              <div class="v">{{ formatDateTime(detail.updatedAt) }}</div>
            </div>
          </div>

          <div v-if="detail.nextActions.length > 0" class="row mt-2">
            <BaseButton v-if="can('EDIT')" :disabled="busy" @click="openEdit">
              {{ COMMAND_LABEL.EDIT }}
            </BaseButton>
            <BaseButton v-if="can('START')" variant="primary" :loading="busy" @click="doStart">
              {{ busy ? '处理中…' : COMMAND_LABEL.START }}
            </BaseButton>
            <BaseButton v-if="can('SUBMIT')" variant="primary" @click="openSubmit">
              {{ COMMAND_LABEL.SUBMIT }}
            </BaseButton>
            <BaseButton
              v-if="can('REVIEW_RETURN') || can('REVIEW_COMPLETE')"
              variant="primary"
              @click="openReview"
            >
              逐项验收
            </BaseButton>
          </div>

          <div class="mt-2">
            <NextStepCard
              :state="detail.state"
              :my-role="detail.myRole"
              :next-actions="detail.nextActions"
            />
          </div>
        </div>

        <div class="card-body">
          <h3 class="mb-1" style="font-size: 13px; color: var(--c-text-muted)">问题与内容说明</h3>
          <div class="prose">{{ detail.description }}</div>
        </div>
      </section>

      <!-- 验收条件 -->
      <section class="card">
        <div class="card-head">
          <h3>验收条件（{{ detail.criteria.length }} 条）</h3>
          <span class="faint small">开始处理后冻结，双方以此为唯一标准</span>
        </div>
        <div class="card-body">
          <CriteriaList :criteria="detail.criteria" />
        </div>
      </section>

      <!-- 提交与验收记录 -->
      <section class="card">
        <div class="card-head">
          <h3>提交与验收记录（{{ detail.submissions.length }} 次提交）</h3>
          <span class="faint small">每次提交独立保留，旧记录不被覆盖</span>
        </div>
        <div class="card-body">
          <div v-if="detail.submissions.length === 0" class="faint small">负责人尚未提交成果。</div>

          <SubmissionCard
            v-for="submission in detail.submissions"
            :key="submission.id"
            :submission="submission"
            :is-current="submission.id === detail.currentSubmissionId"
            :criterion-text="criterionText"
          />
        </div>
      </section>

      <!-- 操作留痕 -->
      <section class="card">
        <div class="card-head">
          <h3>操作留痕（{{ detail.events.length }} 条事件）</h3>
          <span class="faint small">追加式记录，不可篡改</span>
        </div>
        <div class="card-body">
          <EventTimeline :events="detail.events" />
        </div>
      </section>
    </template>

    <!-- 编辑需求 -->
    <BaseModal v-model="editOpen" title="编辑需求" :closable="!busy">
      <AlertBox v-if="editFormError" kind="error" class="mb-2">{{ editFormError }}</AlertBox>

      <FormField
        label="标题"
        required
        for-id="edit-title"
        :error="editErrors.title"
        :counter="`${countCodePoints(editForm.title)} / 200`"
      >
        <input id="edit-title" v-model="editForm.title" class="input" maxlength="200" />
      </FormField>

      <FormField
        label="问题与内容说明"
        required
        for-id="edit-description"
        :error="editErrors.description"
      >
        <textarea id="edit-description" v-model="editForm.description" class="textarea" />
      </FormField>

      <FormField
        label="验收条件"
        required
        for-id="edit-criteria"
        :error="editErrors.criteriaText"
        hint="每行一条。仅在「待处理」阶段可编辑；开始处理后将被冻结。"
      >
        <textarea id="edit-criteria" v-model="editForm.criteriaText" class="textarea" />
      </FormField>

      <template #footer>
        <BaseButton :disabled="busy" @click="editOpen = false">取消</BaseButton>
        <BaseButton variant="primary" :loading="busy" @click="saveEdit">
          {{ busy ? '保存中…' : '保存' }}
        </BaseButton>
      </template>
    </BaseModal>

    <!-- 提交成果 -->
    <BaseModal v-model="submitOpen" title="提交成果" :closable="!busy">
      <AlertBox v-if="submitFormError" kind="error" class="mb-2">{{ submitFormError }}</AlertBox>
      <AlertBox kind="info" class="mb-2">
        每次提交都会生成新的版本号（V1、V2…），历史版本不会被覆盖。
      </AlertBox>

      <FormField
        label="成果链接"
        required
        for-id="submit-artifacts"
        :error="submitErrors.artifactsText"
        hint="每行一个完整 URL，1~20 个，须以 http:// 或 https:// 开头。"
      >
        <textarea
          id="submit-artifacts"
          v-model="submitForm.artifactsText"
          class="textarea"
          placeholder="https://github.com/org/repo/pull/12"
        />
      </FormField>

      <FormField
        label="完成说明"
        required
        for-id="submit-note"
        :error="submitErrors.note"
        hint="说明本次实现了什么、如何验证；可对应到具体验收条件。"
      >
        <textarea
          id="submit-note"
          v-model="submitForm.note"
          class="textarea"
          placeholder="例如：已实现 CSV 导出，入口在列表页右上角；附上验证步骤与截图链接。"
        />
      </FormField>

      <template #footer>
        <BaseButton :disabled="busy" @click="submitOpen = false">取消</BaseButton>
        <BaseButton variant="primary" :loading="busy" @click="doSubmit">
          {{ busy ? '提交中…' : '提交' }}
        </BaseButton>
      </template>
    </BaseModal>

    <!-- 逐项验收 -->
    <ReviewPanel
      v-if="detail"
      v-model="reviewOpen"
      :criteria="detail.criteria"
      :submission-no="detail.currentSubmission?.submissionNo ?? 0"
      :busy="busy"
      :server-error="reviewServerError"
      @submit="doReview"
    />
  </main>
</template>
