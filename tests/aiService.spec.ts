import assert from "node:assert/strict";
import {
  AGENT_SYSTEM_PROMPT,
  ANSWER_SYSTEM_PROMPT,
  AiService,
  NO_ANSWER_TEXT,
  isNoAnswer,
  type AgentMessage,
  type ToolDefinition,
} from "../src/services/aiService";

const SETTINGS = {
  aiEnabled: true,
  deepseekApiKey: "test-key",
  deepseekBaseUrl: "https://api.deepseek.com/",
  deepseekModel: "deepseek-chat",
  aiTemperature: 0.2,
  aiMaxTokens: 700,
  aiTimeout: 5000,
};

const TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "search_oni_bwiki",
    description: "检索 BWIKI",
    parameters: { type: "object", properties: {} },
  },
};

/** 假 ctx.http：记录请求体并按预设返回 */
function createService(response: unknown) {
  const requests: Array<{ url: string; body: any }> = [];
  const ctx = {
    http: {
      post: async (url: string, body: any) => {
        requests.push({ url, body });
        return response;
      },
    },
  } as any;
  return { ai: new AiService(ctx, SETTINGS as any), requests };
}

function reply(message: Record<string, unknown>) {
  return { choices: [{ message }] };
}

describe("services/aiService 提示词", () => {
  it("回答提示词保留防幻觉硬约束", () => {
    assert.ok(ANSWER_SYSTEM_PROMPT.includes("严格且仅"));
    assert.ok(ANSWER_SYSTEM_PROMPT.includes("绝对禁止编造"));
    assert.ok(
      ANSWER_SYSTEM_PROMPT.includes(
        `如果资料中未提及，请直接回答：${NO_ANSWER_TEXT}`,
      ),
    );
    assert.ok(ANSWER_SYSTEM_PROMPT.includes("分点的中文回答"));
    assert.ok(ANSWER_SYSTEM_PROMPT.includes("结合对话历史理解指代"));
  });

  it("Agent 提示词要求先调用工具、禁止凭记忆作答", () => {
    assert.ok(AGENT_SYSTEM_PROMPT.includes("search_oni_bwiki"));
    assert.ok(AGENT_SYSTEM_PROMPT.includes("必须先调用工具"));
    assert.ok(AGENT_SYSTEM_PROMPT.includes("绝对禁止编造"));
  });

  it("两套提示词各司其职：Agent 不管资料，回答不管检索", () => {
    assert.ok(!AGENT_SYSTEM_PROMPT.includes("【BWIKI 资料开始】"));
    assert.ok(!ANSWER_SYSTEM_PROMPT.includes("search_oni_bwiki"));
  });
});

describe("services/aiService.complete", () => {
  const messages: AgentMessage[] = [{ role: "user", content: "电解器耗电多少" }];

  it("传了 tools 就把 tools 与 tool_choice 写进请求体", async () => {
    const { ai, requests } = createService(reply({ content: "好" }));

    await ai.complete(messages, {
      tools: [TOOL],
      toolChoice: { type: "function", function: { name: "search_oni_bwiki" } },
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.deepseek.com/chat/completions");
    assert.equal(requests[0].body.model, "deepseek-chat");
    assert.deepEqual(requests[0].body.tools, [TOOL]);
    assert.deepEqual(requests[0].body.tool_choice, {
      type: "function",
      function: { name: "search_oni_bwiki" },
    });
  });

  it("不传 tools 时请求体里没有 tools 键（第 2 轮只能给终稿）", async () => {
    const { ai, requests } = createService(reply({ content: "好" }));

    await ai.complete(messages);

    assert.equal("tools" in requests[0].body, false);
    assert.equal("tool_choice" in requests[0].body, false);
  });

  it("解析 tool_calls：arguments 从 JSON 字符串解开", async () => {
    const { ai } = createService(
      reply({
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "search_oni_bwiki",
              arguments: '{"keyword":"电解器"}',
            },
          },
        ],
      }),
    );

    const result = await ai.complete(messages, { tools: [TOOL] });

    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0].id, "call_1");
    assert.equal(result.toolCalls[0].args.keyword, "电解器");
    // 原样回传用：assistant 消息必须带 tool_calls，否则第 2 轮请求不合法
    assert.deepEqual(result.message.tool_calls, [
      {
        id: "call_1",
        type: "function",
        function: { name: "search_oni_bwiki", arguments: '{"keyword":"电解器"}' },
      },
    ]);
  });

  it("arguments 不是合法 JSON 时退化为空参数，不抛错", async () => {
    const { ai } = createService(
      reply({
        tool_calls: [
          {
            id: "call_2",
            type: "function",
            function: { name: "search_oni_bwiki", arguments: "keyword=电解器" },
          },
        ],
      }),
    );

    const result = await ai.complete(messages, { tools: [TOOL] });
    assert.deepEqual(result.toolCalls[0].args, {});
  });

  it("只有 content 的普通回答不会被当成 tool_call", async () => {
    const { ai } = createService(reply({ content: "  你好  " }));

    const result = await ai.complete(messages, { tools: [TOOL] });

    assert.equal(result.content, "你好");
    assert.equal(result.toolCalls.length, 0);
    assert.equal("tool_calls" in result.message, false);
  });

  it("没有 choices 时抛错（而不是静默返回空串）", async () => {
    const { ai } = createService({ error: { message: "余额不足" } });
    await assert.rejects(
      () => ai.complete(messages),
      /余额不足/,
    );
  });

  it("未配置 API Key 时不发请求", async () => {
    const ctx = { http: { post: async () => assert.fail("不该发请求") } } as any;
    const ai = new AiService(ctx, {
      ...SETTINGS,
      deepseekApiKey: "",
    } as any);
    const original = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      await assert.rejects(() => ai.complete(messages), /API Key/);
    } finally {
      if (original !== undefined) process.env.DEEPSEEK_API_KEY = original;
    }
  });
});

describe("isNoAnswer", () => {
  it("识别标准的「未提及」回答（忽略标点与空白差异）", () => {
    assert.equal(isNoAnswer(NO_ANSWER_TEXT), true);
    assert.equal(isNoAnswer("  抱歉 资料中未提及相关信息 "), true);
    assert.equal(isNoAnswer("抱歉，资料中未提及相关信息。\n\n请换个问法"), true);
  });

  it("正常回答不算未提及", () => {
    assert.equal(isNoAnswer("电解器耗电 120 瓦。"), false);
    assert.equal(isNoAnswer(""), false);
  });
});
