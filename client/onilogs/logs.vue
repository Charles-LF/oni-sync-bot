<template>
  <k-layout>
    <div class="oni-logs">
      <!-- 筛选区 -->
      <div class="toolbar">
        <div class="level-tabs" role="tablist">
          <button
            v-for="tab in LEVEL_TABS"
            :key="tab.value"
            class="level-tab"
            :class="{ active: levelMode === tab.value }"
            role="tab"
            @click="levelMode = tab.value"
          >
            {{ tab.label }}
            <span class="count">{{ counts[tab.value] }}</span>
          </button>
        </div>

        <div class="filters">
          <el-select
            v-model="scope"
            size="small"
            class="filter-scope"
            placeholder="所有模块"
            clearable
          >
            <el-option value="" label="所有模块" />
            <el-option
              v-for="item in snapshot.scopes"
              :key="item.name"
              :value="item.name"
              :label="`${item.name}（${item.count}）`"
            />
          </el-select>

          <el-input
            v-model="keyword"
            size="small"
            class="filter-keyword"
            placeholder="搜索内容 / 模块"
            clearable
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>

          <el-select
            v-model="timeRange"
            size="small"
            class="filter-range"
            placeholder="时间范围"
          >
            <el-option
              v-for="item in TIME_RANGES"
              :key="item.value"
              :value="item.value"
              :label="item.label"
            />
          </el-select>
        </div>

        <div class="actions">
          <el-button size="small" :loading="loading" @click="reload()">
            <el-icon><Refresh /></el-icon>
            <span class="hide-sm">刷新</span>
          </el-button>
          <el-button size="small" @click="scrollToLatest">
            <el-icon><Bottom /></el-icon>
            <span class="hide-sm">最新</span>
          </el-button>
          <el-button size="small" type="danger" plain @click="clearAll">
            <el-icon><Delete /></el-icon>
            <span class="hide-sm">清空</span>
          </el-button>
        </div>
      </div>

      <!-- 日志列表 -->
      <div ref="listRef" class="log-list" @scroll="onScroll">
        <div v-if="loading && logs.length === 0" class="hint">加载中…</div>
        <div v-else-if="logs.length === 0" class="hint">
          <p>没有匹配的日志</p>
          <p class="hint-sub">共 {{ snapshot.totalAll }} 条历史日志</p>
        </div>

        <template v-else>
          <button
            v-if="hasMore"
            class="load-more"
            :disabled="loadingMore"
            @click="loadMore"
          >
            {{ loadingMore ? "加载中…" : `加载更早的日志（还有 ${snapshot.total - logs.length} 条）` }}
          </button>

          <div
            v-for="item in logs"
            :key="item.id"
            class="log-row"
            :class="[`level-${item.level}`, { expanded: expanded === item.id }]"
            @click="toggle(item.id)"
          >
            <div class="row-head">
              <span class="time">{{ formatTime(item.time) }}</span>
              <span class="level-badge">{{ LEVEL_LABEL[item.level] }}</span>
              <span class="scope">{{ item.scope }}</span>
              <span class="message">{{ item.message }}</span>
            </div>
            <div v-if="expanded === item.id" class="row-detail">
              <div class="detail-line"><b>时间</b>{{ formatFull(item.time) }}</div>
              <div class="detail-line"><b>级别</b>{{ item.level }}</div>
              <div class="detail-line"><b>模块</b>{{ item.scope }}</div>
              <div class="detail-line"><b>来源</b>{{ item.name }}</div>
              <div class="detail-line"><b>序号</b>{{ item.id }}</div>
              <pre class="detail-message">{{ item.message }}</pre>
            </div>
          </div>

          <div class="list-end" />
        </template>
      </div>
    </div>
  </k-layout>
</template>

<script lang="ts" setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { send, store, Time } from "@koishijs/client";
import { Search, Refresh, Bottom, Delete } from "@element-plus/icons-vue";

type Level = "info" | "warn" | "error";

interface LogEntry {
  id: number;
  time: number;
  level: Level;
  name: string;
  scope: string;
  message: string;
}

interface Snapshot {
  entries: LogEntry[];
  total: number;
  totalAll: number;
  scopes: Array<{ name: string; count: number }>;
  levels: Record<Level, number>;
}

interface OniLogSummary {
  totalAll: number;
  lastId: number;
  version: number;
}

