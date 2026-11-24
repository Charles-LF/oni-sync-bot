<template>
  <div class="oni-sync">
    <!-- ───────────────────────── 概览 ───────────────────────── -->
    <section class="stats">
      <div v-for="item in stats" :key="item.label" class="stat">
        <span class="stat-label">{{ item.label }}</span>
        <span class="stat-value" :class="item.tone">{{ item.value }}</span>
        <span v-if="item.hint" class="stat-hint">{{ item.hint }}</span>
      </div>
    </section>

    <!-- ───────────────────────── 任务卡片 ───────────────────────── -->
    <section class="tasks">
      <article
        v-for="task in status.tasks"
        :key="task.id"
        class="task"
        :class="`state-${task.state}`"
        @click="openTaskDetail(task)"
      >
        <header class="task-head">
          <span class="dot" :class="`is-${task.state}`" />
          <h3>{{ task.label }}</h3>
          <span v-if="!task.controllable" class="badge">自动</span>
          <span class="state-pill" :class="`is-${task.state}`">
            {{ stateLabel(task.state) }}
          </span>
        </header>

        <p class="task-desc">{{ task.description }}</p>

        <div class="task-body">
          <template v-if="isActive(task)">
            <div class="progress-line">
              <span class="phase">{{ task.progress.phase }}</span>
              <span class="counter">
                {{ task.progress.current }} / {{ task.progress.total || "?" }}
              </span>
            </div>
            <el-progress
              :percentage="percent(task)"
              :status="progressStatus(task)"
              :stroke-width="6"
              :show-text="false"
            />
            <div class="counters">
              <span class="ok">同步 {{ task.progress.synced }}</span>
              <span class="skip">跳过 {{ task.progress.skipped }}</span>
              <span class="bad">失败 {{ task.progress.failed }}</span>
            </div>
            <p
              v-if="task.progress.message"
              class="task-message"
              :title="task.progress.message"
            >
              {{ task.progress.message }}
            </p>
          </template>

          <template v-else>
            <p class="task-message">
              {{ task.lastSummary || task.progress.message || "尚未运行" }}
            </p>
            <p v-if="task.lastError" class="task-error" :title="task.lastError">
              上次失败：{{ task.lastError }}
            </p>
            <p v-else-if="task.finishedAt" class="task-time">
              {{ formatTime(task.finishedAt) }} 结束
            </p>
          </template>
        </div>

        <footer v-if="task.controllable" class="task-actions" @click.stop>
          <button
            class="btn primary"
            :disabled="isActive(task)"
            @click="control(task.id, 'start')"
          >
            <el-icon><VideoPlay /></el-icon>
            开始
          </button>
          <button
            v-if="task.state === 'paused'"
            class="btn"
            @click="control(task.id, 'resume')"
          >
            <el-icon><VideoPlay /></el-icon>
            继续
          </button>
          <button
            v-else
            class="btn"
            :disabled="task.state !== 'running'"
            @click="control(task.id, 'pause')"
          >
            <el-icon><VideoPause /></el-icon>
            暂停
          </button>
          <button
            class="btn danger"
            :disabled="!isActive(task)"
            @click="control(task.id, 'stop')"
          >
            <el-icon><Close /></el-icon>
            停止
          </button>
        </footer>
      </article>
    </section>

    <transition name="fade">
      <p v-if="toast" class="toast" :class="`is-${toast.type}`">{{ toast.message }}</p>
    </transition>

    <!-- ───────────────────────── 最近更改 ───────────────────────── -->
    <section class="changes">
      <header class="changes-head">
        <div class="changes-title">
          <h3>最近更改</h3>
          <span class="muted">共 {{ total }} 条</span>
        </div>
        <div class="changes-tools">
          <el-input
            v-model="keyword"
            size="small"
            class="filter-keyword"
            placeholder="搜索标题 / 用户 / 摘要"
            clearable
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>
          <button class="btn" :disabled="loading" @click="reload()">
            <el-icon><Refresh /></el-icon>
            刷新
          </button>
        </div>
      </header>

      <div class="change-list">
        <button
          v-for="item in entries"
          :key="item.id"
          class="change-row"
          @click="openDetail(item)"
        >
          <span class="time">{{ formatISO(item.timestamp) }}</span>
          <span class="title" :title="item.title">{{ item.title }}</span>
          <span class="user" :title="item.user">@{{ item.user }}</span>
          <span class="size" :class="sizeClass(item.sizeDiff)">
            {{ formatSize(item.sizeDiff) }}
          </span>
          <span class="comment" :title="item.comment">{{ item.comment || "—" }}</span>
        </button>

        <button v-if="hasMore" class="load-more" :disabled="loadingMore" @click="loadMore">
          {{ loadingMore ? "加载中…" : `加载更早的更改（还有 ${total - entries.length} 条）` }}
        </button>

        <div v-if="entries.length === 0" class="empty">
          <p>{{ loading ? "加载中…" : "暂无更改记录" }}</p>
          <p class="empty-sub">增量同步运行后，这里按时间倒序展示原站编辑</p>
        </div>
      </div>
    </section>

    <!-- ───────────────────────── 忽略规则 ───────────────────────── -->
    <IgnoreRulePanel @notify="notify" />

    <!-- ───────────────────────── 抽屉 ───────────────────────── -->
    <ChangeDiffDrawer
      :open="diffOpen"
      :item="selectedChange"
      @close="diffOpen = false"
    />
    <TaskDetailDrawer
      :open="taskOpen"
      :task="openedTask"
      @close="taskOpen = false"
    />
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref, watch } from "vue";
import { store } from "@koishijs/client";
import {
  Close,
  Refresh,
  Search,
  VideoPause,
  VideoPlay,
} from "@element-plus/icons-vue";
import ChangeDiffDrawer from "./components/ChangeDiffDrawer.vue";
import IgnoreRulePanel from "./components/IgnoreRulePanel.vue";
import TaskDetailDrawer from "./components/TaskDetailDrawer.vue";
import { call } from "./rpc";
import { formatISO, formatSize, formatTime, sizeClass, stateLabel } from "./format";
import type { ChangeItem, SyncStatus, TaskId, TaskSnapshot } from "./types";

