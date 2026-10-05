<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { ApiError, api, isRefreshable } from '../api';
import { COMMAND_LABEL, EVENT_LABEL } from '../types';
import type { CommandType, RequirementDetail } from '../types';

const props = defineProps<{ id: string }>();
const router = useRouter();

const detail = ref<RequirementDetail | null>(null);
const loading = ref(true);
const busy = ref(false);
const error = ref('');
const notice = ref('');

function fmt(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    detail.value = await api.detail(props.id);
  } catch (e) {
    detail.value = null;
    error.value = e instanceof ApiError ? e.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

onMounted(load);
watch(() => props.id, load);

/** 统一执行写操作：成功刷新并提示；412 冲突时自动重载以拿到最新 rowVersion */
async function run(fn: () => Promise<unknown>, successMsg: string): Promise<boolean> {
  if (!detail.value) return false;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await fn();
    notice.value = successMsg;
    await load();
    return true;
  } catch (e) {
    error.value = e instanceof ApiError ? e.message : '操作失败';
    if (isRefreshable(e)) {
      await load();
      error.value = `${error.value}（已为你刷新到最新数据）`;
    }
    return false;
  } finally {
    busy.value = false;
  }
}

const can = (c: CommandType): boolean => detail.value?.nextActions.includes(c) ?? false;

const isProposer = computed(() => detail.value?.myRole === 'PROPOSER');
const isAssignee = computed(() => detail.value?.myRole === 'ASSIGNEE');

/** 验收条件 id → 文本，用于把验收结果渲染成「条件 + 通过/未通过」 */
const criterionText = computed(() => {
  const map: Record<string, string> = {};
  for (const c of detail.value?.criteria ?? []) map[c.id] = `${c.seq}. ${c.text}`;
  return map;
});

function actionHint(c: CommandType): string {
  return COMMAND_LABEL[c];
}

// ────────────────── 开始处理 ──────────────────

async function doStart(): Promise<void> {
  if (!detail.value) return;
  await run(
    () => api.start(detail.value!.id, detail.value!.rowVersion),
    '已开始处理，验收条件已冻结',
  );
}

// ────────────────── 编辑 ──────────────────

const editOpen = ref(false);
const editForm = reactive({ title: '', description: '', criteriaText: '' });
const editError = ref('');

function openEdit(): void {
  if (!detail.value) return;
  editForm.title = detail.value.title;
  editForm.description = detail.value.description;
  editForm.criteriaText = detail.value.criteria.map((c) => c.text).join('\n');
  editError.value = '';
  editOpen.value = true;
}

async function saveEdit(): Promise<void> {
  if (!detail.value) return;
  editError.value = '';
  const criteria = editForm.criteriaText
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!editForm.title.trim()) {
    editError.value = '请填写标题';
    return;
  }
  if (criteria.length === 0) {
    editError.value = '至少需要一条验收条件';
    return;
  }

  const ok = await run(
    () =>
      api.edit(
        detail.value!.id,
        {
          title: editForm.title.trim(),
          description: editForm.description.trim(),
          criteria,
        },
        detail.value!.rowVersion,
      ),
    '需求已更新',
  );
  if (ok) editOpen.value = false;
  else editError.value = error.value;
}

// ────────────────── 提交成果 ──────────────────

const submitOpen = ref(false);
const submitForm = reactive({ note: '', artifactsText: '' });
const submitError = ref('');

function openSubmit(): void {
  submitForm.note = '';
  submitForm.artifactsText = '';
  submitError.value = '';
  submitOpen.value = true;
}

async function doSubmit(): Promise<void> {
  if (!detail.value) return;
  submitError.value = '';
  const artifacts = submitForm.artifactsText
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (artifacts.length === 0) {
    submitError.value = '至少填写一个可查看的成果链接（每行一个）';
    return;
  }
  if (!submitForm.note.trim()) {
    submitError.value = '请填写完成说明';
    return;
  }

  const ok = await run(
    () =>
      api.submit(
        detail.value!.id,
        { artifacts, note: submitForm.note.trim() },
        detail.value!.rowVersion,
      ),
    '成果已提交，等待提出者验收',
  );
  if (ok) submitOpen.value = false;
  else submitError.value = error.value;
}

