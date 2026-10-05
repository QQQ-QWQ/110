<script setup lang="ts">
import type { Submission } from '../types';
import { formatDateTime } from '../utils/format';

/**
 * SubmissionCard —— 单次提交记录（V1 / V2 …）。
 *
 * 历史追溯的核心载体：**每次提交独立成卡，绝不覆盖**，
 * 卡片内同时展示该次提交的链接、说明与对应验收结果（含退回原因），
 * 让负责人能明确看到「哪一条没通过、为什么」，而不是只看到一个「被退回」。
 */
defineProps<{
  submission: Submission;
  isCurrent: boolean;
  /** criterionId → "1. 条件文本"，用于把验收结果还原成可读条目 */
  criterionText: Record<string, string>;
}>();
</script>

<template>
  <article class="submission">
    <header class="submission-head">
      <strong>V{{ submission.submissionNo }}</strong>
      <span v-if="isCurrent" class="tag is-accent">当前提交</span>
      <span class="faint small">
        {{ submission.submittedBy.name }} 提交于 {{ formatDateTime(submission.submittedAt) }}
      </span>
    </header>

    <div class="submission-body">
      <h4>完成说明</h4>
      <div class="prose mb-2">{{ submission.note }}</div>

      <h4>成果链接</h4>
      <ul class="artifact-list mb-1">
        <li v-for="a in submission.artifacts" :key="a.seq">
          <a :href="a.url" target="_blank" rel="noopener noreferrer">{{ a.url }}</a>
        </li>
      </ul>

      <template v-if="submission.reviews.length > 0">
        <div
          v-for="(review, index) in submission.reviews"
          :key="index"
          class="review-block"
          :class="review.action"
        >
          <div class="review-head">
            <span>{{ review.action === 'RETURN' ? '退回修改' : '确认完成' }}</span>
            <span class="faint">
              · {{ review.reviewer.name }} · {{ formatDateTime(review.reviewedAt) }}
            </span>
          </div>

          <div v-if="review.reason" class="mb-1">
            <strong>退回原因：</strong>
            <span class="prose" style="display: inline">{{ review.reason }}</span>
          </div>

          <ul class="check-list">
            <li v-for="check in review.checks" :key="check.criterionId">
              <span class="check-mark" :class="check.passed ? 'pass' : 'fail'">
                {{ check.passed ? '✓' : '✗' }}
              </span>
              <span>{{ criterionText[check.criterionId] ?? check.criterionId }}</span>
            </li>
          </ul>
        </div>
      </template>
      <div v-else class="faint small mt-1">该提交尚未验收。</div>
    </div>
  </article>
</template>
