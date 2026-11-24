import assert from "node:assert/strict";
import {
  AiQueryCommands,
  isPureFollowUp,
  residualSubject,
  toBlockText,
  wrapCodeBlock,
} from "../src/interface/aiQueryCommands";
import { AiMemory } from "../src/application/ai/aiMemory";
import { generatePinyinInfo } from "../src/utils/tools";
import type {
  AgentMessage,
  CompletionResult,
  ParsedToolCall,
} from "../src/infrastructure/ai/aiService";

/**
 * 只测 Agent 的「调度」逻辑：用原型造实例、塞假的 ctx / ai，
 * 不启动 Koishi、不联网。覆盖点都是最容易出错的地方——
 * tool_call 与 role:'tool' 消息的配对、强制检索、追问兜底。
 */

type Decision = Omit<CompletionResult, "message"> & {
  message: Extract<AgentMessage, { role: "assistant" }>;
};

function toolCall(id: string, keyword: string): ParsedToolCall {
  const raw = {
    id,
    type: "function" as const,
    function: { name: "search_oni_bwiki", arguments: JSON.stringify({ keyword }) },
  };
  return { id, name: "search_oni_bwiki", args: { keyword }, raw };
}

function plan(calls: ParsedToolCall[], content = ""): Decision {
  const message: Extract<AgentMessage, { role: "assistant" }> = {
    role: "assistant",
    content: content || null,
  };
  if (calls.length > 0) message.tool_calls = calls.map((call) => call.raw);
  return { content, toolCalls: calls, message };
}

function final(content: string): Decision {
  return { content, toolCalls: [], message: { role: "assistant", content } };
}

interface Options {
  /** 依次返回的模型结果 */
  decisions: Decision[];
  /** 标题 → 正文（没有的即为页面不存在） */
  pages?: Record<string, string>;
  /** 本地 wikipages 里的标题 */
  pageList?: string[];
  /** wiki 全文检索的返回 */
  searched?: string[];
}

function createPlugin(options: Options) {
  const plugin = Object.create(AiQueryCommands.prototype) as any;
  const completeCalls: Array<{ messages: AgentMessage[]; opts: any }> = [];
  const fetched: string[] = [];
  const searched: string[] = [];

  plugin.config = { aiMemoryTurns: 0 };
  plugin.log = { info() {}, warn() {}, debug() {}, error() {} };
  plugin.ai = {
    complete: async (messages: AgentMessage[], opts: any = {}) => {
      // 快照当前消息：多轮循环会继续往同一个数组里追加，直接存引用会让断言看到后续轮次
      completeCalls.push({ messages: [...messages], opts });
      const next = options.decisions.shift();
      if (!next) throw new Error("模型调用次数超出预期");
      return next;
    },
  };
  plugin.ctx = {
    database: {
      // 按真实表结构造数据：pinyin_* 是拼音，不是中文标题
      get: async () =>
        (options.pageList ?? []).map((title, index) => {
          const { pinyin_full, pinyin_first } = generatePinyinInfo(title);
          return { id: index + 1, title, pinyin_full, pinyin_first };
        }),
    },
    wikiBot: {
      isBWikiBotReady: () => true,
      searchPageTitles: async (keyword: string) => {
        searched.push(keyword);
        return options.searched ?? [];
      },
      fetchPagePlainText: async (title: string) => {
        fetched.push(title);
        return options.pages?.[title] ?? null;
      },
    },
  };

  return { plugin, completeCalls, fetched, searched };
}

function toolMessages(messages: AgentMessage[]) {
  return messages.filter((message) => message.role === "tool") as Array<{
    role: "tool";
    tool_call_id: string;
    content: string;
  }>;
}