// ────────────────── 验收面板 ──────────────────

const reviewOpen = ref(false);
const reviewError = ref('');
const checks = ref<Record<string, boolean>>({});
const returnReason = ref('');

function openReview(): void {
  checks.value = {};
  for (const c of detail.value?.criteria ?? []) checks.value[c.id] = false;
  returnReason.value = '';
  reviewError.value = '';
  reviewOpen.value = true;
}

const passedCount = computed(
  () => (detail.value?.criteria ?? []).filter((c) => checks.value[c.id]).length,
);
const totalCount = computed(() => detail.value?.criteria.length ?? 0);
const allPassed = computed(() => totalCount.value > 0 && passedCount.value === totalCount.value);

function toggle(id: string): void {
  checks.value = { ...checks.value, [id]: !checks.value[id] };
}

async function doReview(action: 'RETURN' | 'COMPLETE'): Promise<void> {
  const current = detail.value?.currentSubmission;
  if (!detail.value || !current) {
    reviewError.value = '当前没有可验收的提交';
    return;
  }
  reviewError.value = '';

  if (action === 'RETURN' && !returnReason.value.trim()) {
    reviewError.value = '退回时必须填写具体修改原因';
    return;
  }
  if (action === 'COMPLETE' && !allPassed.value) {
    reviewError.value = '存在未通过的验收条件，不能确认完成';
    return;
  }

  const ok = await run(
    () =>
      api.review(
        current.id,
        {
          action,
          reason: action === 'RETURN' ? returnReason.value.trim() : undefined,
          checks: (detail.value!.criteria ?? []).map((c) => ({
            criterionId: c.id,
            passed: !!checks.value[c.id],
          })),
        },
        detail.value!.rowVersion,
      ),
    action === 'RETURN' ? '已退回，负责人可重新提交' : '已确认完成',
  );

  if (ok) reviewOpen.value = false;
  else reviewError.value = error.value;
}
</script>

