import assert from "node:assert/strict";
import {
  AccountConfig,
  AiConfig,
  NotifyConfig,
  ScheduleConfig,
  SiteConfig,
} from "../src/config";

/**
 * schemastery 的 ObjectSchema 把字段放在 `dict` 上。
 * 这里做一次结构自检，避免实现细节变化后测试静默失效。
 */
function keysOf(schema: unknown): string[] {
  const dict = (schema as { dict?: Record<string, unknown> }).dict;
  return dict ? Object.keys(dict) : [];
}

const GROUPS = {
  AccountConfig,
  SiteConfig,
  NotifyConfig,
  ScheduleConfig,
  AiConfig,
};

describe("插件配置 schema", () => {
  it("每个分组都能取到键（schemastery 结构自检）", () => {
    for (const [name, schema] of Object.entries(GROUPS)) {
      assert.ok(keysOf(schema).length > 0, `${name} 未取到任何键`);
    }
  });

  it("分组之间不存在重复键（这正是本次重构修复的核心缺陷）", () => {
    const owner = new Map<string, string>();
    const duplicates: string[] = [];

    for (const [groupName, schema] of Object.entries(GROUPS)) {
      for (const key of keysOf(schema)) {
        const previous = owner.get(key);
        if (previous) {
          duplicates.push(`${key}: ${previous} 与 ${groupName}`);
        } else {
          owner.set(key, groupName);
        }
      }
    }

    assert.deepEqual(duplicates, [], "配置键被重复声明");
  });

  it("包含全部预期的配置键（键名不可悄悄丢失）", () => {
    const all = new Set(Object.values(GROUPS).flatMap((s) => keysOf(s)));
    const expected = [
      // 账号
      "ggUsername",
      "ggPassword",
      "bwikiusername",
      "bwikipassword",
      // 站点
      "domain",
      "main_site",
      "bwiki_site",
      // 通知
      "logsUrl",
      "notifyGroupIds",
      "notifyBotPlatform",
      // 定时任务
      "updateCron",
      // AI 问答
      "aiEnabled",
      "deepseekApiKey",
      "deepseekBaseUrl",
      "deepseekModel",
      "aiTemperature",
      "aiMaxTokens",
      "aiTimeout",
      "aiCooldown",
      "aiMaxQuestionLength",
      "aiMemoryTurns",
      "aiMemoryTtl",
      "aiChannelMemory",
      "aiCodeBlockMinChars",
    ];

    const missing = expected.filter((key) => !all.has(key));
    assert.deepEqual(missing, [], "缺少配置键");
  });

  it("已删除的向量 / 渲染文本配置不再出现", () => {
    const all = new Set(Object.values(GROUPS).flatMap((s) => keysOf(s)));
    const removed = [
      // 本地向量检索（0.12.0 废弃，0.12.5 删除）
      "vectorEnabled",
      "vectorIndexPath",
      "embeddingModel",
      "embeddingDtype",
      "embeddingCacheDir",
      "embeddingRemoteHost",
      "chunkSize",
      "chunkOverlap",
      "maxChunksPerPage",
      "retrieveTopK",
      "retrieveMinScore",
      "queryInstruction",
      "embedBatchSize",
      // 渲染文本落库（改为按需抓取后不再需要）
      "textSyncOnChange",
      "textApiUrl",
      "textTableMode",
      "textMaxLength",
      "textSyncInterval",
    ];

    const stillThere = removed.filter((key) => all.has(key));
    assert.deepEqual(stillThere, [], "废弃配置键应当已删除");
  });
});
