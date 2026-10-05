<script setup lang="ts">
import { computed } from 'vue';
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
  icon: string;
  title: string;
  desc: string;
}

const ACTION_GUIDE: Partial<Record<CommandType, Guidance>> = {
  EDIT: {
    tone: 'action',
    icon: '→',
    title: '下一步：修改需求',
    desc: '你是提出者。待处理阶段可修改标题、说明与验收条件；确认无误后等待负责人开始处理。',
  },
  START: {
    tone: 'action',
    icon: '→',
    title: '下一步：开始处理',
    desc: '你是负责人。开始后正文与验收条件将被冻结，双方以此为唯一标准，之后不可再改。',
  },
  SUBMIT: {
    tone: 'action',
    icon: '→',
    title: '下一步：提交成果',
    desc: '你是负责人。请填写至少一个成果链接与完成说明；每次提交都会生成独立版本，不覆盖历史。',
  },
  REVIEW_RETURN: {
    tone: 'action',
    icon: '→',
    title: '下一步：逐项验收',
    desc: '你是提出者。请逐条核对验收条件：全部通过才能确认完成，否则必须填写具体退回原因。',
  },
  REVIEW_COMPLETE: {
    tone: 'action',
    icon: '→',
    title: '下一步：逐项验收',
    desc: '你是提出者。请逐条核对验收条件：全部通过才能确认完成，否则必须填写具体退回原因。',
  },
};

const guidance = computed<Guidance>(() => {
  if (props.state === 'COMPLETED') {
    return {
      tone: 'done',
      icon: '✓',
      title: '需求已完成',
      desc: '这是终态。历史提交与验收记录均已留痕，不可再退回或重新推进。',
    };
  }

  const first = props.nextActions[0];
  if (first && ACTION_GUIDE[first]) return ACTION_GUIDE[first] as Guidance;

  if (props.myRole === 'IRRELEVANT') {
    return {
      tone: 'wait',
      icon: '·',
      title: '你与这条需求无关',
      desc: '仅提出者与负责人可以查看和操作这条需求。',
    };
  }

  if (props.myRole === 'PROPOSER' && props.state === 'IN_PROGRESS') {
    return {
      tone: 'wait',
      icon: '…',
      title: '等待负责人提交成果',
      desc: '负责人正在处理。你可以随时查看进展，但不能代替其提交或验收。',
    };
  }

  if (props.myRole === 'ASSIGNEE' && props.state === 'IN_REVIEW') {
    return {
      tone: 'wait',
      icon: '…',
      title: '等待提出者验收',
      desc: '成果已提交。提出者会逐项核对验收条件；若被退回，你会在提交记录中看到具体原因。',
    };
  }

  return {
    tone: 'wait',
    icon: '·',
    title: '当前没有待办操作',
    desc: '这个状态下你无法执行任何动作，请等待对方推进。',
  };
});
</script>

<template>
  <div
    class="next-step"
    :class="{ 'is-wait': guidance.tone === 'wait', 'is-done': guidance.tone === 'done' }"
  >
    <span class="next-step-icon" aria-hidden="true">{{ guidance.icon }}</span>
    <div>
      <div class="next-step-title">{{ guidance.title }}</div>
      <div class="next-step-desc">{{ guidance.desc }}</div>
    </div>
  </div>
</template>
