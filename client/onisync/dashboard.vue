<template>
  <div class="oni-sync">
    <!-- ───────────────────────── 任务控制面板 ───────────────────────── -->
    <section class="panel">
      <header class="panel-head">
        <div class="state">
          <span class="dot" :class="statusClass" />
          <span class="state-text">{{ stateLabel }}</span>
          <el-tag v-if="status.lastTrigger" size="small" effect="plain" round>
            {{ triggerLabel }}
          </el-tag>
        </div>

        <div class="actions">
          <el-button
            type="primary"
            size="small"
            :disabled="busy"
            :loading="acting === 'start'"
            @click="control('start')"
          >
            <el-icon><VideoPlay /></el-icon>
            <span class="hide-sm">开始同步</span>
          </el-button>

          <el-button
            v-if="status.state === 'paused'"
            size="small"
            :loading="acting === 'resume'"
            @click="control('resume')"
          >
            <el-icon><VideoPlay /></el-icon>
            <span class="hide-sm">继续</span>
          </el-button>
          <el-button
            v-else
            size="small"
            :disabled="status.state !== 'running'"
            :loading="acting === 'pause'"
            @click="control('pause')"
          >
            <el-icon><VideoPause /></el-icon>
            <span class="hide-sm">暂停</span>
          </el-button>

          <el-button
            type="danger"
            plain
            size="small"
            :disabled="!busy"
            :loading="acting === 'stop'"
            @click="control('stop')"
          >
            <el-icon><Close /></el-icon>
            <span class="hide-sm">停止</span>
          </el-button>
        </div>
      </header>

      <!-- 进度 -->
      <div class="progress-block">
        <div class="progress-line">
          <span class="phase">{{ status.progress.phase || "空闲" }}</span>
          <span class="progress-detail">
            {{ status.progress.current }} / {{ status.progress.total || "?" }}
          </span>
          <span class="counters">
            <span class="ok">同步 {{ status.progress.synced }}</span>
            <span class="skip">跳过 {{ status.progress.skipped }}</span>
            <span class="bad">失败 {{ status.progress.failed }}</span>
          </span>
        </div>
        <el-progress
          :percentage="percentage"
          :status="progressStatus"
          :stroke-width="6"
          :show-text="false"
        />
        <p v-if="status.progress.message" class="progress-message">
          {{ status.progress.message }}
        </p>
      </div>

      <!-- 元信息 + cron -->
      <div class="meta">
        <div class="meta-item">
          <span class="label">下次自动同步</span>
          <span class="value">{{ formatTime(status.nextRunAt) }}</span>
        </div>
        <div class="meta-item">
          <span class="label">同步水位</span>
          <span class="value">{{ status.lastSyncTime ? formatISO(status.lastSyncTime) : "未设置" }}</span>
        </div>
        <div class="meta-item">
          <span class="label">图片索引</span>
          <span class="value">{{ status.imageIndexCount }} 张</span>
        </div>
        <div class="meta-item">
          <span class="label">更改记录</span>
          <span class="value">{{ status.logCount }} 条</span>
        </div>
      </div>

      <div class="cron-row">
        <el-input
          v-model="cronInput"
          size="small"
          class="cron-input"
          placeholder="cron 表达式，如 15 * * * *"
        >
          <template #prefix>
            <el-icon><Timer /></el-icon>
          </template>
        </el-input>
        <el-button size="small" :loading="savingCron" @click="saveCron">
          保存定时
        </el-button>
      </div>

      <p v-if="status.lastResult" class="last-result">
        <el-icon><Clock /></el-icon>
        {{ status.lastResult }}
      </p>
      <p v-if="status.lastError" class="last-error">
        <el-icon><WarningFilled /></el-icon>
        上次执行失败：{{ status.lastError }}
      </p>

      <transition name="fade">
        <p v-if="toast" class="toast" :class="`is-${toast.type}`">{{ toast.message }}</p>
      </transition>
    </section>

    <!-- ───────────────────────── 最近更改列表 ───────────────────────── -->
    <section class="panel list-panel">
      <header class="panel-head">
        <div class="state">
          <span class="state-text">最近更改</span>
          <span class="hint">共 {{ total }} 条</span>
        </div>
        <div class="filters">
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
          <el-button size="small" :loading="loading" @click="reload()">
            <el-icon><Refresh /></el-icon>
            <span class="hide-sm">刷新</span>
          </el-button>
          <el-button size="small" type="danger" plain @click="clearLogs">
            <el-icon><Delete /></el-icon>
            <span class="hide-sm">清空</span>
          </el-button>
        </div>
      </header>

      <div class="change-list">
        <template v-if="entries.length > 0">
          <button
            v-for="item in entries"
            :key="item.id"
            class="change-row"
            @click="openDetail(item)"
          >
            <span class="time">{{ formatISO(item.timestamp) }}</span>
            <span class="title" :title="item.title">{{ item.title }}</span>
            <span class="user">@{{ item.user }}</span>
            <span class="size" :class="sizeClass(item.sizeDiff)">
              {{ formatSize(item.sizeDiff) }}
            </span>
            <span class="comment" :title="item.comment">{{ item.comment || "（无摘要）" }}</span>
            <el-icon class="arrow"><ArrowRight /></el-icon>
          </button>

          <button v-if="hasMore" class="load-more" :disabled="loadingMore" @click="loadMore">
            {{ loadingMore ? "加载中…" : `加载更早的更改（还有 ${total - entries.length} 条）` }}
          </button>
        </template>

        <div v-else-if="loading" class="hint big">加载中…</div>
        <div v-else class="hint big">
          <p>暂无更改记录</p>
          <p class="hint-sub">
            增量同步运行后，这里会按时间倒序展示原站的最近编辑
          </p>
        </div>
      </div>
    </section>

    <!-- ───────────────────────── 详情抽屉 ───────────────────────── -->
    <transition name="fade">
      <div v-if="detailVisible" class="mask" @click.self="closeDetail">
        <div class="drawer">
          <header class="drawer-head">
            <div class="drawer-title">
              <h3>{{ detail?.title }}</h3>
              <div class="drawer-meta">
                <span>{{ detail?.user ? "@" + detail.user : "" }}</span>
                <span>{{ detail ? formatISO(detail.timestamp) : "" }}</span>
                <span :class="sizeClass(detail?.sizeDiff ?? 0)">
                  {{ formatSize(detail?.sizeDiff ?? 0) }}
                </span>
              </div>
            </div>
            <el-button size="small" text @click="closeDetail">
              <el-icon><Close /></el-icon>
            </el-button>
          </header>

          <p v-if="detail?.comment" class="drawer-comment">{{ detail.comment }}</p>

          <div v-if="detailLoading" class="hint big">正在获取 diff…</div>
          <div v-else-if="safeDiff" class="diff" v-html="safeDiff" />
          <div v-else class="hint big">
            该次编辑没有可展示的 diff（可能是新建页面或内容过大）
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script lang="ts" setup>
import { computed, onMounted, ref, watch } from "vue";
import { send, store, Time } from "@koishijs/client";
import {
  ArrowRight,
  Clock,
  Close,
  Delete,
  Refresh,
  Search,
  Timer,
  VideoPause,
  VideoPlay,
  WarningFilled,
} from "@element-plus/icons-vue";

