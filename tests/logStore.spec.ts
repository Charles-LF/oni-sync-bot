import assert from "node:assert/strict";
import {
  LogStore,
  MAX_LOG_RECORDS,
  resolveScope,
  type OniLogSummary,
} from "../src/services/logStore";

/** LogStore 只用到 ctx.setTimeout / ctx.database，测查询逻辑时给个假的即可 */
function createStore() {
  const timers: Array<() => void> = [];
  const ctx = {
    setTimeout: (cb: () => void) => {
      timers.push(cb);
      return () => {};
    },
    database: {
      get: async () => [],
      upsert: async () => ({}),
      remove: async () => ({}),
    },
  } as any;
  const changes: OniLogSummary[] = [];
  return { store: new LogStore(ctx, (s) => changes.push(s)), changes };
}

function push(store: LogStore, type: string, name: string, content: string) {
  store.append({ type, name, content });
}

describe("services/logStore 日志归类", () => {
  it("按日志前缀拆出业务模块", () => {
    const cases: Array<[string, string]> = [
      ["[增量更新流程] ⏰ 开始处理", "增量更新"],
      ["[SyncAllPages] 📄 已获取 500 个页面", "全量页面同步"],
      ["[syncSinglePage] ✅ 页面 电解器 同步成功", "页面同步"],
      ["[数据库初始化] ✅ 页面已添加到数据库", "页面同步"],
      ["[SyncAllImgs] 图片同步完成", "图片同步"],
      ["[moduleSync] 同步模块", "模块同步"],
      ["[ai] Agent 决定检索: 电解器", "AI 问答"],
      ["[wikiBot] 命中正文缓存", "Wiki 客户端"],
      ["定时任务「每小时增量同步」执行失败", "定时任务"],
      ["✅ WIKIGIG 登录成功", "登录"],
      ["❌ bwiki 登录失败 Failed: xxx", "登录"],
      ["贡献者同步完成", "贡献者同步"],
      ["✅ 定时同步任务已注册（每小时增量 / 每周三图片 / 每周四页面 / 每周日贡献者）", "定时任务"],
      ["页面缓存已更新", "页面缓存更新"],
      ["日志读取失败：cannot resolve table \"onilogs\"", "日志系统"],
      ["说不清来源的一句话", "其他"],
    ];
    for (const [message, expected] of cases) {
      assert.equal(resolveScope("oni-sync", message), expected, message);
    }
  });

  it("前缀判断不出来的按 logger 名兜底", () => {
    assert.equal(resolveScope("oni-ai", "无前缀的日志"), "AI 问答");
    assert.equal(resolveScope("oni-todolist", "无前缀的日志"), "TodoList");
    assert.equal(resolveScope("oni-sync", "无前缀的日志"), "其他");
  });
});

