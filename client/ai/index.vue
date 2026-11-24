<template>
  <k-layout>
    <el-scrollbar class="ai-page">
      <AiInsights />
    </el-scrollbar>
  </k-layout>
</template>

<script lang="ts" setup>
import AiInsights from "./ai-insights.vue";
</script>

<style lang="scss" scoped>
/* 背景交给 k-layout（它会随主题变）；页面里只画卡片 */
.ai-page {
  height: 100%;
  padding: 16px;
  color: var(--el-text-color-primary);
}

@media (max-width: 768px) {
  .ai-page {
    padding: 10px;
  }
}
</style>