/** 同步运维首页：任务卡片 + 最近更改；抽屉与忽略规则各自独立成组件 */
const PAGE_SIZE = 50;

const EMPTY: SyncStatus = {
  tasks: [],
  version: 0,
  deltaCron: "",
  logCount: 0,
  imageIndexCount: 0,
  ignoreCount: 0,
};

const status = ref<SyncStatus>(EMPTY);
const entries = ref<ChangeItem[]>([]);
const total = ref(0);
const keyword = ref("");
const loading = ref(false);
const loadingMore = ref(false);
const toast = ref<{ type: "success" | "warning" | "error"; message: string } | null>(
  null,
);

/** 最近更改详情抽屉 */
const diffOpen = ref(false);
const selectedChange = ref<ChangeItem | null>(null);

/** 任务详情抽屉 */
const taskOpen = ref(false);
const openedTask = ref<TaskSnapshot | null>(null);

let toastTimer: number | undefined;
let debounceTimer: number | undefined;

const stats = computed(() => [
  {
    label: "同步水位",
    value: status.value.lastSyncTime ? formatISO(status.value.lastSyncTime) : "未设置",
    hint: "增量同步已覆盖到的时间点",
    tone: "",
  },
  {
    label: "下次增量",
    value: status.value.nextDeltaAt ? formatTime(status.value.nextDeltaAt) : "未排期",
    hint: `按 ${status.value.deltaCron || "-"} 自动运行`,
    tone: "",
  },
  {
    label: "更改记录",
    value: `${status.value.logCount}`,
    hint: "最近更改库中条数",
    tone: "",
  },
  {
    label: "图片索引",
    value: `${status.value.imageIndexCount}`,
    hint: "参与增量比对的图片数",
    tone: "",
  },
  {
    label: "忽略规则",
    value: `${status.value.ignoreCount ?? 0}`,
    hint: "数据库驱动的跳过名单",
    tone: "",
  },
]);

const hasMore = computed(() => entries.value.length < total.value);

type ToastPayload = { type: "success" | "warning" | "error"; message: string };

