import assert from "node:assert/strict";
import type { Mwn } from "mwn";
import { ModuleSyncer } from "../src/sync/moduleSync";
import { PageSyncer } from "../src/sync/pageSync";
import { ImageSyncer } from "../src/sync/imgSync";

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
      assert.deepEqual(result, { success: true, reason: "ignored" });
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
      assert.deepEqual(result, { success: true, reason: "ignored" });
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
      assert.deepEqual(result, { success: true, reason: "ignored" });
    });
  });
});
