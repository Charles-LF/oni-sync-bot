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
          <span class="state-pill" :class="`is-${task.state}`">{{ stateLabel(task.state) }}</span>
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
            <p v-if="task.progress.message" class="task-message" :title="task.progress.message">
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
          <span class="size" :class="sizeClass(item.sizeDiff)">{{ formatSize(item.sizeDiff) }}</span>
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
    <section class="ignore">
      <header class="changes-head">
        <div class="changes-title">
          <h3>忽略规则</h3>
          <span class="muted">
            共 {{ ignoreRules.length }} 条 · 名称支持 * 通配 · 页面 / 图片 / 模块分别匹配
          </span>
        </div>
      </header>

      <div class="ignore-form">
        <el-select v-model="newIgnore.type" size="small" class="ignore-type">
          <el-option label="页面" value="page" />
          <el-option label="图片" value="image" />
          <el-option label="模块" value="module" />
        </el-select>
        <el-input
          v-model="newIgnore.name"
          size="small"
          class="ignore-name-input"
          placeholder="名称，如 教程 / File:Old.png"
          @keyup.enter="addIgnore"
        />
        <el-input
          v-model="newIgnore.reason"
          size="small"
          class="ignore-reason-input"
          placeholder="原因（可选，会显示在任务详情里）"
          @keyup.enter="addIgnore"
        />
        <button
          class="btn primary"
          :disabled="!newIgnore.name.trim()"
          @click="addIgnore"
        >
          添加
        </button>
      </div>

      <div class="ignore-list">
        <div v-for="rule in ignoreRules" :key="rule.id" class="ignore-row">
          <span class="ignore-tag" :class="`is-${rule.type}`">
            {{ typeLabel(rule.type) }}
          </span>
          <span class="ignore-name-text" :title="rule.name">{{ rule.name }}</span>
          <span class="ignore-reason-text" :title="rule.reason">
            {{ rule.reason || "—" }}
          </span>
          <button class="btn danger" @click="removeIgnore(rule)">移除</button>
        </div>
        <div v-if="ignoreRules.length === 0" class="empty">
          <p>暂无忽略规则</p>
          <p class="empty-sub">也可以直接用命令 sync.ignore.add 添加（需要管理员权限）</p>
        </div>
      </div>
    </section>

    <!-- ───────────────────────── diff 抽屉 ───────────────────────── -->
    <transition name="fade">
      <div v-if="detailVisible" class="mask" @click.self="closeDetail">
        <div class="drawer">
          <header class="drawer-head">
            <div>
              <h3 class="drawer-title">{{ detail?.title }}</h3>
              <div class="drawer-meta">
                <span v-if="detail?.user">@{{ detail.user }}</span>
                <span>{{ detail ? formatISO(detail.timestamp) : "" }}</span>
                <span :class="sizeClass(detail?.sizeDiff ?? 0)">
                  {{ formatSize(detail?.sizeDiff ?? 0) }} 字节
                </span>
              </div>
            </div>
            <button class="btn icon" @click="closeDetail">
              <el-icon><Close /></el-icon>
            </button>
          </header>

          <p v-if="detail?.comment" class="drawer-comment">{{ detail.comment }}</p>

          <div v-if="detailLoading" class="empty"><p>正在获取 diff…</p></div>
          <div v-else-if="diffLines.length" class="diff">
            <div
              v-for="(line, index) in diffLines"
              :key="index"
              class="diff-line"
              :class="`diff-${line.type}`"
            >{{ line.text || " " }}</div>
          </div>
          <div v-else class="empty">
            <p>没有可展示的 diff</p>
            <p class="empty-sub">可能是新建页面，或原站未返回差异内容</p>
          </div>
        </div>
      </div>
    </transition>

    <!-- ───────────────────── 任务详情（日志 / 条目） ───────────────────── -->
    <transition name="fade">
      <div v-if="taskVisible" class="mask" @click.self="closeTaskDetail">
        <div class="drawer run-drawer">
          <header class="drawer-head">
            <div>
              <h3 class="drawer-title">{{ taskTitle }}</h3>
              <div class="drawer-meta">
                <span
                  v-if="taskDetail"
                  class="state-pill"
                  :class="`is-${taskDetail.run.state}`"
                >
                  {{ runStateLabel(taskDetail.run.state) }}
                </span>
                <span v-if="taskDetail">
                  {{ formatTime(taskDetail.run.startedAt) }} 开始
                </span>
                <span v-if="taskDetail?.run.trigger">
                  触发：{{ taskDetail.run.trigger }}
                </span>
                <span v-if="isLive" class="live-badge">● 实时</span>
              </div>
            </div>
            <button class="btn icon" @click="closeTaskDetail">
              <el-icon><Close /></el-icon>
            </button>
          </header>

          <p v-if="taskDetail?.run.message" class="drawer-comment">
            {{ taskDetail.run.message }}
          </p>

          <div class="run-counters">
            <span class="ok">成功 {{ taskDetail?.run.synced ?? 0 }}</span>
            <span class="skip">跳过 {{ taskDetail?.run.skipped ?? 0 }}</span>
            <span class="bad">失败 {{ taskDetail?.run.failed ?? 0 }}</span>
            <span class="muted">
              总计 {{ taskDetail?.run.total ?? 0 }} · 日志 {{ visibleLogs.length }} 条
            </span>
          </div>

          <div class="run-tabs">
            <button
              v-for="tab in runTabs"
              :key="tab.key"
              class="tab"
              :class="{ active: runTab === tab.key }"
              @click="runTab = tab.key"
            >
              {{ tab.label }}
              <span class="tab-count">{{ tab.count }}</span>
            </button>
          </div>

          <div v-if="taskLoading" class="empty"><p>正在读取运行记录…</p></div>

          <div v-else-if="runTab === 'logs'" ref="logBox" class="run-log">
            <div
              v-for="(line, index) in visibleLogs"
              :key="index"
              class="log-line"
              :class="`lv-${line.level}`"
            >
              <span class="log-time">{{ formatClock(line.at) }}</span>
              <span class="log-message">{{ line.message }}</span>
            </div>
            <div v-if="visibleLogs.length === 0" class="empty">
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
  </div>
