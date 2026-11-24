<template>
  <div class="ai-insights">
    <!-- ───────────────────────── 数据看板 ───────────────────────── -->
    <section class="cards">
      <div v-for="card in cards" :key="card.label" class="card">
        <span class="card-label">{{ card.label }}</span>
        <span class="card-value">{{ card.value }}</span>
        <span class="card-hint">{{ card.hint }}</span>
      </div>
    </section>

    <!-- ───────────────────────── 图表 ───────────────────────── -->
    <section class="charts">
      <div class="panel">
        <header class="panel-head">
          <h3>最近 7 天提问趋势</h3>
          <span class="muted">按北京时间切日</span>
        </header>
        <TrendChart :data="stats.dailyTrend" />
      </div>

      <div class="panel">
        <header class="panel-head">
          <h3>最关心的游戏名词 Top 5</h3>
          <span class="muted">检索关键词词频</span>
        </header>
        <KeywordBars :items="stats.topKeywords" @pick="pickKeyword" />
      </div>
    </section>

    <!-- ───────────────────────── 高频问题 ───────────────────────── -->
    <section class="panel">
      <header class="panel-head">
        <h3>高频问题 Top 10</h3>
        <span class="muted">点击可用该问题搜索对话流</span>
      </header>
      <div v-if="stats.topQuestions.length" class="chips">
        <button
          v-for="item in stats.topQuestions"
          :key="item.question"
          class="chip"
          :title="item.question"
          @click="pickKeyword(item.question)"
        >
          <span class="chip-text">{{ item.question }}</span>
          <span class="chip-count">{{ item.count }}</span>
        </button>
      </div>
      <p v-else class="muted empty-line">暂无提问记录</p>
    </section>

    <!-- ───────────────────────── 实时对话流 ───────────────────────── -->
    <section class="panel">
      <header class="panel-head logs-head">
        <div class="logs-title">
          <h3>实时对话流</h3>
          <span class="muted">共 {{ formatCount(totalAll) }} 条</span>
        </div>
        <div class="logs-tools">
          <el-input
            v-model="keyword"
            size="small"
            class="filter-keyword"
            placeholder="搜索用户名 / QQ / 问题"
            clearable
          >
            <template #prefix>
              <el-icon><Search /></el-icon>
            </template>
          </el-input>
          <label class="live-toggle" title="新对话写入时自动出现在列表顶部">
            <input v-model="live" type="checkbox" />
            实时
          </label>
          <button class="btn" :disabled="loading" @click="refreshAll">
            <el-icon><Refresh /></el-icon>
            刷新
          </button>
        </div>
      </header>

      <button v-if="pendingNew > 0" class="new-hint" @click="acceptNew">
        有 {{ pendingNew }} 条新对话，点击刷新
      </button>

      <div class="log-list">
        <button
          v-for="entry in entries"
          :key="entry.id"
          class="log-row"
          @click="openDetail(entry)"
        >
          <span class="time">{{ formatShortDateTime(entry.createdAt) }}</span>
          <span class="user" :title="entry.userId ? `QQ ${entry.userId}` : ''">
            {{ userLabel(entry) }}
          </span>
          <span class="question" :title="entry.question">{{ entry.question }}</span>
          <span class="answer" :title="entry.answerSummary">
            {{ entry.answerSummary || "—" }}
          </span>
          <span class="tools">
            <template v-if="entry.toolCalls.length === 0">
              <span class="muted">直接回答</span>
            </template>
            <span
              v-for="(tool, index) in entry.toolCalls"
              :key="index"
              class="tool-chip"
              :title="tool.page ? `${tool.keyword} → ${tool.page}` : toolLabel(tool)"
            >
              {{ tool.keyword || tool.name }}
            </span>
          </span>
        </button>

        <button
          v-if="hasMore"
          class="load-more"
          :disabled="loadingMore"
          @click="loadMore"
        >
          {{
            loadingMore
              ? "加载中…"
              : `加载更早的对话（还有 ${total - entries.length} 条）`
          }}
        </button>

        <div v-if="entries.length === 0" class="empty">
          <p>{{ loading ? "加载中…" : "暂无对话记录" }}</p>
          <p class="empty-sub">群友向机器人提问后，这里会实时出现</p>
        </div>
      </div>
    </section>

    <ChatDetailDrawer
      :open="detailOpen"
      :log="detail"
      :loading="detailLoading"
      @close="detailOpen = false"
    />
  </div>
</template>

