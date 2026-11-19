import assert from "node:assert/strict";
import {
  chunkText,
  extractPlainText,
  squash,
} from "../src/utils/renderText";

/** 模拟 MediaWiki `action=parse&prop=text` 的一段典型输出 */
const SAMPLE_HTML = `
<div class="mw-parser-output">
  <table class="infobox">
    <tr><th colspan="2" class="infobox-title">电解器</th></tr>
    <tr><td class="infobox-image-cell"><div class="infobox-caption">把水分解成氧气和氢气。</div></td></tr>
    <tr><th class="infobox-th">ID</th><td class="infobox-td"><code>Electrolyzer</code></td></tr>
    <tr><td colspan="2" class="infobox-group-cell">
      <table class="infobox-group">
        <tr><th class="infobox-group-title">效果 <span class="mw-collapsible-toggle"><a>折叠</a></span></th></tr>
        <tr><td class="infobox-group-content">
          <div class="infobox-group-child"><div class="infobox-th">电力</div><div class="infobox-td">消耗 1200 瓦</div></div>
        </td></tr>
      </table>
    </td></tr>
  </table>
  <p><b>电解器</b>用于把水分解为氧气和氢气。</p>
  <h2><span class="mw-headline">数据</span></h2>
  <table class="wikitable">
    <tr><th>项目</th><th>数值</th></tr>
    <tr><td>耗电</td><td>120 瓦</td></tr>
    <tr><td>产氧</td><td>888 克/秒</td></tr>
  </table>
  <div class="navbox"><a href="/a">导航：建筑</a></div>
  <ul>
    <li>需要 1 千克水
      <ul><li>嵌套子项不应重复</li></ul>
    </li>
  </ul>
  <script>console.log("should be removed")</script>
  <sup class="reference">[1]</sup>
</div>`;

