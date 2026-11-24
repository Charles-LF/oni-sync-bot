import assert from "node:assert/strict";
import { SyncRepository } from "../src/services/syncRepository";
import {
  RunToken,
  SyncAbortedError,
  SyncTaskManager,
  type SyncRunner,
} from "../src/services/syncTaskManager";
import { runIncrementalSync } from "../src/sync/incrementalSync";

/** 一张表的主键，供假数据库做 upsert 去重 */
const PRIMARY_KEYS: Record<string, string> = {
  sync_logs: "id",
  sync_config: "key",
  sync_images: "title",
};

/** 只实现本模块用到的最小能力：等值 / $in 查询、upsert、remove、cursor 排序分页 */
class FakeDatabase {
  readonly tables = new Map<string, any[]>();

  private rows(table: string): any[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }

  private static matches(row: any, query: any): boolean {
    return Object.entries(query ?? {}).every(([key, expect]) => {
      if (expect && typeof expect === "object" && "$in" in (expect as any)) {
        return (expect as any).$in.includes(row[key]);
      }
      return row[key] === expect;
    });
  }

  async get(table: string, query: any = {}, cursor?: any): Promise<any[]> {
    let rows = this.rows(table).filter((row) => FakeDatabase.matches(row, query));
    if (cursor && !Array.isArray(cursor)) {
      rows = [...rows];
      if (cursor.sort) {
        const [field, direction] = Object.entries(cursor.sort)[0] as [string, string];
        rows.sort((a, b) =>
          direction === "desc"
            ? String(b[field]).localeCompare(String(a[field]))
            : String(a[field]).localeCompare(String(b[field])),
        );
      }
      const offset = cursor.offset ?? 0;
      rows = rows.slice(offset, offset + (cursor.limit ?? rows.length));
      if (cursor.fields) {
        rows = rows.map((row) =>
          Object.fromEntries(cursor.fields.map((f: string) => [f, row[f]])),
        );
      }
    }
    return rows.map((row) => ({ ...row }));
  }

  async upsert(table: string, data: any): Promise<unknown> {
    const key = PRIMARY_KEYS[table];
    for (const row of Array.isArray(data) ? data : [data]) {
      const rows = this.rows(table);
      const index = rows.findIndex((item) => item[key] === row[key]);
      if (index >= 0) rows[index] = { ...rows[index], ...row };
      else rows.push({ ...row });
    }
    return { inserted: 1 };
  }

  async remove(table: string, query: any = {}): Promise<{ removed: number }> {
    const rows = this.rows(table);
    const kept = rows.filter((row) => !FakeDatabase.matches(row, query));
    const removed = rows.length - kept.length;
    this.tables.set(table, kept);
    return { removed };
  }
}