describe("interface/aiQueryCommands Agent 调度", () => {
  it("单次 tool_call：把正文以 role:'tool' 回填，并让 id 对上", async () => {
    const { plugin, completeCalls, fetched } = createPlugin({
      decisions: [
        plan([toolCall("call_1", "电解器")]),
        final("电解器耗电 120 瓦。"),
      ],
      pages: { 电解器: "【电解器】[效果] 电力：消耗 120 瓦" },
      pageList: ["电解器"],
    });

    const result = await plugin.runAgent("电解器耗电多少", []);

    assert.equal(result!.answer, "电解器耗电 120 瓦。");
    assert.deepEqual(result!.pages, ["电解器"]);
    assert.deepEqual(fetched, ["电解器"]);

    const round2 = completeCalls[1].messages;
    const tools = toolMessages(round2);
    assert.equal(tools.length, 1);
    assert.equal(tools[0].tool_call_id, "call_1");
    assert.ok(tools[0].content.includes("电力：消耗 120 瓦"));
    // 第 2 轮仍是 auto：模型可以继续检索（多轮工具调用），也可以直接收尾
    assert.deepEqual(completeCalls[1].opts.toolChoice, "auto");
    // 本轮返回文本 → 循环结束，不再多调一次模型
    assert.equal(completeCalls.length, 2);
  });

  it("两个 tool_call（比较类问题）必须各回一条 tool 消息", async () => {
    const { plugin, completeCalls } = createPlugin({
      decisions: [
        plan([toolCall("c1", "电解器"), toolCall("c2", "气泵")]),
        final("电解器 120 瓦，气泵 240 瓦。"),
      ],
      pages: { 电解器: "电解器正文", 气泵: "气泵正文" },
      pageList: ["电解器", "气泵"],
    });

    const result = await plugin.runAgent("电解器和气泵哪个费电", []);

    assert.deepEqual(result!.pages, ["电解器", "气泵"]);
    const tools = toolMessages(completeCalls[1].messages);
    assert.deepEqual(
      tools.map((message) => message.tool_call_id),
      ["c1", "c2"],
    );
    // assistant 消息里的 tool_calls 必须原样保留，否则服务端判定消息不完整
    const assistant = completeCalls[1].messages.find(
      (message) => message.role === "assistant",
    ) as Extract<AgentMessage, { role: "assistant" }>;
    assert.equal(assistant.tool_calls?.length, 2);
  });

  it("超出上限的第三个 tool_call 也要补一条 tool 消息（保持结构合法）", async () => {
    const { plugin, completeCalls, fetched } = createPlugin({
      decisions: [
        plan([
          toolCall("c1", "电解器"),
          toolCall("c2", "气泵"),
          toolCall("c3", "水泵"),
        ]),
        final("好的。"),
      ],
      pages: { 电解器: "电解器正文", 气泵: "气泵正文", 水泵: "水泵正文" },
      pageList: ["电解器", "气泵", "水泵"],
    });

    await plugin.runAgent("三个都说说", []);

    const tools = toolMessages(completeCalls[1].messages);
    assert.equal(tools.length, 3);
    assert.equal(tools[2].tool_call_id, "c3");
    assert.ok(tools[2].content.includes("已跳过"));
    assert.deepEqual(fetched, ["电解器", "气泵"], "第三个不应真的去抓");
  });

  it("多轮工具调用：先查电解器、再查复制人，最后直接出文本", async () => {
    const { plugin, completeCalls, fetched } = createPlugin({
      decisions: [
        plan([toolCall("c1", "电解器")]),
        plan([toolCall("c2", "复制人")]),
        final("按资料推算：满载电解器可供 8 个复制人。"),
      ],
      pages: { 电解器: "产氧 888 克/秒", 复制人: "耗氧 100 克/秒" },
      pageList: ["电解器", "复制人"],
    });

    const result = await plugin.runAgent("满载电解器能供几个复制人", []);

    assert.deepEqual(fetched, ["电解器", "复制人"]);
    assert.deepEqual(result!.pages, ["电解器", "复制人"]);
    assert.equal(result!.sources.length, 2);
    assert.deepEqual(
      completeCalls.map((call) => call.opts.toolChoice),
      ["auto", "auto", "auto"],
      "每一轮都允许模型继续检索，直到它自己给出文本",
    );

    const lastMessages = completeCalls[2].messages;
    assert.deepEqual(
      toolMessages(lastMessages).map((message) => message.tool_call_id),
      ["c1", "c2"],
      "两轮检索的资料都必须留在上下文里",
    );
    assert.ok(
      toolMessages(lastMessages).some((message) =>
        message.content.includes("产氧 888 克/秒"),
      ),
    );
  });

  it("达到最大轮数时强制收尾（tool_choice:none）并追加收尾提示", async () => {
    const { plugin, completeCalls } = createPlugin({
      decisions: [
        plan([toolCall("c1", "电解器")]),
        final("按资料推算：可供 8 个复制人。"),
      ],
      pages: { 电解器: "产氧 888 克/秒" },
      pageList: ["电解器"],
    });
    plugin.config.aiMaxToolRounds = 2;

    const result = await plugin.runAgent("满载电解器能供几个复制人", []);

    assert.equal(result!.answer, "按资料推算：可供 8 个复制人。");
    assert.deepEqual(
      completeCalls.map((call) => call.opts.toolChoice),
      ["auto", "none"],
      "最后一轮禁止再调工具，防止死循环",
    );
    assert.ok(
      completeCalls[1].messages.some(
        (message) =>
          message.role === "system" && message.content.includes("检索轮数已达上限"),
      ),
      "收尾轮必须带上「用已有资料作答」的提示",
    );
  });

  it("重复检索同一页面时不再重复灌正文，也不重复记来源", async () => {
    const { plugin, completeCalls } = createPlugin({
      decisions: [
        plan([toolCall("c1", "电解器")]),
        plan([toolCall("c2", "电解器")]),
        final("耗电 120 瓦。"),
      ],
      pages: { 电解器: "电解器正文" },
      pageList: ["电解器"],
    });

    const result = await plugin.runAgent("电解器耗电多少", []);

    assert.equal(result!.sources.length, 1, "同一页面只记一个来源");
    const lastTool = toolMessages(completeCalls[2].messages).at(-1)!;
    assert.ok(lastTool.content.includes("已在上文提供"));
  });

  it("页面不存在时回「未找到」，不写来源也不写记忆页", async () => {
    const { plugin, completeCalls } = createPlugin({
      decisions: [
        plan([toolCall("c1", "不存在的词条")]),
        final("抱歉，资料中未提及相关信息。"),
      ],
      pages: {},
    });

    const result = await plugin.runAgent("不存在的词条是什么", []);

    const tools = toolMessages(completeCalls[1].messages);
    assert.ok(tools[0].content.includes("未找到"));
    assert.deepEqual(result!.sources, []);
    assert.deepEqual(result!.pages, []);
  });

  it("模型没调工具时追加一次强制检索", async () => {
    const { plugin, completeCalls } = createPlugin({
      decisions: [
        plan([], "电解器就是用水的那个。"),
        plan([toolCall("c1", "电解器")]),
        final("电解器把水分解为氧气和氢气。"),
      ],
      pages: { 电解器: "电解器正文" },
      pageList: ["电解器"],
    });

    const result = await plugin.runAgent("电解器是什么", []);

    assert.equal(completeCalls.length, 3);
    assert.deepEqual(completeCalls[0].opts.toolChoice, "auto");
    assert.deepEqual(completeCalls[1].opts.toolChoice, "required");
    assert.equal(result!.answer, "电解器把水分解为氧气和氢气。");
  });

  it("强制检索请求失败时退回第 1 轮的直接回答（不把问答拖垮）", async () => {
    const { plugin, completeCalls } = createPlugin({
      decisions: [plan([], "电解器就是用水的那个。")],
    });
    // 第二次调用（强制检索）直接抛错
    const original = plugin.ai.complete;
    plugin.ai.complete = async (messages: AgentMessage[], opts: any = {}) => {
      if (opts.toolChoice === "required") throw new Error("HTTP 400 tool_choice");
      return original(messages, opts);
    };

    const result = await plugin.runAgent("电解器是什么", []);

    assert.equal(completeCalls.length, 1);
    assert.equal(result!.answer, "电解器就是用水的那个。");
    assert.deepEqual(result!.sources, []);
  });

  it("强制检索仍失败时，返回模型的直接回答（不再调用第 3 轮）", async () => {
    const { plugin, completeCalls } = createPlugin({
      decisions: [plan([], "你好。"), plan([], "你好呀。")],
    });

    const result = await plugin.runAgent("你好", []);

    assert.equal(completeCalls.length, 2);
    assert.equal(result!.answer, "你好呀。");
    assert.deepEqual(result!.sources, []);
  });

  it("关键词解析不出页面时沿用上一轮的页面（追问兜底）", async () => {
    const { plugin, fetched } = createPlugin({
      decisions: [
        plan([toolCall("c1", "耗电")]),
        final("耗电 120 瓦。"),
      ],
      pages: { 电解器: "电解器正文" },
      pageList: ["电解器"],
    });

    const turns = [
      { question: "电解器是什么", answer: "…", page: "电解器", at: Date.now() },
    ];
    const result = await plugin.runAgent("那它耗电多少", turns);

    assert.ok(fetched.includes("电解器"));
    assert.deepEqual(result!.pages, ["电解器"]);
    // 真的沿用了上一轮页面 → 标注承接
    assert.equal(result!.reusedPage, "电解器");
  });

  it("问的是新词条且该页不存在时，不得拿上一轮的页面顶替", async () => {
    const { plugin, fetched } = createPlugin({
      decisions: [
        plan([toolCall("c1", "水泵")]),
        final("抱歉，资料中未提及相关信息。"),
      ],
      // 水泵没有正文；氧石精炼炉有
      pages: { 氧石精炼炉: "氧石精炼炉正文" },
      pageList: ["氧石精炼炉"],
    });

    const turns = [
      {
        question: "氧石精炼炉是什么",
        answer: "一种精炼建筑。",
        page: "氧石精炼炉",
        at: Date.now(),
      },
    ];
    const result = await plugin.runAgent("水泵有什么用", turns);

    assert.equal(
      fetched.includes("氧石精炼炉"),
      false,
      `不该用上一轮的页面回答新问题，实际抓取：${fetched.join(",")}`,
    );
    assert.deepEqual(result!.pages, []);
    assert.deepEqual(result!.sources, []);
    assert.equal(result!.reusedPage, undefined);
  });

  it("关键词里点名了上一轮页面时，仍算追问（可沿用）", async () => {
    const { plugin, fetched } = createPlugin({
      decisions: [
        plan([toolCall("c1", "氧石精炼炉 材料")]),
        final("需要金 100 千克。"),
      ],
      pages: { 氧石精炼炉: "氧石精炼炉正文" },
      pageList: ["氧石精炼炉"],
    });

    const turns = [
      {
        question: "氧石精炼炉是什么",
        answer: "一种精炼建筑。",
        page: "氧石精炼炉",
        at: Date.now(),
      },
    ];
    await plugin.runAgent("那它的材料呢", turns);

    assert.ok(fetched.includes("氧石精炼炉"));
  });

  it("历史里答「未提及」的轮次不回放给模型（避免带偏）", async () => {
    const { plugin, completeCalls } = createPlugin({
      decisions: [plan([toolCall("c1", "电解器")]), final("120 瓦。")],
      pages: { 电解器: "电解器正文" },
      pageList: ["电解器"],
    });

    await plugin.runAgent("电解器耗电多少", [
      {
        question: "电解器能飞吗",
        answer: "抱歉，资料中未提及相关信息。",
        page: "电解器",
        at: 1,
      },
      { question: "电解器是什么", answer: "制氧建筑。", page: "电解器", at: 2 },
    ]);

    const roles = completeCalls[0].messages.map((m) => m.role);
    assert.deepEqual(roles, ["system", "user", "assistant", "user"]);
    assert.equal(
      (completeCalls[0].messages[1] as { content: string }).content,
      "电解器是什么",
      "「未提及」的轮次应被跳过",
    );
  });

  it("多轮历史按 user/assistant 交替回放，且资料不进 system", async () => {
    const { plugin, completeCalls } = createPlugin({
      decisions: [
        plan([toolCall("c1", "电解器")]),
        final("120 瓦。"),
      ],
      pages: { 电解器: "电解器正文" },
      pageList: ["电解器"],
    });

    await plugin.runAgent("那它耗电多少", [
      { question: "电解器是什么", answer: "制氧建筑。", page: "电解器", at: 1 },
    ]);

    const first = completeCalls[0].messages.map((message) => message.role);
    assert.deepEqual(first, ["system", "user", "assistant", "user"]);
    assert.equal(
      (completeCalls[0].messages[0] as { content: string }).content.includes(
        "【BWIKI 资料",
      ),
      false,
    );
  });

  it("关键词带问句成分时能拆出页面名（电解器 耗电 → 电解器）", async () => {
    const { plugin, fetched } = createPlugin({
      decisions: [
        plan([toolCall("c1", "电解器 耗电")]),
        final("耗电 120 瓦。"),
      ],
      pages: { 电解器: "电解器正文" },
      pageList: ["电解器"],
    });

    const result = await plugin.runAgent("电解器耗电多少", []);

    assert.deepEqual(fetched, ["电解器"]);
    assert.deepEqual(result.pages, ["电解器"]);
  });

  it("关键词很长时，抓取与全文检索的次数都有上限", async () => {
    const { plugin, fetched, searched } = createPlugin({
      decisions: [
        plan([toolCall("c1", "电解器 耗电 瓦数 过热 气压")]),
        final("抱歉，资料中未提及相关信息。"),
      ],
      pages: {},
    });

    await plugin.runAgent("电解器耗电多少", []);

    assert.ok(fetched.length <= 4, `实际抓取 ${fetched.length} 次：${fetched.join(",")}`);
    assert.ok(searched.length <= 2, `实际检索 ${searched.length} 次：${searched.join(",")}`);
  });

  it("同一页面被检索两次时，来源不重复", async () => {    const { plugin } = createPlugin({
      decisions: [
        plan([toolCall("c1", "电解器"), toolCall("c2", "电解器")]),
        final("耗电 120 瓦。"),
      ],
      pages: { 电解器: "电解器正文" },
      pageList: ["电解器"],
    });

    const result = await plugin.runAgent("电解器耗电多少", []);

    assert.deepEqual(result.pages, ["电解器"]);
    assert.deepEqual(
      result.sources.map((source) => source.title),
      ["电解器"],
    );
  });

  it("本地拼音匹配能命中带空格的问法里的词条", async () => {
    const { plugin, fetched } = createPlugin({
      decisions: [
        plan([toolCall("c1", "dianjieqi")]),
        final("耗电 120 瓦。"),
      ],
      pages: { 电解器: "电解器正文" },
      pageList: ["电解器"],
    });

    await plugin.runAgent("dianjieqi 耗电多少", []);

    assert.ok(fetched.includes("电解器"), `实际抓取：${fetched.join(",")}`);
  });
});