describe("services/logStore 查询", () => {
  it("只收 info / warn / error", () => {
    const { store } = createStore();
    push(store, "debug", "oni-sync", "调试信息");
    push(store, "info", "oni-sync", "普通信息");
    push(store, "success", "oni-sync", "未知级别");
    assert.equal(store.query({}).total, 1);
  });

  it("按级别筛选", () => {
    const { store } = createStore();
    push(store, "info", "oni-sync", "[syncSinglePage] 页面 A 同步成功");
    push(store, "warn", "oni-sync", "[syncSinglePage] 页面 B 跳过");
    push(store, "error", "oni-sync", "[syncSinglePage] 页面 C 同步失败");

    assert.equal(store.query({}).total, 3);
    assert.equal(store.query({ levels: ["info"] }).total, 1);
    assert.equal(store.query({ levels: ["warn", "error"] }).total, 2);
  });

  it("按模块筛选", () => {
    const { store } = createStore();
    push(store, "info", "oni-sync", "[增量更新流程] 开始");
    push(store, "info", "oni-sync", "[SyncAllPages] 开始");
    push(store, "info", "oni-ai", "[ai] 回答");

    assert.equal(store.query({ scopes: ["增量更新"] }).total, 1);
    assert.equal(store.query({ scopes: ["增量更新", "全量页面同步"] }).total, 2);
    assert.deepEqual(
      store.query({}).scopes.map((item) => item.name).sort(),
      ["AI 问答", "全量页面同步", "增量更新"].sort(),
    );
  });

  it("关键词匹配内容与模块名，忽略大小写", () => {
    const { store } = createStore();
    push(store, "info", "oni-sync", "[syncSinglePage] 页面 Electrolyzer 同步成功");
    push(store, "error", "oni-sync", "[syncSinglePage] 页面 电解器 同步失败");

    assert.equal(store.query({ keyword: "electrolyzer" }).total, 1);
    assert.equal(store.query({ keyword: "电解器" }).total, 1);
    assert.equal(store.query({ keyword: "页面同步" }).total, 2);
    assert.equal(store.query({ keyword: "不存在" }).total, 0);
  });

  it("按时间范围筛选", async () => {
    const { store } = createStore();
    push(store, "info", "oni-sync", "第一条");
    const first = store.query({}).entries[0].time;
    // 让第二条落在更晚的毫秒，避免同毫秒导致范围判断失去意义
    await new Promise((resolve) => setTimeout(resolve, 5));
    push(store, "info", "oni-sync", "第二条");

    assert.equal(store.query({ from: first }).total, 2);
    assert.equal(store.query({ from: first + 1 }).total, 1);
    assert.equal(store.query({ to: first }).total, 1);
  });

  it("分页：从最新往旧取，offset 递增拿到更早的", () => {
    const { store } = createStore();
    for (let i = 1; i <= 5; i++) push(store, "info", "oni-sync", `第 ${i} 条`);

    const page1 = store.query({ limit: 2 });
    assert.deepEqual(page1.entries.map((e) => e.message), ["第 4 条", "第 5 条"]);
    assert.equal(page1.total, 5);

    const page2 = store.query({ limit: 2, offset: 2 });
    assert.deepEqual(page2.entries.map((e) => e.message), ["第 2 条", "第 3 条"]);
  });

  it("分面统计：选中某个维度后，另一维度的数字跟着变", () => {
    const { store } = createStore();
    push(store, "info", "oni-sync", "[增量更新流程] A");
    push(store, "error", "oni-sync", "[SyncAllPages] B");
    push(store, "warn", "oni-sync", "[增量更新流程] C");

    const filtered = store.query({ levels: ["error"] });
    assert.equal(filtered.total, 1);
    assert.equal(filtered.totalAll, 3);
    // 只看 error 时，模块下拉里只剩全量页面同步
    assert.deepEqual(
      filtered.scopes.map((item) => item.name),
      ["全量页面同步"],
    );
    // 级别数字不受自身筛选影响，仍能切回其它级别
    assert.deepEqual(filtered.levels, { info: 1, warn: 1, error: 1 });

    const byScope = store.query({ scopes: ["增量更新"] });
    assert.equal(byScope.total, 2);
    assert.deepEqual(byScope.levels, { info: 1, warn: 1, error: 0 });
    // 模块下拉不因自身筛选而缩水，否则切换模块就找不到别的选项了
    assert.equal(byScope.scopes.length, 2);
  });

  it(`超过 ${MAX_LOG_RECORDS} 条时只保留最新的`, () => {
    const { store } = createStore();
    for (let i = 0; i < MAX_LOG_RECORDS + 20; i++) {
      push(store, "info", "oni-sync", `第 ${i} 条`);
    }
    const all = store.query({ limit: MAX_LOG_RECORDS });
    assert.equal(all.totalAll, MAX_LOG_RECORDS);
    assert.equal(all.entries[all.entries.length - 1].message, `第 ${MAX_LOG_RECORDS + 19} 条`);
  });

  it("清空后查询为空", async () => {
    const { store } = createStore();
    push(store, "info", "oni-sync", "一条日志");
    assert.equal(store.query({}).total, 1);
    await store.clear();
    assert.equal(store.query({}).total, 0);
  });
});