<template>
  <main class="page">
    <div class="mb-1">
      <button class="btn btn-sm btn-ghost" type="button" @click="router.push({ name: 'list' })">
        ← 返回列表
      </button>
    </div>

    <div v-if="loading" class="card"><div class="empty">加载中…</div></div>

    <div v-else-if="!detail" class="card">
      <div class="empty">
        {{ error || '需求不存在或你无权访问' }}
        <div class="mt-1"><button class="btn btn-sm" type="button" @click="load">重试</button></div>
      </div>
    </div>

    <template v-else>
      <div v-if="error || notice" style="margin-bottom: 14px">
        <div v-if="error" class="alert alert-error" style="margin-bottom: 0">{{ error }}</div>
        <div v-else class="alert alert-info" style="margin-bottom: 0">{{ notice }}</div>
      </div>

      <!-- 头部：标题 / 状态 / 元信息 / 动作 -->
      <div class="card">
        <div class="detail-head">
          <div class="list-item-title" style="margin-bottom: 0">
            <h1 class="detail-title" style="margin: 0">{{ detail.title }}</h1>
            <span class="badge" :class="detail.state">{{ detail.stateLabel }}</span>
            <span v-if="isProposer" class="tag role-PROPOSER">你是提出者</span>
            <span v-else-if="isAssignee" class="tag role-ASSIGNEE">你是负责人</span>
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
              <div class="v">{{ fmt(detail.updatedAt) }}</div>
            </div>
          </div>

          <div v-if="detail.nextActions.length > 0" class="row mt-2">
            <button v-if="can('EDIT')" class="btn" type="button" :disabled="busy" @click="openEdit">
              {{ actionHint('EDIT') }}
            </button>
            <button
              v-if="can('START')"
              class="btn btn-primary"
              type="button"
              :disabled="busy"
              @click="doStart"
            >
              {{ busy ? '处理中…' : actionHint('START') }}
            </button>
            <button
              v-if="can('SUBMIT')"
              class="btn btn-primary"
              type="button"
              :disabled="busy"
              @click="openSubmit"
            >
              {{ actionHint('SUBMIT') }}
            </button>
            <button
              v-if="can('REVIEW_RETURN') || can('REVIEW_COMPLETE')"
              class="btn btn-primary"
              type="button"
              :disabled="busy"
              @click="openReview"
            >
              逐项验收
            </button>
          </div>
          <div v-else class="mt-2 faint small">
            当前状态下你没有可执行的操作（已完成，或你不是该需求的提出者 / 负责人）。
          </div>
        </div>

        <div class="card-body">
          <h3 class="mb-1" style="font-size: 13px; color: var(--text-muted)">问题与内容说明</h3>
          <div class="prose">{{ detail.description }}</div>
        </div>
      </div>

      <!-- 验收条件 -->
      <div class="card">
        <div class="card-head">
          <h3>验收条件（{{ detail.criteria.length }} 条）</h3>
          <span class="faint small">开始处理后冻结，双方以此为唯一标准</span>
        </div>
        <div class="card-body">
          <ul class="criteria-list">
            <li v-for="c in detail.criteria" :key="c.id">
              <span class="seq">{{ c.seq }}</span>
              <span>{{ c.text }}</span>
            </li>
          </ul>
        </div>
      </div>

      <!-- 提交与验收记录 -->
      <div class="card">
        <div class="card-head">
          <h3>提交与验收记录（{{ detail.submissions.length }} 次提交）</h3>
        </div>
        <div class="card-body">
          <div v-if="detail.submissions.length === 0" class="faint small">负责人尚未提交成果。</div>

          <div v-for="s in detail.submissions" :key="s.id" class="submission">
            <div class="submission-head">
              <strong>V{{ s.submissionNo }}</strong>
              <span
                v-if="s.id === detail.currentSubmissionId"
                class="tag"
                style="background: var(--primary-soft); color: var(--primary-dark)"
              >
                当前提交
              </span>
              <span class="faint small"
                >{{ s.submittedBy.name }} 提交于 {{ fmt(s.submittedAt) }}</span
              >
            </div>

            <div class="submission-body">
              <h5>完成说明</h5>
              <div class="prose" style="margin-bottom: 12px">{{ s.note }}</div>

              <h5>成果链接</h5>
              <ul class="artifact-list" style="margin-bottom: 4px">
                <li v-for="a in s.artifacts" :key="a.seq">
                  <a :href="a.url" target="_blank" rel="noopener noreferrer">{{ a.url }}</a>
                </li>
              </ul>

              <template v-if="s.reviews.length > 0">
                <div v-for="(r, i) in s.reviews" :key="i" class="review-block" :class="r.action">
                  <div class="review-head">
                    <span>{{ r.action === 'RETURN' ? '退回修改' : '确认完成' }}</span>
                    <span class="faint">· {{ r.reviewer.name }} · {{ fmt(r.reviewedAt) }}</span>
                  </div>

                  <div v-if="r.reason" class="mb-1">
                    <strong>退回原因：</strong
                    ><span class="prose" style="display: inline">{{ r.reason }}</span>
                  </div>

                  <ul class="check-list">
                    <li v-for="c in r.checks" :key="c.criterionId">
                      <span class="check-mark" :class="c.passed ? 'pass' : 'fail'">
                        {{ c.passed ? '✓' : '✗' }}
                      </span>
                      <span>{{ criterionText[c.criterionId] ?? c.criterionId }}</span>
                    </li>
                  </ul>
                </div>
              </template>
              <div v-else class="faint small mt-1">该提交尚未验收。</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 事件时间线 -->
      <div class="card">
        <div class="card-head">
          <h3>操作留痕（{{ detail.events.length }} 条事件）</h3>
          <span class="faint small">追加式记录，不可篡改</span>
        </div>
        <div class="card-body">
          <ul class="timeline">
            <li v-for="e in detail.events" :key="e.seq">
              <div class="tl-head">
                <span class="mono faint">#{{ e.seq }}</span>
                <span class="tl-actor">{{ e.actor.name }}</span>
                <span>{{ EVENT_LABEL[e.eventType] ?? e.eventType }}</span>
                <span class="tl-time">{{ fmt(e.createdAt) }}</span>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </template>

    <!-- 编辑需求 -->
    <div v-if="editOpen" class="overlay" @click.self="editOpen = false">
      <div class="modal">
        <div class="modal-head">
          <h3>编辑需求</h3>
          <button class="icon-btn" type="button" @click="editOpen = false">×</button>
        </div>
        <div class="modal-body">
          <div v-if="editError" class="alert alert-error">{{ editError }}</div>
          <div class="field">
            <label>标题</label>
            <input v-model="editForm.title" class="input" maxlength="200" />
          </div>
          <div class="field">
            <label>问题与内容说明</label>
            <textarea v-model="editForm.description" class="textarea" />
          </div>
          <div class="field" style="margin-bottom: 0">
            <label>验收条件</label>
            <textarea v-model="editForm.criteriaText" class="textarea" />
            <div class="hint">每行一条。仅在「待处理」阶段可编辑。</div>
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" type="button" :disabled="busy" @click="editOpen = false">取消</button>
          <button class="btn btn-primary" type="button" :disabled="busy" @click="saveEdit">
            {{ busy ? '保存中…' : '保存' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 提交成果 -->
    <div v-if="submitOpen" class="overlay" @click.self="submitOpen = false">
      <div class="modal">
        <div class="modal-head">
          <h3>提交成果</h3>
          <button class="icon-btn" type="button" @click="submitOpen = false">×</button>
        </div>
        <div class="modal-body">
          <div v-if="submitError" class="alert alert-error">{{ submitError }}</div>
          <div class="alert alert-info">
            每次提交都会生成新的版本号（V1、V2…），历史版本不会被覆盖。
          </div>
          <div class="field">
            <label>成果链接</label>
            <textarea
              v-model="submitForm.artifactsText"
              class="textarea"
              placeholder="每行一个完整 URL，例如：&#10;https://github.com/org/repo/pull/12"
            />
            <div class="hint">1~20 个，须以 http:// 或 https:// 开头。</div>
          </div>
          <div class="field" style="margin-bottom: 0">
            <label>完成说明</label>
            <textarea
              v-model="submitForm.note"
              class="textarea"
              placeholder="说明本次实现了什么、如何验证"
            />
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" type="button" :disabled="busy" @click="submitOpen = false">
            取消
          </button>
          <button class="btn btn-primary" type="button" :disabled="busy" @click="doSubmit">
            {{ busy ? '提交中…' : '提交' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 验收面板 -->
    <div v-if="reviewOpen" class="overlay" @click.self="reviewOpen = false">
      <div class="modal">
        <div class="modal-head">
          <h3>逐项验收 · V{{ detail?.currentSubmission?.submissionNo }}</h3>
          <button class="icon-btn" type="button" @click="reviewOpen = false">×</button>
        </div>
        <div class="modal-body">
          <div v-if="reviewError" class="alert alert-error">{{ reviewError }}</div>

          <div class="alert alert-info">
            必须对全部 {{ totalCount }} 条验收条件逐项记录结果。已通过
            <strong>{{ passedCount }}</strong> / {{ totalCount }}。
          </div>

          <div
            v-for="c in detail?.criteria ?? []"
            :key="c.id"
            class="review-item"
            :class="checks[c.id] ? 'pass' : 'fail'"
            @click="toggle(c.id)"
          >
            <input type="checkbox" :checked="!!checks[c.id]" @click.stop="toggle(c.id)" />
            <span class="rtext">{{ c.seq }}. {{ c.text }}</span>
          </div>

          <div class="field mt-2" style="margin-bottom: 0">
            <label>退回原因（选择「退回修改」时必填）</label>
            <textarea
              v-model="returnReason"
              class="textarea"
              placeholder="请具体说明哪一条未通过、期望如何修改"
            />
          </div>
        </div>
        <div class="modal-foot">
          <button class="btn" type="button" :disabled="busy" @click="reviewOpen = false">
            取消
          </button>
          <button class="btn btn-danger" type="button" :disabled="busy" @click="doReview('RETURN')">
            退回修改
          </button>
          <button
            class="btn btn-primary"
            type="button"
            :disabled="busy || !allPassed"
            @click="doReview('COMPLETE')"
          >
            确认完成
          </button>
        </div>
      </div>
    </div>
  </main>
</template>
