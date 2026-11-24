<template>
  <transition name="fade">
    <div v-if="open" class="mask" @click.self="close">
      <div class="drawer run-drawer">
        <header class="drawer-head">
          <div>
            <h3 class="drawer-title">{{ taskTitle }}</h3>
            <div class="drawer-meta">
              <span
                v-if="detail"
                class="state-pill"
                :class="`is-${detail.run.state}`"
              >
                {{ runStateLabel(detail.run.state) }}
              </span>
              <span v-if="detail">
                {{ formatTime(detail.run.startedAt) }} 开始
              </span>
              <span v-if="detail?.run.trigger">
                触发：{{ detail.run.trigger }}
              </span>
              <span v-if="isLive" class="live-badge">● 实时</span>
            </div>
          </div>
          <button class="btn icon" @click="close">
            <el-icon><Close /></el-icon>
          </button>
        </header>

        <p v-if="detail?.run.message" class="drawer-comment">
          {{ detail.run.message }}
        </p>

        <div class="run-counters">
          <span class="ok">成功 {{ detail?.run.synced ?? 0 }}</span>
          <span class="skip">跳过 {{ detail?.run.skipped ?? 0 }}</span>
          <span class="bad">失败 {{ detail?.run.failed ?? 0 }}</span>
          <span class="muted">
            总计 {{ detail?.run.total ?? 0 }} · 日志 {{ logs.length }} 条
          </span>
        </div>

        <div class="run-tabs">
          <button
            v-for="item in tabs"
            :key="item.key"
            class="tab"
            :class="{ active: tab === item.key }"
            @click="tab = item.key"
          >
            {{ item.label }}
            <span class="tab-count">{{ item.count }}</span>
          </button>
        </div>

        <div v-if="loading" class="empty"><p>正在读取运行记录…</p></div>

        <div v-else-if="tab === 'logs'" ref="logBox" class="run-log">
          <div
            v-for="(line, index) in logs"
            :key="index"
            class="log-line"
            :class="`lv-${line.level}`"
          >
            <span class="log-time">{{ formatClock(line.at) }}</span>
            <span class="log-message">{{ line.message }}</span>
          </div>
          <div v-if="logs.length === 0" class="empty">
            <p>暂无日志</p>
            <p class="empty-sub">任务开始后，条目级日志会实时出现在这里</p>
          </div>
        </div>

        <div v-else class="run-items">
          <div v-for="item in currentItems" :key="item.id" class="run-item">
            <span class="item-title" :title="item.title">{{ item.title }}</span>
            <span class="item-reason" :title="item.reason">
              {{ item.reason }}
            </span>
          </div>
          <div v-if="currentItems.length === 0" class="empty">
            <p>{{ emptyItemText }}</p>
          </div>
        </div>
      </div>
    </div>
  </transition>
</template>

<script lang="ts" setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Close } from "@element-plus/icons-vue";
import { useContext } from "@koishijs/client";
import { call } from "../rpc";
import { formatClock, formatTime, runStateLabel } from "../format";
import type {
  RunTab,
  SyncLogEvent,
  SyncRunItemRow,
  SyncTaskDetail,
  TaskSnapshot,
} from "../types";

/**
 * 任务详情抽屉：本次运行的成功 / 跳过 / 失败条目 + 完整日志流。
 *
 * 日志双通道：
 * - 打开时先拉 `sync/taskDetail`（库里已落盘的部分）；
 * - 之后订阅 `sync/log` 广播实时追加，用时间水位去重；
 * - 运行中的任务每 3 秒刷新一次条目列表（日志不重拉）。
 */
const props = defineProps<{ open: boolean; task: TaskSnapshot | null }>();
const emit = defineEmits<{ close: [] }>();

const detail = ref<SyncTaskDetail | null>(null);
const loading = ref(false);
const tab = ref<RunTab>("logs");
const logs = ref<SyncLogEvent[]>([]);
const logBox = ref<HTMLElement | null>(null);

/** 已展示日志的时间水位，避免「落库的」与「广播的」重复 */
let cursor = 0;
let refreshTimer: number | undefined;

const taskTitle = computed(() => props.task?.label ?? "任务详情");
const isLive = computed(() => detail.value?.run.state === "running");

const tabs = computed(() => [
  {
    key: "synced" as const,
    label: "成功",
    count: detail.value?.items.synced.length ?? 0,
  },
  {
    key: "skipped" as const,
    label: "跳过",
    count: detail.value?.items.skipped.length ?? 0,
  },
  {
    key: "failed" as const,
    label: "失败",
    count: detail.value?.items.failed.length ?? 0,
  },
  { key: "logs" as const, label: "日志", count: logs.value.length },
]);

const currentItems = computed<SyncRunItemRow[]>(() => {
  const current = detail.value;
  const key = tab.value;
  if (!current || key === "logs") return [];
  return current.items[key] ?? [];
});

