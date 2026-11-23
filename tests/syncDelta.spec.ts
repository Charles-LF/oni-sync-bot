import assert from "node:assert/strict";
import { SyncRepository } from "../src/services/syncRepository";
import {
  RunToken,
  SyncAbortedError,
  SyncTaskManager,
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
  function createManager() {
    const ctx = {
      setTimeout: (cb: () => void, ms: number) => {
        const timer = setTimeout(cb, ms);
        return () => clearTimeout(timer);
      },
    } as any;
    const snapshots: string[] = [];
    const manager = new SyncTaskManager(ctx, (snapshot) => {
      snapshots.push(snapshot.state);
    });
    return { manager, snapshots };
  }

  it("start → pause → resume → stop 的完整流转", async () => {
    const { manager } = createManager();
    let finished = false;

    const started = await manager.start("test", async (token, report) => {
      for (let i = 0; i < 200; i++) {
        await token.checkpoint();
        report({ phase: "跑", current: i + 1, total: 200 });
        await sleep(2);
      }
      finished = true;
      return { synced: 1, skipped: 0, failed: 0, message: "完成" };
    });

    assert.equal(started.ok, true);
    assert.equal(manager.snapshot().state, "running");

    manager.pause();
    assert.equal(manager.snapshot().state, "paused");

    manager.resume();
    assert.equal(manager.snapshot().state, "running");

    manager.stop();
    assert.equal(manager.snapshot().state, "stopped", "停止请求应立即反映到快照");

    await sleep(60);
    assert.equal(manager.busy, false, "任务应已退出");
    assert.equal(finished, false, "循环不应跑完");
    assert.equal(manager.snapshot().state, "stopped");
  });

  it("同一时刻只允许一个任务", async () => {
    const { manager } = createManager();
    await manager.start("test", async (token) => {
      await sleep(40);
      return { synced: 0, skipped: 0, failed: 0, message: "完成" };
    });
    const second = await manager.start("test", async () => ({
      synced: 0,
      skipped: 0,
      failed: 0,
      message: "完成",
    }));
    assert.equal(second.ok, false);
    manager.stop();
    await sleep(50);
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
      // 模拟 prop=imageinfo 的批量查询
      async request(params: any) {
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

  it("首次运行（无水位）回溯默认 3 小时", async () => {
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
    assert.ok(Math.abs(span - 3 * 3600_000) < 5000, `回溯区间应约等于 3 小时，实际 ${span}ms`);
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
});