describe("interface/aiQueryCommands 追问判定", () => {
  describe("residualSubject", () => {
    it("纯属性/指代词剔完什么都不剩", () => {
      assert.equal(residualSubject("耗电多少"), "");
      assert.equal(residualSubject("那它耗电多少"), "");
      assert.equal(residualSubject("它能干什么"), "");
      assert.equal(residualSubject("建筑材料"), "");
      assert.equal(residualSubject("过热温度"), "");
    });

    it("带实体的问句剔完还剩词条名", () => {
      assert.equal(residualSubject("水泵有什么用"), "水泵");
      assert.equal(residualSubject("氧石精炼炉怎么用"), "氧石精炼炉");
      assert.equal(residualSubject("电解器和气泵哪个费电"), "电解器气泵");
    });
  });

  describe("isPureFollowUp", () => {
    it("没有主语的问题算追问（可沿用上一轮）", () => {
      assert.equal(isPureFollowUp("耗电多少", "电解器"), true);
      assert.equal(isPureFollowUp("那它能干什么", "电解器"), true);
      assert.equal(isPureFollowUp("", "电解器"), true);
    });

    it("点名上一轮页面算追问", () => {
      assert.equal(isPureFollowUp("电解器的材料", "电解器"), true);
    });

    it("带新实体的问题不算追问", () => {
      assert.equal(isPureFollowUp("水泵有什么用", "氧石精炼炉"), false);
      assert.equal(isPureFollowUp("氧石精炼炉怎么用", "电解器"), false);
    });

    it("没有上一轮页面时永远不算追问", () => {
      assert.equal(isPureFollowUp("耗电多少", undefined), true);
      assert.equal(isPureFollowUp("水泵有什么用", undefined), false);
    });
  });
});

