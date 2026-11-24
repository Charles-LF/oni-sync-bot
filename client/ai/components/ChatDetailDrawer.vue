<template>
  <transition name="fade">
    <div v-if="open" class="mask" @click.self="emit('close')">
      <aside class="drawer chat-drawer">
        <header class="drawer-head">
          <div class="head-main">
            <h3 class="drawer-title">
              {{ log ? userLabel(log) : "对话详情" }}
            </h3>
            <div v-if="log" class="drawer-meta">
              <span>{{ formatDateTime(log.createdAt) }}</span>
              <span v-if="log.userId">QQ {{ log.userId }}</span>
              <span>#{{ log.id }}</span>
            </div>
          </div>
          <div class="head-actions">
            <button
              v-if="log"
              class="btn"
              :disabled="!log.answer"
              @click="copyAnswer"
            >
              <el-icon><CopyDocument /></el-icon>
              {{ copied ? "已复制" : "复制回答" }}
            </button>
            <button class="btn icon" title="关闭" @click="emit('close')">
              <el-icon><Close /></el-icon>
            </button>
          </div>
        </header>

        <div class="drawer-body">
          <p v-if="loading" class="loading">加载中…</p>

          <template v-else-if="log">
            <section class="block">
              <h4>用户提问</h4>
              <p class="question">{{ log.question }}</p>
            </section>

            <section class="block">
              <h4>工具调用（{{ log.toolCalls.length }}）</h4>
              <p v-if="log.toolCalls.length === 0" class="muted">
                没有调用工具，直接由模型回答
              </p>
              <ul v-else class="tools">
                <li v-for="(call, index) in log.toolCalls" :key="index">
                  <span class="tool-name">{{ call.name }}</span>
                  <span v-if="call.keyword" class="tool-keyword">
                    {{ call.keyword }}
                  </span>
                  <span v-if="call.page" class="tool-page">→ {{ call.page }}</span>
                </li>
              </ul>
            </section>

            <section class="block">
              <h4>AI 回答</h4>
              <pre class="answer">{{ log.answer || "（空）" }}</pre>
            </section>
          </template>

          <p v-else class="loading">记录不存在或已被清理</p>
        </div>
      </aside>
    </div>
  </transition>
</template>

<script lang="ts" setup>
import { ref } from "vue";
import { Close, CopyDocument } from "@element-plus/icons-vue";
import { formatDateTime } from "../../shared/time";
import { userLabel } from "../format";
import type { AiChatLogDetail } from "../types";

/** 单条对话详情：完整回答 + 工具调用明细 */
const props = withDefaults(
  defineProps<{
    open: boolean;
    log?: AiChatLogDetail | null;
    loading?: boolean;
  }>(),
  { log: null, loading: false },
);

const emit = defineEmits<{ close: [] }>();

const copied = ref(false);

async function copyAnswer(): Promise<void> {
  const text = props.log?.answer ?? "";
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    window.setTimeout(() => {
      copied.value = false;
    }, 2000);
  } catch {
    // 非 https / 无权限时 clipboard 不可用，忽略即可
  }
}
</script>

<style lang="scss" scoped>
@use "../../shared/styles/drawer.scss" as *;

.head-main {
  min-width: 0;
}

.head-actions {
  display: flex;
  flex: 0 0 auto;
  gap: 6px;
}

.drawer-body {
  flex: 1;
  padding-top: 12px;
  overflow-y: auto;
}

.block {
  margin-bottom: 16px;

  h4 {
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.4px;
    color: var(--el-text-color-secondary);
  }
}

.question {
  margin: 0;
  font-size: 14px;
  line-height: 1.6;
  color: var(--el-text-color-primary);
  word-break: break-word;
}

.tools {
  padding: 0;
  margin: 0;
  list-style: none;

  li {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    padding: 5px 8px;
    margin-bottom: 6px;
    font-size: 12px;
    background: var(--el-fill-color-light);
    border-radius: 6px;
  }
}

.tool-name {
  font-family: var(--el-font-family-mono, monospace);
  color: var(--el-text-color-placeholder);
}

.tool-keyword {
  padding: 0 6px;
  color: var(--el-color-primary);
  background: color-mix(in srgb, var(--el-color-primary) 12%, transparent);
  border-radius: 4px;
}

.tool-page {
  color: var(--el-text-color-regular);
}

.answer {
  padding: 10px 12px;
  margin: 0;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.7;
  color: var(--el-text-color-primary);
  word-break: break-word;
  white-space: pre-wrap;
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.loading {
  padding: 40px 0;
  margin: 0;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  text-align: center;
}
</style>