<script lang="ts" setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useContext } from "@koishijs/client";
import { Refresh, Search } from "@element-plus/icons-vue";
import ChatDetailDrawer from "./components/ChatDetailDrawer.vue";
import KeywordBars from "./components/KeywordBars.vue";
import TrendChart from "./components/TrendChart.vue";
import { formatCount, toolLabel, userLabel } from "./format";
import { formatShortDateTime } from "../shared/time";
import { call } from "../shared/rpc";
import {
  EMPTY_STATS,
  type AiChatLogDetail,
  type AiChatLogPage,
  type AiChatLogSummary,
  type AiStats,
} from "./types";

/**
 * AI 运营面板：看板 + 图表 + 实时对话流。
 *
 * 数据全部来自控制台事件：`get-ai-stats` / `get-ai-logs` / `ai/get-log`，
 * 新对话由服务端广播 `ai/chat/new` 推过来，前端按「实时」开关决定是
 * 直接插到列表顶部还是攒成一条「有 N 条新对话」的提示。
 */
const PAGE_SIZE = 30;
/** 统计接口要读全表，实时推送下必须节流 */
const STATS_DEBOUNCE = 2000;

const ctx = useContext();

const stats = ref<AiStats>({ ...EMPTY_STATS });
const entries = ref<AiChatLogSummary[]>([]);
const total = ref(0);
const totalAll = ref(0);
const keyword = ref("");
const loading = ref(false);
const loadingMore = ref(false);
const live = ref(true);
const pendingNew = ref(0);

const detailOpen = ref(false);
const detailLoading = ref(false);
const detail = ref<AiChatLogDetail | null>(null);

let searchTimer: number | undefined;
let statsTimer: number | undefined;

const hasMore = computed(() => entries.value.length < total.value);

const cards = computed(() => {
  const trend = stats.value.dailyTrend;
  const today = trend.length > 0 ? trend[trend.length - 1].count : 0;
  return [
    {
      label: "总提问数",
      value: formatCount(stats.value.totalQuestions),
      hint: "全部历史提问",
    },
    {
      label: "独立用户数",
      value: formatCount(stats.value.totalUsers),
      hint: "按 QQ 号去重",
    },
    {
      label: "工具调用次数",
      value: formatCount(stats.value.toolCallCount),
      hint: "平均每次问答的检索量",
    },
    {
      label: "今日提问",
      value: formatCount(today),
      hint: "北京时间 0 点起",
    },
  ];
});

async function loadStats(): Promise<void> {
  const next = await call<AiStats>("get-ai-stats");
  if (next) stats.value = next;
}

async function reload(append = false): Promise<void> {
  if (append) {
    if (loadingMore.value || !hasMore.value) return;
    loadingMore.value = true;
  } else {
    if (loading.value) return;
    loading.value = true;
  }

  const page = await call<AiChatLogPage>("get-ai-logs", {
    offset: append ? entries.value.length : 0,
    limit: PAGE_SIZE,
    keyword: keyword.value.trim() || undefined,
  });

  if (append) loadingMore.value = false;
  else loading.value = false;
  if (!page) return;

  entries.value = append ? [...entries.value, ...page.entries] : page.entries;
  total.value = page.total;
  totalAll.value = page.totalAll;
}

function refreshAll(): void {
  pendingNew.value = 0;
  void loadStats();
  void reload();
}

function loadMore(): void {
  void reload(true);
}

async function openDetail(entry: AiChatLogSummary): Promise<void> {
  detail.value = null;
  detailLoading.value = true;
  detailOpen.value = true;

  const full = await call<AiChatLogDetail | null>("ai/get-log", {
    id: entry.id,
  });
  detailLoading.value = false;
  detail.value = full ?? null;
}

function pickKeyword(value: string): void {
  keyword.value = value;
}

function acceptNew(): void {
  refreshAll();
}

function scheduleStats(): void {
  window.clearTimeout(statsTimer);
  statsTimer = window.setTimeout(() => void loadStats(), STATS_DEBOUNCE);
}

/** 新对话：实时模式下插到顶部，否则只累加提示计数 */
function onNewChat(entry: AiChatLogSummary): void {
  // 同一条广播可能重复到达（断线重连后会补推）
  if (entries.value.some((item) => item.id === entry.id)) return;

  totalAll.value += 1;
  scheduleStats();

  if (!live.value || keyword.value.trim()) {
    pendingNew.value += 1;
    return;
  }

  const before = entries.value;
  const next = [entry, ...before];
  // 还有更早的历史时保持条数不变：翻页用的是 offset = 已加载条数，
  // 让列表凭空变长会把下一页的第一条挤成重复项。
  if (before.length < total.value && next.length > PAGE_SIZE) next.pop();

  entries.value = next;
  total.value += 1;
}

