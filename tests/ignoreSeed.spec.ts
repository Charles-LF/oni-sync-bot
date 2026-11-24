import assert from "node:assert/strict";
import {
  DEFAULT_IGNORE_RULES,
  IGNORE_SEED_VERSION,
} from "../src/domain/sync/defaultIgnores";
import { SyncIgnoreRepository } from "../src/infrastructure/persistence/syncIgnoreRepository";

/** 只实现补种用到的能力：等值查询、create、upsert、remove */
class FakeDatabase {
  readonly tables = new Map<string, any[]>();
  private nextId = 1;

  private rows(table: string): any[] {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return this.tables.get(table)!;
  }

  async get(table: string, query: any = {}): Promise<any[]> {
    return this.rows(table)
      .filter((row) =>
        Object.entries(query).every(([key, value]) => row[key] === value),
      )
      .map((row) => ({ ...row }));
  }

  async create(table: string, data: any): Promise<any> {
    const row = { id: this.nextId++, ...data };
    this.rows(table).push(row);
    return { ...row };
  }

  async upsert(table: string, data: any): Promise<unknown> {
    for (const row of Array.isArray(data) ? data : [data]) {
      const rows = this.rows(table);
      const index = rows.findIndex((item) => item.key === row.key);
      if (index >= 0) rows[index] = { ...rows[index], ...row };
      else rows.push({ ...row });
    }
    return { inserted: 1 };
  }

  async remove(table: string, query: any = {}): Promise<{ removed: number }> {
    const rows = this.rows(table);
    const kept = rows.filter((row) =>
      !Object.entries(query).every(([key, value]) => row[key] === value),
    );
    const removed = rows.length - kept.length;
    this.tables.set(table, kept);
    return { removed };
  }
}

function createRepo() {
  const db = new FakeDatabase();
  return { db, repo: new SyncIgnoreRepository({ database: db } as any) };
}

describe("infrastructure/SyncIgnoreRepository.seedDefaults", () => {
  it("首次启动补种全部内置规则并记下版本", async () => {
    const { db, repo } = createRepo();

    const inserted = await repo.seedDefaults();
    assert.equal(inserted, DEFAULT_IGNORE_RULES.length);

    const rules = db.tables.get("sync_ignore") ?? [];
    assert.equal(rules.length, DEFAULT_IGNORE_RULES.length);
    assert.ok(rules.every((rule) => rule.type === "image"));
    assert.ok(rules.some((rule) => rule.name === "Favicon.ico"));

    const config = db.tables.get("sync_config") ?? [];
    assert.equal(config[0].key, "ignore_seed_version");
    assert.equal(config[0].value, IGNORE_SEED_VERSION);
  });

  it("同版本重启不再补种，管理员删掉的规则不会复活", async () => {
    const { db, repo } = createRepo();
    await repo.seedDefaults();
    await repo.delete("image", "Favicon.ico");

    assert.equal(await repo.seedDefaults(), 0);
    const rules = db.tables.get("sync_ignore") ?? [];
    assert.equal(rules.length, DEFAULT_IGNORE_RULES.length - 1);
    assert.ok(!rules.some((rule) => rule.name === "Favicon.ico"));
  });

  it("已存在的同名规则不会重复插入", async () => {
    const { repo } = createRepo();
    await repo.insert({
      type: "image",
      name: "File:Favicon.ico",
      reason: "手工加的",
    });

    const inserted = await repo.seedDefaults();
    assert.equal(inserted, DEFAULT_IGNORE_RULES.length - 1);

    const rules = await repo.list("image");
    const favicons = rules.filter((rule) => rule.name === "File:Favicon.ico");
    assert.equal(favicons.length, 1);
    assert.equal(favicons[0].reason, "手工加的");
    // 归一化后同名，因此内置的 `Favicon.ico` 被跳过，但 `Site-favicon.ico` 仍会补种
    assert.ok(rules.some((rule) => rule.name === "Site-favicon.ico"));
  });

  it("版本升级后只补缺失的那些", async () => {
    const { repo } = createRepo();
    await repo.seedDefaults("2024-01-01");
    await repo.delete("image", "EX1-456658.gif");

    const inserted = await repo.seedDefaults("2024-06-01");
    assert.equal(inserted, 1);

    const names = (await repo.list("image")).map((rule) => rule.name);
    assert.ok(names.includes("EX1-456658.gif"));
    assert.equal(names.length, DEFAULT_IGNORE_RULES.length);
  });

  it("补种出来的规则会直接参与跳过判断", async () => {
    const { repo } = createRepo();
    await repo.seedDefaults();

    const ruleSet = await repo.loadRuleSet();
    assert.ok(ruleSet.match("image", "File:U51-594211.gif"));
    assert.equal(ruleSet.match("page", "U51-594211.gif"), undefined);
  });
});
