import assert from "node:assert/strict";
import {
  calculateScore,
  findFuzzyMatches,
  getCommonPrefixLength,
  type ScorablePage,
} from "../src/utils/matcher";

/** 构造一个页面，拼音由调用方给定，避免测试依赖 pinyin-pro */
function page(
  id: number,
  title: string,
  pinyin_full: string,
  pinyin_first: string,
): ScorablePage {
  return { id, title, pinyin_full, pinyin_first };
}

const JINGLIANQI = page(1, "精炼器", "jinglianqi", "jlq");
const ZHENGQI_JINGLIANQI = page(2, "蒸汽精炼器", "zhengqijinglianqi", "zhqjlq");
const YANJIANG_JINGLIANQI = page(3, "岩浆精炼器", "yanjiangjinglianqi", "yjjlq");

describe("utils/matcher", () => {
  describe("getCommonPrefixLength", () => {
    it("完全相同返回全长", () => {
      assert.equal(getCommonPrefixLength("abc", "abc"), 3);
    });

    it("无公共前缀返回 0", () => {
      assert.equal(getCommonPrefixLength("abc", "xyz"), 0);
    });

    it("按较短串封顶", () => {
      assert.equal(getCommonPrefixLength("abc", "abcdef"), 3);
    });

    it("空串返回 0", () => {
      assert.equal(getCommonPrefixLength("", "abc"), 0);
    });
  });

  describe("calculateScore", () => {
    it("完全命中：标题+全拼开头+首字母+公共前缀", () => {
      // 10(标题) + 9(全拼开头) + 8(全拼包含) + 6(首字母) + 3(标题前缀) + 5(全拼前缀/2)
      assert.equal(
        calculateScore(JINGLIANQI, "精炼器", "jinglianqi", "jlq"),
        41,
      );
    });

    it("部分命中：标题包含 + 全拼包含 + 首字母，但无前缀加分", () => {
      // 10 + 8 + 6
      assert.equal(
        calculateScore(ZHENGQI_JINGLIANQI, "精炼器", "jinglianqi", "jlq"),
        24,
      );
    });

    it("完全不相关时得 0", () => {
      assert.equal(
        calculateScore(JINGLIANQI, "挖掘机", "wajueji", "wjj"),
        0,
      );
    });

    it("关键词为全拼时：前缀 + 包含 + 首字母加分", () => {
      // 9(全拼开头) + 8(全拼包含) + 6(首字母) + 5(全拼前缀/2)，标题不含拉丁串故无 +10
      assert.equal(
        calculateScore(JINGLIANQI, "jinglianqi", "jinglianqi", "jlq"),
        28,
      );
    });
  });

  describe("findFuzzyMatches", () => {
    const all = [JINGLIANQI, ZHENGQI_JINGLIANQI, YANJIANG_JINGLIANQI];

    it("按分数降序排列", () => {
      const result = findFuzzyMatches(all, "精炼器", "jinglianqi", "jlq");
      assert.equal(result[0].title, "精炼器");
      assert.ok(result[0].score >= result[1].score);
    });

    it("只返回命中项，过滤掉 0 分", () => {
      const result = findFuzzyMatches(all, "精炼器", "jinglianqi", "jlq");
      assert.equal(result.length, 3);
      assert.ok(result.every((r) => r.score > 0));
    });

    it("同标题去重，保留分数最高的那个", () => {
      const dup = [
        page(10, "精炼器", "jinglianqi", "jlq"),
        page(11, "精炼器", "jinglianqi", "jlq"),
        page(12, "精炼器", "jinglianqi", "jlq"),
      ];
      const result = findFuzzyMatches(dup, "精炼器", "jinglianqi", "jlq");
      assert.equal(result.length, 1);
    });

    it("默认最多返回 5 条", () => {
      const many = Array.from({ length: 8 }, (_, i) =>
        page(100 + i, `精炼器${i}`, "jinglianqi", "jlq"),
      );
      const result = findFuzzyMatches(many, "精炼器", "jinglianqi", "jlq");
      assert.equal(result.length, 5);
    });

    it("limit 可自定义", () => {
      const many = Array.from({ length: 8 }, (_, i) =>
        page(200 + i, `精炼器${i}`, "jinglianqi", "jlq"),
      );
      assert.equal(findFuzzyMatches(many, "精炼器", "jinglianqi", "jlq", 2).length, 2);
    });

  });

  describe("空查询串不得产生匹配信号（回归测试）", () => {
    it("首字母为空串时不再给所有页面白送 6 分", () => {
      const irrelevant = page(9, "完全无关", "wanquanwuguan", "wqwg");
      assert.equal(calculateScore(irrelevant, "refinery", "refinery", ""), 0);
    });

    it("全符号查询（全拼与首字母均为空）不再给所有页面白送 23 分", () => {
      const irrelevant = page(9, "完全无关", "wanquanwuguan", "wqwg");
      assert.equal(calculateScore(irrelevant, "!!!", "", ""), 0);
    });

    it("真正的拉丁命中仍能正常得分（判空没有把正常路径一起挡掉）", () => {
      // 拉丁页面的 pinyin_first 本身就是空串，属于最容易误伤的输入
      const latin = page(1, "refinery", "refinery", "");
      assert.equal(calculateScore(latin, "refinery", "refinery", ""), 39);
    });

    it("纯拉丁查询在没有真实命中时返回空列表而非随机页面", () => {
      const pages = [
        page(1, "完全无关", "wanquanwuguan", "wqwg"),
        page(2, "另一页", "lingyiyie", "lyy"),
      ];
      assert.deepEqual(findFuzzyMatches(pages, "refinery", "refinery", ""), []);
    });

    it("全符号查询同样返回空列表", () => {
      const pages = [page(1, "完全无关", "wanquanwuguan", "wqwg")];
      assert.deepEqual(findFuzzyMatches(pages, "!!!", "", ""), []);
    });
  });
});
