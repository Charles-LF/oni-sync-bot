import assert from "node:assert/strict";
import type { Mwn } from "mwn";
import { createReloginAwareProxy } from "../src/services/reloginAwareProxy";

/**
 * 假 client：像 mwn 一样**通过 `this` 访问自己的成员**。
 *
 * 这一点是本测试文件存在的理由：如果转发时丢失了 `this` 绑定，
 * 下面这些方法会抛 `Cannot read properties of undefined`。
 */
class FakeBot {
  public readonly marker = "bot-instance";

  async request(): Promise<string> {
    return `ok:${this.marker}`;
  }

  async *continuedQueryGen(): AsyncGenerator<string> {
    yield `gen:${this.marker}`;
  }
}

function proxyOf(
  getBot: () => FakeBot,
  relogin: () => Promise<void> = async () => {},
) {
  return createReloginAwareProxy({
    getBot: () => getBot() as unknown as Mwn,
    relogin,
    label: "FAKE",
  });
}

const callRequest = (proxy: Mwn) =>
  (proxy.request as unknown as () => Promise<string>)();

const callGen = (proxy: Mwn) =>
  (proxy.continuedQueryGen as unknown as () => AsyncGenerator<string>)();

describe("services/reloginAwareProxy", () => {
  it("普通方法：保留 this 绑定", async () => {
    const proxy = proxyOf(() => new FakeBot());
    assert.equal(await callRequest(proxy), "ok:bot-instance");
  });

  it("非函数成员直接透传", () => {
    const proxy = proxyOf(() => new FakeBot());
    assert.equal((proxy as unknown as { marker: string }).marker, "bot-instance");
  });

  // ↓ 这条就是 2026-10-16 线上故障的回归测试：
  //   当时实现写成 `const f = bot.continuedQueryGen; f(...)`，this 丢失即崩
  it("continuedQueryGen：迭代过程中保留 this 绑定", async () => {
    const proxy = proxyOf(() => new FakeBot());
    const seen: string[] = [];
    for await (const item of callGen(proxy)) seen.push(item);
    assert.deepEqual(seen, ["gen:bot-instance"]);
  });

  it("普通方法遇到 assertuserfailed：重新登录并重放一次", async () => {
    let calls = 0;
    let relogins = 0;
    const bot = {
      async request() {
        calls++;
        if (calls === 1) throw { code: "assertuserfailed" };
        return "replayed";
      },
    };

    const proxy = createReloginAwareProxy({
      getBot: () => bot as unknown as Mwn,
      relogin: async () => {
        relogins++;
      },
      label: "FAKE",
    });

    assert.equal(await callRequest(proxy), "replayed");
    assert.equal(calls, 2);
    assert.equal(relogins, 1);
  });

  it("continuedQueryGen 迭代中途 assertuserfailed：重登并重建迭代器", async () => {
    let runs = 0;
    let relogins = 0;
    const bot = {
      async *continuedQueryGen(): AsyncGenerator<string> {
        runs++;
        if (runs === 1) throw { code: "assertuserfailed" };
        yield "second-run";
      },
    };

    const proxy = createReloginAwareProxy({
      getBot: () => bot as unknown as Mwn,
      relogin: async () => {
        relogins++;
      },
      label: "FAKE",
    });

    const seen: string[] = [];
    for await (const item of callGen(proxy)) seen.push(item);

    assert.deepEqual(seen, ["second-run"]);
    assert.equal(runs, 2);
    assert.equal(relogins, 1);
  });

  it("非 assertuserfailed 的错误原样抛出，不触发重登", async () => {
    let relogins = 0;
    const bot = {
      async request(): Promise<string> {
        throw new Error("boom");
      },
    };

    const proxy = createReloginAwareProxy({
      getBot: () => bot as unknown as Mwn,
      relogin: async () => {
        relogins++;
      },
      label: "FAKE",
    });

    await assert.rejects(() => callRequest(proxy), /boom/);
    assert.equal(relogins, 0);
  });

  it("getBot 未就绪时，属性访问即同步抛出（与原实现一致）", () => {
    const proxy = createReloginAwareProxy({
      getBot: () => {
        throw new Error("bot 尚未就绪");
      },
      relogin: async () => {},
      label: "FAKE",
    });

    assert.throws(() => callRequest(proxy), /bot 尚未就绪/);
  });

  // 对照实验：证明 FakeBot 确实依赖 this。
  // 若这条开始失败，说明上面的「保留 this 绑定」测试已退化为空测。
  it("对照：裸调用 FakeBot 的方法必定因 this 丢失而抛错", async () => {
    const bare = new FakeBot().continuedQueryGen;
    await assert.rejects(async () => {
      for await (const item of bare()) {
        void item;
      }
    }, TypeError);
  });
});
