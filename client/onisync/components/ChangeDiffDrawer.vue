<template>
  <transition name="fade">
    <div v-if="open" class="mask" @click.self="close">
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
          <button class="btn icon" @click="close">
            <el-icon><Close /></el-icon>
          </button>
        </header>

        <p v-if="detail?.comment" class="drawer-comment">{{ detail.comment }}</p>

        <div v-if="loading" class="empty"><p>正在获取 diff…</p></div>
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
</template>

<script lang="ts" setup>
import { computed, ref, watch } from "vue";
import { Close } from "@element-plus/icons-vue";
import { call } from "../rpc";
import { formatISO, formatSize, sizeClass } from "../format";
import type { ChangeDetail, ChangeItem, DiffLine } from "../types";

/** 最近更改的 diff 抽屉：打开时按需向源站取 unified diff 并缓存 */
const props = defineProps<{ open: boolean; item: ChangeItem | null }>();
const emit = defineEmits<{ close: [] }>();

const detail = ref<ChangeDetail | null>(null);
const loading = ref(false);

const diffLines = computed<DiffLine[]>(() =>
  detail.value?.diffHtml ? parseUnifiedDiff(detail.value.diffHtml) : [],
);

watch(
  () => [props.open, props.item?.id] as const,
  ([open, id]) => {
    if (!open || !id) return;
    // 先用列表里的轻量数据铺底，再等详情（含 diff）返回
    detail.value = { ...(props.item as ChangeItem), diffHtml: "", revid: "", parentid: "", ns: 0 };
    loading.value = true;
    void (async () => {
      const full = await call<ChangeDetail | null>("sync/detail", { id });
      loading.value = false;
      if (full) detail.value = full;
    })();
  },
  { immediate: true },
);

function close(): void {
  emit("close");
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
</script>

<style lang="scss" scoped>
@use "../../shared/styles/drawer.scss" as *;

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

@media (max-width: 768px) {
  .drawer {
    width: 100vw;
    padding: 12px;
  }
}
</style>
