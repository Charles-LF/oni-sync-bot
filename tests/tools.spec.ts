import assert from "node:assert/strict";
import {
  generatePinyinInfo,
  getErrorMessage,
  formatWikiTime,
  normalizeChannelId,
  truncateComment,
  normalizeImageTitle,
  stripImagePrefix,
} from "../src/utils/tools";

describe("utils/tools", () => {
  describe("generatePinyinInfo", () => {
    it("空字符串返回空结果", () => {
      assert.deepEqual(generatePinyinInfo(""), {
        pinyin_full: "",
        pinyin_first: "",
      });
    });

    it("纯符号（过滤后为空）返回空结果", () => {
      assert.deepEqual(generatePinyinInfo("!!! ???"), {
        pinyin_full: "",
        pinyin_first: "",
      });
    });

    it("中文生成无音调全拼与小写首字母", () => {
      assert.deepEqual(generatePinyinInfo("精炼器"), {
        pinyin_full: "jinglianqi",
        pinyin_first: "jlq",
      });
    });

    it("首字母可能是多字母声母（蒸 -> zh）", () => {
      assert.deepEqual(generatePinyinInfo("蒸汽精炼器"), {
        pinyin_full: "zhengqijinglianqi",
        pinyin_first: "zhqjlq",
      });
    });

    it("先过滤符号再转拼音，拉丁字母直接保留", () => {
      assert.deepEqual(generatePinyinInfo("精炼器 (Refinery)"), {
        pinyin_full: "jinglianqirefinery",
        pinyin_first: "jlq",
      });
    });

    it("纯拉丁输入：全拼为小写原文，首字母为空串", () => {
      assert.deepEqual(generatePinyinInfo("Rocket Calculator"), {
        pinyin_full: "rocketcalculator",
        pinyin_first: "",
      });
    });
  });

  describe("getErrorMessage", () => {
    it("Error 取 message", () => {
      assert.equal(getErrorMessage(new Error("boom")), "boom");
    });

    it("字符串原样返回", () => {
      assert.equal(getErrorMessage("plain"), "plain");
    });

    it("数字转字符串", () => {
      assert.equal(getErrorMessage(123), "123");
    });

    it("null / undefined 转字符串", () => {
      assert.equal(getErrorMessage(null), "null");
      assert.equal(getErrorMessage(undefined), "undefined");
    });

    it("普通对象走 String()", () => {
      assert.equal(getErrorMessage({ a: 1 }), "[object Object]");
    });
  });

  describe("formatWikiTime（MediaWiki UTC -> 北京时间，且不应依赖机器时区）", () => {
    it("同日转换 UTC+8", () => {
      assert.equal(formatWikiTime("2024-06-19T10:30:45Z"), "2024-06-19 18:30");
    });

    it("跨日进位", () => {
      assert.equal(formatWikiTime("2024-06-19T22:30:45Z"), "2024-06-20 06:30");
    });

    it("跨年进位", () => {
      assert.equal(formatWikiTime("2024-12-31T20:00:00Z"), "2025-01-01 04:00");
    });

    it("午夜边界", () => {
      assert.equal(formatWikiTime("2024-01-01T00:00:00Z"), "2024-01-01 08:00");
    });

    it("无法解析时原样返回", () => {
      assert.equal(formatWikiTime("not-a-date"), "not-a-date");
    });
  });

  describe("normalizeChannelId", () => {
    it("去掉 group: 前缀", () => {
      assert.equal(normalizeChannelId("  group:123  "), "123");
    });

    it("去掉 channel: 前缀", () => {
      assert.equal(normalizeChannelId("channel:456"), "456");
    });

    it("去掉 qq: 前缀", () => {
      assert.equal(normalizeChannelId("qq:789"), "789");
    });

    it("前缀大小写不敏感，且保留剩余部分原样", () => {
      assert.equal(normalizeChannelId("GROUP:AbC"), "AbC");
    });

    it("无前缀时仅去空白", () => {
      assert.equal(normalizeChannelId("  plain  "), "plain");
    });

    it("空 / 全空白返回空串", () => {
      assert.equal(normalizeChannelId(""), "");
      assert.equal(normalizeChannelId("   "), "");
    });
  });

  describe("truncateComment", () => {
    it("空值返回空串", () => {
      assert.equal(truncateComment(""), "");
    });

    it("去空白后返回", () => {
      assert.equal(truncateComment("  hello  "), "hello");
    });

    it("恰好等于上限时不加省略号", () => {
      assert.equal(truncateComment("1234567890"), "1234567890");
    });

    it("超过上限时截断并加省略号", () => {
      assert.equal(truncateComment("12345678901"), "1234567890...");
    });

    it("支持自定义上限", () => {
      assert.equal(truncateComment("abcdef", 3), "abc...");
    });
  });

  describe("normalizeImageTitle", () => {
    it("无前缀时补 File:", () => {
      assert.equal(normalizeImageTitle("Foo.png"), "File:Foo.png");
    });

    it("已有 File: 前缀保持不变", () => {
      assert.equal(normalizeImageTitle("File:Foo.png"), "File:Foo.png");
    });

    it("File: 前缀保留原始大小写", () => {
      assert.equal(normalizeImageTitle("file:foo"), "file:foo");
    });

    it("Image: 前缀保持不变", () => {
      assert.equal(normalizeImageTitle("Image:x"), "Image:x");
    });

    it("中文 文件: 前缀保持不变", () => {
      assert.equal(normalizeImageTitle("文件:测试.png"), "文件:测试.png");
    });

    it("先去空白再判断", () => {
      assert.equal(normalizeImageTitle("  Foo.png  "), "File:Foo.png");
    });
  });

  describe("stripImagePrefix", () => {
    it("去掉 File:", () => {
      assert.equal(stripImagePrefix("File:Foo.png"), "Foo.png");
    });

    it("前缀大小写不敏感", () => {
      assert.equal(stripImagePrefix("file:foo"), "foo");
    });

    it("去掉 Image:", () => {
      assert.equal(stripImagePrefix("Image:x"), "x");
    });

    it("去掉中文 文件:", () => {
      assert.equal(stripImagePrefix("文件:测试"), "测试");
    });

    it("无前缀时原样返回", () => {
      assert.equal(stripImagePrefix("Foo.png"), "Foo.png");
    });

    it("先去空白再处理", () => {
      assert.equal(stripImagePrefix("  File:a.png  "), "a.png");
    });
  });
});