/** 既支持 `notify("success", "…")`，也支持子组件的 `@notify="notify"` 事件负载 */
function notify(type: ToastPayload["type"], message: string): void;
function notify(payload: ToastPayload): void;
function notify(payload: ToastPayload["type"] | ToastPayload, message?: string): void {
  const toastPayload: ToastPayload =
    typeof payload === "string"
      ? { type: payload, message: message ?? "" }
      : payload;
  toast.value = toastPayload;
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.value = null;
  }, 4000);
}

function isActive(task: TaskSnapshot): boolean {
  return task.state === "running" || task.state === "paused";
}

function percent(task: TaskSnapshot): number {
  const { current, total: all } = task.progress;
  if (!all) return task.state === "running" ? 5 : 0;
  return Math.min(100, Math.round((current / all) * 100));
}

function progressStatus(
  task: TaskSnapshot,
): "" | "success" | "warning" | "exception" {
  if (task.state === "paused") return "warning";
  if (task.progress.failed > 0 && task.state === "idle") return "exception";
  if (task.state === "idle" && percent(task) >= 100) return "success";
  return "";
}

async function refreshStatus(): Promise<void> {
  const next = await call<SyncStatus>("sync/status");
  if (next) status.value = next;
}

async function reload(append = false): Promise<void> {
  if (append) {
    if (loadingMore.value || !hasMore.value) return;
    loadingMore.value = true;
  } else {
    if (loading.value) return;
    loading.value = true;
  }

  const page = await call<{
    entries: ChangeItem[];
    total: number;
    totalAll: number;
  }>("sync/logs", {
    offset: append ? entries.value.length : 0,
    limit: PAGE_SIZE,
    keyword: keyword.value.trim() || undefined,
  });

  if (append) loadingMore.value = false;
  else loading.value = false;
  if (!page) return;

  entries.value = append ? [...entries.value, ...page.entries] : page.entries;
  total.value = page.total;
}

function loadMore(): void {
  void reload(true);
}

async function control(
  taskId: TaskId,
  action: "start" | "pause" | "resume" | "stop",
): Promise<void> {
  const result = await call<{ ok: boolean; message: string; status: SyncStatus }>(
    "sync/control",
    { taskId, action },
  );
  if (!result) return;
  status.value = result.status;
  notify(result.ok ? "success" : "warning", result.message);
}

function openDetail(item: ChangeItem): void {
  selectedChange.value = item;
  diffOpen.value = true;
}

function openTaskDetail(task: TaskSnapshot): void {
  openedTask.value = task;
  taskOpen.value = true;
}

watch(keyword, () => {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => void reload(), 300);
});

// 任务结束后刷新列表（进度推送很频繁，不能每次都查）
watch(
  () => status.value.tasks.map((task) => task.lastSummary).join("|"),
  () => void reload(),
);

watch(
  () => ((store as any).onisync as SyncStatus | undefined)?.version,
  () => {
    const next = (store as any).onisync as SyncStatus | undefined;
    if (next) status.value = next;
  },
);

onMounted(() => {
  const initial = (store as any).onisync as SyncStatus | undefined;
  if (initial) status.value = initial;
  void refreshStatus();
  void reload();
});
</script>

<style lang="scss" scoped>
@use "../shared/styles/drawer.scss" as *;

.oni-sync {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ───────────────────────── 概览 ───────────────────────── */
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
}

.stat-label {
  font-size: 11px;
  letter-spacing: 0.4px;
  color: var(--el-text-color-secondary);
}

.stat-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--el-text-color-primary);
}

.stat-hint {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

/* ───────────────────────── 任务卡片 ───────────────────────── */
.tasks {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 12px;
}

.task {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  cursor: pointer;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
  transition: border-color 0.2s, box-shadow 0.2s;

  &:hover {
    border-color: var(--el-border-color);
    box-shadow: 0 4px 16px rgb(0 0 0 / 6%);
  }

  &.state-running {
    border-color: var(--el-color-primary-light-5);
  }

  &.state-paused {
    border-color: var(--el-color-warning-light-5);
  }
}

.task-head {
  display: flex;
  gap: 8px;
  align-items: center;

  h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .state-pill {
    margin-left: auto;
  }
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-text-color-placeholder);

  &.is-running {
    background: var(--el-color-success);
    animation: pulse 1.6s infinite;
  }

  &.is-paused {
    background: var(--el-color-warning);
  }

  &.is-stopped {
    background: var(--el-color-danger);
  }
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

.badge {
  padding: 0 6px;
  font-size: 10px;
  line-height: 16px;
  color: var(--el-color-primary);
  background: color-mix(in srgb, var(--el-color-primary) 18%, transparent);
  border-radius: 8px;
}

.task-desc {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--el-text-color-secondary);
}

