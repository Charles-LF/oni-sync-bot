import assert from "node:assert/strict";
import { QueryCommands } from "../src/interface/queryCommands";

/** 假 wiki 页（结构兼容 WikiPages） */
interface Page {
  id: number;
  title: string;
  pinyin_full: string;
  pinyin_first: string;
  contributor?: string;
  change_time?: string;
}

const PAGES: Page[] = [
  { id: 1, title: "电解器", pinyin_full: "dianjieqi", pinyin_first: "djq" },
  { id: 2, title: "基地", pinyin_full: "jidi", pinyin_first: "jd" },
  { id: 3, title: "极地", pinyin_full: "jidi", pinyin_first: "jd" },
  { id: 4, title: "Sandbox", pinyin_full: "sandbox", pinyin_first: "" },
];

function createPlugin(pages: Page[] = PAGES) {
  const plugin = Object.create(QueryCommands.prototype) as any;
  const sent: Array<{ content?: string; page?: any; keyboard?: any; prefix?: string }> = [];
  const queries: any[] = [];
  let action: any;
  let middleware: any;

  const ctx: any = {
    database: {
      get: async (_table: string, query: Record<string, any> = {}) => {
        queries.push(query);
        return pages
          .filter((page) =>
            Object.entries(query).every(
              ([key, value]) => (page as any)[key] === value,
            ),
          )
          .map((page) => ({ ...page }));
      },
    },
    command: () => ({
      alias: () => ({
        action: (fn: any) => {
          action = fn;
        },
      }),
    }),
    middleware: (cb: any) => {
      middleware = cb;
      return () => {
        middleware = undefined;
      };
    },
  };

  plugin.config = { domain: "klei.test" };
  plugin.renderer = {
    isQQ: (session: any) => session?.platform === "qq",
    usageMessage: async () => "usage",
    send: async (_session: any, content: string, keyboard?: any) => {
      sent.push({ content, keyboard });
      return undefined;
    },
    resultMessage: async (_session: any, page: any, prefix?: string) => {
      sent.push({ page, prefix });
      return undefined;
    },
    matchListKeyboard: (matches: any[]) => ({ rows: matches.length }),
  };
  plugin.registerCommands(ctx);

  return {
    plugin,
    ctx,
    sent,
    queries,
    run: (input: string, session: any = { platform: "qq", userId: "u1", channelId: "c1" }) =>
      action({ session }, input),
    middleware: () => middleware,
  };
}

describe("interface/queryCommands 查询链路", () => {
  it("标题精准命中（中文）", async () => {
    const { run, sent } = createPlugin();
    await run("电解器");

    assert.equal(sent.length, 1);
    assert.equal(sent[0].page.title, "电解器");
    assert.equal(sent[0].prefix, "✅ 精准匹配成功");
  });

  it("英文标题忽略大小写也能精准命中（不再被小写化搞挂）", async () => {
    const { run, sent } = createPlugin();
    await run("sandbox");

    assert.equal(sent.length, 1);
    assert.equal(sent[0].page.title, "Sandbox");
  });

  it("拼音对不上时，标题大小写不敏感仍能兜住", async () => {
    // 有些页面（英文 / 带命名空间）拼音可能不是输入的样子，靠标题回落命中
    const { run, sent } = createPlugin([
      { id: 9, title: "Sandbox", pinyin_full: "sb", pinyin_first: "s" },
    ]);
    await run("sandbox");

    assert.equal(sent[0].page.title, "Sandbox");
    assert.equal(sent[0].prefix, "✅ 精准匹配成功");
  });

  it("全拼命中唯一页面时直接给结果", async () => {
    const { run, sent } = createPlugin();
    await run("dianjieqi");

    assert.equal(sent[0].page.title, "电解器");
    assert.ok(String(sent[0].prefix).includes("拼音精准匹配"));
  });

  it("全拼重码时给候选列表，而不是随机挑第一个", async () => {
    const { run, sent } = createPlugin();
    await run("jidi");

    assert.equal(sent[0].page, undefined, "不应该直接给出某一页");
    assert.equal(sent[0].keyboard.rows, 2, "应该走候选按钮");
    assert.ok(String(sent[0].content).includes("基地"));
    assert.ok(String(sent[0].content).includes("极地"));
  });

  it("候选按标题排序，结果稳定", async () => {
    const { run, sent } = createPlugin();
    await run("jd");
    const text = String(sent[0].content);
    assert.ok(text.indexOf("基地") < text.indexOf("极地"));
  });

  it("特殊词条的链接用配置里的 domain，而不是写死的 klei.vip", async () => {
    const { run, sent } = createPlugin();
    await run("火箭计算器");

    assert.ok(String(sent[0].content).includes("https://klei.test/calculator"));
    assert.ok(!String(sent[0].content).includes("klei.vip"));
  });

  it("空输入给使用说明", async () => {
    const { run } = createPlugin();
    const result = await run("   ");

    assert.equal(result, "usage");
  });

  it("页面列表 60 秒内只读一次库，过期后重新读", async () => {
    const { plugin, ctx } = createPlugin();
    const counter = { count: 0 };
    const original = ctx.database.get;
    ctx.database.get = async (table: string, query: any = {}) => {
      if (table === "wikipages" && Object.keys(query).length === 0) counter.count++;
      return original(table, query);
    };

    await plugin.loadPages(ctx);
    await plugin.loadPages(ctx);
    assert.equal(counter.count, 1, "第二次应命中缓存");

    plugin.pageCache = { at: Date.now() - 61_000, task: plugin.pageCache.task };
    await plugin.loadPages(ctx);
    assert.equal(counter.count, 2, "过期后应重新读");
  });

  it("找不到时提示可能还没同步", async () => {
    const { run, sent } = createPlugin();
    await run("完全不存在的页面");

    assert.ok(String(sent[0].content).includes("未找到"));
    assert.ok(String(sent[0].content).includes("update"));
  });
});