describe("utils/renderText", () => {
  describe("extractPlainText", () => {
    it("信息框按「标签：值」保留，关键数值不丢", () => {
      const text = extractPlainText(SAMPLE_HTML);
      assert.ok(text.includes("【电解器】"), `缺少信息框标题：\n${text}`);
      assert.ok(text.includes("电力：消耗 1200 瓦"), "信息框分组数值丢失");
      assert.ok(text.includes("ID：Electrolyzer"), "信息框键值行丢失");
      assert.ok(!text.includes("折叠"), "折叠按钮应作为噪音剔除");
    });

    it("剔除导航框 / 脚本 / 脚注标记", () => {
      const text = extractPlainText(SAMPLE_HTML);
      assert.ok(!text.includes("导航：建筑"), "导航框未剔除");
      assert.ok(!text.includes("should be removed"), "脚本未剔除");
      assert.ok(!text.includes("[1]"), "脚注标记未剔除");
    });

    it("正文表格压平成「单元格 | 单元格」，保留数值", () => {
      const text = extractPlainText(SAMPLE_HTML);
      assert.ok(text.includes("耗电 | 120 瓦"), `未保留表格数值：\n${text}`);
      assert.ok(text.includes("产氧 | 888 克/秒"), "未保留表格数值");
    });

    it("标题保留层级，正文段落保留", () => {
      const text = extractPlainText(SAMPLE_HTML);
      assert.ok(text.includes("## 数据"), "标题未保留层级");
      assert.ok(text.includes("电解器用于把水分解为氧气和氢气。"), text);
    });

    it("嵌套列表不会重复输出文字", () => {
      const text = extractPlainText(SAMPLE_HTML);
      const occurrences = text.split("嵌套子项不应重复").length - 1;
      assert.equal(occurrences, 1, "嵌套列表文字出现了多次");
      assert.ok(text.includes("需要 1 千克水"));
    });

    it("tableMode=drop 时丢弃全部表格（含信息框）", () => {
      const text = extractPlainText(SAMPLE_HTML, { tableMode: "drop" });
      assert.ok(!text.includes("888 克/秒"), "表格内容未被丢弃");
      assert.ok(!text.includes("电力：消耗 1200 瓦"), "信息框内容未被丢弃");
      assert.ok(text.includes("电解器用于把水分解"), "正文被误删");
    });

    it("maxLength 会截断超长正文", () => {
      const text = extractPlainText(SAMPLE_HTML, { maxLength: 10 });
      assert.equal(text.length <= 10, true, `未截断：${text}`);
    });

    it("空输入返回空串", () => {
      assert.equal(extractPlainText(""), "");
    });
  });

  describe("chunkText", () => {
    it("空文本不产生块", () => {
      assert.deepEqual(chunkText(""), []);
      assert.deepEqual(chunkText("   \n  "), []);
    });

    it("短文本只产生一个块", () => {
      const chunks = chunkText("电解器耗电 120 瓦。", { size: 200 });
      assert.equal(chunks.length, 1);
      assert.equal(chunks[0].index, 0);
      assert.equal(chunks[0].text, "电解器耗电 120 瓦。");
    });

    it("长文本按自然断点切块，且不超过上限太多", () => {
      const paragraph = "电解器把水分解成氧气和氢气，需要持续供电。".repeat(20);
      const chunks = chunkText(paragraph, {
        size: 100,
        overlap: 20,
        maxChunks: 50,
      });
      assert.ok(chunks.length > 1, "长文本应被切成多块");
      for (const chunk of chunks) {
        assert.ok(chunk.text.length <= 100, `块超长：${chunk.text.length}`);
      }
      assert.deepEqual(
        chunks.map((chunk) => chunk.index),
        chunks.map((_, index) => index),
        "块序号应连续递增",
      );
    });

    it("maxChunks 限制块数量", () => {
      const long = "氧气".repeat(2000);
      const chunks = chunkText(long, { size: 100, overlap: 10, maxChunks: 3 });
      assert.equal(chunks.length, 3);
    });

    it("没有标点的长串也会被强制切开（不会死循环）", () => {
      const chunks = chunkText("a".repeat(500), { size: 120, overlap: 10 });
      assert.ok(chunks.length >= 4);
      assert.ok(chunks.every((chunk) => chunk.text.length <= 120));
    });

    it("信息框分组标题处优先断块，数值不和建造项混在一起", () => {
      const intro = "电解器把水分解为氧气和氢气，是基地最常用的制氧建筑之一。".repeat(3);
      const text = [
        "【电解器】",
        intro,
        "[效果]",
        "电力：消耗 120 瓦",
        "产热：1 千复制热/秒",
        "[建造]",
        "类别：氧气 > 生产",
        "科技：空气系统",
        "建造时间：30 秒",
      ].join("\n");

      const chunks = chunkText(text, { size: 350, overlap: 0, maxChunks: 8 });

      assert.ok(chunks.length >= 2, `未按分组切块：${JSON.stringify(chunks)}`);
      assert.ok(chunks[0].text.includes("【电解器】"));
      assert.ok(chunks[0].text.includes("电力：消耗 120 瓦"), chunks[0].text);
      assert.ok(!chunks[0].text.includes("[建造]"), "分组标题应成为新块起点");
      assert.ok(chunks[1].text.startsWith("[建造]"), chunks[1].text);
    });

    it("分组标题不会把短块切碎（当前块不足 120 字时不切）", () => {
      const text = [
        "【电灯】",
        "通电时提供光照。",
        "[效果]",
        "电力：消耗 8 瓦",
        "[工作条件]",
        "过热：75°C",
      ].join("\n");

      const chunks = chunkText(text, { size: 350, overlap: 0 });
      assert.equal(chunks.length, 1, JSON.stringify(chunks));
    });
  });

  describe("squash", () => {
    it("压缩多空格并丢弃空行", () => {
      assert.equal(squash("  a   b \n\n\n c  "), "a b\nc");
    });

    it("把不换行空格当作普通空格", () => {
      assert.equal(squash("a\u00a0b"), "a b");
    });
  });
});