.task-body {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
  min-height: 62px;
}

.progress-line {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.phase {
  font-weight: 600;
  color: var(--el-color-primary);
}

.counters {
  display: flex;
  gap: 10px;
  font-size: 11px;

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

.task-message {
  margin: 0;
  overflow: hidden;
  font-size: 12px;
  color: var(--el-text-color-regular);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-error {
  margin: 0;
  overflow: hidden;
  font-size: 11px;
  color: var(--el-color-danger);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.task-time {
  margin: 0;
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

.task-actions {
  display: flex;
  gap: 6px;
  padding-top: 8px;
  border-top: 1px dashed var(--el-border-color-lighter);
}

.toast {
  padding: 8px 12px;
  margin: 0;
  font-size: 12px;
  border-radius: 8px;

  &.is-success {
    color: var(--el-color-success);
    background: color-mix(in srgb, var(--el-color-success) 14%, transparent);
  }

  &.is-warning {
    color: var(--el-color-warning);
    background: color-mix(in srgb, var(--el-color-warning) 14%, transparent);
  }

  &.is-error {
    color: var(--el-color-danger);
    background: color-mix(in srgb, var(--el-color-danger) 14%, transparent);
  }
}

/* ───────────────────────── 最近更改 ───────────────────────── */
.changes {
  padding: 14px 16px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
}

.changes-head {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
}

.changes-title {
  display: flex;
  gap: 8px;
  align-items: baseline;

  h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
}

.changes-tools {
  display: flex;
  gap: 8px;
  align-items: center;
}

.filter-keyword {
  width: 220px;
}

.change-list {
  margin-top: 10px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.change-row {
  display: grid;
  grid-template-columns: 96px minmax(120px, 1.3fr) 100px 64px minmax(100px, 1.8fr);
  gap: 10px;
  align-items: center;
  width: 100%;
  padding: 8px 6px;
  font-size: 13px;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;

  &:hover {
    background: var(--el-fill-color-light);
  }
}

.time {
  font-family: var(--el-font-family-mono, monospace);
  font-size: 11px;
  color: var(--el-text-color-secondary);
}

.title,
.user,
.comment {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.title {
  font-weight: 500;
  color: var(--el-color-primary);
}

.user {
  font-size: 12px;
  color: var(--el-text-color-regular);
}

.comment {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.size {
  font-family: var(--el-font-family-mono, monospace);
  font-size: 12px;

  &.plus {
    color: var(--el-color-success);
  }

  &.minus {
    color: var(--el-color-danger);
  }

  &.zero {
    color: var(--el-text-color-placeholder);
  }
}

.load-more {
  width: 100%;
  padding: 10px;
  font-size: 12px;
  color: var(--el-color-primary);
  cursor: pointer;
  background: transparent;
  border: none;

  &:hover {
    background: var(--el-fill-color-light);
  }
}

/* ───────────────────────── 移动端 ───────────────────────── */
@media (max-width: 768px) {
  .stats {
    grid-template-columns: repeat(2, 1fr);
  }

  .tasks {
    grid-template-columns: 1fr;
  }

  .changes {
    padding: 12px;
  }

  .filter-keyword {
    width: 100%;
  }

  .changes-tools {
    width: 100%;
  }

  .change-row {
    grid-template-columns: 1fr auto;
    gap: 2px 8px;

    .time {
      grid-column: 1;
    }

    .size {
      grid-column: 2;
      justify-self: end;
    }

    .title {
      grid-column: 1 / -1;
    }

    .user,
    .comment {
      grid-column: 1 / -1;
    }
  }
}
</style>