type SyncTaskState = "idle" | "running" | "paused" | "stopped";

interface SyncProgress {
  phase: string;
  current: number;
  total: number;
  synced: number;
  skipped: number;
  failed: number;
  message: string;
}

interface SyncStatus {
  state: SyncTaskState;
  progress: SyncProgress;
  lastError?: string;
  lastSummary?: string;
  lastTrigger?: string;
  version: number;
  cron: string;
  nextRunAt?: number;
  lastSyncTime?: string;
  lastResult?: string;
  imageIndexCount: number;
  logCount: number;
}

interface ChangeItem {
  id: string;
  title: string;
  user: string;
  timestamp: string;
  comment: string;
  sizeDiff: number;
}

interface ChangeDetail extends ChangeItem {
  diffHtml: string;
  revid: string;
  parentid: string;
  ns: number;
}

const PAGE_SIZE = 50;

const EMPTY_STATUS: SyncStatus = {
  state: "idle",
  progress: {
    phase: "空闲",
    current: 0,
    total: 0,
    synced: 0,
    skipped: 0,
    failed: 0,
    message: "",
  },
  version: 0,
  cron: "",
  imageIndexCount: 0,
  logCount: 0,
};

const status = ref<SyncStatus>(EMPTY_STATUS);
const cronInput = ref("");
const savingCron = ref(false);
const acting = ref<"start" | "pause" | "resume" | "stop" | "">("");

const entries = ref<ChangeItem[]>([]);
const total = ref(0);
const keyword = ref("");
const loading = ref(false);
const loadingMore = ref(false);

const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<ChangeDetail | null>(null);

const toast = ref<{ type: "success" | "warning" | "error"; message: string } | null>(null);
let toastTimer: number | undefined;
let debounceTimer: number | undefined;

/** 轻量提示：不依赖 ElMessage（控制台里未必注册），4 秒后自动消失 */
function notify(type: "success" | "warning" | "error", message: string): void {
  toast.value = { type, message };
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.value = null;
  }, 4000);
}

const busy = computed(
  () => status.value.state === "running" || status.value.state === "paused",
);

const stateLabel = computed(() => {
  switch (status.value.state) {
    case "running":
      return "运行中";
    case "paused":
      return "已暂停";
    case "stopped":
      return "已停止";
    default:
      return "空闲";
  }
});

