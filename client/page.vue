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
          <el-button size="small" @click="scrollToTop">
            <el-icon>
              <Top />
            </el-icon>
            顶部
          </el-button>
          <el-button size="small" @click="scrollToBottom">
            <el-icon>
              <Bottom />
            </el-icon>
            底部
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
  if (!filterText.value.trim()) {
    return currentLogs.value
  }
  const search = filterText.value.toLowerCase()
  return currentLogs.value.filter(log =>
    log.toLowerCase().includes(search)
  )
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

watch(() => displayLogs.value.length, () => {
  setTimeout(scrollToBottom, 0)
})

onMounted(() => {
  scrollToBottom()
})
</script>

<style lang="scss" scoped>
.filter-container {
  background: #fff;
  padding: 16px;
  margin-bottom: 12px;
  border-radius: 4px;
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.log-tabs {
  margin-bottom: 16px;
}

.filter-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

.filter-input {
  flex: 1;
}

.button-group {
  display: flex;
  gap: 8px;
}

.log-container {
  width: 100%;
  height: calc(100vh - 220px);
  overflow-y: auto;
  padding: 12px;
  font-family: monospace;
  background: #1e1e1e;
  color: #d4d4d4;
  border-radius: 4px;
}

.log-line {
  line-height: 1.5;
  font-size: 13px;
}

pre {
  margin: 0;
  font-family: inherit;
  white-space: pre-wrap;
  word-break: break-all;
}

.log-error {
  color: #f44747;
}

.log-warn {
  color: #dcdcaa;
}

.log-info {
  color: #4fc1ff;
}

.empty-state {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100%;
  color: #808080;
  font-size: 14px;
}
</style>
