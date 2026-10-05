<script setup lang="ts">
import type { DomainEvent } from '../types';
import { EVENT_LABEL } from '../types';
import { formatDateTime } from '../utils/format';

/**
 * EventTimeline —— 操作留痕时间线。
 *
 * 追加式（append-only）事件流：谁、在什么时间、做了什么。
 * 事件类型文案集中在 types.ts 的 EVENT_LABEL，组件只做渲染，
 * 新增事件类型时无需改组件。
 */
defineProps<{ events: DomainEvent[] }>();
</script>

<template>
  <ul class="timeline">
    <li v-for="event in events" :key="event.seq">
      <div class="tl-head">
        <span class="mono faint">#{{ event.seq }}</span>
        <span class="tl-actor">{{ event.actor.name }}</span>
        <span>{{ EVENT_LABEL[event.eventType] ?? event.eventType }}</span>
        <span class="tl-time">{{ formatDateTime(event.createdAt) }}</span>
      </div>
    </li>
  </ul>
</template>