watch(keyword, () => {
  window.clearTimeout(searchTimer);
  pendingNew.value = 0;
  searchTimer = window.setTimeout(() => void reload(), 300);
});

onMounted(() => {
  // 客户端 Context 的 Events 没有跨包类型声明，这里与 `send` 一样走 any
  (ctx as any).on("ai/chat/new", onNewChat);
  refreshAll();
});

onBeforeUnmount(() => {
  window.clearTimeout(searchTimer);
  window.clearTimeout(statsTimer);
});
</script>

<style lang="scss" scoped>
@use "../shared/styles/drawer.scss" as *;

.ai-insights {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* ───────────────────────── 看板 ───────────────────────── */
.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 10px;
}

.card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px 14px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 10px;
}

.card-label {
  font-size: 11px;
  letter-spacing: 0.4px;
  color: var(--el-text-color-secondary);
}

.card-value {
  font-size: 22px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--el-text-color-primary);
}

.card-hint {
  font-size: 11px;
  color: var(--el-text-color-placeholder);
}

/* ───────────────────────── 面板 ───────────────────────── */
.panel {
  padding: 14px 16px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
}

.charts {
  display: grid;
  grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr);
  gap: 12px;
}

.panel-head {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: baseline;
  justify-content: space-between;
  margin-bottom: 6px;

  h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
}

/* ───────────────────────── 高频问题 ───────────────────────── */
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.chip {
  display: inline-flex;
  gap: 6px;
  align-items: center;
  max-width: 100%;
  padding: 4px 10px;
  font: inherit;
  font-size: 12px;
  color: var(--el-text-color-regular);
  cursor: pointer;
  background: var(--el-fill-color-light);
  border: 1px solid transparent;
  border-radius: 999px;
  transition: color 0.15s, border-color 0.15s;

  &:hover {
    color: var(--el-color-primary);
    border-color: var(--el-color-primary-light-5);
  }
}

.chip-text {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip-count {
  font-size: 11px;
  color: var(--el-color-primary);
}

.empty-line {
  margin: 8px 0 0;
}

/* ───────────────────────── 对话流 ───────────────────────── */
.logs-head {
  margin-bottom: 10px;
}

.logs-title {
  display: flex;
  gap: 8px;
  align-items: baseline;
}

.logs-tools {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.filter-keyword {
  width: 220px;
}

.live-toggle {
  display: inline-flex;
  gap: 4px;
  align-items: center;
  font-size: 12px;
  color: var(--el-text-color-secondary);
  cursor: pointer;
  user-select: none;

  input {
    cursor: pointer;
  }
}

.new-hint {
  width: 100%;
  padding: 6px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--el-color-primary);
  cursor: pointer;
  background: color-mix(in srgb, var(--el-color-primary) 10%, transparent);
  border: 1px dashed var(--el-color-primary-light-5);
  border-radius: 6px;
}

.log-list {
  border-top: 1px solid var(--el-border-color-lighter);
}

.log-row {
  display: grid;
  grid-template-columns:
    92px minmax(90px, 0.7fr) minmax(140px, 1.4fr)
    minmax(140px, 1.6fr) minmax(100px, 1fr);
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
  transition: background 0.15s;

  &:hover {
    background: var(--el-fill-color-light);
  }

  > span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .time {
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    color: var(--el-text-color-secondary);
  }

  .user {
    color: var(--el-text-color-regular);
  }

  .question {
    color: var(--el-text-color-primary);
  }

  .answer {
    color: var(--el-text-color-secondary);
  }
}

.tool-chip {
  display: inline-block;
  padding: 0 6px;
  margin-right: 4px;
  font-size: 11px;
  line-height: 18px;
  color: var(--el-color-primary);
  background: color-mix(in srgb, var(--el-color-primary) 12%, transparent);
  border-radius: 4px;
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
@media (max-width: 900px) {
  .charts {
    grid-template-columns: 1fr;
  }

  .panel {
    padding: 12px;
  }

  .logs-tools,
  .filter-keyword {
    width: 100%;
  }

  .log-row {
    grid-template-columns: 1fr auto;

    > span {
      white-space: normal;
    }

    .time {
      grid-column: 1;
    }

    .user {
      grid-column: 2;
      justify-self: end;
    }

    .question,
    .answer,
    .tools {
      grid-column: 1 / -1;
    }
  }
}
</style>
