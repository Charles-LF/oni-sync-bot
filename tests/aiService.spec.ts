import assert from "node:assert/strict";
import {
  NO_ANSWER_TEXT,
  SYSTEM_PROMPT,
  buildContext,
  buildMessages,
  isNoAnswer,
} from "../src/services/aiService";

const CHUNKS = [
  {
    title: "电解器",
    url: "https://wiki.biligame.com/oni/电解器",
    text: "耗电 120 瓦，产氧 888 克/秒。",
  },
  {
    title: "制氧机",
    text: "需要藻类作为原料。",
  },
];

describe("services/aiService 提示词构造", () => {
  it("系统提示词包含防幻觉硬约束", () => {
    assert.ok(SYSTEM_PROMPT.includes("严格且仅"));
    assert.ok(SYSTEM_PROMPT.includes("绝对禁止编造"));
    assert.ok(SYSTEM_PROMPT.includes(`如果资料中未提及，请直接回答：${NO_ANSWER_TEXT}`));
    assert.ok(SYSTEM_PROMPT.includes("分点的中文回答"));
  });

  it("资料片段带上页面名与链接", () => {
    const context = buildContext(CHUNKS);
    assert.ok(context.includes("[资料1] 页面：电解器（https://wiki.biligame.com/oni/电解器）"));
    assert.ok(context.includes("耗电 120 瓦"));
    assert.ok(context.includes("[资料2] 页面：制氧机"));
  });

  it("资料进 system、问题进 user", () => {
    const messages = buildMessages("电解器耗电多少？", CHUNKS);

    assert.equal(messages.length, 2);
    assert.equal(messages[0].role, "system");
    assert.ok(messages[0].content.includes("【BWIKI 资料开始】"));
    assert.ok(messages[0].content.includes("【BWIKI 资料结束】"));
    assert.ok(messages[0].content.includes("耗电 120 瓦"));
    assert.deepEqual(messages[1], { role: "user", content: "电解器耗电多少？" });
  });

  it("多轮追问时按 user/assistant 顺序回放历史", () => {
    const messages = buildMessages("那它能干什么？", CHUNKS, [
      { question: "电解器耗电多少？", answer: "耗电 120 瓦。" },
    ]);

    assert.deepEqual(
      messages.map((message) => message.role),
      ["system", "user", "assistant", "user"],
    );
    assert.equal(messages[1].content, "电解器耗电多少？");
    assert.equal(messages[2].content, "耗电 120 瓦。");
    assert.equal(messages[3].content, "那它能干什么？");
    assert.ok(messages[0].content.includes("结合对话历史理解指代"));
  });

  it("历史中缺失字段的轮次会被跳过", () => {
    const messages = buildMessages("继续", CHUNKS, [
      { question: "", answer: "无问题" },
      { question: "有效问题", answer: "" },
    ]);
    assert.equal(messages.length, 2);
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
});
