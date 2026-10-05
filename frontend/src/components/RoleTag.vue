<script setup lang="ts">
import type { Role } from '../types';

/**
 * RoleTag —— 当前用户在这条需求中的角色标签。
 *
 * 关键业务语义：角色是**按每条需求**判定的（同一个人在不同需求中
 * 可能分别是提出者与负责人），因此标签必须跟着需求走，不能放在顶栏。
 */
defineProps<{ role: Role }>();

const LABEL: Record<Role, string> = {
  PROPOSER: '提出者',
  ASSIGNEE: '负责人',
  IRRELEVANT: '无关',
};
</script>

<template>
  <span v-if="role !== 'IRRELEVANT'" class="tag" :class="`role-${role}`">{{ LABEL[role] }}</span>
</template>
