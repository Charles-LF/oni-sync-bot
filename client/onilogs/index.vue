<template>
  <k-layout>
    <el-scrollbar class="oni-logs-page">
      <k-slot name="onilogs" />
    </el-scrollbar>
  </k-layout>
</template>

<style lang="scss" scoped>
/*
 * 背景交给 k-layout 自己画（它会随主题变），这里只保证文字色正确。
 * 不要用 --el-bg-color-page：Koishi 的深色主题并没有重新定义它，
 * 深色模式下会漏出浅灰底色。
 */
.oni-logs-page {
  padding: 16px;
  color: var(--el-text-color-primary);
}

@media (max-width: 768px) {
  .oni-logs-page {
    padding: 10px;
  }
}
</style>