const emptyItemText = computed(() => {
  switch (tab.value) {
    case "synced":
      return "本次没有成功同步的条目";
    case "skipped":
      return "本次没有跳过的条目";
    case "failed":
      return "本次没有失败的条目";
    default:
      return "暂无日志";
  }
});

function scrollLogs(): void {
  void nextTick(() => {
    const box = logBox.value;
    if (box) box.scrollTop = box.scrollHeight;
  });
}

async function refresh(reset: boolean): Promise<void> {
  const task = props.task;
  if (!task) return;

  loading.value = reset;
  const next = await call<SyncTaskDetail | null>("sync/taskDetail", {
    taskId: task.id,
    runId: reset ? undefined : detail.value?.run.id,
  });
  loading.value = false;
  if (!next) {
    if (reset) detail.value = null;
    return;
  }

  detail.value = next;
  if (!reset) return;

  logs.value = next.logs.map((line) => ({
    runId: next.run.id,
    taskId: task.id,
    level: line.level,
    message: line.message,
    at: line.at,
    seq: 0,
  }));
  const last = logs.value[logs.value.length - 1];
  cursor = last?.at ?? 0;
  scrollLogs();
}

function start(): void {
  detail.value = null;
  logs.value = [];
  cursor = 0;
  tab.value = "logs";
  void refresh(true);
  stopTimer();
  refreshTimer = window.setInterval(() => {
    if (!props.open) return;
    if (detail.value?.run.state !== "running") return;
    void refresh(false);
  }, 3000);
}

function stopTimer(): void {
  window.clearInterval(refreshTimer);
  refreshTimer = undefined;
}

function close(): void {
  emit("close");
}

watch(
  () => [props.open, props.task?.id] as const,
  ([open]) => {
    if (open) start();
    else stopTimer();
  },
  { immediate: true },
);

onBeforeUnmount(stopTimer);

const clientContext = useContext();
// 服务端用 console.broadcast 推送；useContext 会在组件卸载时自动解绑
(clientContext as any).on("sync/log", (event: SyncLogEvent) => {
  if (!props.open) return;
  if (event.taskId !== props.task?.id) return;
  if (cursor && event.at < cursor) return;

  cursor = Math.max(cursor, event.at);
  logs.value.push(event);
  if (logs.value.length > 600) {
    logs.value.splice(0, logs.value.length - 600);
  }
  if (tab.value === "logs") scrollLogs();
});
</script>

<style lang="scss" scoped>
@use "../../shared/styles/drawer.scss" as *;

.run-drawer {
  width: min(880px, 96vw);
}

.live-badge {
  font-size: 11px;
  color: var(--el-color-success);
  animation: pulse 1.6s infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }

  50% {
    opacity: 0.3;
  }
}

.run-counters {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  align-items: center;
  padding: 10px 0 0;
  font-size: 12px;

  .ok {
    color: var(--el-color-success);
  }

  .skip {
    color: var(--el-text-color-secondary);
  }

  .bad {
    color: var(--el-color-danger);
  }
}

.run-tabs {
  display: flex;
  gap: 6px;
  margin-top: 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.tab {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;

  &:hover {
    color: var(--el-color-primary);
  }

  &.active {
    color: var(--el-color-primary);
    border-bottom-color: var(--el-color-primary);
  }
}

.tab-count {
  margin-left: 4px;
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.run-log {
  flex: 1;
  margin-top: 10px;
  overflow: auto;
  font-family: var(--el-font-family-mono, monospace);
  font-size: 12px;
  line-height: 1.6;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.log-line {
  display: flex;
  gap: 8px;
  padding: 1px 10px;
  color: var(--el-text-color-regular);
  white-space: pre-wrap;
  border-left: 3px solid transparent;

  &.lv-warn {
    color: var(--el-color-warning);
    background: color-mix(in srgb, var(--el-color-warning) 10%, transparent);
    border-left-color: var(--el-color-warning);
  }

  &.lv-error {
    color: var(--el-color-danger);
    background: color-mix(in srgb, var(--el-color-danger) 10%, transparent);
    border-left-color: var(--el-color-danger);
  }
}

.log-time {
  flex: 0 0 auto;
  color: var(--el-text-color-placeholder);
}

.log-message {
  word-break: break-all;
}

.run-items {
  flex: 1;
  margin-top: 10px;
  overflow: auto;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.run-item {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(140px, 1.4fr);
  gap: 10px;
  padding: 7px 10px;
  font-size: 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);

  &:last-child {
    border-bottom: none;
  }
}

.item-title {
  overflow: hidden;
  color: var(--el-color-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.item-reason {
  overflow: hidden;
  color: var(--el-text-color-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 768px) {
  .run-drawer {
    width: 100vw;
    padding: 12px;
  }

  .run-item {
    grid-template-columns: 1fr;

    .item-reason {
      white-space: normal;
    }
  }
}
</style>
