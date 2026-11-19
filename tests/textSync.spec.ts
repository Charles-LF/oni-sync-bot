import assert from "node:assert/strict";
import {
  RenderedTextSyncer,
  buildPageUrl,
  type TextDatabase,
  type TextHttp,
} from "../src/sync/textSync";
import type { VectorPage } from "../src/services/vectorService";

const SAMPLE_HTML = `
<div class="mw-parser-output">
  <p>电解器把水分解成氧气与氢气。</p>
  <table class="navbox"><tr><td>导航噪音</td></tr></table>
  <table class="wikitable"><tr><td>耗电</td><td>120 瓦</td></tr></table>
</div>`;

/** 内存版数据库，只实现本模块用到的两个方法 */
function createDatabase() {
  const rows = new Map<string, Record<string, any>>();
  const database: TextDatabase & { rows: typeof rows } = {
    rows,
    async get(table, query) {
      const id = (query as { id?: string }).id;
      if (id === undefined) return [...rows.values()] as any[];
      return rows.has(id) ? ([{ ...rows.get(id) }] as any[]) : ([] as any[]);
    },
    async upsert(table, data) {
      for (const item of Array.isArray(data) ? data : [data]) {
        rows.set((item as { id: string }).id, { ...item });
      }
    },
  };
  return database;
}

function createHttp(html: string): TextHttp {
  return {
    async get() {
      return {
        parse: { title: "电解器", pageid: 11, revid: 22, text: html },
      } as any;
    },
  };
}

function createVector() {
  const indexed: VectorPage[] = [];
  return {
    indexed,
    async indexPage(page: VectorPage) {
      indexed.push(page);
      return 1;
    },
    async removePage() {
      /* noop */
    },
  };
}