describe("interface/queryCommands 序号选择", () => {
  const session = { platform: "satori", userId: "u1", channelId: "c1" };

  it("只认提问者本人的回复，别人的消息原样放行", async () => {
    const { plugin, ctx, middleware } = createPlugin();
    const pending = plugin.waitForUserInput(ctx, session, 5000);
    const cb = middleware();
    assert.ok(cb, "应该注册了中间件");

    let passed = 0;
    const next = () => {
      passed++;
    };

    // 别人的消息：不该被吞
    cb({ userId: "other", channelId: "c1", content: "3" }, next);
    assert.equal(passed, 1);

    // 别的频道：也不吞
    cb({ userId: "u1", channelId: "c2", content: "3" }, next);
    assert.equal(passed, 2);

    cb({ userId: "u1", channelId: "c1", content: " 2 " }, next);
    assert.equal(await pending, "2");
    assert.equal(passed, 2, "本人的回复应该被吃掉");
  });

  it("超时返回 undefined", async () => {
    const { plugin, ctx } = createPlugin();
    const value = await plugin.waitForUserInput(ctx, session, 20);
    assert.equal(value, undefined);
  });

  it("序号必须是纯数字：3abc 会被拒绝", async () => {
    const { plugin, ctx, sent } = createPlugin();
    plugin.waitForUserInput = async () => "3abc";

    await plugin.handleSelection(ctx, session, [
      { id: 1, title: "基地", score: 1 },
      { id: 3, title: "极地", score: 1 },
    ]);

    assert.ok(
      sent.some((item) => String(item.content).includes("输入无效")),
      "非法序号要提示重输",
    );
  });

  it("超范围的序号同样拒绝", async () => {
    const { plugin, ctx, sent } = createPlugin();
    plugin.waitForUserInput = async () => "9";

    await plugin.handleSelection(ctx, session, [{ id: 1, title: "基地", score: 1 }]);

    assert.ok(sent.some((item) => String(item.content).includes("1-1")));
  });

  it("合法序号返回选中的页面", async () => {
    const { plugin, ctx, sent } = createPlugin();
    plugin.waitForUserInput = async () => "2";

    await plugin.handleSelection(ctx, session, [
      { id: 1, title: "基地", score: 1 },
      { id: 3, title: "极地", score: 1 },
    ]);

    const result = sent.find((item) => item.page);
    assert.equal(result?.page.title, "极地");
    assert.equal(result?.prefix, "✅ 选择成功");
  });

  it("超时（undefined）时不再回复任何内容", async () => {
    const { plugin, ctx, sent } = createPlugin();
    plugin.waitForUserInput = async () => undefined;

    await plugin.handleSelection(ctx, session, [{ id: 1, title: "基地", score: 1 }]);

    assert.equal(sent.length, 1, "只应该发出那一条候选提示");
  });
});
