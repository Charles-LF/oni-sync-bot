import assert from "node:assert/strict";
import {
  IgnoreRuleSet,
  normalizeIgnoreName,
  type IgnoreRule,
  type IgnoreType,
  type StoredIgnoreRule,
} from "../src/domain/sync/ignoreRule";
import { classifySyncResult, decideIgnore } from "../src/domain/sync/decision";
import {
  DuplicateIgnoreRuleError,
  EmptyIgnoreNameError,
  IgnoreListUseCase,
  IgnoreRuleNotFoundError,
  InvalidIgnoreTypeError,
  type IgnoreRuleRepositoryPort,
} from "../src/application/sync/ignoreListUseCase";

/** 内存仓储：只实现用例用到的 4 个方法 */
class MemoryIgnoreRepository implements IgnoreRuleRepositoryPort {
  rows: StoredIgnoreRule[] = [];

  async list(type?: IgnoreType): Promise<StoredIgnoreRule[]> {
    return type ? this.rows.filter((row) => row.type === type) : [...this.rows];
  }

  async find(
    type: IgnoreType,
    name: string,
  ): Promise<StoredIgnoreRule | undefined> {
    const target = normalizeIgnoreName(type, name);
    return this.rows.find(
      (row) => row.type === type && normalizeIgnoreName(row.type, row.name) === target,
    );
  }

  async insert(rule: IgnoreRule): Promise<StoredIgnoreRule> {
    const row: StoredIgnoreRule = {
      id: this.rows.length + 1,
      type: rule.type,
      name: rule.name,
      reason: rule.reason ?? "",
      createdAt: Date.now(),
    };
    this.rows.push(row);
    return row;
  }

  async delete(type: IgnoreType, name: string): Promise<number> {
    const target = normalizeIgnoreName(type, name);
    const before = this.rows.length;
    this.rows = this.rows.filter(
      (row) =>
        !(row.type === type && normalizeIgnoreName(row.type, row.name) === target),
    );
    return before - this.rows.length;
  }
}

describe("domain/sync/ignoreRule 匹配规则", () => {
  it("大小写、下划线、首尾空白都不影响命中", () => {
    const rules = new IgnoreRuleSet([{ type: "page", name: "  MediaWiki:Common_CSS " }]);
    assert.ok(rules.match("page", "mediawiki:common css"));
    assert.ok(rules.match("page", "MediaWiki:Common_CSS"));
    assert.equal(rules.match("page", "MediaWiki:Common.js"), undefined);
  });

  it("图片规则忽略 File: / 文件: 前缀", () => {
    const rules = new IgnoreRuleSet([{ type: "image", name: "File:Foo.png" }]);
    assert.ok(rules.match("image", "Foo.png"));
    assert.ok(rules.match("image", "文件:Foo.png"));
    assert.equal(rules.match("image", "Bar.png"), undefined);
  });

  it("模块规则忽略 Module: 前缀", () => {
    const rules = new IgnoreRuleSet([{ type: "module", name: "Module:Mod:Foo" }]);
    assert.ok(rules.match("module", "Mod:Foo"));
  });

  it("支持 * 通配，且不跨类型误伤", () => {
    const rules = new IgnoreRuleSet([
      { type: "image", name: "File:Icon_*", reason: "图标批量忽略" },
      { type: "page", name: "沙盒*" },
    ]);
    assert.ok(rules.match("image", "File:Icon Building.png"));
    assert.equal(rules.match("image", "Logo.png"), undefined);
    assert.ok(rules.match("page", "沙盒/测试"));
    // 同名规则换类型不生效
    assert.equal(rules.match("module", "沙盒/测试"), undefined);
  });

  it("返回原始规则（便于展示原因与原始写法）", () => {
    const rules = new IgnoreRuleSet([
      { type: "page", name: "教程", reason: "原站教程页不同步" },
    ]);
    const hit = rules.match("page", "教程");
    assert.equal(hit?.name, "教程");
    assert.equal(hit?.reason, "原站教程页不同步");
  });
});

describe("domain/sync/decision 判定语义", () => {
  it("成功 + no_change / ignored 归为跳过，失败归为 failed", () => {
    assert.equal(classifySyncResult({ success: true, reason: "synced" }).action, "synced");
    assert.equal(classifySyncResult({ success: true, reason: "no_change" }).action, "skipped");
    assert.equal(classifySyncResult({ success: true, reason: "ignored" }).action, "skipped");
    const failed = classifySyncResult({ success: false, reason: "boom" });
    assert.equal(failed.action, "failed");
    assert.equal(failed.message, "boom");
  });

  it("数据库规则优先，内置名单兜底", () => {
    const rules = new IgnoreRuleSet([{ type: "page", name: "教程" }]);
    assert.equal(decideIgnore(rules, "page", "教程", true).rule?.name, "教程");
    assert.ok(decideIgnore(rules, "page", "首页", true).message.includes("内置"));
    assert.equal(decideIgnore(rules, "page", "电解器", false).ignored, false);
  });
});

describe("application/sync/IgnoreListUseCase", () => {
  it("添加后归一化查重：File:Foo.png 与 Foo.png 视为同一条", async () => {
    const useCase = new IgnoreListUseCase(new MemoryIgnoreRepository());
    await useCase.add({ type: "image", name: "File:Foo.png", reason: "占位图" });

    await assert.rejects(
      () => useCase.add({ type: "image", name: "foo.PNG" }),
      DuplicateIgnoreRuleError,
    );
    assert.equal((await useCase.list()).length, 1);
  });

  it("非法类型与空名称都会被拒绝", async () => {
    const useCase = new IgnoreListUseCase(new MemoryIgnoreRepository());
    await assert.rejects(
      () => useCase.add({ type: "unknown", name: "x" }),
      InvalidIgnoreTypeError,
    );
    await assert.rejects(
      () => useCase.add({ type: "page", name: "   " }),
      EmptyIgnoreNameError,
    );
  });

  it("删除不存在的规则会报错，删除命中后列表为空", async () => {
    const repo = new MemoryIgnoreRepository();
    const useCase = new IgnoreListUseCase(repo);
    await useCase.add({ type: "page", name: "教程" });

    await useCase.remove({ type: "page", name: "教程" });
    assert.equal((await useCase.list()).length, 0);
    await assert.rejects(
      () => useCase.remove({ type: "page", name: "教程" }),
      IgnoreRuleNotFoundError,
    );
  });
});
