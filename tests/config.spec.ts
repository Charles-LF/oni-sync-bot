import assert from "node:assert/strict";
import {
  AccountConfig,
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
    ];

    const missing = expected.filter((key) => !all.has(key));
    assert.deepEqual(missing, [], "缺少配置键");
  });
});
