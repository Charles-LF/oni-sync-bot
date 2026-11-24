import assert from "node:assert/strict";
import { SyncRunRepository } from "../src/infrastructure/persistence/syncRunRepository";
import { SyncRunRecorder } from "../src/infrastructure/console/syncRunRecorder";
import type { SyncItemEvent } from "../src/domain/sync/ports";

/** 主键，供假数据库做 upsert 去重 */
const PRIMARY_KEYS: Record<string, string> = {
  sync_runs: "id",
  sync_run_items: "id",
  sync_run_logs: "id",
};

/** 只实现运行记录用到的最小能力：等值 / $in 查询、upsert / create / set / remove */
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
          Object.fromEntries(cursor.fields.map((field: string) => [field, row[field]])),
        );
      }
    }
    return rows.map((row) => ({ ...row }));
  }

  async create(table: string, data: any): Promise<any> {
    this.rows(table).push({ ...data });
    return { ...data };
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

  async set(table: string, query: any, patch: any): Promise<{ matched: number }> {
    let matched = 0;
    for (const row of this.rows(table)) {
      if (!FakeDatabase.matches(row, query)) continue;
      Object.assign(row, patch);
      matched++;
    }
    return { matched };
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
  const repo = new SyncRunRepository({ database: db } as any);
  return { db, repo };
}

const ctx = {} as any;

function item(title: string, action: SyncItemEvent["action"]): SyncItemEvent {
  return { title, action, reason: action, message: `${title} ${action}`, at: Date.now() };
}

describe("infrastructure/SyncRunRepository", () => {
  it("初始化运行记录，结束后写入最终状态", async () => {
    const { db, repo } = createRepo();
    const runId = await repo.begin("pages", "console");

    const running = await repo.getRun(runId);
    assert.equal(running?.state, "running");
    assert.equal(running?.finishedAt, 0);

    await repo.finish(runId, {
      state: "completed",
      message: "页面 10 个",
      synced: 8,
      skipped: 1,
      failed: 1,
    });

    const done = await repo.getRun(runId);
    assert.equal(done?.state, "completed");
    assert.equal(done?.synced, 8);
    assert.ok((done?.finishedAt ?? 0) > 0);

    const todos = db.tables.get("sync_runs") ?? [];
    assert.equal(todos.length, 1);
  });

  it("日志超出保留条数时删除最早的（id 字典序即写入顺序）", async () => {
    const { db, repo } = createRepo();
    const runId = await repo.begin("pages", "console");

    await repo.appendLogs(
      runId,
      [1, 2, 3, 4, 5].map((seq) => ({
        seq,
        level: "info",
        message: `line-${seq}`,
        at: seq,
      })),
    );
    await repo.trimLogs(runId, 3);

    const logs = await repo.listLogs(runId);
    assert.deepEqual(
      logs.map((log) => log.message),
      ["line-3", "line-4", "line-5"],
    );
    assert.equal((db.tables.get("sync_run_logs") ?? []).length, 3);
  });

  it("只保留最近 N 次运行，连同条目与日志一起清理", async () => {
    const { repo } = createRepo();
    const oldId = await repo.begin("pages", "cron");
    await repo.appendItems(oldId, [
      { seq: 1, title: "旧页面", action: "synced", reason: "同步成功", at: 1 },
    ]);
    await repo.appendLogs(oldId, [
      { seq: 1, level: "info", message: "旧日志", at: 1 },
    ]);
    await repo.finish(oldId, { state: "completed", message: "旧运行" });

    // 让 startedAt 必然不同，排序才稳定
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newId = await repo.begin("pages", "console");

    await repo.trimRuns(1);

    assert.equal(await repo.getRun(oldId), undefined);
    assert.deepEqual(await repo.listItems(oldId), []);
    assert.deepEqual(await repo.listLogs(oldId), []);
    assert.equal((await repo.getRun(newId))?.state, "running");
  });

  it("进程重启后把遗留的 running 记录标记为 stopped", async () => {
    const { repo } = createRepo();
    const runId = await repo.begin("pages", "cron");
    await repo.closeDanglingRuns();

    const run = await repo.getRun(runId);
    assert.equal(run?.state, "stopped");
    assert.ok(run?.message.includes("中断"));
  });
});

describe("infrastructure/SyncRunRecorder", () => {
  it("缓冲写入 + 实时广播 + 收尾裁剪", async () => {
    const { repo } = createRepo();
    const events: Array<{ seq: number; message: string }> = [];
    const runId = await repo.begin("pages", "console");

    const recorder = new SyncRunRecorder(ctx, repo, runId, "pages", {
      logLimit: 3,
      runKeep: 5,
      broadcast: (event) => events.push({ seq: event.seq, message: event.message }),
    });

    for (let index = 1; index <= 5; index++) {
      recorder.log("info", `line-${index}`);
    }
    recorder.item(item("电解器", "synced"));
    recorder.item(item("教程", "skipped"));

    // 收尾前还没落库（没有 ctx.setTimeout，节流定时器不会触发）
    assert.deepEqual(await repo.listLogs(runId), []);
    assert.deepEqual(
      events.map((event) => event.message),
      ["line-1", "line-2", "line-3", "line-4", "line-5"],
      "每条日志都应立刻推送，前端不用等落库",
    );

    await recorder.finish({
      state: "completed",
      message: "done",
      synced: 1,
      skipped: 1,
      failed: 0,
    });

    const logs = await repo.listLogs(runId);
    assert.deepEqual(
      logs.map((log) => log.message),
      ["line-3", "line-4", "line-5"],
      "超出 logLimit 的最早日志应被裁掉",
    );

    const items = await repo.listItems(runId);
    assert.deepEqual(
      items.map((row) => row.action),
      ["synced", "skipped"],
    );
    assert.equal((await repo.getRun(runId))?.state, "completed");
  });
});