const statusClass = computed(() => `is-${status.value.state}`);

const triggerLabel = computed(() => {
  switch (status.value.lastTrigger) {
    case "cron":
      return "定时触发";
    case "console":
      return "控制台触发";
    case "command":
      return "指令触发";
    default:
      return status.value.lastTrigger ?? "";
  }
});

const percentage = computed(() => {
  const { current, total: all } = status.value.progress;
  if (!all) return status.value.state === "running" ? 5 : 0;
  return Math.min(100, Math.round((current / all) * 100));
});

const progressStatus = computed(() => {
  if (status.value.state === "paused") return "warning";
  if (status.value.progress.failed > 0 && status.value.state === "idle") return "exception";
  if (status.value.state === "idle" && percentage.value >= 100) return "success";
  return "";
});

const hasMore = computed(() => entries.value.length < total.value);

/** 只放行常见的安全标签，去掉 script / on* 处理器，防止 wiki 侧被注入 */
function sanitize(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/javascript:/gi, "");
}

const safeDiff = computed(() => (detail.value?.diffHtml ? sanitize(detail.value.diffHtml) : ""));

function formatISO(value?: string): string {
  if (!value) return "-";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return Time.template("yyyy-MM-dd hh:mm", new Date(time));
}

function formatTime(value?: number): string {
  if (!value) return "未排期";
  return Time.template("yyyy-MM-dd hh:mm:ss", new Date(value));
}

function formatSize(diff: number): string {
  if (!diff) return "±0";
  return diff > 0 ? `+${diff}` : `${diff}`;
}

function sizeClass(diff: number): string {
  if (diff > 0) return "plus";
  if (diff < 0) return "minus";
  return "zero";
}

async function call<T>(event: string, payload?: unknown): Promise<T | undefined> {
  try {
    return (await (send as any)(event, payload)) as T;
  } catch (error) {
    console.warn(`${event} 调用失败`, error);
    return undefined;
  }
}

async function refreshStatus(): Promise<void> {
  const next = await call<SyncStatus>("sync/status");
  if (next) {
    status.value = next;
    if (!cronInput.value) cronInput.value = next.cron;
  }
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

async function control(action: "start" | "pause" | "resume" | "stop"): Promise<void> {
  acting.value = action;
  const result = await call<{ ok: boolean; message: string; status: SyncStatus }>(
    "sync/control",
    { action },
  );
  acting.value = "";
  if (result) {
    status.value = result.status;
    notify(result.ok ? "success" : "warning", result.message);
  }
}

async function saveCron(): Promise<void> {
  const expression = cronInput.value.trim();
  if (!expression) return;
  savingCron.value = true;
  const result = await call<{ ok: boolean; message: string; status: SyncStatus }>(
    "sync/cron",
    { expression },
  );
  savingCron.value = false;
  if (result) {
    status.value = result.status;
    notify(result.ok ? "success" : "error", result.message);
  }
}

async function clearLogs(): Promise<void> {
  const result = await call<{ removed: number }>("sync/clearLogs");
  if (result) {
    notify("success", `已清空 ${result.removed} 条更改记录`);
    await reload();
  }
}

async function openDetail(item: ChangeItem): Promise<void> {
  detail.value = { ...item, diffHtml: "", revid: "", parentid: "", ns: 0 };
  detailVisible.value = true;
  detailLoading.value = true;
  const full = await call<ChangeDetail | null>("sync/detail", { id: item.id });
  detailLoading.value = false;
  if (full) detail.value = full;
}

function closeDetail(): void {
  detailVisible.value = false;
  detail.value = null;
}

/**
 * 任务结束 / 水位变化时重查列表，避免进度推送（每 400ms）把接口打爆
 */
watch(
  () => status.value.lastSummary,
  () => void reload(),
);

watch(keyword, () => {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => void reload(), 300);
});

onMounted(() => {
  const initial = (store as any).onisync as SyncStatus | undefined;
  if (initial) {
    status.value = initial;
    cronInput.value = initial.cron;
  }
  void refreshStatus();
  void reload();
});

// DataService 推送：只更新状态，不触发列表查询
watch(
  () => ((store as any).onisync as SyncStatus | undefined)?.version,
  () => {
    const next = (store as any).onisync as SyncStatus | undefined;
    if (!next) return;
    status.value = next;
    if (!cronInput.value) cronInput.value = next.cron;
  },
);
</script>

<style lang="scss" scoped>
.oni-sync {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.panel {
  padding: 14px 16px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
}

.panel-head {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
}

.state {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 14px;
  font-weight: 600;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--el-text-color-placeholder);

  &.is-running {
    background: var(--el-color-success);
    box-shadow: 0 0 0 3px var(--el-color-success-light-9);
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
    opacity: 0.35;
  }
}

