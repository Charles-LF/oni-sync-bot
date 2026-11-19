import assert from "node:assert/strict";
import { AiQueryCommands } from "../src/plugins/aiQueryCommands";

/**
 * 只测「话题页判定」这类纯逻辑：用原型造实例、塞一个假的 ctx，
 * 不启动 Koishi、不碰向量库。
 */
function createPlugin(pages: string[] | Error) {
  const plugin = Object.create(AiQueryCommands.prototype) as any;
  plugin.ctx = {
    database: {
      get: async () => {
        if (pages instanceof Error) throw pages;
        return pages.map((title) => ({ title }));
      },
    },
  };
  return plugin;
}

function chunk(documentId: string) {
  return { documentId, title: documentId, url: "", text: `${documentId} 的正文` };
}

describe("plugins/aiQueryCommands 话题页判定", () => {
  describe("subjectPages：问题里点名的页面", () => {
    it("命中问题中出现的标题", async () => {
      const plugin = createPlugin(["电解器", "氧石精炼炉", "水泵"]);
      assert.deepEqual(await plugin.subjectPages("氧石精炼炉怎么用"), [
        "氧石精炼炉",
      ]);
    });

    it("长标题优先，并丢掉被长标题包含的短标题", async () => {
      const plugin = createPlugin(["氧石", "氧石精炼炉"]);
      assert.deepEqual(await plugin.subjectPages("氧石精炼炉有什么用"), [
        "氧石精炼炉",
      ]);
    });

    it("最多取两个页面（比较类问题）", async () => {
      const plugin = createPlugin(["电解器", "气泵", "水泵"]);
      assert.deepEqual(await plugin.subjectPages("电解器和气泵哪个费电"), [
        "电解器",
        "气泵",
      ]);
    });

    it("单字标题不参与匹配（避免「水」这类噪音）", async () => {
      const plugin = createPlugin(["水"]);
      assert.deepEqual(await plugin.subjectPages("水解反应怎么做"), []);
    });

    it("没有点名任何页面时返回空数组", async () => {
      const plugin = createPlugin(["电解器"]);
      assert.deepEqual(await plugin.subjectPages("这游戏怎么发电"), []);
    });

    it("读库失败时不抛错，退化为空数组", async () => {
      const plugin = createPlugin(new Error("boom"));
      assert.deepEqual(await plugin.subjectPages("电解器怎么用"), []);
    });
  });

  describe("dominantDocument：命中集中在某一页", () => {
    it("过半命中来自同一页时返回该页", () => {
      const plugin = createPlugin([]);
      const chunks = [
        chunk("电解器"),
        chunk("电解器"),
        chunk("电解器"),
        chunk("空间加热器"),
        chunk("氧石精炼炉"),
      ];
      assert.equal(plugin.dominantDocument(chunks), "电解器");
    });

    it("命中分散在多个页面时不猜话题页", () => {
      const plugin = createPlugin([]);
      const chunks = [
        chunk("电解器"),
        chunk("电解器"),
        chunk("气泵"),
        chunk("气泵"),
        chunk("水泵"),
        chunk("氧石精炼炉"),
      ];
      assert.equal(plugin.dominantDocument(chunks), undefined);
    });

    it("命中太少时不猜话题页", () => {
      const plugin = createPlugin([]);
      assert.equal(
        plugin.dominantDocument([chunk("电解器"), chunk("电解器")]),
        undefined,
      );
    });
  });
});