function createRepo() {
  const db = new FakeDatabase();
  const repo = new SyncRepository({ database: db } as any);
  return { db, repo };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("services/syncTaskManager 取消令牌", () => {
  it("暂停时 checkpoint 会等待，继续后放行", async () => {
    const token = new RunToken();
    token.pause();

    let passed = false;
    const pending = (async () => {
      await token.checkpoint();
      passed = true;
    })();

    await sleep(20);
    assert.equal(passed, false, "暂停期间不应通过 checkpoint");

    token.resume();
    await pending;
    assert.equal(passed, true);
  });

  it("停止时 checkpoint 抛 SyncAbortedError（暂停中也能立刻停）", async () => {
    const token = new RunToken();
    token.pause();

    const pending = token.checkpoint();
    token.abort();
    await assert.rejects(pending, SyncAbortedError);
  });
});

describe("services/syncTaskManager 状态机", () => {
  const META = [
    {
      id: "delta" as const,
      label: "增量同步",
      description: "自动运行",
      controllable: false,
    },
    {
      id: "pages" as const,
      label: "全量同步页面",
      description: "手动",
      controllable: true,
    },
    {
      id: "images" as const,
      label: "全量同步图片",
      description: "手动",
      controllable: true,
    },
  ];

  function createManager() {
    const ctx = {
      setTimeout: (cb: () => void, ms: number) => {
        const timer = setTimeout(cb, ms);
        return () => clearTimeout(timer);
      },
    } as any;
    const manager = new SyncTaskManager(ctx, META, () => {});
    return { manager };
  }

  function taskOf(manager: SyncTaskManager, id: "delta" | "pages" | "images") {
    return manager.snapshot().tasks.find((task) => task.id === id)!;
  }

  /** 一直跑到被暂停/停止的 runner（暂停时会停在 checkpoint 上） */
  function longRunner(): SyncRunner {
    return async (token, report) => {
      for (let i = 0; i < 200; i++) {
        await token.checkpoint();
        report({ phase: "跑", current: i + 1, total: 200 });
        await sleep(2);
      }
      return { synced: 0, skipped: 0, failed: 0, message: "完成" };
    };
  }

  it("start → pause → resume → stop 的完整流转", async () => {
    const { manager } = createManager();
    let finished = false;

    const started = await manager.start("pages", "test", async (token, report) => {
      for (let i = 0; i < 200; i++) {
        await token.checkpoint();
        report({ phase: "跑", current: i + 1, total: 200 });
        await sleep(2);
      }
      finished = true;
      return { synced: 1, skipped: 0, failed: 0, message: "完成" };
    });

    assert.equal(started.ok, true);
    assert.equal(taskOf(manager, "pages").state, "running");
    assert.equal(manager.activeId, "pages");

    manager.pause("pages");
    assert.equal(taskOf(manager, "pages").state, "paused");

    manager.resume("pages");
    assert.equal(taskOf(manager, "pages").state, "running");

    manager.stop("pages");
    assert.equal(
      taskOf(manager, "pages").state,
      "stopped",
      "停止请求应立即反映到快照",
    );

    await sleep(60);
    assert.equal(manager.busy, false, "任务应已退出");
    assert.equal(finished, false, "循环不应跑完");
    assert.equal(taskOf(manager, "pages").state, "stopped");
  });

  it("启动另一个任务时，正在跑的任务自动暂停（互相让路）", async () => {
    const { manager } = createManager();
    await manager.start("pages", "test", longRunner());

    const second = await manager.start("images", "console", longRunner(), true);
    assert.equal(second.ok, true);
    assert.match(second.message, /已暂停「全量同步页面」/);
    assert.equal(taskOf(manager, "pages").state, "paused");
    assert.equal(taskOf(manager, "images").state, "running");
    assert.match(taskOf(manager, "pages").progress.message, /自动暂停/);

    manager.stop("images");
    await sleep(60);
    assert.equal(taskOf(manager, "images").state, "stopped");
    // pages 仍停在被自动暂停的状态，需要显式停止才算退出
    assert.equal(taskOf(manager, "pages").state, "paused");
    manager.stop("pages");
    await sleep(60);
    assert.equal(manager.busy, false);
  });

  it("增量同步优先级最高：全量任务让路，增量在跑时全量不能抢占", async () => {
    const { manager } = createManager();
    await manager.start("pages", "console", longRunner(), true);

    // 定时触发（非手动）的增量同步要能抢占
    const delta = await manager.start("delta", "cron", longRunner());
    assert.equal(delta.ok, true);
    assert.equal(taskOf(manager, "pages").state, "paused");
    assert.equal(taskOf(manager, "images").state, "idle");
    assert.match(taskOf(manager, "pages").progress.message, /增量同步/);

    // 增量在跑时，全量任务不能抢占（增量不可暂停）
    const blocked = await manager.start("images", "console", longRunner(), true);
    assert.equal(blocked.ok, false);
    assert.match(blocked.message, /优先级最高/);

    manager.stop("delta");
    await sleep(60);
  });

  it("对已暂停的任务点「开始」等价于继续", async () => {
    const { manager } = createManager();
    await manager.start("pages", "test", longRunner());
    manager.pause("pages");

    const again = await manager.start("pages", "console", longRunner(), true);
    assert.equal(again.ok, true);
    assert.equal(taskOf(manager, "pages").state, "running");

    manager.stop("pages");
    await sleep(60);
  });

  it("不可控任务不能手动启动/暂停/停止", async () => {
    const { manager } = createManager();
    const started = await manager.start("delta", "console", longRunner(), true);
    assert.equal(started.ok, false, "增量同步不允许手动启动");
    assert.match(started.message, /自动调度/);

    assert.equal(manager.pause("delta").ok, false);
    assert.equal(manager.stop("delta").ok, false);
    assert.match(manager.stop("delta").message, /自动调度/);
  });
});

describe("services/syncRepository", () => {
  it("写入更改按 rcid 去重，重复拉取不会写两遍", async () => {
    const { repo } = createRepo();
    const record = {
      id: "100",
      title: "电解器",
      user: "A",
      timestamp: "2024-05-01T00:00:00Z",
      comment: "修改",
      sizeDiff: 12,
      revid: "9",
      parentid: "8",
      ns: 0,
    };

    assert.equal(await repo.saveChanges([record]), 1);
    assert.equal(await repo.saveChanges([record]), 0);
    assert.equal(await repo.saveChanges([{ ...record, id: "101" }]), 1);
  });

  it("列表按时间倒序分页，关键词匹配标题/用户/摘要", async () => {
    const { repo } = createRepo();
    await repo.saveChanges([
      {
        id: "1",
        title: "电解器",
        user: "A",
        timestamp: "2024-05-01T00:00:00Z",
        comment: "首次创建",
        sizeDiff: 100,
      },
      {
        id: "2",
        title: "氧石精炼炉",
        user: "B",
        timestamp: "2024-05-02T00:00:00Z",
        comment: "补充耗电",
        sizeDiff: -5,
      },
      {
        id: "3",
        title: "水泵",
        user: "A",
        timestamp: "2024-05-03T00:00:00Z",
        comment: "改错字",
        sizeDiff: 1,
      },
    ]);

    const page = await repo.listChanges({ limit: 2 });
    assert.deepEqual(page.entries.map((item) => item.id), ["3", "2"]);
    assert.equal(page.total, 3);

    const second = await repo.listChanges({ limit: 2, offset: 2 });
    assert.deepEqual(second.entries.map((item) => item.id), ["1"]);

    assert.equal((await repo.listChanges({ keyword: "水" })).total, 1);
    assert.equal((await repo.listChanges({ keyword: "补充" })).total, 1);
    assert.equal((await repo.listChanges({ keyword: "A" })).total, 2);
  });

  it("超过上限时裁剪最旧的记录", async () => {
    const { repo } = createRepo();
    const records = Array.from({ length: 250 }, (_, i) => ({
      id: String(i),
      title: `页面${i}`,
      user: "A",
      timestamp: new Date(2024, 0, 1, 0, 0, i).toISOString(),
      comment: "",
      sizeDiff: 0,
    }));
    await repo.saveChanges(records);

    const removed = await repo.trimChanges(200);
    assert.equal(removed, 50);
    assert.equal((await repo.listChanges({ limit: 1 })).totalAll, 200);
  });

  it("水位可持久化并读回", async () => {
    const { repo } = createRepo();
    await repo.loadConfig();
    assert.equal(repo.getLastSyncTime(), undefined);

    await repo.setLastSyncTime("2024-05-01T12:00:00.000Z");
    assert.equal(repo.getLastSyncTime(), Date.parse("2024-05-01T12:00:00.000Z"));

    // 重新加载（模拟重启）
    const reloaded = new SyncRepository({ database: (repo as any).ctx.database } as any);
    await reloaded.loadConfig();
    assert.equal(reloaded.getLastSyncTime(), Date.parse("2024-05-01T12:00:00.000Z"));
  });

  it("能查出入库记录里最新一条的时间（水位体检用）", async () => {
    const { repo } = createRepo();
    assert.equal(await repo.getNewestChangeTime(), undefined, "空表返回 undefined");

    await repo.saveChanges([
      {
        id: "1",
        title: "电解器",
        user: "A",
        timestamp: "2024-05-01T09:00:00Z",
        comment: "",
        sizeDiff: 0,
      },
      {
        id: "2",
        title: "水泵",
        user: "B",
        timestamp: "2024-05-02T09:00:00Z",
        comment: "",
        sizeDiff: 0,
      },
    ]);

    assert.equal(
      await repo.getNewestChangeTime(),
      Date.parse("2024-05-02T09:00:00Z"),
    );
  });
});

describe("sync/incrementalSync 增量同步", () => {
  interface Harness {
    calls: Array<{ list: string; params: any }>;
    syncedTitles: string[];
    imagesSynced: string[];
    /** 页面同步时的回调，可用于中途停止 */
    onPage?: (title: string) => void;
  }

  function createEngine(options: {
    changes?: any[];
    images?: any[];
    lastSync?: number;
    onPage?: (title: string) => void;
    /** 水位体检（空隙探测）返回的变更，默认空 = 没有漏更 */
    gapProbe?: any[];
    /** 0 条变更时诊断用：源站最新的一条变更 */
    newestChange?: any;
  } = {}) {
    const harness: Harness = {
      calls: [],
      syncedTitles: [],
      imagesSynced: [],
      onPage: options.onPage,
    };

    const imageInfo = new Map(
      (options.images ?? []).map((item) => [
        item.title,
        { timestamp: item.timestamp, sha1: `sha1-${item.title}` },
      ]),
    );

    const source = {
      continuedQueryGen(params: any) {
        harness.calls.push({ list: params.list, params });
        const payload =
          params.list === "recentchanges"
            ? { recentchanges: options.changes ?? [] }
            : { allimages: options.images ?? [] };
        return (async function* () {
          yield { query: payload };
        })();
      },
      // 模拟 prop=imageinfo 的批量查询 + 水位体检 / 最新变更诊断
      async request(params: any) {
        if (params.list === "recentchanges") {
          const isNewest = params.rcdir === "older";
          harness.calls.push({ list: isNewest ? "newest" : "probe", params });
          const items = isNewest
            ? options.newestChange
              ? [options.newestChange]
              : []
            : options.gapProbe ?? [];
          return { query: { recentchanges: items } };
        }
        const titles = String(params.titles ?? "").split("|").filter(Boolean);
        return {
          query: {
            pages: titles.map((title) => ({
              title,
              imageinfo: imageInfo.has(title) ? [imageInfo.get(title)] : undefined,
            })),
          },
        };
      },
    } as any;

    const pages = {
      async ensurePage() {},
      async updateContributor() {},
      async syncOne(title: string) {
        harness.syncedTitles.push(title);
        harness.onPage?.(title);
        return { success: true, reason: "synced" };
      },
    } as any;

    const images = {
      async syncOne(title: string) {
        harness.imagesSynced.push(title);
        return { success: true, reason: "synced" };
      },
    } as any;

    const { repo } = createRepo();
    if (options.lastSync !== undefined) repo.setLastSyncTime(options.lastSync);

    return { harness, repo, source, pages, images };
  }

  const changes = [
    {
      rcid: 1,
      revid: 11,
      old_revid: 10,
      pageid: 100,
      title: "电解器",
      user: "A",
      timestamp: "2024-05-01T10:00:00Z",
      comment: "改耗电",
      oldlen: 100,
      newlen: 120,
      ns: 0,
    },
    {
      rcid: 2,
      revid: 12,
      pageid: 101,
      title: "水泵",
      user: "B",
      timestamp: "2024-05-01T10:05:00Z",
      comment: "新页面",
      oldlen: 0,
      newlen: 50,
      ns: 0,
    },
    // 同页重复编辑：只应同步一次
    {
      rcid: 3,
      revid: 13,
      pageid: 100,
      title: "电解器",
      user: "C",
      timestamp: "2024-05-01T10:10:00Z",
      comment: "再改",
      oldlen: 120,
      newlen: 130,
      ns: 0,
    },
  ];

  it("按水位拉取（起始时间向前偏移 10 秒）并只同步去重后的页面", async () => {
    const lastSync = Date.parse("2024-05-01T10:00:00Z");
    const engine = createEngine({ changes, lastSync });
    const token = new RunToken();

    const before = Date.now();
    const result = await runIncrementalSync(
      {
        ...(engine as any),
        target: engine.source,
        repo: engine.repo,
      },
      token,
      () => {},
      { checkImages: false },
    );
    const after = Date.now();

    const rc = engine.harness.calls.find((call) => call.list === "recentchanges")!;
    assert.equal(rc.params.rcnamespace, 0, "只看主命名空间");
    assert.equal(rc.params.rctype, "edit|new", "排除删除日志");
    assert.equal(rc.params.rcdir, "newer", "按时间正序处理，截断时才能用游标续跑");

    const rcStart = Date.parse(rc.params.rcstart);
    assert.equal(rcStart, lastSync - 10_000, "起始时间必须比水位早 10 秒");
    const rcEnd = Date.parse(rc.params.rcend);
    assert.ok(rcEnd >= before && rcEnd <= after + 1000, "结束时间约为当前时刻");

    assert.deepEqual(engine.harness.syncedTitles, ["电解器", "水泵"]);
    assert.equal(result.changes, 3);
    assert.equal(result.pages, 2);

    // 三条更改都应入库（含同页的第二次编辑）
    const logs = await engine.repo.listChanges({ limit: 10 });
    assert.equal(logs.total, 3);
    assert.deepEqual(
      logs.entries.map((item) => item.id).sort(),
      ["1", "2", "3"],
    );
    // 变更字节数
    assert.equal(logs.entries.find((item) => item.id === "1")!.sizeDiff, 20);

    // 完成后推进水位到现在
    const watermark = engine.repo.getLastSyncTime()!;
    assert.ok(watermark >= before && watermark <= after + 1000);
  });

  it("首次运行（无水位）回溯默认 24 小时", async () => {
    const engine = createEngine({ changes: [] });
    await runIncrementalSync(
      { ...(engine as any), target: engine.source, repo: engine.repo },
      new RunToken(),
      () => {},
      { checkImages: false },
    );

    const rc = engine.harness.calls.find((call) => call.list === "recentchanges")!;
    const span =
      Date.parse(rc.params.rcend) - Date.parse(rc.params.rcstart);
    assert.ok(Math.abs(span - 24 * 3600_000) < 5000, `回溯区间应约等于 24 小时，实际 ${span}ms`);
  });

  it("水位超前于入库记录且空隙里有变更时，窗口回退到记录处补齐", async () => {
    const lastSync = Date.parse("2024-05-01T10:05:00Z");
    // 入库记录停在 09:00，水位却已经推到 10:05：中间那段从没被拉过
    const engine = createEngine({
      changes,
      lastSync,
      gapProbe: [{ title: "水泵", timestamp: "2024-05-01T09:30:00Z" }],
    });
    await engine.repo.saveChanges([
      {
        id: "9",
        title: "电解器",
        user: "A",
        timestamp: "2024-05-01T09:00:00Z",
        comment: "",
        sizeDiff: 1,
      },
    ]);

    await runIncrementalSync(
      { ...(engine as any), target: engine.source, repo: engine.repo },
      new RunToken(),
      () => {},
      { checkImages: false },
    );

    const rc = engine.harness.calls.find((call) => call.list === "recentchanges")!;
    assert.equal(
      Date.parse(rc.params.rcstart),
      Date.parse("2024-05-01T09:00:00Z") - 10_000,
      "窗口必须回退到已入库的最新记录（再向前偏移 10 秒）",
    );
    assert.deepEqual(engine.harness.syncedTitles, ["电解器", "水泵"]);

    // 探测下界要比记录新 1 秒，否则已入库的那条会一直触发假阳性
    const probe = engine.harness.calls.find((call) => call.list === "probe")!;
    assert.equal(
      Date.parse(probe.params.rcstart),
      Date.parse("2024-05-01T09:00:00Z") + 1000,
    );
    assert.equal(Date.parse(probe.params.rcend), lastSync);
  });

  it("空隙里确实没有变更时不回退窗口", async () => {
    const lastSync = Date.parse("2024-05-01T10:05:00Z");
    const engine = createEngine({ changes: [], lastSync, gapProbe: [] });
    await engine.repo.saveChanges([
      {
        id: "9",
        title: "电解器",
        user: "A",
        timestamp: "2024-05-01T09:00:00Z",
        comment: "",
        sizeDiff: 1,
      },
    ]);

    await runIncrementalSync(
      { ...(engine as any), target: engine.source, repo: engine.repo },
      new RunToken(),
      () => {},
      { checkImages: false },
    );

    const rc = engine.harness.calls.find((call) => call.list === "recentchanges")!;
    assert.equal(Date.parse(rc.params.rcstart), lastSync - 10_000);
  });

  it("没有入库记录可参照时不做窗口回退", async () => {
    const engine = createEngine({
      changes: [],
      lastSync: Date.parse("2024-05-01T10:05:00Z"),
      gapProbe: [{ title: "x", timestamp: "2024-05-01T09:30:00Z" }],
    });

    await runIncrementalSync(
      { ...(engine as any), target: engine.source, repo: engine.repo },
      new RunToken(),
      () => {},
      { checkImages: false },
    );

    const rc = engine.harness.calls.find((call) => call.list === "recentchanges")!;
    assert.equal(
      Date.parse(rc.params.rcstart),
      Date.parse("2024-05-01T10:05:00Z") - 10_000,
      "没有记录可参照时不做回退",
    );
  });

  it("页面数被 maxPagesPerRun 截断时，水位停在游标处而不是 now", async () => {
    const lastSync = Date.parse("2024-05-01T10:00:00Z");
    const engine = createEngine({ changes, lastSync });

    const result = await runIncrementalSync(
      { ...(engine as any), target: engine.source, repo: engine.repo },
      new RunToken(),
      () => {},
      { checkImages: false, maxPagesPerRun: 1 },
    );

    assert.deepEqual(engine.harness.syncedTitles, ["电解器"], "只处理第一个页面");
    assert.equal(result.pages, 1);

    // 游标 = 最后一个被处理页面的最早一次编辑（电解器 10:00），而不是 now
    assert.equal(
      engine.repo.getLastSyncTime(),
      Date.parse("2024-05-01T10:00:00Z"),
      "水位必须停在游标处，剩余页面下一轮继续",
    );
    assert.ok(result.message.includes("剩余 1 个页面"), result.message);
  });

  it("中途停止不推进水位", async () => {
    const lastSync = Date.parse("2024-05-01T10:00:00Z");
    const token = new RunToken();
    const engine = createEngine({
      changes,
      lastSync,
      onPage: () => token.abort(),
    });

    await assert.rejects(
      runIncrementalSync(
        { ...(engine as any), target: engine.source, repo: engine.repo },
        token,
        () => {},
        { checkImages: false },
      ),
      SyncAbortedError,
    );

    assert.equal(
      engine.repo.getLastSyncTime(),
      lastSync,
      "停止后水位必须保持原值，下次仍会覆盖这段区间",
    );
  });

  it("图片：新图片与时间戳变化都要处理，没变化则跳过", async () => {
    const engine = createEngine({
      changes: [],
      images: [
        { title: "File:A.png", timestamp: "2024-05-01T00:00:00Z" },
        { title: "File:B.png", timestamp: "2024-05-02T00:00:00Z" },
        { title: "File:C.png", timestamp: "2024-05-03T00:00:00Z" },
      ],
    });

    // A 已同步过且未变化；B 时间戳变了；C 是全新图片
    await engine.repo.upsertImages([
      {
        title: "File:A.png",
        timestamp: "2024-05-01T00:00:00Z",
        sha1: "aa",
        synced_at: Date.now(),
      },
      {
        title: "File:B.png",
        timestamp: "2024-05-01T00:00:00Z",
        sha1: "bb",
        synced_at: Date.now(),
      },
    ]);

    const result = await runIncrementalSync(
      { ...(engine as any), target: engine.source, repo: engine.repo },
      new RunToken(),
      () => {},
    );

    // syncOne 收到的是去掉 File: 前缀的文件名
    assert.deepEqual(engine.harness.imagesSynced.sort(), ["B.png", "C.png"]);
    assert.equal(result.imagesSynced, 2);

    const index = await engine.repo.loadImageIndex();
    assert.equal(index.get("File:C.png")?.timestamp, "2024-05-03T00:00:00Z");
    assert.ok((index.get("File:B.png")?.synced_at ?? 0) > 0);
  });

  it("只同步了图片时也要推出群通知（type=image）", async () => {
    const engine = createEngine({
      changes: [],
      images: [{ title: "File:C.png", timestamp: "2024-05-03T00:00:00Z" }],
    });

    const notified: any[] = [];
    const result = await runIncrementalSync(
      {
        ...(engine as any),
        target: engine.source,
        repo: engine.repo,
        notify: (items) => notified.push(...items),
      },
      new RunToken(),
      () => {},
    );

    assert.equal(result.pages, 0, "本轮没有页面变更");
    assert.equal(result.imagesSynced, 1);
    assert.deepEqual(notified, [
      { title: "C.png", type: "image", timestamp: "2024-05-03T00:00:00Z" },
    ]);
  });

  it("0 条变更时会记录源站最新变更，便于区分「确实没更新」与「被过滤」", async () => {
    const engine = createEngine({
      changes: [],
      newestChange: { title: "玻璃", timestamp: "2024-05-01T09:30:00Z" },
    });

    const result = await runIncrementalSync(
      { ...(engine as any), target: engine.source, repo: engine.repo },
      new RunToken(),
      () => {},
      { checkImages: false },
    );

    assert.equal(result.changes, 0);
    assert.equal(result.pages, 0);
  });
});