</template>

<script lang="ts" setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { send, store, Time, useContext } from "@koishijs/client";
import {
  Close,
  Refresh,
  Search,
  VideoPause,
  VideoPlay,
} from "@element-plus/icons-vue";

type TaskState = "idle" | "running" | "paused" | "stopped";
type TaskId = "delta" | "pages" | "images" | "modules";

interface SyncProgress {
  phase: string;
  current: number;
  total: number;
  synced: number;
  skipped: number;
  failed: number;
  message: string;
}

interface TaskSnapshot {
  id: TaskId;
  label: string;
  description: string;
  controllable: boolean;
  state: TaskState;
  progress: SyncProgress;
  startedAt?: number;
  finishedAt?: number;
  lastError?: string;
  lastSummary?: string;
  lastTrigger?: string;
  /** 最近一次运行 id（点开卡片时取详情） */
  lastRunId?: string;
}

interface SyncStatus {
  tasks: TaskSnapshot[];
  activeId?: TaskId;
  version: number;
  deltaCron: string;
  nextDeltaAt?: number;
  lastSyncTime?: string;
  logCount: number;
  imageIndexCount: number;
  ignoreCount: number;
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

interface DiffLine {
  type: "add" | "del" | "meta" | "context";
  text: string;
}

/** 一次运行（`sync_runs`） */
interface SyncRunRow {
  id: string;
  taskId: string;
  trigger: string;
  state: "running" | "completed" | "stopped" | "failed";
  startedAt: number;
  finishedAt: number;
  message: string;
  total: number;
  synced: number;
  skipped: number;
  failed: number;
}

interface SyncRunItemRow {
  id: string;
  runId: string;
  title: string;
  action: "synced" | "skipped" | "failed";
  reason: string;
  at: number;
}

interface SyncRunLogRow {
  id: string;
  level: "info" | "warn" | "error";
  message: string;
  at: number;
}

interface SyncTaskDetail {
  run: SyncRunRow;
  items: {
    synced: SyncRunItemRow[];
    skipped: SyncRunItemRow[];
    failed: SyncRunItemRow[];
  };
  logs: SyncRunLogRow[];
}

/** `sync/log` 广播的实时日志 */
interface SyncLogEvent {
  runId: string;
  taskId: TaskId;
  level: "info" | "warn" | "error";
  message: string;
  at: number;
  seq: number;
}

interface IgnoreRuleView {
  id: number;
  type: "page" | "image" | "module";
  name: string;
  reason: string;
  createdAt: number;
}

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
const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<ChangeDetail | null>(null);
const toast = ref<{ type: "success" | "warning" | "error"; message: string } | null>(null);

/** 任务详情抽屉 */
const taskVisible = ref(false);
const taskLoading = ref(false);
const taskTitle = ref("");
const openedTaskId = ref<TaskId | null>(null);
const taskDetail = ref<SyncTaskDetail | null>(null);
const runTab = ref<"synced" | "skipped" | "failed" | "logs">("logs");
/** 前端保留的日志流（实时广播 + 打开时从库里补齐） */
const liveLogs = ref<SyncLogEvent[]>([]);
const logBox = ref<HTMLElement | null>(null);
/** 已展示日志的时间水位，避免「落库的」与「广播的」重复 */
let logCursor = 0;

/** 忽略规则 */
const ignoreRules = ref<IgnoreRuleView[]>([]);
const newIgnore = ref({
  type: "page" as IgnoreRuleView["type"],
  name: "",
  reason: "",
});

let toastTimer: number | undefined;
let debounceTimer: number | undefined;
let taskRefreshTimer: number | undefined;

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

const isLive = computed(() => taskDetail.value?.run.state === "running");

const visibleLogs = computed(() => liveLogs.value);

const runTabs = computed(() => [
  {
    key: "synced" as const,
    label: "成功",
    count: taskDetail.value?.items.synced.length ?? 0,
  },
  {
    key: "skipped" as const,
    label: "跳过",
    count: taskDetail.value?.items.skipped.length ?? 0,
  },
  {
    key: "failed" as const,
    label: "失败",
    count: taskDetail.value?.items.failed.length ?? 0,
  },
  { key: "logs" as const, label: "日志", count: liveLogs.value.length },
]);

const currentItems = computed<SyncRunItemRow[]>(() => {
  const detail = taskDetail.value;
  const tab = runTab.value;
  if (!detail || tab === "logs") return [];
  return detail.items[tab] ?? [];
});

const emptyItemText = computed(() => {
  switch (runTab.value) {
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

const diffLines = computed<DiffLine[]>(() =>
  detail.value?.diffHtml ? parseUnifiedDiff(detail.value.diffHtml) : [],
);

function notify(type: "success" | "warning" | "error", message: string): void {
  toast.value = { type, message };
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.value = null;
  }, 4000);
}

function stateLabel(state: TaskState): string {
  switch (state) {
    case "running":
      return "运行中";
    case "paused":
      return "已暂停";
    case "stopped":
      return "已停止";
    default:
      return "空闲";
  }
}

function isActive(task: TaskSnapshot): boolean {
  return task.state === "running" || task.state === "paused";
}

function percent(task: TaskSnapshot): number {
  const { current, total: all } = task.progress;
  if (!all) return task.state === "running" ? 5 : 0;
  return Math.min(100, Math.round((current / all) * 100));
}

function progressStatus(task: TaskSnapshot): "" | "success" | "warning" | "exception" {
  if (task.state === "paused") return "warning";
  if (task.progress.failed > 0 && task.state === "idle") return "exception";
  if (task.state === "idle" && percent(task) >= 100) return "success";
  return "";
}

function formatISO(value?: string): string {
  if (!value) return "-";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  return Time.template("MM-dd hh:mm", new Date(time));
}

function formatTime(value?: number): string {
  if (!value) return "-";
  return Time.template("yyyy-MM-dd hh:mm", new Date(value));
}

function formatClock(value?: number): string {
  if (!value) return "";
  return Time.template("hh:mm:ss", new Date(value));
}

function runStateLabel(state: SyncRunRow["state"]): string {
  switch (state) {
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "stopped":
      return "已停止";
    default:
      return "失败";
  }
}

function typeLabel(type: IgnoreRuleView["type"]): string {
  if (type === "page") return "页面";
  if (type === "image") return "图片";
  return "模块";
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

/**
 * 把 MediaWiki 的 unified diff（`<pre>` 里的一段文本）拆成带类型的行。
 * 老数据里可能存的是整表 HTML，此时退化成「去标签后的纯文本」。
 */
function parseUnifiedDiff(html: string): DiffLine[] {
  const preMatch = /<pre[^>]*>([\s\S]*?)<\/pre>/i.exec(html);
  const raw = preMatch ? preMatch[1] : html.replace(/<[^>]+>/g, "");
  const text = decodeEntities(raw).replace(/\r\n/g, "\n");

  return text
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .filter((line, index, all) => !(line === "" && index === all.length - 1))
    .map<DiffLine>((line) => {
      if (line.startsWith("@@")) return { type: "meta", text: line };
      if (line.startsWith("+++") || line.startsWith("---")) {
        return { type: "meta", text: line };
      }
      if (line.startsWith("+")) return { type: "add", text: line };
      if (line.startsWith("-")) return { type: "del", text: line };
      return { type: "context", text: line };
    });
}

function decodeEntities(input: string): string {
  return input
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
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

async function control(taskId: TaskId, action: "start" | "pause" | "resume" | "stop"): Promise<void> {
  const result = await call<{ ok: boolean; message: string; status: SyncStatus }>(
    "sync/control",
    { taskId, action },
  );
  if (!result) return;
  status.value = result.status;
  notify(result.ok ? "success" : "warning", result.message);
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

// ───────────────────────── 任务详情（运行记录 / 实时日志） ─────────────────────────

function scrollLogs(): void {
  void nextTick(() => {
    const box = logBox.value;
    if (box) box.scrollTop = box.scrollHeight;
  });
}

function openTaskDetail(task: TaskSnapshot): void {
  taskVisible.value = true;
  taskTitle.value = task.label;
  openedTaskId.value = task.id;
  taskDetail.value = null;
  liveLogs.value = [];
  logCursor = 0;
  runTab.value = "logs";
  void refreshTaskDetail(true);
  startTaskRefresh();
  void loadIgnoreRules();
}

function closeTaskDetail(): void {
  taskVisible.value = false;
  taskDetail.value = null;
  liveLogs.value = [];
  stopTaskRefresh();
}

async function refreshTaskDetail(reset: boolean): Promise<void> {
  const taskId = openedTaskId.value;
  if (!taskId) return;

  taskLoading.value = reset;
  const detail = await call<SyncTaskDetail | null>("sync/taskDetail", {
    taskId,
    runId: reset ? undefined : taskDetail.value?.run.id,
  });
  taskLoading.value = false;
  if (!detail) {
    if (reset) taskDetail.value = null;
    return;
  }

  taskDetail.value = detail;
  if (!reset) return;

  // 打开时先用库里已有的日志铺底，后续行由 sync/log 实时补上
  liveLogs.value = detail.logs.map((line) => ({
    runId: detail.run.id,
    taskId,
    level: line.level,
    message: line.message,
    at: line.at,
    seq: 0,
  }));
  const lastLog = liveLogs.value[liveLogs.value.length - 1];
  logCursor = lastLog?.at ?? 0;
  scrollLogs();
}

function startTaskRefresh(): void {
  stopTaskRefresh();
  // 只刷新条目列表（日志走广播）；结束的任务不再轮询
  taskRefreshTimer = window.setInterval(() => {
    if (!taskVisible.value) return;
    if (taskDetail.value?.run.state !== "running") return;
    void refreshTaskDetail(false);
  }, 3000);
}

function stopTaskRefresh(): void {
  window.clearInterval(taskRefreshTimer);
  taskRefreshTimer = undefined;
}

// ───────────────────────── 忽略规则 ─────────────────────────

async function loadIgnoreRules(): Promise<void> {
  const rules = await call<IgnoreRuleView[]>("sync/ignore/list");
  if (rules) ignoreRules.value = rules;
}

async function addIgnore(): Promise<void> {
  const name = newIgnore.value.name.trim();
  if (!name) return;

  const result = await call<{
    ok: boolean;
    message: string;
    rules: IgnoreRuleView[];
  }>("sync/ignore/add", {
    type: newIgnore.value.type,
    name,
    reason: newIgnore.value.reason.trim(),
  });
  if (!result) return;

  ignoreRules.value = result.rules;
  notify(result.ok ? "success" : "warning", result.message);
  if (result.ok) newIgnore.value = { ...newIgnore.value, name: "", reason: "" };
}

async function removeIgnore(rule: IgnoreRuleView): Promise<void> {
  const result = await call<{
    ok: boolean;
    message: string;
    rules: IgnoreRuleView[];
  }>("sync/ignore/remove", { type: rule.type, name: rule.name });
  if (!result) return;

  ignoreRules.value = result.rules;
  notify(result.ok ? "success" : "warning", result.message);
}

const clientContext = useContext();
// 服务端用 console.broadcast 推送；useContext 会在组件卸载时自动解绑
(clientContext as any).on("sync/log", (event: SyncLogEvent) => {
  if (!taskVisible.value) return;
  if (event.taskId !== openedTaskId.value) return;
  if (logCursor && event.at < logCursor) return;

  logCursor = Math.max(logCursor, event.at);
  liveLogs.value.push(event);
  if (liveLogs.value.length > 600) {
    liveLogs.value.splice(0, liveLogs.value.length - 600);
  }
  if (runTab.value === "logs") scrollLogs();
});

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
  void loadIgnoreRules();
});
</script>

<style lang="scss" scoped>
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

.state-pill {
  margin-left: auto;
  padding: 0 8px;
  font-size: 11px;
  line-height: 18px;
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  border-radius: 9px;

  &.is-running {
    color: var(--el-color-success);
    background: color-mix(in srgb, var(--el-color-success) 18%, transparent);
  }

  &.is-paused {
    color: var(--el-color-warning);
    background: color-mix(in srgb, var(--el-color-warning) 18%, transparent);
  }

  &.is-stopped {
    color: var(--el-color-danger);
    background: color-mix(in srgb, var(--el-color-danger) 18%, transparent);
  }
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

/* 通用按钮：比 el-button 更紧凑，卡片里更好看 */
.btn {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 5px 10px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  background: var(--el-fill-color-blank);
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  transition: all 0.15s;

  &:hover:not(:disabled) {
    color: var(--el-color-primary);
    border-color: var(--el-color-primary-light-5);
  }

  &:disabled {
    color: var(--el-text-color-disabled);
    cursor: not-allowed;
    opacity: 0.6;
  }

  &.primary {
    color: #fff;
    background: var(--el-color-primary);
    border-color: var(--el-color-primary);

    &:hover:not(:disabled) {
      color: #fff;
      background: color-mix(in srgb, var(--el-color-primary) 82%, #fff);
      border-color: color-mix(in srgb, var(--el-color-primary) 82%, #fff);
    }
  }

  &.danger {
    color: var(--el-color-danger);
    border-color: color-mix(in srgb, var(--el-color-danger) 45%, transparent);

    &:hover:not(:disabled) {
      background: color-mix(in srgb, var(--el-color-danger) 14%, transparent);
    }
  }

  &.icon {
    padding: 5px 7px;
  }
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

.muted {
  font-size: 12px;
  color: var(--el-text-color-secondary);
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

.empty {
  padding: 40px 10px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  text-align: center;

  p {
    margin: 0;
  }
}

.empty-sub {
  margin-top: 6px !important;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

/* ───────────────────────── diff 抽屉 ───────────────────────── */
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
  width: min(760px, 94vw);
  height: 100%;
  padding: 16px 18px;
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

.drawer-title {
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
  margin-top: 10px;
  overflow: auto;
  font-family: var(--el-font-family-mono, monospace);
  font-size: 12px;
  line-height: 1.65;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 8px;
}

.diff-line {
  padding: 0 10px;
  white-space: pre;
  border-left: 3px solid transparent;
}

.diff-add {
  color: var(--el-color-success);
  background: color-mix(in srgb, var(--el-color-success) 14%, transparent);

  &.diff-line {
    border-left-color: var(--el-color-success);
  }
}

.diff-del {
  color: var(--el-color-danger);
  background: color-mix(in srgb, var(--el-color-danger) 14%, transparent);

  &.diff-line {
    border-left-color: var(--el-color-danger);
  }
}

.diff-meta {
  color: var(--el-color-primary);
  background: color-mix(in srgb, var(--el-color-primary) 16%, transparent);
}

.diff-context {
  color: var(--el-text-color-regular);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.18s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ───────────────────────── 任务详情 ───────────────────────── */
.task {
  cursor: pointer;
}

.state-pill.is-completed {
  color: var(--el-color-success);
  background: color-mix(in srgb, var(--el-color-success) 18%, transparent);
}

.live-badge {
  font-size: 11px;
  color: var(--el-color-success);
  animation: pulse 1.6s infinite;
}

.run-drawer {
  width: min(880px, 96vw);
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

/* ───────────────────────── 忽略规则 ───────────────────────── */
.ignore {
  padding: 14px 16px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
}

.ignore-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.ignore-type {
  width: 100px;
}

.ignore-name-input {
  width: 240px;
}

.ignore-reason-input {
  flex: 1;
  min-width: 180px;
}

.ignore-list {
  margin-top: 10px;
  border-top: 1px solid var(--el-border-color-lighter);
}

.ignore-row {
  display: grid;
  grid-template-columns: 56px minmax(120px, 1fr) minmax(120px, 1.4fr) auto;
  gap: 10px;
  align-items: center;
  padding: 7px 4px;
  font-size: 12px;
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.ignore-tag {
  padding: 0 6px;
  font-size: 11px;
  line-height: 18px;
  text-align: center;
  border-radius: 9px;

  &.is-page {
    color: var(--el-color-primary);
    background: color-mix(in srgb, var(--el-color-primary) 16%, transparent);
  }

  &.is-image {
    color: var(--el-color-success);
    background: color-mix(in srgb, var(--el-color-success) 16%, transparent);
  }

  &.is-module {
    color: var(--el-color-warning);
    background: color-mix(in srgb, var(--el-color-warning) 16%, transparent);
  }
}

.ignore-name-text,
.ignore-reason-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ignore-name-text {
  font-family: var(--el-font-family-mono, monospace);
  color: var(--el-text-color-regular);
}

.ignore-reason-text {
  color: var(--el-text-color-secondary);
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

  .drawer {
    width: 100vw;
    padding: 12px;
  }

  .ignore-form {
    flex-direction: column;
  }

  .ignore-type,
  .ignore-name-input,
  .ignore-reason-input {
    width: 100%;
  }

  .ignore-row {
    grid-template-columns: 56px 1fr auto;
  }

  .ignore-reason-text {
    display: none;
  }

  .run-item {
    grid-template-columns: 1fr;

    .item-reason {
      white-space: normal;
    }
  }
}
</style>
