import assert from "node:assert/strict";
import { AiMemory, pickContext } from "../src/services/aiMemory";

const PAGE = "电解器";

function turn(question: string) {
  return { question, answer: `${question}的答案`, page: PAGE, at: 0 };
}

/** 模拟「从数据库读出来的历史」，带真实时间戳 */
function storedTurn(question: string, at = Date.now()) {
  return { question, answer: `${question}的答案`, page: PAGE, at };
}

describe("services/aiMemory", () => {
  it("保留最近 maxTurns 轮，丢弃更早的", () => {
    const memory = new AiMemory(2, 60_000);
    memory.add("k", turn("第一问"));
    memory.add("k", turn("第二问"));
    memory.add("k", turn("第三问"));

    const turns = memory.get("k");
    assert.deepEqual(
      turns.map((item) => item.question),
      ["第二问", "第三问"],
    );
    assert.equal(turns[1].page, "电解器");
  });

  it("超过 TTL 的轮次被视为过期", () => {
    let now = 1_000;
    const memory = new AiMemory(3, 10_000, () => now);
    memory.add("k", turn("旧问题"));
    now += 11_000;

    assert.deepEqual(memory.get("k"), []);

    memory.add("k", turn("新问题"));
    assert.deepEqual(
      memory.get("k").map((item) => item.question),
      ["新问题"],
    );
  });

  it("部分过期时只保留未过期的轮次", () => {
    let now = 1_000;
    const memory = new AiMemory(3, 10_000, () => now);
    memory.add("k", turn("旧问题"));
    now += 6_000;
    memory.add("k", turn("新问题"));
    now += 6_000;

    assert.deepEqual(
      memory.get("k").map((item) => item.question),
      ["新问题"],
    );
  });

  it("maxTurns=0 时关闭记忆", () => {
    const memory = new AiMemory(0, 10_000);
    memory.add("k", turn("问题"));
    assert.equal(memory.enabled, false);
    assert.deepEqual(memory.get("k"), []);
  });

  it("不同用户/频道互不影响", () => {
    const memory = new AiMemory(2, 60_000);
    memory.add("qq:1:alice", turn("A 的问题"));
    memory.add("qq:1:bob", turn("B 的问题"));

    assert.deepEqual(
      memory.get("qq:1:alice").map((item) => item.question),
      ["A 的问题"],
    );
    assert.deepEqual(
      memory.get("qq:1:bob").map((item) => item.question),
      ["B 的问题"],
    );
  });

  it("空键不记录", () => {
    const memory = new AiMemory(2, 60_000);
    memory.add("", turn("无会话的问题"));
    assert.deepEqual(memory.get(""), []);
  });

  it("clear 会清空指定键", () => {
    const memory = new AiMemory(2, 60_000);
    memory.add("k", turn("问题"));
    memory.clear("k");
    assert.deepEqual(memory.get("k"), []);
  });

  describe("restore（重启后从数据库恢复）", () => {
    it("恢复后能读到，并按轮数裁剪", () => {
      const memory = new AiMemory(2, 60_000);
      const restored = memory.restore("k", [
        storedTurn("第一问"),
        storedTurn("第二问"),
        storedTurn("第三问"),
      ]);

      assert.deepEqual(
        restored.map((item) => item.question),
        ["第二问", "第三问"],
      );
      assert.equal(memory.get("k").length, 2);
    });

    it("恢复时剔除已过期的轮次", () => {
      let now = 1_000;
      const memory = new AiMemory(2, 10_000, () => now);
      now += 20_000;

      const restored = memory.restore("k", [storedTurn("旧问题", 1_000)]);
      assert.deepEqual(restored, []);
      assert.deepEqual(memory.get("k"), []);
    });

    it("关闭记忆时 restore 不生效", () => {
      const memory = new AiMemory(0, 60_000);
      assert.deepEqual(memory.restore("k", [turn("问题")]), []);
    });
  });

  describe("pickContext（群内追问）", () => {
    it("有自己的历史时优先用自己的", () => {
      const own = [turn("我自己的问题")];
      const shared = [turn("群里别人的问题")];
      const picked = pickContext(own, shared, true);

      assert.deepEqual(picked.turns, own);
      assert.equal(picked.inheritedFrom, undefined);
    });

    it("自己没有历史时承接群内上一轮，并标记来源问题", () => {
      const picked = pickContext([], [turn("氧石精炼炉是什么")], true);

      assert.equal(picked.turns.length, 1);
      assert.equal(picked.turns[0].question, "氧石精炼炉是什么");
      assert.equal(picked.inheritedFrom, "氧石精炼炉是什么");
    });

    it("关闭群内承接时退回单轮", () => {
      const picked = pickContext([], [turn("氧石精炼炉是什么")], false);
      assert.deepEqual(picked.turns, []);
      assert.equal(picked.inheritedFrom, undefined);
    });

    it("群里也没有话题时退回单轮", () => {
      const picked = pickContext([], [], true);
      assert.deepEqual(picked.turns, []);
    });
  });
});
