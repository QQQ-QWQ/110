<script setup lang="ts">
import { computed } from 'vue';
import AppIcon from './AppIcon.vue';
import type { IconName } from './AppIcon.vue';
import type { CommandType, RequirementState, Role } from '../types';

/**
 * NextStepCard —— 「下一步该做什么」引导。
 *
 * 直接对应考核验收项：**提出者和负责人均能看懂下一步该做什么**。
 * 权限是 f(用户, 需求, 状态) 的函数，因此提示必须由这三者共同推导，
 * 而不是写死一句「请继续操作」。
 *
 * 三种语气：
 *  - action：你有可执行动作 → 明确告诉你要做什么、为什么；
 *  - wait：轮不到你 → 说明在等谁，避免误以为卡住；
 *  - done：终态 → 明确结束，避免用户反复找按钮。
 */
const props = defineProps<{
  state: RequirementState;
  myRole: Role;
  nextActions: CommandType[];
}>();

type Tone = 'action' | 'wait' | 'done';

interface Guidance {
  tone: Tone;
  /** 图标名（见 AppIcon）—— 用图形而不是 emoji/排版字符，避免跨平台外观不一致 */
  icon: IconName;
  title: string;
  desc: string;
}

const ACTION_GUIDE: Partial<Record<CommandType, Guidance>> = {
  EDIT: {
    tone: 'action',
    icon: 'arrow',
    title: '下一步：修改需求',
    desc: '你是提出者。待处理阶段可修改标题、说明与验收条件；确认无误后等待负责人开始处理。',
  },
  START: {
    tone: 'action',
    icon: 'arrow',
    title: '下一步：开始处理',
    desc: '你是负责人。开始后正文与验收条件将被冻结，双方以此为唯一标准，之后不可再改。',
  },
  SUBMIT: {
    tone: 'action',
    icon: 'arrow',
    title: '下一步：提交成果',
    desc: '你是负责人。请填写至少一个成果链接与完成说明；每次提交都会生成独立版本，不覆盖历史。',
  },
  REVIEW_RETURN: {
    tone: 'action',
    icon: 'arrow',
    title: '下一步：逐项验收',
    desc: '你是提出者。请逐条核对验收条件：全部通过才能确认完成，否则必须填写具体退回原因。',
  },
  REVIEW_COMPLETE: {
    tone: 'action',
    icon: 'arrow',
    title: '下一步：逐项验收',
    desc: '你是提出者。请逐条核对验收条件：全部通过才能确认完成，否则必须填写具体退回原因。',
  },
};

const guidance = computed<Guidance>(() => {
  if (props.state === 'COMPLETED') {
    return {
      tone: 'done',
      icon: 'check',
      title: '需求已完成',
      desc: '这是终态。历史提交与验收记录均已留痕，不可再退回或重新推进。',
    };
  }

  const first = props.nextActions[0];
  if (first && ACTION_GUIDE[first]) return ACTION_GUIDE[first] as Guidance;

  if (props.myRole === 'IRRELEVANT') {
    return {
      tone: 'wait',
      icon: 'wait',
      title: '你与这条需求无关',
      desc: '仅提出者与负责人可以查看和操作这条需求。',
    };
  }

  if (props.myRole === 'PROPOSER' && props.state === 'IN_PROGRESS') {
    return {
      tone: 'wait',
      icon: 'more',
      title: '等待负责人提交成果',
      desc: '负责人正在处理。你可以随时查看进展，但不能代替其提交或验收。',
    };
  }

  if (props.myRole === 'ASSIGNEE' && props.state === 'IN_REVIEW') {
    return {
      tone: 'wait',
      icon: 'more',
      title: '等待提出者验收',
      desc: '成果已提交。提出者会逐项核对验收条件；若被退回，你会在提交记录中看到具体原因。',
    };
  }

  return {
    tone: 'wait',
    icon: 'wait',
    title: '现在轮不到你操作',
    desc: '当前状态下没有你可执行的动作，需要等对方推进。页面顶部的状态徽标会随对方操作更新。',
  };
});
</script>

<template>
  <div
    class="next-step"
    :class="{ 'is-wait': guidance.tone === 'wait', 'is-done': guidance.tone === 'done' }"
  >
    <span class="next-step-icon" aria-hidden="true"><AppIcon :name="guidance.icon" /></span>
    <div>
      <div class="next-step-title">{{ guidance.title }}</div>
      <div class="next-step-desc">{{ guidance.desc }}</div>
    </div>
  </div>
</template>