const LEVEL_TABS = [
  { value: "all", label: "全部" },
  { value: "info", label: "正常" },
  { value: "error", label: "警告 / 错误" },
] as const;

const TIME_RANGES = [
  { value: 0, label: "不限时间" },
  { value: 1, label: "最近 1 小时" },
  { value: 24, label: "最近 24 小时" },
  { value: 24 * 7, label: "最近 7 天" },
];

const LEVEL_LABEL: Record<Level, string> = {
  info: "信息",
  warn: "警告",
  error: "错误",
};

/** 单页条数；滚到顶部自动加载更早的 */
const PAGE_SIZE = 200;

const levelMode = ref<"all" | "info" | "error">("all");
const scope = ref("");
const keyword = ref("");
const timeRange = ref(0);

const logs = ref<LogEntry[]>([]);
const snapshot = ref<Snapshot>({
  entries: [],
  total: 0,
  totalAll: 0,
  scopes: [],
  levels: { info: 0, warn: 0, error: 0 },
});
const loading = ref(false);
const loadingMore = ref(false);
const expanded = ref<number | null>(null);

const listRef = ref<HTMLElement>();

const counts = computed(() => {
  const { info, warn, error } = snapshot.value.levels;
  // 与当前模块/关键词/时间筛选联动，选中模块后 tab 数字不会和列表打架
  return { all: info + warn + error, info, error: warn + error };
});

const hasMore = computed(() => logs.value.length < snapshot.value.total);

function levelsOf(mode: typeof levelMode.value): Level[] | undefined {
  if (mode === "info") return ["info"];
  if (mode === "error") return ["warn", "error"];
  return undefined;
}

function buildFilter(offset: number): Record<string, unknown> {
  const filter: Record<string, unknown> = { limit: PAGE_SIZE, offset };
  const levels = levelsOf(levelMode.value);
  if (levels) filter.levels = levels;
  if (scope.value) filter.scopes = [scope.value];
  if (keyword.value.trim()) filter.keyword = keyword.value.trim();
  if (timeRange.value > 0) {
    filter.from = Date.now() - timeRange.value * 3600_000;
  }
  return filter;
}

async function query(offset: number): Promise<Snapshot | undefined> {
  try {
    return (await (send as any)("onilogs/query", buildFilter(offset))) as Snapshot;
  } catch (error) {
    console.warn("查询日志失败", error);
    return undefined;
  }
}

/** 重新查询第一页（筛选变化、新日志到达、手动刷新） */
async function reload(keepScroll = false) {
  if (loading.value) return;
  loading.value = true;
  const result = await query(0);
  loading.value = false;
  if (!result) return;

  snapshot.value = result;
  logs.value = [...result.entries];
  expanded.value = null;

  await nextTick();
  if (!keepScroll) scrollToLatest();
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return;
  loadingMore.value = true;
  const result = await query(logs.value.length);
  loadingMore.value = false;
  if (!result) return;

  snapshot.value = { ...result, entries: snapshot.value.entries };
  // 更早的日志插到顶部
  logs.value = [...result.entries, ...logs.value];
}

function toggle(id: number) {
  expanded.value = expanded.value === id ? null : id;
}

function formatTime(time: number): string {
  return Time.template("MM-dd hh:mm:ss", new Date(time));
}

function formatFull(time: number): string {
  return Time.template("yyyy-MM-dd hh:mm:ss", new Date(time));
}

function scrollToLatest() {
  void nextTick(() => {
    const el = listRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function onScroll() {
  const el = listRef.value;
  if (!el) return;
  // 滚到顶部附近自动加载更早的日志
  if (el.scrollTop < 40 && hasMore.value) void loadMore();
}

async function clearAll() {
  try {
    await (send as any)("onilogs/clear");
    await reload();
  } catch (error) {
    console.warn("清空日志失败（需要权限 1）", error);
  }
}

// 新日志到达（摘要 version 变化）时刷新，但保留阅读位置
watch(
  () => ((store as any).onilogs as OniLogSummary | undefined)?.version,
  () => void reload(true),
);

watch([levelMode, scope, timeRange], () => void reload());

let debounceTimer: number | undefined;
watch(keyword, () => {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => void reload(), 300);
});

onMounted(() => void reload());
</script>

<style lang="scss" scoped>
/* 颜色一律用 Element Plus 变量，自动跟随 Koishi 明暗主题 */
.oni-logs {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 140px);
  min-height: 320px;
  color: var(--el-text-color-primary);
}

.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  padding: 2px 0 10px;
}

