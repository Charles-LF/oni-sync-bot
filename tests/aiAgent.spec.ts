import assert from "node:assert/strict";
import { AiQueryCommands } from "../src/plugins/aiQueryCommands";
import { generatePinyinInfo } from "../src/utils/tools";
import type {
  AgentMessage,
  CompletionResult,
  ParsedToolCall,
} from "../src/services/aiService";

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

  plugin.config = { aiMemoryTurns: 0 };
  plugin.log = { info() {}, warn() {}, debug() {}, error() {} };
  plugin.ai = {
    complete: async (messages: AgentMessage[], opts: any = {}) => {
      completeCalls.push({ messages, opts });
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
      searchPageTitles: async () => options.searched ?? [],
      fetchPagePlainText: async (title: string) => {
        fetched.push(title);
        return options.pages?.[title] ?? null;
      },
    },
  };

  return { plugin, completeCalls, fetched };
}

function toolMessages(messages: AgentMessage[]) {
  return messages.filter((message) => message.role === "tool") as Array<{
    role: "tool";
    tool_call_id: string;
    content: string;
  }>;
}

describe("plugins/aiQueryCommands Agent 调度", () => {
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
    // 第 2 轮必须禁止再次调工具，否则模型可能无限检索
    assert.deepEqual(completeCalls[1].opts.toolChoice, "none");
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

  it("同一页面被检索两次时，来源不重复", async () => {
    const { plugin } = createPlugin({
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
