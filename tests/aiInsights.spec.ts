import assert from "node:assert/strict";
import {
  AiChatLogUseCase,
  type AiChatLogDraft,
} from "../src/application/ai/aiChatLogUseCase";
import {
  buildAiStats,
  normalizeQuestion,
  summarizeAnswer,
  type AiStatsRow,
} from "../src/domain/ai/chatLog";
import { AiChatLogRepository } from "../src/infrastructure/persistence/aiChatLogRepository";

/** 只实现仓储用到的最小能力：等值 / $in 查询、投影、排序分页、create / remove */
class FakeDatabase {
  readonly tables = new Map<string, any[]>();
  private nextId = 1;

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

  private static pick(row: any, fields: string[]): any {
    return Object.fromEntries(fields.map((field) => [field, row[field]]));
  }

  async get(table: string, query: any = {}, cursor?: any): Promise<any[]> {
    let rows = this.rows(table).filter((row) => FakeDatabase.matches(row, query));
    if (Array.isArray(cursor)) {
      return rows.map((row) => FakeDatabase.pick(row, cursor));
    }
    if (cursor) {
      rows = [...rows];
      if (cursor.sort) {
        const [field, direction] = Object.entries(cursor.sort)[0] as [
          string,
          string,
        ];
        const factor = direction === "desc" ? -1 : 1;
        rows.sort((a, b) => (Number(a[field]) - Number(b[field])) * factor);
      }
      const offset = cursor.offset ?? 0;
      rows = rows.slice(offset, offset + (cursor.limit ?? rows.length));
      if (cursor.fields) {
        rows = rows.map((row) => FakeDatabase.pick(row, cursor.fields));
      }
    }
    return rows.map((row) => ({ ...row }));
  }

  async create(table: string, data: any): Promise<any> {
    const row = { id: this.nextId++, ...data };
    this.rows(table).push(row);
    return { ...row };
  }

  async remove(table: string, query: any = {}): Promise<{ removed: number }> {
    const rows = this.rows(table);
    const kept = rows.filter((row) => !FakeDatabase.matches(row, query));
    const removed = rows.length - kept.length;
    this.tables.set(table, kept);
    return { removed };
  }
}

function createRepo(maxRows = 10000) {
  const db = new FakeDatabase();
  const repo = new AiChatLogRepository({ database: db } as any, { maxRows });
  return { db, repo };
}

let seq = 0;

function draft(question: string, userName = "群友"): Required<AiChatLogDraft> {
  seq += 1;
  return {
    userId: `u${seq}`,
    userName,
    question,
    answer: "电解器用于把水分解成氧气和氢气。",
    toolCalls: [{ name: "search_oni_bwiki", keyword: "电解器" }],
    createdAt: Date.now() + seq,
  };
}

describe("domain/buildAiStats", () => {
  const now = Date.parse("2024-05-10T12:00:00+08:00");

  function row(
    userId: string,
    question: string,
    createdAt: number,
    keywords: string[] = [],
  ): AiStatsRow {
    return {
      userId,
      question,
      createdAt,
      toolCalls: keywords.map((keyword) => ({ name: "search_oni_bwiki", keyword })),
    };
  }

  it("聚合总人数 / 总提问 / 工具调用 / Top 问题 / Top 关键词", () => {
    const stats = buildAiStats(
      [
        row("1", "电解器怎么用？", now, ["电解器"]),
        row("1", "电解器怎么用", now, ["电解器", "复制人"]),
        row("2", "高压制氧", now - 86_400_000, []),
      ],
      now,
    );

    assert.equal(stats.totalUsers, 2);
    assert.equal(stats.totalQuestions, 3);
    assert.equal(stats.toolCallCount, 3);

    assert.equal(stats.topQuestions.length, 2);
    assert.equal(stats.topQuestions[0].question, "电解器怎么用？");
    assert.equal(stats.topQuestions[0].count, 2);

    assert.equal(stats.topKeywords[0].keyword, "电解器");
    assert.equal(stats.topKeywords[0].count, 2);
    assert.equal(stats.topKeywords[1].keyword, "复制人");
  });

  it("按北京时间切日，7 天之外的数据不计入趋势", () => {
    const stats = buildAiStats(
      [
        row("1", "今天", Date.parse("2024-05-10T00:00:00+08:00")),
        row("1", "最早那天", Date.parse("2024-05-04T00:00:00+08:00")),
        row("1", "超出窗口", Date.parse("2024-05-03T23:59:59+08:00")),
      ],
      now,
    );

    assert.equal(stats.dailyTrend.length, 7);
    assert.deepEqual(
      stats.dailyTrend.map((item) => item.date),
      [
        "2024-05-04",
        "2024-05-05",
        "2024-05-06",
        "2024-05-07",
        "2024-05-08",
        "2024-05-09",
        "2024-05-10",
      ],
    );
    assert.equal(stats.dailyTrend[0].count, 1);
    assert.equal(stats.dailyTrend[6].count, 1);
    assert.equal(
      stats.dailyTrend.reduce((sum, item) => sum + item.count, 0),
      2,
    );
  });

  it("空数据也能给出完整的 7 天空曲线", () => {
    const stats = buildAiStats([], now);
    assert.equal(stats.totalQuestions, 0);
    assert.equal(stats.dailyTrend.length, 7);
    assert.equal(stats.topQuestions.length, 0);
  });

  it("问题归一化忽略空白 / 标点 / 大小写", () => {
    assert.equal(normalizeQuestion("  电解 器 怎么用？ "), "电解器怎么用");
    assert.equal(normalizeQuestion("ABC 是什么"), "abc是什么");
  });

  it("回答摘要压缩空白并截断", () => {
    assert.equal(summarizeAnswer("  氧气   和\n氢气 "), "氧气 和 氢气");
    assert.equal(summarizeAnswer("字".repeat(200)).length, 121);
    assert.ok(summarizeAnswer("字".repeat(200)).endsWith("…"));
  });
});