.level-tabs {
  display: inline-flex;
  padding: 2px;
  border-radius: 6px;
  background: var(--el-fill-color-light);
}

.level-tab {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  padding: 4px 10px;
  font-size: 13px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  background: transparent;
  border: none;
  border-radius: 4px;

  &:hover {
    color: var(--el-color-primary);
  }

  &.active {
    color: var(--el-color-primary);
    background: var(--el-bg-color);
    box-shadow: 0 1px 3px rgb(0 0 0 / 10%);
  }

  .count {
    font-size: 11px;
    color: var(--el-text-color-secondary);
  }
}

.filters {
  display: flex;
  flex: 1;
  flex-wrap: wrap;
  gap: 8px;
  min-width: 220px;
}

.filter-scope {
  width: 150px;
}

.filter-keyword {
  flex: 1;
  min-width: 140px;
}

.filter-range {
  width: 130px;
}

.actions {
  display: flex;
  gap: 6px;
}

.log-list {
  flex: 1;
  overflow-y: auto;
  overscroll-behavior: contain;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-bg-color);

  &::-webkit-scrollbar {
    width: 8px;
  }

  &::-webkit-scrollbar-thumb {
    background: var(--el-border-color);
    border-radius: 4px;
  }
}

.log-row {
  padding: 6px 10px;
  font-size: 13px;
  line-height: 1.5;
  cursor: pointer;
  border-bottom: 1px solid var(--el-border-color-lighter);

  &:hover,
  &.expanded {
    background: var(--el-fill-color-light);
  }
}

.row-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.time {
  flex: none;
  font-family: var(--el-font-family-mono, monospace);
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.level-badge {
  flex: none;
  padding: 0 5px;
  font-size: 11px;
  line-height: 17px;
  border: 1px solid currentcolor;
  border-radius: 3px;
}

.level-info .level-badge {
  color: var(--el-color-success);
}

.level-warn .level-badge {
  color: var(--el-color-warning);
}

.level-error .level-badge {
  color: var(--el-color-danger);
}

.scope {
  flex: none;
  max-width: 110px;
  overflow: hidden;
  font-size: 12px;
  color: var(--el-color-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.message {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.level-warn .message {
  color: var(--el-color-warning);
}

.level-error .message {
  color: var(--el-color-danger);
}

.row-detail {
  padding: 8px 0 2px 4px;
  margin-top: 6px;
  font-size: 12px;
  color: var(--el-text-color-regular);
  border-top: 1px dashed var(--el-border-color);
}

.detail-line {
  display: flex;
  gap: 8px;
  margin-bottom: 2px;

  b {
    flex: none;
    width: 40px;
    font-weight: 500;
    color: var(--el-text-color-secondary);
  }
}

.detail-message {
  padding: 8px;
  margin: 6px 0 0;
  font-family: var(--el-font-family-mono, monospace);
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--el-fill-color);
  border-radius: 4px;
}

.load-more {
  width: 100%;
  padding: 8px;
  font-size: 12px;
  color: var(--el-color-primary);
  cursor: pointer;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--el-border-color-lighter);

  &:hover {
    background: var(--el-fill-color-light);
  }
}

.hint {
  padding: 40px 16px;
  font-size: 13px;
  color: var(--el-text-color-secondary);
  text-align: center;
}

.hint-sub {
  margin-top: 4px;
  font-size: 12px;
  color: var(--el-text-color-placeholder);
}

.list-end {
  height: 1px;
}

/* 移动端：筛选竖排、消息换行到第二行 */
@media (max-width: 768px) {
  .oni-logs {
    height: calc(100vh - 120px);
  }

  .toolbar {
    gap: 6px;
  }

  .filters {
    order: 3;
    width: 100%;
  }

  .filter-scope,
  .filter-range {
    flex: 1;
    width: auto;
    min-width: 0;
  }

  .filter-keyword {
    width: 100%;
    min-width: 0;
  }

  .scope {
    max-width: 72px;
  }

  .row-head {
    flex-wrap: wrap;
  }

  .message {
    width: 100%;
    flex-basis: 100%;
  }

  .hide-sm {
    display: none;
  }
}
</style>
