<template>
  <k-layout>
    <el-scrollbar class="oni-sync-page">
      <k-slot name="onisync" />
    </el-scrollbar>
  </k-layout>
</template>

<style lang="scss" scoped>
/* 背景与文字色跟随控制台主题（--el-* 由 Element Plus / Koishi 主题注入） */
.oni-sync-page {
  height: 100%;
  padding: 16px;
  color: var(--el-text-color-primary);
  background: var(--el-bg-color-page);
}

@media (max-width: 768px) {
  .oni-sync-page {
    padding: 10px;
  }
}
</style>