describe("infrastructure/AiChatLogRepository", () => {
  it("超过上限时删除最早的记录", async () => {
    // 仓储对上限有保底（至少 100），所以这里按保底值撑满再溢出 5 条
    const { db, repo } = createRepo(100);
    for (let index = 1; index <= 105; index++) {
      await repo.append(draft(`问题 ${index}`));
    }

    const rows = db.tables.get("ai_chat_logs") ?? [];
    assert.equal(rows.length, 100);
    assert.equal(rows[0].question, "问题 6");
    assert.equal(rows[99].question, "问题 105");
    assert.equal(await repo.count(), 100);
  });

  it("列表按 id 倒序分页，关键字命中时只回表取当前页", async () => {
    const { repo } = createRepo();
    await repo.append(draft("电解器怎么用", "小明"));
    await repo.append(draft("高压制氧", "小红"));

    const page = await repo.list({ limit: 1 });
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0].question, "高压制氧");
    assert.equal(page.total, 2);
    assert.equal(page.totalAll, 2);

    const searched = await repo.list({ keyword: "小明" });
    assert.equal(searched.total, 1);
    assert.equal(searched.entries[0].question, "电解器怎么用");
    assert.equal(searched.entries[0].userName, "小明");
  });

  it("详情返回完整回答，统计投影不带 answer", async () => {
    const { repo } = createRepo();
    const id = await repo.append(draft("电解器"));

    const detail = await repo.get(id);
    assert.equal(detail?.answer, "电解器用于把水分解成氧气和氢气。");

    const rows = await repo.listForStats();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].question, "电解器");
    assert.equal(rows[0].toolCalls.length, 1);
    assert.ok(!("answer" in rows[0]));
  });
});

describe("application/AiChatLogUseCase", () => {
  it("记录问答并把摘要交给回调广播，空白提问直接丢弃", async () => {
    const { repo } = createRepo();
    const seen: any[] = [];
    const useCase = new AiChatLogUseCase(repo, (entry) => seen.push(entry));

    const summary = await useCase.record({
      userId: "1",
      userName: "小明",
      question: "  电解器怎么用  ",
      answer: "字".repeat(200),
      toolCalls: [{ name: "search_oni_bwiki", keyword: "电解器" }],
    });

    assert.equal(summary?.question, "电解器怎么用");
    assert.equal(summary?.answerSummary.length, 121);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].question, "电解器怎么用");

    const skipped = await useCase.record({
      userId: "1",
      userName: "小明",
      question: "   ",
      answer: "",
      toolCalls: [],
    });
    assert.equal(skipped, undefined);
    assert.equal(seen.length, 1);
  });

  it("统计走用例聚合，拿到的是看板形状", async () => {
    const { repo } = createRepo();
    const useCase = new AiChatLogUseCase(repo);
    await useCase.record({
      userId: "1",
      userName: "小明",
      question: "电解器怎么用",
      answer: "电解器用于把水分解成氧气和氢气。",
      toolCalls: [{ name: "search_oni_bwiki", keyword: "电解器" }],
    });

    const stats = await useCase.stats();
    assert.equal(stats.totalQuestions, 1);
    assert.equal(stats.totalUsers, 1);
    assert.equal(stats.toolCallCount, 1);
    assert.equal(stats.topKeywords[0].keyword, "电解器");
    assert.equal(stats.dailyTrend.length, 7);
  });
});
