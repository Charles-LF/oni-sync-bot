import assert from "node:assert/strict";
import type { Mwn } from "mwn";
import { ModuleSyncer } from "../src/sync/moduleSync";
import { PageSyncer } from "../src/sync/pageSync";
import { ImageSyncer } from "../src/sync/imgSync";
import { IgnoreRuleSet } from "../src/domain/sync/ignoreRule";
import { describeFullSync } from "../src/application/sync/fullSyncUseCase";

/**
 * 这些测试针对 P3 引入的**依赖注入**本身：
 * 只覆盖"被忽略/提前返回"的分支，不会发起任何网络请求。
 */
const fakeBot = {} as unknown as Mwn;

describe("sync 模块的依赖注入", () => {
  describe("PageSyncer", () => {
    it("默认忽略列表包含「教程」", async () => {
      const syncer = new PageSyncer(fakeBot, fakeBot);
      const result = await syncer.syncOne("教程", "tester");
      assert.equal(result.success, true);
      assert.equal(result.reason, "ignored");
      assert.ok(result.detail?.includes("内置忽略名单"));
    });

    it("注入的 options 会覆盖默认忽略列表", async () => {
      const syncer = new PageSyncer(fakeBot, fakeBot, {
        options: { ignoredPages: new Set(["自定义页面"]) },
      });
      // 「教程」不再被忽略，于是会走到取内容那一步并因假 client 失败，
      // 从而证明默认值确实被替换掉了（而不是叠加）。
      const result = await syncer.syncOne("教程", "tester");
      assert.equal(result.success, false);
    });

    it("pageid 已被别的标题占用时，ensurePage 改为按主键覆盖而不是报错", async () => {
      const writes: string[] = [];
      const database = {
        async get() {
          return [];
        },
        async create() {
          writes.push("create");
          throw new Error("UNIQUE constraint failed: wikipages.id");
        },
        async set(_table: string, query: object, data: object) {
          writes.push("set");
          return { ...query, ...data };
        },
        async upsert() {
          writes.push("upsert");
          return {};
        },
      };
      const syncer = new PageSyncer(fakeBot, fakeBot, { database: database as any });
      await syncer.ensurePage(4872, "网孔砖");
      assert.deepEqual(writes, ["create", "set"]);
    });

    it("页面已在库里时不写入", async () => {
      const writes: string[] = [];
      const database = {
        async get() {
          return [{ id: 1, title: "已有页面" }];
        },
        async create() {
          writes.push("create");
        },
        async set() {
          writes.push("set");
        },
        async upsert() {
          writes.push("upsert");
        },
      };
      const syncer = new PageSyncer(fakeBot, fakeBot, { database: database as any });
      await syncer.ensurePage(1, "已有页面");
      assert.deepEqual(writes, []);
    });

    it("pageid 已被别的标题占用时，先按主键改标题，不再走 create 撞 UNIQUE", async () => {
      const writes: string[] = [];
      const database = {
        async get(_table: string, query: any) {
          // 按标题查不到，按 pageid 查得到（页面被改过名）
          return query.id === 4872 ? [{ id: 4872, title: "旧标题" }] : [];
        },
        async create() {
          writes.push("create");
        },
        async set(_table: string, query: object, data: object) {
          writes.push("set");
          return { ...query, ...data };
        },
        async upsert() {
          writes.push("upsert");
          return {};
        },
      };
      const syncer = new PageSyncer(fakeBot, fakeBot, { database: database as any });
      await syncer.ensurePage(4872, "网孔砖");
      assert.deepEqual(writes, ["set"]);
    });
  });

  describe("ModuleSyncer", () => {
    it("默认不忽略任何模块", async () => {
      const syncer = new ModuleSyncer(fakeBot, fakeBot);
      const result = await syncer.syncOne("Mod:Anything");
      assert.equal(result.success, false, "应尝试处理并因假 client 失败");
    });

    it("注入 ignoredModules 后命中忽略分支", async () => {
      const syncer = new ModuleSyncer(fakeBot, fakeBot, {
        options: { ignoredModules: ["Mod:Anything"] },
      });
      const result = await syncer.syncOne("Mod:Anything");
      assert.equal(result.success, true);
      assert.equal(result.reason, "ignored");
    });
  });

  describe("ImageSyncer", () => {
    it("默认不忽略任何图片", async () => {
      const syncer = new ImageSyncer(fakeBot, fakeBot);
      const result = await syncer.syncOne("Foo.png");
      assert.equal(result.success, false, "应尝试处理并因假 client 失败");
    });

    it("注入 ignoredImages 后命中忽略分支", async () => {
      const syncer = new ImageSyncer(fakeBot, fakeBot, {
        options: { ignoredImages: ["Foo.png"] },
      });
      const result = await syncer.syncOne("Foo.png");
      assert.equal(result.success, true);
      assert.equal(result.reason, "ignored");
    });

    it("数据库驱动的规则可命中图片（含 File: 前缀归一化）", async () => {
      const syncer = new ImageSyncer(fakeBot, fakeBot, {
        ignoreRules: new IgnoreRuleSet([
          { type: "image", name: "File:Foo.png", reason: "占位图" },
        ]),
      });
      const result = await syncer.syncOne("Foo.png");
      assert.equal(result.reason, "ignored");
      assert.ok(result.detail?.includes("占位图"));
    });
  });

  describe("PageSyncer 的数据库忽略规则", () => {
    it("通配规则命中时不发起任何请求", async () => {
      const syncer = new PageSyncer(fakeBot, fakeBot, {
        ignoreRules: new IgnoreRuleSet([
          { type: "page", name: "教程*", reason: "长期不同步" },
        ]),
      });
      const result = await syncer.syncOne("教程/电力", "tester");
      assert.equal(result.success, true);
      assert.equal(result.reason, "ignored");
      assert.ok(result.detail?.includes("教程*"));
    });
  });
});

describe("application/sync/FullSyncUseCase 摘要", () => {
  it("三种任务的结束摘要保持原有文案（会写进任务卡片与 last_result）", () => {
    const stats = { total: 10, synced: 8, skipped: 1, failed: 1 };
    assert.equal(
      describeFullSync("pages", stats),
      "页面 10 个：同步 8、跳过 1、失败 1",
    );
    assert.equal(
      describeFullSync("images", stats),
      "图片 10 张：转存 8、跳过 1、失败 1",
    );
    assert.equal(
      describeFullSync("modules", stats),
      "模块 10 个：同步 8、跳过 1、失败 1",
    );
  });
});