describe("sync/textSync", () => {
  it("抓取渲染文本、剔除噪音并写入数据库与向量库", async () => {
    const database = createDatabase();
    const vector = createVector();
    const syncer = new RenderedTextSyncer({
      http: createHttp(SAMPLE_HTML),
      database,
      vector,
      options: { pageUrlBase: "https://wiki.biligame.com/oni/" },
    });

    const result = await syncer.syncOne("电解器");

    assert.deepEqual(result, { success: true, reason: "synced" });
    const stored = database.rows.get("电解器");
    assert.ok(stored, "正文未入库");
    assert.ok(stored!.text.includes("耗电 | 120 瓦"), stored!.text);
    assert.ok(!stored!.text.includes("导航噪音"), "导航框未被剔除");
    assert.equal(stored!.revid, 22);

    assert.equal(vector.indexed.length, 1);
    assert.equal(
      vector.indexed[0].url,
      "https://wiki.biligame.com/oni/%E7%94%B5%E8%A7%A3%E5%99%A8",
    );
  });

  it("正文未变化时返回 unchanged 且不重复写入", async () => {
    const database = createDatabase();
    const vector = createVector();
    const syncer = new RenderedTextSyncer({
      http: createHttp(SAMPLE_HTML),
      database,
      vector,
    });

    await syncer.syncOne("电解器");
    const firstHash = database.rows.get("电解器")!.hash;
    vector.indexed.length = 0;

    const second = await syncer.syncOne("电解器");

    assert.deepEqual(second, { success: true, reason: "unchanged" });
    assert.equal(database.rows.size, 1);
    assert.equal(database.rows.get("电解器")!.hash, firstHash);
    assert.equal(vector.indexed.length, 0, "未变化时不应重新向量化");
  });

  it("解析接口报错时返回 failed 且不影响调用方", async () => {
    const syncer = new RenderedTextSyncer({
      http: {
        async get() {
          return { error: { code: "parseerror", info: "解析失败" } } as any;
        },
      },
      database: createDatabase(),
    });

    const result = await syncer.syncOne("出错的页面");

    assert.equal(result.success, false);
    assert.equal(result.reason, "failed");
    assert.ok(result.message?.includes("parseerror"), result.message);
  });

  it("missingtitle 归类为 missing，不算失败", async () => {
    const syncer = new RenderedTextSyncer({
      http: {
        async get() {
          return {
            error: { code: "missingtitle", info: "The page you specified doesn't exist." },
          } as any;
        },
      },
      database: createDatabase(),
    });

    const result = await syncer.syncOne("不存在的页面");

    assert.equal(result.success, false);
    assert.equal(result.reason, "missing");
  });

  it("向量化失败不视为抓取失败", async () => {
    const database = createDatabase();
    const syncer = new RenderedTextSyncer({
      http: createHttp(SAMPLE_HTML),
      database,
      vector: {
        async indexPage() {
          throw new Error("模型未就绪");
        },
        async removePage() {
          /* noop */
        },
      },
    });

    const result = await syncer.syncOne("电解器");

    assert.equal(result.success, true);
    assert.equal(result.reason, "synced");
    assert.ok(database.rows.has("电解器"), "文本仍应入库");
    assert.ok(result.message?.includes("向量化失败"), result.message);
  });

  it("空标题直接拒绝", async () => {
    const syncer = new RenderedTextSyncer({
      http: createHttp(SAMPLE_HTML),
      database: createDatabase(),
    });
    const result = await syncer.syncOne("   ");
    assert.equal(result.success, false);
    assert.equal(result.reason, "empty");
  });

  it("syncMany 汇总统计", async () => {
    const syncer = new RenderedTextSyncer({
      http: createHttp(SAMPLE_HTML),
      database: createDatabase(),
      options: { interval: 0 },
    });

    const summary = await syncer.syncMany(["电解器", "制氧机", "  "]);

    assert.equal(summary.total, 3);
    assert.equal(summary.synced, 2);
    assert.equal(summary.missing, 0);
    assert.equal(summary.failed, 1);
  });

  it("http 兜底请求必须带 Referer（缺了会被 bwiki WAF 以 567 拦截）", async () => {
    let sent: { url: string; config: any } | undefined;
    const syncer = new RenderedTextSyncer({
      http: {
        async get(url, config) {
          sent = { url, config };
          return {
            parse: { title: "电解器", text: SAMPLE_HTML },
          } as any;
        },
      },
      database: createDatabase(),
      options: { pageUrlBase: "https://wiki.biligame.com/oni/" },
    });

    await syncer.syncOne("电解器");

    assert.ok(sent, "未发起请求");
    assert.equal(sent!.config.headers.Referer, "https://wiki.biligame.com/oni/");
    assert.ok(sent!.config.headers["User-Agent"], "缺少 User-Agent");
    assert.equal(sent!.config.params.action, "parse");
  });

  it("提供 wikiBot 时优先走 bot 通道（自带 Cookie / Referer）", async () => {
    let botCalls = 0;
    let httpCalls = 0;
    const syncer = new RenderedTextSyncer({
      http: {
        async get() {
          httpCalls++;
          return {} as any;
        },
      },
      bot: () => ({
        async request() {
          botCalls++;
          return { parse: { title: "电解器", text: SAMPLE_HTML } } as any;
        },
      }),
      database: createDatabase(),
    });

    const result = await syncer.syncOne("电解器");

    assert.deepEqual(result, { success: true, reason: "synced" });
    assert.equal(botCalls, 1);
    assert.equal(httpCalls, 0, "有 bot 时不应再走 http");
  });

  it("bot 惰性获取：每次请求时才解析，登录完成后即可切换", async () => {
    let ready = false;
    let botCalls = 0;
    const syncer = new RenderedTextSyncer({
      http: {
        async get() {
          return { parse: { title: "电解器", text: SAMPLE_HTML } } as any;
        },
      },
      bot: () =>
        ready
          ? {
              async request() {
                botCalls++;
                return { parse: { title: "电解器", text: SAMPLE_HTML } } as any;
              },
            }
          : undefined,
      database: createDatabase(),
      options: { interval: 0 },
    });

    await syncer.syncOne("电解器");
    assert.equal(botCalls, 0, "未登录时不应走 bot");

    ready = true;
    await syncer.syncOne("制氧机");
    assert.equal(botCalls, 1, "登录后应改用 bot");
  });

  describe("buildPageUrl", () => {
    it("空格转下划线并编码中文", () => {
      assert.equal(
        buildPageUrl("https://wiki.biligame.com/oni/", "Water Cooler"),
        "https://wiki.biligame.com/oni/Water_Cooler",
      );
      assert.equal(
        buildPageUrl("https://wiki.biligame.com/oni/", "电解器"),
        "https://wiki.biligame.com/oni/%E7%94%B5%E8%A7%A3%E5%99%A8",
      );
    });
  });
});
