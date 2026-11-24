import assert from "node:assert/strict";
import {
  VERIFY_SYSTEM_PROMPT,
  buildVerifyMessage,
  collectPercents,
  detectPercentConflicts,
  isVerifyOk,
  looksIncomplete,
  needsNumericCheck,
  numericSignature,
  parseVerifyReply,
  pickRevision,
} from "../src/domain/ai/answerGuard";

/** 线上翻车过的原句：同一份回答里 0.9% 与 9% 并存 */
const BAD_ANSWER = [
  "**若把这 3.33333 千克/秒原油全部送进精炼器：**",
  "- 石油：3.33333 × 50% = 1.667 千克/秒",
  "- 天然气：3.33333 × 0.9% = 30 克/秒",
  "## 关于水回收",
  "- 精炼器：原油 50% 变石油、9% 变天然气",
  "- 石油发电机：石油 37.5% 变污染水",
].join("\n");

describe("domain/answerGuard 百分比与数值", () => {
  it("抽取所有百分比（含空格写法）", () => {
    const hits = collectPercents("0.9% 与 37.5 % 以及 9%");
    assert.deepEqual(
      hits.map((hit) => hit.value),
      [0.9, 37.5, 9],
    );
  });

  it("同一回答里出现相差 10 倍的百分比时给出疑点", () => {
    const issues = detectPercentConflicts(BAD_ANSWER);
    assert.equal(issues.length, 1);
    assert.ok(issues[0].message.includes("0.9%"));
    assert.ok(issues[0].message.includes("9%"));
  });

  it("互不相干的百分比不算矛盾", () => {
    const issues = detectPercentConflicts(
      "石油 50% 变石油，石油发电机 37.5% 变污染水，天然气发电机 75% 变污染水，净损失 12.75%",
    );
    assert.deepEqual(issues, []);
  });

  it("只有一两个百分比时也不误报", () => {
    assert.deepEqual(detectPercentConflicts("转化率 9%"), []);
    assert.deepEqual(detectPercentConflicts(""), []);
  });

  it("含百分比 / 算式 / 多个数字的回答需要复核", () => {
    assert.equal(needsNumericCheck(BAD_ANSWER), true);
    assert.equal(needsNumericCheck("500 ÷ 2 = 250 克/秒"), true);
    assert.equal(needsNumericCheck("耗电 120 瓦，产热 2 千复制热，尺寸 2×2"), true);
    assert.equal(needsNumericCheck("电解器可以把水分解成氧气和氢气。"), false);
  });

  it("「资料未提及 / 无法计算」这类收场白能被识别", () => {
    assert.equal(looksIncomplete(""), true);
    assert.equal(looksIncomplete("抱歉，资料中未提及相关信息。"), true);
    assert.equal(
      looksIncomplete("**结论：缺少油井产油速率，无法得出「够几台炼油」的数值。**"),
      true,
    );
    assert.equal(looksIncomplete("满载油井产出 3.33 千克/秒原油。"), false);
  });
});

describe("domain/answerGuard 复核结果判定", () => {
  const revised =
    "满载油井的天然气是 33.3 克/秒，精炼器副产 30 克/秒，合计 63.3 克/秒。";

  it("OK 的各种写法都视为没问题", () => {
    assert.equal(isVerifyOk("OK"), true);
    assert.equal(isVerifyOk(" ok "), true);
    assert.equal(isVerifyOk("OK，没有数值问题"), true);
    assert.equal(isVerifyOk(""), false);
    assert.equal(isVerifyOk("FIX\n回答"), false);
  });

  it("按协议解析：OK 保持原稿，FIX 才替换", () => {
    assert.deepEqual(parseVerifyReply("OK"), { ok: true });
    assert.deepEqual(parseVerifyReply("  ok\n"), { ok: true });
    assert.deepEqual(parseVerifyReply(`FIX\n${revised}`), {
      ok: false,
      revision: revised,
    });
  });

  it("模型没按格式回（把回答复述一遍）时一律沿用原稿", () => {
    assert.equal(parseVerifyReply(revised).ok, true);
    assert.equal(parseVerifyReply("这段仅供参考……").ok, true);
    assert.equal(parseVerifyReply("FIX\n太短").ok, true, "说了要修却给半句话，视为没改");
  });

  it("pickRevision：OK / 无协议头 / 半句话都保留原稿，只有 FIX 才换", () => {
    const draft = "满载油井天然气 33.3 克/秒。";
    assert.equal(pickRevision(draft, "OK"), draft);
    assert.equal(pickRevision(draft, "9%"), draft);
    assert.equal(pickRevision(draft, revised), draft, "没有 FIX 头不覆盖原稿");
    assert.equal(pickRevision(draft, `FIX\n${revised}`), revised);
  });

  it("只改措辞（数字完全一样）的「修正」不予采纳", () => {
    const draft = "满载油井天然气 33.3 克/秒，加上副产 30 克/秒，合计 63.3 克/秒。";
    const reworded = "据 BWIKI，满载油井自身产 33.3 克/秒天然气，精炼器再副产 30 克/秒，总共 63.3 克/秒。";
    assert.equal(numericSignature(draft), numericSignature(reworded));
    assert.equal(pickRevision(draft, `FIX\n${reworded}`), draft);

    const corrected = "满载油井天然气 33.3 克/秒，加上副产 30 克/秒，合计 63.3 克/秒（副产率 0.9%）。";
    assert.equal(pickRevision(draft, `FIX\n${corrected}`), corrected);
  });

  it("复核请求带上问题、资料摘录与程序预检疑点，资料过长会截断", () => {
    const message = buildVerifyMessage(
      "满载油井需要多少水",
      "资".repeat(9000),
      "初稿",
      ["0.9% 与 9% 相差 10 倍"],
    );
    assert.ok(message.includes("【原始问题】满载油井需要多少水"));
    assert.ok(message.includes("【待校对回答】\n初稿"));
    assert.ok(message.includes("0.9% 与 9% 相差 10 倍"));
    assert.ok(message.includes("已截断"));
  });

  it("复核提示词要求「没问题只回 OK、有问题先写 FIX」", () => {
    assert.ok(VERIFY_SYSTEM_PROMPT.includes("OK"));
    assert.ok(VERIFY_SYSTEM_PROMPT.includes("FIX"));
    assert.ok(VERIFY_SYSTEM_PROMPT.includes("0.9%"));
  });
});