.hint {
  font-size: 12px;
  font-weight: 400;
  color: var(--el-text-color-secondary);

  &.big {
    padding: 40px 0;
    font-size: 13px;
    text-align: center;
  }
}

.hint-sub {
  margin-top: 6px;
  color: var(--el-text-color-placeholder);
}

.actions,
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.actions :deep(.el-button) {
  display: inline-flex;
  gap: 4px;
  align-items: center;
}

.filter-keyword {
  width: 220px;
}

.progress-block {
  margin-top: 14px;
}

.progress-line {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: baseline;
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.phase {
  font-size: 13px;
  font-weight: 600;
  color: var(--el-color-primary);
}

.counters {
  display: flex;
  gap: 10px;
  margin-left: auto;

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

.progress-message {
  margin: 6px 0 0;
  overflow: hidden;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 8px 16px;
  padding: 12px 0;
  margin-top: 10px;
  border-top: 1px dashed var(--el-border-color-lighter);
}

.meta-item {
  display: flex;
  flex-direction: column;
  gap: 2px;

  .label {
    font-size: 11px;
    color: var(--el-text-color-secondary);
  }

  .value {
    font-size: 13px;
    color: var(--el-text-color-primary);
  }
}

.cron-row {
  display: flex;
  gap: 8px;
}

.cron-input {
  max-width: 260px;
}

.last-result,
.last-error {
  display: flex;
  gap: 6px;
  align-items: center;
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.last-error {
  color: var(--el-color-danger);
}

.toast {
  padding: 8px 10px;
  margin: 10px 0 0;
  font-size: 12px;
  border-radius: 6px;

  &.is-success {
    color: var(--el-color-success);
    background: var(--el-color-success-light-9);
  }

  &.is-warning {
    color: var(--el-color-warning);
    background: var(--el-color-warning-light-9);
  }

  &.is-error {
    color: var(--el-color-danger);
    background: var(--el-color-danger-light-9);
  }
}

/* ------------------------------------------------------------- 更改列表 */
.list-panel {
  display: flex;
  flex-direction: column;
  min-height: 240px;
}

.change-list {
  margin-top: 10px;
  border-top: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
}

.change-row {
  display: grid;
  grid-template-columns: 120px minmax(140px, 1.4fr) 110px 72px minmax(120px, 2fr) 16px;
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
  overflow: hidden;
  font-size: 12px;
  color: var(--el-text-color-regular);
  text-overflow: ellipsis;
  white-space: nowrap;
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

.arrow {
  font-size: 12px;
  color: var(--el-text-color-placeholder);
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

/* --------------------------------------------------------------- 详情面板 */
.mask {
  position: fixed;
  inset: 0;
  z-index: 3000;
  display: flex;
  justify-content: flex-end;
  background: rgb(0 0 0 / 35%);
}

.drawer {
  display: flex;
  flex-direction: column;
  width: min(720px, 92vw);
  height: 100%;
  padding: 16px 18px;
  overflow: hidden;
  background: var(--el-bg-color);
  border-left: 1px solid var(--el-border-color-lighter);
}

.drawer-head {
  display: flex;
  gap: 10px;
  align-items: flex-start;
  justify-content: space-between;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.drawer-title h3 {
  margin: 0;
  font-size: 16px;
  word-break: break-all;
}

.drawer-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.drawer-comment {
  margin: 10px 0 0;
  font-size: 12px;
  color: var(--el-text-color-regular);
}

.diff {
  flex: 1;
  padding: 10px;
  margin-top: 10px;
  overflow: auto;
  font-family: var(--el-font-family-mono, monospace);
  font-size: 12px;
  line-height: 1.6;
  background: var(--el-fill-color-light);
  border-radius: 6px;

  /* wiki diff 自带大量内联样式，这里只做必要的收敛 */
  :deep(table) {
    width: 100%;
    border-collapse: collapse;
  }

  :deep(td) {
    padding: 2px 6px;
    vertical-align: top;
    word-break: break-word;
  }

  :deep(.diff-deletedline) {
    background: var(--el-color-danger-light-9);
  }

  :deep(.diff-addedline) {
    background: var(--el-color-success-light-9);
  }

  :deep(.diff-context) {
    color: var(--el-text-color-secondary);
  }
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ------------------------------------------------------------------ 移动端 */
@media (max-width: 768px) {
  .panel {
    padding: 12px;
  }

  .filter-keyword {
    width: 100%;
  }

  .cron-row {
    flex-wrap: wrap;
  }

  .cron-input {
    max-width: none;
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

    .arrow {
      display: none;
    }
  }

  .drawer {
    width: 100vw;
    padding: 12px;
  }

  .counters {
    margin-left: 0;
  }

  .hide-sm {
    display: none;
  }
}
</style>
