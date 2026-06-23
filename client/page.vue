<template>
  <k-layout>
    <div class="filter-container">
      <el-tabs v-model="activeTab" class="log-tabs">
        <el-tab-pane name="all" label="全部日志" />
        <el-tab-pane name="normal" label="正常日志" />
        <el-tab-pane name="error" label="错误/警告" />
      </el-tabs>
      <div class="filter-row">
        <el-input v-model="filterText" placeholder="搜索日志内容..." clearable class="filter-input" />
        <div class="button-group">
          <el-button size="small" @click="scrollToBottom">
            <el-icon>
              <Bottom />
            </el-icon>
            底部
          </el-button>
          <el-button size="small" @click="scrollToTop">
            <el-icon>
              <Top />
            </el-icon>
            顶部
          </el-button>
        </div>
      </div>
    </div>
    <div class="log-container" ref="scrollRef">
      <div v-for="(text, index) in filteredLogs" :key="index" class="log-line">
        <pre :class="getLogClass(text)">{{ text }}</pre>
      </div>
      <div v-if="filteredLogs.length === 0" class="empty-state">
        <p>暂无日志</p>
      </div>
    </div>
  </k-layout>
</template>

<script lang="ts" setup>
import { ref, computed, watch, onMounted } from 'vue'
import { store, Time } from '@koishijs/client'
import { Top, Bottom } from '@element-plus/icons-vue'

const scrollRef = ref<HTMLElement>()
const activeTab = ref('all')
const filterText = ref('')
const displayLogs = ref<string[]>([])
const timeFormat = 'yyyy-MM-dd hh:mm:ss'

function formatRecord(record: any): string {
  const time = Time.template(timeFormat, new Date(record.timestamp))
  const level = record.type.toUpperCase()
  const content = record.content.replace(/\u001b\[[0-9;]*m/g, '')
  return `[${time}] [${level}] ${content}`
}

const normalLogs = computed(() => {
  return displayLogs.value.filter(log =>
    !log.includes('[ERROR]') && !log.includes('[WARN]')
  )
})

const errorLogs = computed(() => {
  return displayLogs.value.filter(log =>
    log.includes('[ERROR]') || log.includes('[WARN]')
  )
})

const currentLogs = computed(() => {
  switch (activeTab.value) {
    case 'normal':
      return normalLogs.value
    case 'error':
      return errorLogs.value
    default:
      return displayLogs.value
  }
})

const filteredLogs = computed(() => {
  let logs = currentLogs.value
  if (!filterText.value.trim()) {
    return [...logs].reverse()
  }
  const search = filterText.value.toLowerCase()
  return logs.filter(log =>
    log.toLowerCase().includes(search)
  ).reverse()
})

function getLogClass(text: string): string {
  if (text.includes('[ERROR]')) return 'log-error'
  if (text.includes('[WARN]')) return 'log-warn'
  if (text.includes('[INFO]')) return 'log-info'
  return ''
}

const scrollToTop = () => {
  if (scrollRef.value) {
    scrollRef.value.scrollTop = 0
  }
}

const scrollToBottom = () => {
  if (scrollRef.value) {
    scrollRef.value.scrollTop = scrollRef.value.scrollHeight
  }
}

watch(
  () => (store as any)['onilogs'],
  (newLogs) => {
    if (!newLogs) return
    displayLogs.value = newLogs.map(formatRecord)
  },
  { deep: true, immediate: true }
)

onMounted(() => {
  scrollToTop()
})
</script>

<style lang="scss" scoped>
.filter-container {
  background: #ffffff;
  padding: 16px;
  margin-bottom: 12px;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  border: 1px solid #e8e8e8;
}

.log-tabs {
  margin-bottom: 16px;

  :deep(.el-tabs__header) {
    border-bottom: 2px solid #e8e8e8;
  }

  :deep(.el-tabs__item) {
    color: #333333 !important;
    font-weight: 500;
    font-size: 14px;
    padding: 0 20px;
    margin-right: 10px;
    opacity: 1 !important;

    &:hover {
      color: #1890ff !important;
    }
  }

  :deep(.el-tabs__item.is-active) {
    color: #1890ff !important;
    font-weight: 600;
  }

  :deep(.el-tabs__active-bar) {
    background-color: #1890ff;
    height: 3px;
  }
}

.filter-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.filter-input {
  flex: 1;

  :deep(.el-input__wrapper) {
    border: 1px solid #d9d9d9;
    border-radius: 6px;
    background-color: #ffffff;
    transition: all 0.3s;

    &:hover {
      border-color: #1890ff;
    }

    &.is-focus {
      border-color: #1890ff;
      box-shadow: 0 0 0 2px rgba(24, 144, 255, 0.1);
    }
  }

  :deep(.el-input__placeholder) {
    color: #8c8c8c;
  }
}

.button-group {
  display: flex;
  gap: 8px;
}

:deep(.el-button) {
  background-color: #ffffff;
  border: 1px solid #d9d9d9;
  color: #333333;
  border-radius: 6px;
  padding: 6px 16px;
  font-size: 13px;
  transition: all 0.3s;

  &:hover {
    background-color: #f5f5f5;
    border-color: #1890ff;
    color: #1890ff;
  }

  &:active {
    background-color: #e8f4ff;
  }
}

.log-container {
  width: 100%;
  height: calc(100vh - 260px);
  overflow-y: auto;
  padding: 16px;
  padding-bottom: 60px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  background-color: #1a1a2e;
  color: #e4e4e4;
  border-radius: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.log-line {
  line-height: 1.6;
  font-size: 13px;
  padding: 2px 0;
}

pre {
  margin: 0;
  font-family: inherit;
  white-space: pre-wrap;
  word-break: break-all;
}

.log-error {
  color: #ff6b6b;
  text-shadow: 0 0 2px rgba(255, 107, 107, 0.3);
}

.log-warn {
  color: #ffd93d;
  text-shadow: 0 0 2px rgba(255, 217, 61, 0.3);
}

.log-info {
  color: #6bcfff;
  text-shadow: 0 0 2px rgba(107, 207, 255, 0.3);
}

.empty-state {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  color: #888888;
  font-size: 14px;
}

::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}

::-webkit-scrollbar-track {
  background: #2a2a4a;
  border-radius: 4px;
}

::-webkit-scrollbar-thumb {
  background: #4a4a6a;
  border-radius: 4px;

  &:hover {
    background: #5a5a8a;
  }
}
</style>