describe("interface/aiQueryCommands 回复渲染", () => {
  /** QQ 场景：renderer.send 直接回传 markdown，方便断言 */
  function createRendererPlugin(threshold: number) {
    const plugin = Object.create(AiQueryCommands.prototype) as any;
    plugin.config = { aiCodeBlockMinChars: threshold };
    plugin.renderer = {
      isQQ: () => true,
      send: async (_session: unknown, markdown: string) => markdown,
    };
    return plugin;
  }

  const SOURCES = [
    { title: "电解器", url: "https://wiki.biligame.com/oni/电解器" },
  ];
  const SHORT = "电解器耗电 120 瓦。";
  const LONG = Array.from(
    { length: 8 },
    (_, i) => `• 第 ${i + 1} 条：电解器在气压达到 1800 克时停止工作。`,
  ).join("\n");

  it("短回答保持普通 markdown（不进代码块）", async () => {
    const plugin = createRendererPlugin(180);
    const markdown = await plugin.renderAnswer(undefined, SHORT, SOURCES);

    assert.ok(markdown.includes(SHORT));
    assert.ok(!markdown.includes("```"), markdown);
    assert.ok(markdown.includes("数据来源：缺氧 BWIKI"));
  });

  it("长回答塞进代码块，避免手机端刷屏", async () => {
    const plugin = createRendererPlugin(180);
    const markdown = await plugin.renderAnswer(undefined, LONG, SOURCES);

    assert.ok(markdown.startsWith("**🤖 AI 回答**\n```"), markdown);
    assert.ok(markdown.includes(LONG), "正文必须完整保留");
    // 代码块必须闭合在来源之前
    const fenceCount = (markdown.match(/```/g) ?? []).length;
    assert.equal(fenceCount, 2, markdown);
    assert.ok(markdown.indexOf("数据来源") > markdown.lastIndexOf("```"));
    assert.ok(markdown.includes("[电解器](https://wiki.biligame.com/oni/电解器)"));
  });

  it("阈值为 0 时始终不用代码块", async () => {
    const plugin = createRendererPlugin(0);
    const markdown = await plugin.renderAnswer(undefined, LONG, SOURCES);
    assert.ok(!markdown.includes("```"), markdown);
  });

  it("「资料未提及」时不列来源，且长文本仍按阈值处理", async () => {
    const plugin = createRendererPlugin(180);
    const markdown = await plugin.renderAnswer(
      undefined,
      `抱歉，资料中未提及相关信息。${LONG}`,
      SOURCES,
    );

    assert.ok(markdown.includes("```"));
    assert.ok(!markdown.includes("🔗"), markdown);
    assert.ok(markdown.includes("数据来源：缺氧 BWIKI"));
  });

  it("承接群内上一问的标注留在代码块外面", async () => {
    const plugin = createRendererPlugin(180);
    const markdown = await plugin.renderAnswer(
      undefined,
      LONG,
      SOURCES,
      "电解器耗电多少",
    );

    assert.ok(markdown.includes("💭 承接群内上一问：电解器耗电多少"));
    assert.ok(
      markdown.indexOf("💭") > markdown.lastIndexOf("```"),
      "标注不应被裹进代码块",
    );
  });

  describe("toBlockText", () => {
    it("去掉 markdown 强调标记（代码块里不会渲染）", () => {
      assert.equal(
        toBlockText("**耗电**：120 瓦，__产热__ 1 千复制热/秒"),
        "耗电：120 瓦，产热 1 千复制热/秒",
      );
    });

    it("列表符号统一成 •，标题去掉 #", () => {
      assert.equal(
        toBlockText("### 机制\n- 第一步\n* 第二步"),
        "机制\n• 第一步\n• 第二步",
      );
    });

    it("行内链接只留文字", () => {
      assert.equal(
        toBlockText("见[电解器](https://example.com/a)页面"),
        "见电解器页面",
      );
    });

    it("保留正文里的数值与换行", () => {
      assert.equal(toBlockText("• 电力：120 瓦\n• 产热：1 千复制热/秒"), "• 电力：120 瓦\n• 产热：1 千复制热/秒");
    });

    it("不误伤以「-10」「#1」开头的数值（只把带空格的形式当列表/标题）", () => {
      assert.equal(
        toBlockText("-10（范围：2 格）\n#1 号管道"),
        "-10（范围：2 格）\n#1 号管道",
      );
    });

    it("落单的 ** 也会被清掉", () => {
      assert.equal(toBlockText("**耗电 120 瓦"), "耗电 120 瓦");
    });
  });

  describe("wrapCodeBlock", () => {
    it("普通正文用三个反引号", () => {
      assert.equal(wrapCodeBlock("abc"), "```\nabc\n```");
    });

    it("正文自带 ``` 时改用更长围栏，避免提前闭合", () => {
      const wrapped = wrapCodeBlock("代码：\n```js\nx\n```");
      assert.ok(wrapped.startsWith("````\n"), wrapped);
      assert.ok(wrapped.endsWith("\n````"), wrapped);
      assert.ok(wrapped.includes("```js"));
    });
  });
});

describe("interface/aiQueryCommands 多人群聊隔离", () => {
  const SESSION = { platform: "qq", channelId: "group1", userId: "user-b" } as any;
  const ELECTROLYZER = {
    question: "电解器是什么",
    answer: "制氧建筑。",
    page: "电解器",
    at: Date.now(),
  };

  function createContextPlugin(options: {
    own?: any[];
    shared?: any[];
  }) {
    const plugin = Object.create(AiQueryCommands.prototype) as any;
    plugin.config = { aiMemoryTurns: 2, aiMemoryTtl: 600, aiChannelMemory: true };
    plugin.log = { info() {}, warn() {}, debug() {}, error() {} };
    plugin.memory = new AiMemory(2, 600_000);
    plugin.channelMemory = new AiMemory(1, 600_000);
    plugin.ctx = { database: { get: async () => [] } };

    if (options.own?.length) plugin.memory.add("qq:group1:user-b", options.own[0]);
    if (options.shared?.length)
      plugin.channelMemory.add("topic:qq:group1", options.shared[0]);
    return plugin;
  }

  it("自带新实体时不取任何历史（B 问水泵，不受 A 的电解器影响）", async () => {
    const plugin = createContextPlugin({ shared: [ELECTROLYZER] });
    const context = await plugin.resolveContext(SESSION, "水泵有什么用");

    assert.deepEqual(context.turns, []);
    assert.equal(context.shared, false);
  });

  it("自己刚问过别的，换话题时也不回放自己的历史", async () => {
    const plugin = createContextPlugin({ own: [ELECTROLYZER] });
    const context = await plugin.resolveContext(SESSION, "水泵机制");

    assert.deepEqual(context.turns, []);
  });

  it("纯追问才承接群话题，并标记 shared", async () => {
    const plugin = createContextPlugin({ shared: [ELECTROLYZER] });
    const context = await plugin.resolveContext(SESSION, "耗电多少");

    assert.equal(context.turns.length, 1);
    assert.equal(context.shared, true);
    assert.equal(context.inheritedFrom, "电解器是什么");
  });

  it("点名了最近话题时也算追问（可用自己的历史）", async () => {
    const plugin = createContextPlugin({ own: [ELECTROLYZER] });
    const context = await plugin.resolveContext(SESSION, "电解器的材料呢");

    assert.equal(context.turns.length, 1);
    assert.equal(context.shared, false);
  });

  it("完全没有历史时返回空上下文", async () => {
    const plugin = createContextPlugin({});
    const context = await plugin.resolveContext(SESSION, "耗电多少");

    assert.deepEqual(context.turns, []);
  });

  it("群话题只回放「问了什么」，不回放别人的答案", async () => {
    const { plugin, completeCalls } = createPlugin({
      decisions: [plan([toolCall("c1", "耗电多少")]), final("120 瓦。")],
      pages: { 电解器: "电解器正文" },
      pageList: ["电解器"],
    });

    await plugin.runAgent("耗电多少", [ELECTROLYZER], true);

    const messages = completeCalls[0].messages;
    assert.equal(
      messages.some((m) => m.role === "assistant"),
      false,
      "别人的答案不该被回放",
    );
    const hint = messages.find(
      (m) => m.role === "system" && String(m.content).includes("群内上一问"),
    ) as { content: string } | undefined;
    assert.ok(hint, "应带上群内上一问的提示");
    assert.ok(hint!.content.includes("电解器是什么"));
    assert.ok(!hint!.content.includes("制氧建筑"), "答案正文不能进提示");
  });

  it("自己的历史答案回放时会被压缩成摘要", async () => {
    const { plugin, completeCalls } = createPlugin({
      decisions: [plan([toolCall("c1", "电解器")]), final("120 瓦。")],
      pages: { 电解器: "电解器正文" },
      pageList: ["电解器"],
    });

    const longAnswer = "电解器".repeat(200);
    await plugin.runAgent(
      "那它耗电多少",
      [{ question: "电解器是什么", answer: longAnswer, page: "电解器", at: 1 }],
      false,
    );

    const assistant = completeCalls[0].messages.find((m) => m.role === "assistant") as {
      content: string;
    };
    assert.ok(assistant.content.length <= 201, `实际 ${assistant.content.length} 字`);
  });
});
