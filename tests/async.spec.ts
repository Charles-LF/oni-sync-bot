import assert from "node:assert/strict";
import { sleep, withRetry } from "../src/utils/async";

describe("utils/async", () => {
  describe("sleep", () => {
    it("至少等待指定时长", async () => {
      const start = Date.now();
      await sleep(15);
      assert.ok(Date.now() - start >= 10, "sleep(15) 至少应耗时 10ms");
    });
  });

  describe("withRetry", () => {
    it("首次成功时只调用一次", async () => {
      let calls = 0;
      const result = await withRetry(
        async () => {
          calls++;
          return "ok";
        },
        { delayMs: 0 },
      );
      assert.equal(result, "ok");
      assert.equal(calls, 1);
    });

    it("失败后重试并最终成功", async () => {
      let calls = 0;
      const result = await withRetry(
        async () => {
          calls++;
          if (calls < 3) throw new Error(`fail ${calls}`);
          return calls;
        },
        { attempts: 3, delayMs: 0 },
      );
      assert.equal(result, 3);
      assert.equal(calls, 3);
    });

    it("全部失败时抛出最后一次的错误本身（不做包装）", async () => {
      let calls = 0;
      const original = { code: "E_BOOM" };
      await assert.rejects(
        () =>
          withRetry(
            async () => {
              calls++;
              throw original;
            },
            { attempts: 3, delayMs: 0 },
          ),
        (err: unknown) => err === original,
      );
      assert.equal(calls, 3);
    });

    it("onRetry 每次失败后触发，次数为 attempts-1，且参数正确", async () => {
      const seen: Array<[number, number]> = [];
      await assert.rejects(() =>
        withRetry(
          async () => {
            throw new Error("x");
          },
          {
            attempts: 4,
            delayMs: 0,
            onRetry: (_error, attempt, attempts) => seen.push([attempt, attempts]),
          },
        ),
      );
      assert.deepEqual(seen, [
        [1, 4],
        [2, 4],
        [3, 4],
      ]);
    });

    it("attempts=1 时不重试", async () => {
      let calls = 0;
      await assert.rejects(() =>
        withRetry(
          async () => {
            calls++;
            throw new Error("x");
          },
          { attempts: 1, delayMs: 0 },
        ),
      );
      assert.equal(calls, 1);
    });

    it("默认 attempts 为 3", async () => {
      let calls = 0;
      await assert.rejects(() =>
        withRetry(
          async () => {
            calls++;
            throw new Error("x");
          },
          { delayMs: 0 },
        ),
      );
      assert.equal(calls, 3);
    });

    it("非法 attempts 立即抛 RangeError", async () => {
      await assert.rejects(() => withRetry(async () => 1, { attempts: 0 }), RangeError);
      await assert.rejects(() => withRetry(async () => 1, { attempts: 1.5 }), RangeError);
    });
  });
});
