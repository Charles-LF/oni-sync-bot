<template>
  <section class="ignore">
    <header class="ignore-head">
      <div class="ignore-title">
        <h3>忽略规则</h3>
        <span class="muted">
          共 {{ rules.length }} 条 · 名称支持 * 通配 · 页面 / 图片 / 模块分别匹配
        </span>
      </div>
    </header>

    <div class="ignore-form">
      <el-select v-model="draft.type" size="small" class="ignore-type">
        <el-option label="页面" value="page" />
        <el-option label="图片" value="image" />
        <el-option label="模块" value="module" />
      </el-select>
      <el-input
        v-model="draft.name"
        size="small"
        class="ignore-name-input"
        placeholder="名称，如 教程 / File:Old.png"
        @keyup.enter="add"
      />
      <el-input
        v-model="draft.reason"
        size="small"
        class="ignore-reason-input"
        placeholder="原因（可选，会显示在任务详情里）"
        @keyup.enter="add"
      />
      <button class="btn primary" :disabled="!draft.name.trim()" @click="add">
        添加
      </button>
    </div>

    <div class="ignore-list">
      <div v-for="rule in rules" :key="rule.id" class="ignore-row">
        <span class="ignore-tag" :class="`is-${rule.type}`">
          {{ typeLabel(rule.type) }}
        </span>
        <span class="ignore-name-text" :title="rule.name">{{ rule.name }}</span>
        <span class="ignore-reason-text" :title="rule.reason">
          {{ rule.reason || "—" }}
        </span>
        <button class="btn danger" @click="remove(rule)">移除</button>
      </div>
      <div v-if="rules.length === 0" class="empty">
        <p>暂无忽略规则</p>
        <p class="empty-sub">
          也可以直接用命令 sync.ignore.add 添加（需要管理员权限）
        </p>
      </div>
    </div>
  </section>
</template>

<script lang="ts" setup>
import { onMounted, ref } from "vue";
import { call } from "../rpc";
import { typeLabel } from "../format";
import type { IgnoreRuleView } from "../types";

/** 忽略规则维护面板：自包含数据加载与增删，结果通过 notify 交给页面统一提示 */
const emit = defineEmits<{
  notify: [payload: { type: "success" | "warning" | "error"; message: string }];
}>();

const rules = ref<IgnoreRuleView[]>([]);
const draft = ref({
  type: "page" as IgnoreRuleView["type"],
  name: "",
  reason: "",
});

async function load(): Promise<void> {
  const list = await call<IgnoreRuleView[]>("sync/ignore/list");
  if (list) rules.value = list;
}

async function add(): Promise<void> {
  const name = draft.value.name.trim();
  if (!name) return;

  const result = await call<{
    ok: boolean;
    message: string;
    rules: IgnoreRuleView[];
  }>("sync/ignore/add", {
    type: draft.value.type,
    name,
    reason: draft.value.reason.trim(),
  });
  if (!result) return;

  rules.value = result.rules;
  emit("notify", {
    type: result.ok ? "success" : "warning",
    message: result.message,
  });
  if (result.ok) draft.value = { ...draft.value, name: "", reason: "" };
}

async function remove(rule: IgnoreRuleView): Promise<void> {
  const result = await call<{
    ok: boolean;
    message: string;
    rules: IgnoreRuleView[];
  }>("sync/ignore/remove", { type: rule.type, name: rule.name });
  if (!result) return;

  rules.value = result.rules;
  emit("notify", {
    type: result.ok ? "success" : "warning",
    message: result.message,
  });
}

onMounted(() => void load());
</script>

<style lang="scss" scoped>
@use "../styles/drawer.scss" as *;

.ignore {
  padding: 14px 16px;
  background: var(--el-bg-color);
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 12px;
}

.ignore-head {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  justify-content: space-between;
}

.ignore-title {
  display: flex;
  gap: 8px;
  align-items: baseline;

  h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }
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

@media (max-width: 768px) {
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
}
</style>
