<template>
  <k-layout>
    <div class="log-container" ref="scrollRef">
      <div v-for="(text, index) in displayLogs" :key="index" class="log-line">
        <pre>{{ text }}</pre>
      </div>
    </div>
  </k-layout>
</template>

<script lang="ts" setup>
import { ref, watch, onMounted } from 'vue'
import { store, Time } from '@koishijs/client'

const scrollRef = ref<HTMLElement>()
const displayLogs = ref<string[]>([])
const timeFormat = 'yyyy-MM-dd hh:mm:ss'

function formatRecord(record: any): string {
  const time = Time.template(timeFormat, new Date(record.timestamp))
  const level = record.type.toUpperCase()
  const content = record.content.replace(/\u001b\[[0-9;]*m/g, '')
  return `[${time}] [${level}] ${content}`
}

watch(
  () => (store as any)['onilogs'],
  (newLogs) => {
    if (!newLogs) return
    displayLogs.value = newLogs.map(formatRecord)
  },
  { deep: true, immediate: true }
)

const scrollToBottom = () => {
  if (scrollRef.value) {
    scrollRef.value.scrollTop = scrollRef.value.scrollHeight
  }
}

watch(() => displayLogs.value.length, () => {
  setTimeout(scrollToBottom, 0)
})

onMounted(() => {
  scrollToBottom()
})
</script>

<style lang="scss" scoped>
.log-container {
  width: 100%;
  height: 100%;
  overflow-y: auto;
  padding: 12px;
  font-family: monospace;
  background: #1e1e1e;
  color: #d4d4d4;
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
</style>