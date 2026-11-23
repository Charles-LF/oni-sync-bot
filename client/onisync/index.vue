<template>
  <k-layout>
    <el-scrollbar class="oni-sync-page">
      <k-slot name="onisync" />
    </el-scrollbar>
  </k-layout>
</template>

<style lang="scss" scoped>
/* 背景交给 k-layout（它会随主题变）；页面里只画卡片 */
.oni-sync-page {
  height: 100%;
  padding: 16px;
  color: var(--el-text-color-primary);
}

@media (max-width: 768px) {
  .oni-sync-page {
    padding: 10px;
  }
}
</style>
