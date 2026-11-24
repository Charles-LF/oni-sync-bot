<template>
  <div class="keywords">
    <div v-if="items.length" class="keyword-list">
      <button
        v-for="(item, index) in items"
        :key="item.keyword"
        class="keyword"
        :title="`${item.keyword}：被检索 ${item.count} 次`"
        @click="emit('pick', item.keyword)"
      >
        <span class="rank" :class="`rank-${index}`">{{ index + 1 }}</span>
        <span class="bar-track">
          <span class="bar" :style="{ width: `${percent(item.count)}%` }" />
          <span class="name">{{ item.keyword }}</span>
        </span>
        <span class="count">{{ item.count }}</span>
      </button>
    </div>

    <p v-else class="empty"><span>还没有检索记录</span></p>
  </div>
</template>

<script lang="ts" setup>
import { computed } from "vue";

/**
 * 群友最关心的游戏名词（来自工具调用的 keyword 词频）。
 *
 * 纯 CSS 横向条形图：数据量只有 Top 5，没必要为了柱状图引入图表库。
 * 点击某一条会把表格的关键字搜索切成这个词。
 */
const props = withDefaults(
  defineProps<{ items: Array<{ keyword: string; count: number }> }>(),
  { items: () => [] },
);

const emit = defineEmits<{ pick: [keyword: string] }>();

const maxCount = computed(() =>
  Math.max(...props.items.map((item) => item.count), 1),
);

function percent(count: number): number {
  return Math.max(4, Math.round((count / maxCount.value) * 100));
}
</script>

<style lang="scss" scoped>
.keyword-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.keyword {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;

  &:hover .bar {
    filter: brightness(1.08);
  }

  &:hover .name {
    color: var(--el-color-primary);
  }
}

.rank {
  flex: 0 0 18px;
  font-size: 11px;
  font-weight: 600;
  color: var(--el-text-color-placeholder);
  text-align: center;

  &.rank-0 {
    color: var(--el-color-danger);
  }

  &.rank-1 {
    color: var(--el-color-warning);
  }

  &.rank-2 {
    color: var(--el-color-primary);
  }
}

.bar-track {
  position: relative;
  flex: 1;
  height: 24px;
  overflow: hidden;
  background: var(--el-fill-color-light);
  border-radius: 6px;
}

.bar {
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--el-color-primary) 85%, #fff),
    color-mix(in srgb, var(--el-color-primary) 45%, #fff)
  );
  border-radius: 6px;
  transition: width 0.35s ease, filter 0.15s;
}

.name {
  position: relative;
  display: block;
  padding: 0 8px;
  font-size: 12px;
  line-height: 24px;
  color: var(--el-text-color-primary);
  transition: color 0.15s;
}

.count {
  flex: 0 0 auto;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-secondary);
}

.empty {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 160px;
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
}
</style>
